"""Background strategy runner driven from the desktop app.

Two modes:

  PAPER  (default) — signals and fills are simulated locally. No broker calls
                     beyond reading candles. Nothing touches your account.
  LIVE            — sends real orders through AngelOneClient.place_order.
                    Requires confirm_live=True in the start payload, which the
                    UI only sets after an explicit typed confirmation.

The runner never starts on its own: it exists idle until /bot/start is called.
"""

import datetime as dt
import threading
import time

from pydantic import BaseModel, Field

from angelone_agent import markets
from angelone_agent.analysis import add_indicators, to_dataframe

STRATEGY_INFO = [
    {
        "id": "sma_crossover",
        "name": "SMA crossover",
        "desc": "Long when the fast SMA is above the slow SMA, flat (or short) when below.",
        "params": ["fast", "slow"],
    },
    {
        "id": "rsi_reversion",
        "name": "RSI mean reversion",
        "desc": "Buy oversold (RSI below the low band), exit when RSI recovers past the high band.",
        "params": ["rsi_low", "rsi_high"],
    },
    {
        "id": "orb",
        "name": "Opening range breakout",
        "desc": "Marks the first N minutes' high/low, then trades the break of that range.",
        "params": ["orb_minutes"],
    },
    {
        "id": "supertrend",
        "name": "Supertrend",
        "desc": "Follows the Supertrend flip — long while the band sits below price, short when above.",
        "params": [],
    },
    {
        "id": "macd_cross",
        "name": "MACD crossover",
        "desc": "Long when the MACD line crosses above its signal line, flat (or short) below.",
        "params": [],
    },
    {
        "id": "vwap_trend",
        "name": "VWAP trend",
        "desc": "Long above session VWAP, short below. Needs traded volume, so not for indices.",
        "params": [],
    },
]


class BotConfig(BaseModel):
    strategy: str = "sma_crossover"
    symbol: str
    exchange: str = "NSE"
    interval: str = "FIVE_MINUTE"
    quantity: int = Field(default=1, gt=0)
    mode: str = Field(default="PAPER", pattern="^(PAPER|LIVE)$")
    product: str = "INTRADAY"
    poll_seconds: int = Field(default=30, ge=10, le=600)
    allow_short: bool = False
    confirm_live: bool = False
    # risk caps
    max_trades: int = Field(default=6, ge=1, le=50)
    max_daily_loss: float = Field(default=2000.0, ge=0)
    square_off: str = "15:15"
    # strategy params
    fast: int = 20
    slow: int = 50
    rsi_low: float = 30.0
    rsi_high: float = 70.0
    orb_minutes: int = 15


def _desired_position(cfg, df):
    """Return the target position: 1 long, -1 short, 0 flat. None = no opinion yet."""
    last = df.iloc[-1]

    if cfg.strategy == "sma_crossover":
        fast = last.get(f"sma_{cfg.fast}")
        slow = last.get(f"sma_{cfg.slow}")
        if fast is None or slow is None or fast != fast or slow != slow:
            return None, "warming up — not enough candles for both SMAs"
        if fast > slow:
            return 1, f"fast SMA {fast:.2f} > slow SMA {slow:.2f}"
        return (-1 if cfg.allow_short else 0), f"fast SMA {fast:.2f} < slow SMA {slow:.2f}"

    if cfg.strategy == "rsi_reversion":
        rsi = last.get("rsi")
        if rsi is None or rsi != rsi:
            return None, "warming up — RSI not available yet"
        if rsi < cfg.rsi_low:
            return 1, f"RSI {rsi:.1f} below {cfg.rsi_low:.0f} (oversold)"
        if rsi > cfg.rsi_high:
            return (-1 if cfg.allow_short else 0), f"RSI {rsi:.1f} above {cfg.rsi_high:.0f}"
        return None, f"RSI {rsi:.1f} in the neutral band — holding"

    if cfg.strategy == "orb":
        start = df.index[0]
        window_end = start + dt.timedelta(minutes=cfg.orb_minutes)
        opening = df[df.index < window_end]
        rest = df[df.index >= window_end]
        if opening.empty or rest.empty:
            return None, f"building the {cfg.orb_minutes}m opening range"
        hi = float(opening["high"].max())
        lo = float(opening["low"].min())
        close = float(last["close"])
        if close > hi:
            return 1, f"close {close:.2f} broke the opening high {hi:.2f}"
        if close < lo:
            return (-1 if cfg.allow_short else 0), f"close {close:.2f} broke the opening low {lo:.2f}"
        return None, f"inside the opening range {lo:.2f}–{hi:.2f}"

    if cfg.strategy == "supertrend":
        direction = last.get("supertrend_dir")
        level = last.get("supertrend")
        if direction is None or direction != direction:
            return None, "warming up — Supertrend not established"
        if int(direction) > 0:
            return 1, f"Supertrend bullish, band at {level:.2f}"
        return (-1 if cfg.allow_short else 0), f"Supertrend bearish, band at {level:.2f}"

    if cfg.strategy == "macd_cross":
        macd, signal = last.get("macd"), last.get("macd_signal")
        if macd is None or signal is None or macd != macd or signal != signal:
            return None, "warming up — MACD not available yet"
        if macd > signal:
            return 1, f"MACD {macd:.2f} above signal {signal:.2f}"
        return (-1 if cfg.allow_short else 0), f"MACD {macd:.2f} below signal {signal:.2f}"

    if cfg.strategy == "vwap_trend":
        vwap = last.get("vwap")
        if vwap is None or vwap != vwap:
            return None, "no VWAP — this instrument reports no traded volume"
        close = float(last["close"])
        if close > vwap:
            return 1, f"close {close:.2f} above VWAP {vwap:.2f}"
        return (-1 if cfg.allow_short else 0), f"close {close:.2f} below VWAP {vwap:.2f}"

    return None, f"unknown strategy {cfg.strategy!r}"


