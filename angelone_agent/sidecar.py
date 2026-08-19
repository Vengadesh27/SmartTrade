"""Localhost HTTP + WebSocket sidecar for the Electron desktop app.

Wraps AngelOneClient so the renderer never touches credentials. Binds to
127.0.0.1 only and requires the shared token that Electron generates at
launch, so nothing else on the machine can drive the trading session.
"""

import asyncio
import datetime as dt
import os
import threading
import time
from collections import defaultdict

import requests
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from angelone_agent import bot as bot_module
from angelone_agent import markets, smc
from angelone_agent.analysis import add_indicators, summarize, to_dataframe
from angelone_agent.client import SCRIP_MASTER_URL, AngelOneClient
from angelone_agent.feed import Broadcaster, LiveFeed

load_dotenv()

AUTH_TOKEN = os.environ.get("SIDECAR_TOKEN", "")

app = FastAPI(title="AngelOne Desk sidecar", docs_url=None, redoc_url=None)

# SmartConnect keeps one session per instance and is not thread-safe; FastAPI
# runs sync endpoints in a threadpool, so every broker call takes this lock.
_api_lock = threading.RLock()
_client = AngelOneClient()
_logged_in = False
_login_error = None

bus = Broadcaster()
live = LiveFeed(_client, bus)


def require_token(x_auth_token: str = Header(default="")):
    if not AUTH_TOKEN or x_auth_token != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="bad token")


# --------------------------------------------------------------------------
# Rate limiting — AngelOne throttles per endpoint and bans on sustained abuse.
# --------------------------------------------------------------------------
_RATE_LIMITS = {"quote": 8.0, "candles": 2.5, "order": 15.0, "book": 1.0}
_last_call = defaultdict(float)
_rate_lock = threading.Lock()


def _throttle(bucket):
    """Block until at least 1/limit seconds have passed since the last call."""
    min_gap = 1.0 / _RATE_LIMITS.get(bucket, 5.0)
    with _rate_lock:
        wait = _last_call[bucket] + min_gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_call[bucket] = time.monotonic()


class _TTLCache:
    def __init__(self, ttl):
        self.ttl = ttl
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._data.get(key)
        if hit and time.monotonic() - hit[0] < self.ttl:
            return hit[1]
        return None

    def put(self, key, value):
        with self._lock:
            self._data[key] = (time.monotonic(), value)


_quote_cache = _TTLCache(2.0)
_candle_cache = _TTLCache(20.0)
_book_cache = _TTLCache(5.0)


# --------------------------------------------------------------------------
# Scrip master — one download, then resolution by symbol / index / contract.
# --------------------------------------------------------------------------
_scrip_rows = None
_scrip_lock = threading.Lock()

FUTURE_TYPES = {"FUTCOM", "FUTSTK", "FUTIDX", "FUTCUR", "FUTIRC", "FUTBAS"}


def scrip_rows():
    global _scrip_rows
    with _scrip_lock:
        if _scrip_rows is None:
            _scrip_rows = requests.get(SCRIP_MASTER_URL, timeout=90).json()
        return _scrip_rows


def resolve_row(symbol, exchange="NSE"):
    """Find the row a user means by a short name.

    Ranked, because names are ambiguous:
      1. cash equity  — "RELIANCE" -> RELIANCE-EQ
      2. index        — "NIFTY" -> the AMXIDX row ("Nifty 50", token 99926000).
                        A bare "NIFTY" row also exists (token 26000) but carries
                        no OHLC and no candle history, so it must not win.
      3. front-month future — "CRUDEOILM" -> CRUDEOILM19AUG26FUT
      4. exact symbol — a fully specified contract the user typed out
    """
    symbol = symbol.upper().strip()
    exchange = (exchange or "NSE").upper()
    today = dt.date.today()

    index = exact = None
    futures = []
    for row in scrip_rows():
        if row.get("exch_seg") != exchange:
            continue
        sym = (row.get("symbol") or "").upper()
        name = (row.get("name") or "").upper()
        itype = row.get("instrumenttype") or ""

        if sym == f"{symbol}-EQ":
            return row  # nothing outranks an exact equity match
        if name == symbol and itype == "AMXIDX" and index is None:
            index = row
        elif name == symbol and itype in FUTURE_TYPES:
            expiry = markets.parse_expiry(row.get("expiry"))
            if expiry and expiry >= today:
                futures.append((expiry, row))
        elif sym == symbol and exact is None:
            exact = row

    if index:
        return index
    if futures:
        return min(futures, key=lambda pair: pair[0])[1]  # nearest live expiry
    if exact:
        return exact
    raise HTTPException(status_code=404, detail=f"No instrument for {symbol} on {exchange}")


