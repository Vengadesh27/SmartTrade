"""Live market data over AngelOne's SmartWebSocketV2, plus a small fan-out bus.

The broker socket runs on its own thread inside the sidecar. Ticks (and bot
events) are pushed onto asyncio queues so the FastAPI /ws endpoint can stream
them to Electron without anyone polling.
"""

import asyncio
import logging
import threading

from SmartApi.smartWebSocketV2 import SmartWebSocketV2

log = logging.getLogger("feed")

EXCHANGE_TYPE = {"NSE": 1, "NFO": 2, "BSE": 3, "BFO": 4, "MCX": 5, "CDS": 13}
# Feed prices arrive as integers scaled by 100 (paise) for these segments.
PRICE_DIVISOR = 100.0


class Broadcaster:
    """Fan-out to every connected renderer socket. Publishing is thread-safe."""

    def __init__(self):
        self._queues = set()
        self._loop = None
        self._lock = threading.Lock()

    def attach_loop(self, loop):
        self._loop = loop

    def register(self):
        q = asyncio.Queue(maxsize=1000)
        with self._lock:
            self._queues.add(q)
        return q

    def unregister(self, q):
        with self._lock:
            self._queues.discard(q)

    def publish(self, message):
        """Callable from any thread."""
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        with self._lock:
            targets = list(self._queues)
        for q in targets:
            try:
                loop.call_soon_threadsafe(q.put_nowait, message)
            except (RuntimeError, asyncio.QueueFull):
                pass


class LiveFeed:
    def __init__(self, client, broadcaster):
        self._client = client
        self.bus = broadcaster
        self._sws = None
        self._thread = None
        self._lock = threading.Lock()
        self._subs = {}  # token -> {"symbol", "exchange_type"}
        self._latest = {}  # token -> normalized tick
        self.connected = False
        self.error = None

    # ------------------------------------------------------------------
    def start(self):
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            conn = self._client.conn  # forces login if needed
            self._sws = SmartWebSocketV2(
                auth_token=conn.access_token,
                api_key=self._client.api_key,
                client_code=self._client.client_id,
                feed_token=conn.feed_token,
                max_retry_attempt=5,
                retry_strategy=0,
                retry_delay=5,
            )
            self._sws.on_open = self._on_open
            self._sws.on_data = self._on_data
            self._sws.on_error = self._on_error
            self._sws.on_close = self._on_close

            self._thread = threading.Thread(target=self._run, daemon=True)
            self._thread.start()

    def _run(self):
        try:
            self._sws.connect()
        except Exception as exc:  # the socket thread must never take the app down
            self.error = str(exc)
            self.connected = False
            self.bus.publish({"type": "feed", "status": "error", "detail": str(exc)})

    # ------------------------------------------------------------------
    def _on_open(self, _wsapp):
        self.connected = True
        self.error = None
        self.bus.publish({"type": "feed", "status": "connected"})
        # Re-arm every subscription — this also covers automatic reconnects.
        with self._lock:
            subs = dict(self._subs)
        by_exch = {}
        for token, meta in subs.items():
            by_exch.setdefault(meta["exchange_type"], []).append(token)
        for exch_type, tokens in by_exch.items():
            self._send_subscribe(exch_type, tokens)

    def _on_close(self, _wsapp):
        self.connected = False
        self.bus.publish({"type": "feed", "status": "disconnected"})

    def _on_error(self, _wsapp, error):
        self.error = str(error)
        self.bus.publish({"type": "feed", "status": "error", "detail": str(error)})

    def _on_data(self, _wsapp, message):
        try:
            tick = self._normalize(message)
        except Exception:
            return
        if tick is None:
            return
        with self._lock:
            prev = self._latest.get(tick["token"], {})
            # LTP-only packets must not blank out OHLC from an earlier quote packet.
            merged = {**prev, **{k: v for k, v in tick.items() if v is not None}}
            self._latest[tick["token"]] = merged
        self.bus.publish({"type": "tick", **merged})

    def _normalize(self, m):
        token = str(m.get("token") or "").strip()
        if not token:
            return None
        with self._lock:
            meta = self._subs.get(token)
        ltp = m.get("last_traded_price")
        if ltp is None:
            return None
        ltp = ltp / PRICE_DIVISOR

        def px(key):
            v = m.get(key)
            return None if v is None else v / PRICE_DIVISOR

        close = px("closed_price")
        change = (ltp - close) if close else None
        return {
            "token": token,
            "symbol": meta["symbol"] if meta else token,
            "ltp": ltp,
            "open": px("open_price_of_the_day"),
            "high": px("high_price_of_the_day"),
            "low": px("low_price_of_the_day"),
            "close": close,
            "change": change,
            "change_pct": (change / close * 100) if (close and change is not None) else None,
            "volume": m.get("volume_trade_for_the_day"),
            "ts": m.get("exchange_timestamp"),
        }

    # ------------------------------------------------------------------
    def _send_subscribe(self, exch_type, tokens):
        try:
            self._sws.subscribe(
                "desk", SmartWebSocketV2.QUOTE, [{"exchangeType": exch_type, "tokens": list(tokens)}]
            )
        except Exception as exc:
            log.warning("subscribe failed: %s", exc)

    def subscribe(self, token, symbol, exchange="NSE"):
        token = str(token)
        exch_type = EXCHANGE_TYPE.get(exchange.upper(), 1)
        with self._lock:
            if token in self._subs:
                return
            self._subs[token] = {"symbol": symbol, "exchange_type": exch_type}
        if self.connected:
            self._send_subscribe(exch_type, [token])

    def unsubscribe(self, token):
        token = str(token)
        with self._lock:
            meta = self._subs.pop(token, None)
            self._latest.pop(token, None)
        if meta and self.connected:
            try:
                self._sws.unsubscribe(
                    "desk",
                    SmartWebSocketV2.QUOTE,
                    [{"exchangeType": meta["exchange_type"], "tokens": [token]}],
                )
            except Exception as exc:
                log.warning("unsubscribe failed: %s", exc)

    def snapshot(self):
        with self._lock:
            return list(self._latest.values())

    def status(self):
        with self._lock:
            n = len(self._subs)
        return {"connected": self.connected, "subscriptions": n, "error": self.error}

    def stop(self):
        try:
            if self._sws:
                self._sws.close_connection()
        except Exception:
            pass
        self.connected = False