class BotRunner:
    def __init__(self, client, api_lock, resolve, throttle, on_event=None):
        self._client = client
        self._api_lock = api_lock
        self._resolve = resolve
        self._throttle = throttle
        self._on_event = on_event or (lambda _msg: None)

        self._thread = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._log = []
        self._seq = 0
        self._cfg = None
        self._reset_state()

    def _reset_state(self):
        self._state = {
            "running": False,
            "position": 0,
            "entry_price": None,
            "qty": 0,
            "realized_pnl": 0.0,
            "unrealized_pnl": 0.0,
            "trades": 0,
            "last_price": None,
            "last_signal": None,
            "stopped_reason": None,
            "started_at": None,
        }

    # ---------------- logging ----------------
    def _emit(self, level, msg):
        with self._lock:
            self._seq += 1
            entry = {
                "seq": self._seq,
                "ts": dt.datetime.now().strftime("%H:%M:%S"),
                "level": level,
                "msg": msg,
            }
            self._log.append(entry)
            if len(self._log) > 500:
                self._log = self._log[-500:]
        self._on_event({"type": "bot_log", **entry})

    def _push_status(self):
        self._on_event({"type": "bot_status", **self.status()})

    def logs(self, since=0):
        with self._lock:
            return {"logs": [e for e in self._log if e["seq"] > since], "seq": self._seq}

    def status(self):
        with self._lock:
            state = dict(self._state)
        state["config"] = self._cfg.model_dump() if self._cfg else None
        return state

    # ---------------- lifecycle ----------------
    def start(self, cfg: BotConfig):
        if self._thread and self._thread.is_alive():
            return {"ok": False, "error": "bot is already running"}
        if cfg.mode == "LIVE" and not cfg.confirm_live:
            return {"ok": False, "error": "LIVE mode requires an explicit confirmation"}

        self._reset_state()
        with self._lock:
            self._log = []
            self._seq = 0
        self._cfg = cfg
        self._stop.clear()
        self._state["running"] = True
        self._state["started_at"] = dt.datetime.now().strftime("%H:%M:%S")

        self._emit("info", f"{cfg.mode} mode — {cfg.strategy} on {cfg.symbol} ({cfg.interval})")
        self._emit(
            "info",
            f"qty {cfg.quantity} · max {cfg.max_trades} trades · stop at -{cfg.max_daily_loss:.0f} · square-off {cfg.square_off}",
        )
        if cfg.mode == "LIVE":
            self._emit("warn", "LIVE — orders will be sent to your real AngelOne account")

        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return {"ok": True}

    def stop(self):
        if not (self._thread and self._thread.is_alive()):
            return {"ok": False, "error": "bot is not running"}
        self._emit("info", "stop requested")
        self._stop.set()
        self._thread.join(timeout=15)
        return {"ok": True}

    # ---------------- main loop ----------------
    def _loop(self):
        cfg = self._cfg
        try:
            token, tsym, exch = self._resolve(cfg.symbol, cfg.exchange)
        except Exception as exc:
            self._emit("error", f"cannot resolve {cfg.symbol}: {exc}")
            self._finish("symbol not found")
            return

        while not self._stop.is_set():
            try:
                self._tick(cfg, token, tsym, exch)
            except Exception as exc:
                self._emit("error", f"tick failed: {exc}")
            self._push_status()
            if self._state.get("stopped_reason"):
                break
            self._stop.wait(cfg.poll_seconds)

        if self._state["position"] != 0:
            self._exit_position(cfg, tsym, token, exch, self._state["last_price"], "shutdown")
        self._finish(self._state.get("stopped_reason") or "stopped by user")

    def _finish(self, reason):
        self._state["running"] = False
        self._state["stopped_reason"] = reason
        self._emit(
            "info",
            f"bot stopped ({reason}) · {self._state['trades']} trades · realized {self._state['realized_pnl']:+.2f}",
        )
        self._push_status()

    def _tick(self, cfg, token, tsym, exch):
        now = dt.datetime.now()
        start, _ = markets.session_window(exch, now)  # MCX runs far later than NSE

        self._throttle("candles")
        with self._api_lock:
            raw = self._client.get_historical_data(
                token=token,
                exchange=exch,
                interval=cfg.interval,
                from_date=start.strftime("%Y-%m-%d %H:%M"),
                to_date=now.strftime("%Y-%m-%d %H:%M"),
            )
        if not raw:
            self._emit("info", "no candles yet for this session")
            return

        df = to_dataframe(raw)
        df = add_indicators(df, fast=cfg.fast, slow=cfg.slow)

        price = float(df.iloc[-1]["close"])
        self._state["last_price"] = price
        if self._state["position"] != 0 and self._state["entry_price"]:
            self._state["unrealized_pnl"] = (
                (price - self._state["entry_price"]) * self._state["qty"] * self._state["position"]
            )

        # --- risk gates, checked before acting on any signal ---
        sq_h, sq_m = (int(x) for x in cfg.square_off.split(":"))
        if now.time() >= dt.time(sq_h, sq_m):
            if self._state["position"] != 0:
                self._exit_position(cfg, tsym, token, exch, price, "square-off time")
            self._state["stopped_reason"] = "square-off time reached"
            return

        total = self._state["realized_pnl"] + self._state["unrealized_pnl"]
        if cfg.max_daily_loss and total <= -cfg.max_daily_loss:
            self._emit("warn", f"daily loss cap hit ({total:+.2f})")
            if self._state["position"] != 0:
                self._exit_position(cfg, tsym, token, exch, price, "loss cap")
            self._state["stopped_reason"] = "daily loss cap"
            return

        target, why = _desired_position(cfg, df)
        self._state["last_signal"] = why
        if target is None:
            self._emit("debug", f"{price:.2f} — {why}")
            return

        current = self._state["position"]
        if target == current:
            self._emit("debug", f"{price:.2f} — {why} (holding {current:+d})")
            return

        if self._state["trades"] >= cfg.max_trades and target != 0:
            self._emit("warn", f"trade cap reached ({cfg.max_trades}) — not opening new positions")
            return

        if current != 0:
            self._exit_position(cfg, tsym, token, exch, price, why)
        if target != 0:
            self._enter_position(cfg, tsym, token, exch, price, target, why)

    # ---------------- fills ----------------
    def _send(self, cfg, tsym, token, exch, side, qty):
        """PAPER logs the intent; LIVE actually routes the order."""
        if cfg.mode == "PAPER":
            return {"paper": True}
        self._throttle("order")
        with self._api_lock:
            return self._client.place_order(
                tradingsymbol=tsym,
                symboltoken=token,
                transactiontype=side,
                quantity=qty,
                exchange=exch,
                ordertype="MARKET",
                producttype=cfg.product,
            )

    def _enter_position(self, cfg, tsym, token, exch, price, direction, why):
        side = "BUY" if direction > 0 else "SELL"
        try:
            resp = self._send(cfg, tsym, token, exch, side, cfg.quantity)
        except Exception as exc:
            self._emit("error", f"entry order rejected: {exc}")
            return
        self._state.update(
            {"position": direction, "entry_price": price, "qty": cfg.quantity, "unrealized_pnl": 0.0}
        )
        tag = "[paper] " if cfg.mode == "PAPER" else ""
        self._emit("trade", f"{tag}{side} {cfg.quantity} {tsym} @ {price:.2f} — {why}")
        if cfg.mode == "LIVE":
            self._emit("info", f"broker response: {resp}")

    def _exit_position(self, cfg, tsym, token, exch, price, why):
        direction = self._state["position"]
        if direction == 0:
            return
        qty = self._state["qty"]
        side = "SELL" if direction > 0 else "BUY"
        try:
            resp = self._send(cfg, tsym, token, exch, side, qty)
        except Exception as exc:
            self._emit("error", f"exit order rejected: {exc} — position still open!")
            return
        price = price or self._state["entry_price"]
        pnl = (price - self._state["entry_price"]) * qty * direction
        self._state["realized_pnl"] += pnl
        self._state["trades"] += 1
        self._state.update({"position": 0, "entry_price": None, "qty": 0, "unrealized_pnl": 0.0})
        tag = "[paper] " if cfg.mode == "PAPER" else ""
        self._emit("trade", f"{tag}{side} {qty} {tsym} @ {price:.2f} — {why} · P&L {pnl:+.2f}")
        if cfg.mode == "LIVE":
            self._emit("info", f"broker response: {resp}")