def resolve(symbol, exchange="NSE"):
    row = resolve_row(symbol, exchange)
    return row["token"], row["symbol"], (exchange or "NSE").upper()


def ensure_login():
    global _logged_in, _login_error
    with _api_lock:
        if _logged_in:
            return
        try:
            _client.connect()
            _logged_in = True
            _login_error = None
        except Exception as exc:
            _login_error = str(exc)
            raise HTTPException(status_code=502, detail=f"login failed: {exc}")
    live.start()  # streaming feed comes up alongside the REST session


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"ok": True, "logged_in": _logged_in, "login_error": _login_error}


@app.post("/login", dependencies=[Depends(require_token)])
def login():
    ensure_login()
    return {"ok": True, "client_id": _client.client_id}


@app.get("/instrument", dependencies=[Depends(require_token)])
def instrument(symbol: str, exchange: str = "NSE"):
    row = resolve_row(symbol, exchange)
    return {
        "symbol": row["symbol"],
        "name": row.get("name"),
        "token": row["token"],
        "exchange": exchange.upper(),
        "instrument": row.get("instrumenttype") or "EQ",
        "expiry": row.get("expiry") or None,
        "lotsize": int(row.get("lotsize") or 1),
        "market_open": markets.is_open(exchange),
    }


@app.get("/search", dependencies=[Depends(require_token)])
def search(q: str, exchange: str = "NSE", limit: int = 20):
    q = q.upper().strip()
    if len(q) < 2:
        return {"results": []}
    exchange = exchange.upper()
    today = dt.date.today()
    out = []
    for row in scrip_rows():
        if row.get("exch_seg") != exchange:
            continue
        sym = row.get("symbol", "")
        if q not in sym.upper():
            continue
        expiry = markets.parse_expiry(row.get("expiry"))
        if expiry and expiry < today:
            continue  # hide dead contracts
        out.append(
            {
                "symbol": sym,
                "name": row.get("name"),
                "token": row["token"],
                "exchange": exchange,
                "instrument": row.get("instrumenttype") or "EQ",
                "expiry": row.get("expiry") or None,
                "lotsize": int(row.get("lotsize") or 1),
            }
        )
        if len(out) >= limit:
            break
    return {"results": out}


@app.get("/quote", dependencies=[Depends(require_token)])
def quote(symbol: str, exchange: str = "NSE"):
    ensure_login()
    key = (symbol.upper(), exchange.upper())
    cached = _quote_cache.get(key)
    if cached:
        return cached
    token, tsym, exch = resolve(symbol, exchange)
    _throttle("quote")
    with _api_lock:
        resp = _client.get_ltp(exch, tsym, token)
    data = resp.get("data") or {}
    close = data.get("close") or 0
    ltp = data.get("ltp") or 0
    out = {
        "symbol": tsym,
        "token": token,
        "exchange": exch,
        "ltp": ltp,
        "open": data.get("open"),
        "high": data.get("high"),
        "low": data.get("low"),
        "close": close,
        "change": (ltp - close) if close else 0,
        "change_pct": ((ltp - close) / close * 100) if close else 0,
    }
    _quote_cache.put(key, out)
    return out


# Series returned alongside each candle, so the chart can draw them directly.
INDICATOR_COLUMNS = [
    "sma_20",
    "sma_50",
    "ema_9",
    "ema_21",
    "bb_upper",
    "bb_mid",
    "bb_lower",
    "vwap",
    "supertrend",
    "supertrend_dir",
    "rsi",
    "macd",
    "macd_signal",
    "macd_hist",
    "atr",
    "stoch_k",
    "stoch_d",
]


def _num(value):
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


@app.get("/candles", dependencies=[Depends(require_token)])
def candles(symbol: str, exchange: str = "NSE", interval: str = "FIVE_MINUTE"):
    ensure_login()
    key = (symbol.upper(), exchange.upper(), interval)
    cached = _candle_cache.get(key)
    if cached:
        return cached

    token, tsym, exch = resolve(symbol, exchange)
    start, end = markets.session_window(exch)
    _throttle("candles")
    with _api_lock:
        raw = _client.get_historical_data(
            token=token,
            exchange=exch,
            interval=interval,
            from_date=start.strftime("%Y-%m-%d %H:%M"),
            to_date=end.strftime("%Y-%m-%d %H:%M"),
        )
    if not raw:
        return {"symbol": tsym, "token": token, "exchange": exch, "candles": [], "summary": None}

    df = to_dataframe(raw)
    df = add_indicators(df)
    stats = summarize(df)

    rows = []
    for ts, r in df.iterrows():
        row = {
            "time": ts.isoformat(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
        }
        for col in INDICATOR_COLUMNS:
            row[col] = _num(r.get(col))
        rows.append(row)

    day_open = float(df.iloc[0]["open"])
    last = float(df.iloc[-1]["close"])
    out = {
        "symbol": tsym,
        "token": token,
        "exchange": exch,
        "interval": interval,
        "session": start.strftime("%Y-%m-%d"),
        "market_open": markets.is_open(exch),
        "candles": rows,
        "smc": smc.analyse(df),
        "summary": {
            "open": day_open,
            "high": float(df["high"].max()),
            "low": float(df["low"].min()),
            "last": last,
            "change": last - day_open,
            "change_pct": (last - day_open) / day_open * 100 if day_open else 0,
            **{k: v for k, v in stats.items() if k != "last_close"},
            "support": [float(x) for x in stats["support"]],
            "resistance": [float(x) for x in stats["resistance"]],
        },
    }
    _candle_cache.put(key, out)
    return out


def _book(name, fn):
    cached = _book_cache.get(name)
    if cached is not None:
        return cached
    _throttle("book")
    with _api_lock:
        resp = fn()
    data = resp.get("data") or []
    _book_cache.put(name, data)
    return data


@app.get("/positions", dependencies=[Depends(require_token)])
def positions():
    ensure_login()
    rows = _book("positions", _client.get_positions) or []
    total = sum(float(r.get("pnl") or 0) for r in rows)
    return {"positions": rows, "total_pnl": total}


@app.get("/holdings", dependencies=[Depends(require_token)])
def holdings():
    ensure_login()
    data = _book("holdings", _client.get_holdings)
    # SmartAPI returns either a list or {holdings: [...], totalholding: {...}}
    if isinstance(data, dict):
        return {"holdings": data.get("holdings") or [], "totals": data.get("totalholding") or {}}
    return {"holdings": data or [], "totals": {}}


@app.get("/funds", dependencies=[Depends(require_token)])
def funds():
    ensure_login()
    _throttle("book")
    with _api_lock:
        resp = _client.conn.rmsLimit()
    return resp.get("data") or {}


@app.get("/orders", dependencies=[Depends(require_token)])
def orders():
    ensure_login()
    return {"orders": _book("orders", _client.order_book) or []}


@app.get("/trades", dependencies=[Depends(require_token)])
def trades():
    ensure_login()
    return {"trades": _book("trades", _client.trade_book) or []}


class OrderRequest(BaseModel):
    symbol: str
    exchange: str = "NSE"
    side: str = Field(pattern="^(BUY|SELL|buy|sell)$")
    quantity: int = Field(gt=0)
    order_type: str = "MARKET"
    product: str = "INTRADAY"
    price: float = 0
    trigger_price: float = 0


@app.post("/order", dependencies=[Depends(require_token)])
def place_order(req: OrderRequest):
    """Places a real order. Only ever called from an explicit user confirmation
    in the renderer — nothing on this server places orders on its own."""
    ensure_login()
    token, tsym, exch = resolve(req.symbol, req.exchange)
    _throttle("order")
    with _api_lock:
        resp = _client.place_order(
            tradingsymbol=tsym,
            symboltoken=token,
            transactiontype=req.side.upper(),
            quantity=req.quantity,
            exchange=exch,
            ordertype=req.order_type,
            producttype=req.product,
            price=req.price,
            triggerprice=req.trigger_price,
        )
    _book_cache.put("orders", None)
    return {"ok": True, "response": resp}


class CancelRequest(BaseModel):
    order_id: str
    variety: str = "NORMAL"


@app.post("/order/cancel", dependencies=[Depends(require_token)])
def cancel_order(req: CancelRequest):
    ensure_login()
    _throttle("order")
    with _api_lock:
        resp = _client.cancel_order(req.order_id, req.variety)
    _book_cache.put("orders", None)
    return {"ok": True, "response": resp}


# --------------------------------------------------------------------------
# Bot control
# --------------------------------------------------------------------------
_runner = bot_module.BotRunner(
    client=_client,
    api_lock=_api_lock,
    resolve=resolve,
    throttle=_throttle,
    on_event=bus.publish,
)


@app.get("/bot/status", dependencies=[Depends(require_token)])
def bot_status():
    return _runner.status()


@app.post("/bot/start", dependencies=[Depends(require_token)])
def bot_start(cfg: bot_module.BotConfig):
    ensure_login()
    return _runner.start(cfg)


@app.post("/bot/stop", dependencies=[Depends(require_token)])
def bot_stop():
    return _runner.stop()


@app.get("/bot/logs", dependencies=[Depends(require_token)])
def bot_logs(since: int = 0):
    return _runner.logs(since)


@app.get("/bot/strategies", dependencies=[Depends(require_token)])
def bot_strategies():
    return {"strategies": bot_module.STRATEGY_INFO}


# --------------------------------------------------------------------------
# Streaming socket — ticks and bot events, pushed instead of polled.
# --------------------------------------------------------------------------
@app.get("/feed/status", dependencies=[Depends(require_token)])
def feed_status():
    return live.status()


def _as_instrument(item, default_exchange="NSE"):
    """Accept either "NIFTY" or {"symbol": "CRUDEOILM", "exchange": "MCX"}."""
    if isinstance(item, str):
        return item, default_exchange
    return item.get("symbol"), (item.get("exchange") or default_exchange)


async def _ws_receive(ws: WebSocket):
    """Handle subscribe/unsubscribe commands coming from the app."""
    while True:
        msg = await ws.receive_json()
        action = msg.get("action")
        if action not in ("subscribe", "unsubscribe"):
            continue
        default_exch = msg.get("exchange", "NSE")
        for item in msg.get("symbols", []):
            sym, exch = _as_instrument(item, default_exch)
            if not sym:
                continue
            try:
                token, tsym, exch = await asyncio.to_thread(resolve, sym, exch)
            except Exception:
                continue
            if action == "subscribe":
                live.subscribe(token, tsym, exch)
            else:
                live.unsubscribe(token)


async def _ws_send(ws: WebSocket, queue):
    while True:
        await ws.send_json(await queue.get())


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not AUTH_TOKEN or ws.query_params.get("token") != AUTH_TOKEN:
        await ws.close(code=4401)
        return
    await ws.accept()

    bus.attach_loop(asyncio.get_running_loop())
    queue = bus.register()
    try:
        await ws.send_json({"type": "snapshot", "ticks": live.snapshot(), "feed": live.status()})
        recv = asyncio.create_task(_ws_receive(ws))
        send = asyncio.create_task(_ws_send(ws, queue))
        done, pending = await asyncio.wait({recv, send}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    finally:
        bus.unregister(queue)


def main():
    import uvicorn

    port = int(os.environ.get("SIDECAR_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
