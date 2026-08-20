"""HTTP + WebSocket backend for the SmartTrade web app.

Wraps AngelOneClient so the browser never touches broker credentials.
Callers must hold a signed session cookie from /auth/login — see auth.py.
"""

import asyncio
import datetime as dt
import os
import re
import secrets
import threading
import time
from collections import defaultdict

import requests
from dotenv import load_dotenv
from fastapi import (
    Cookie,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from angelone_agent import auth as auth_module
from angelone_agent import bot as bot_module
from angelone_agent import chat as chat_module
from angelone_agent import greeks as greeks_mod
from angelone_agent import markets, smc
from angelone_agent.analysis import add_indicators, summarize, to_dataframe
from angelone_agent.client import SCRIP_MASTER_URL, AngelOneClient
from angelone_agent.feed import Broadcaster, LiveFeed

load_dotenv()

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
SESSION_COOKIE = "smarttrade_session"
WEB_ORIGIN = os.environ.get("WEB_ORIGIN", "http://localhost:5173")

app = FastAPI(title="SmartTrade backend", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[WEB_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SmartConnect keeps one session per instance and is not thread-safe; FastAPI
# runs sync endpoints in a threadpool, so every broker call takes this lock.
_api_lock = threading.RLock()
_client = AngelOneClient()
_logged_in = False
_login_error = None

bus = Broadcaster()
live = LiveFeed(_client, bus)


def require_session(smarttrade_session: str = Cookie(default="")):
    if not auth_module.verify_session(smarttrade_session):
        raise HTTPException(status_code=401, detail="not logged in")


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
class LoginRequest(BaseModel):
    username: str
    password: str


@app.post("/auth/login")
def auth_login(req: LoginRequest, response: Response):
    expected_user = os.environ.get("APP_USERNAME", "")
    stored_hash = os.environ.get("APP_PASSWORD_HASH", "")
    if not expected_user or not stored_hash or req.username != expected_user or not auth_module.verify_password(
        req.password, stored_hash
    ):
        raise HTTPException(status_code=401, detail="invalid username or password")
    token = auth_module.issue_session(req.username)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=auth_module.SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=WEB_ORIGIN.startswith("https://"),
    )
    return {"ok": True, "username": req.username}


@app.post("/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8)


@app.post("/auth/password", dependencies=[Depends(require_session)])
def auth_change_password(req: PasswordChangeRequest):
    """Change the app password from the profile page, proving the current one."""
    stored = os.environ.get("APP_PASSWORD_HASH", "")
    if not stored or not auth_module.verify_password(req.current_password, stored):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")
    new_hash = auth_module.hash_password(req.new_password)
    _write_env_file({"APP_PASSWORD_HASH": new_hash})
    os.environ["APP_PASSWORD_HASH"] = new_hash
    return {"ok": True}


# Reachable while logged out, so it is rate limited per IP.
_reset_limiter = auth_module.AttemptLimiter(max_attempts=5, window=900)


class ResetRequest(BaseModel):
    mpin: str
    new_password: str = Field(min_length=8)


@app.post("/auth/reset")
def auth_reset(req: ResetRequest, request: Request):
    """Reset the app password by proving possession of the broker MPIN."""
    client = request.client.host if request.client else "unknown"

    wait = _reset_limiter.blocked_for(client)
    if wait:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Try again in {wait // 60 + 1} minute(s).",
        )

    if not os.environ.get("ANGELONE_MPIN"):
        raise HTTPException(status_code=400, detail="No MPIN is configured, so it cannot verify you.")

    if not auth_module.verify_mpin(req.mpin):
        _reset_limiter.record_failure(client)
        left = _reset_limiter.remaining(client)
        suffix = f" {left} attempt(s) left." if left else ""
        raise HTTPException(status_code=401, detail=f"Incorrect MPIN.{suffix}")

    username = os.environ.get("APP_USERNAME") or "admin"
    updates = {"APP_USERNAME": username, "APP_PASSWORD_HASH": auth_module.hash_password(req.new_password)}
    env = _read_env_file()
    if not env.get("SESSION_SECRET"):
        updates["SESSION_SECRET"] = secrets.token_hex(32)
    _write_env_file(updates)
    for k, v in updates.items():
        os.environ[k] = v

    _reset_limiter.reset(client)
    return {"ok": True, "username": username}


@app.get("/auth/me")
def auth_me(smarttrade_session: str = Cookie(default="")):
    user = auth_module.verify_session(smarttrade_session)
    if not user:
        raise HTTPException(status_code=401, detail="not logged in")
    return {"username": user}


# --------------------------------------------------------------------------
# Settings — AngelOne broker credentials, edited from the web app
# --------------------------------------------------------------------------
SETTINGS_KEYS = [
    "ANGELONE_API_KEY",
    "ANGELONE_CLIENT_ID",
    "ANGELONE_MPIN",
    "ANGELONE_TOTP_SECRET",
    "GEMINI_API_KEY",
]


def _read_env_file():
    values = {}
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
                if m:
                    values[m.group(1)] = m.group(2)
    return values


def _write_env_file(updates):
    values = _read_env_file()
    values.update(updates)
    text = "\n".join(f"{k}={v}" for k, v in values.items()) + "\n"
    with open(ENV_PATH, "w") as f:
        f.write(text)
    os.chmod(ENV_PATH, 0o600)


class SettingsRequest(BaseModel):
    ANGELONE_API_KEY: str
    ANGELONE_CLIENT_ID: str
    ANGELONE_MPIN: str
    ANGELONE_TOTP_SECRET: str
    GEMINI_API_KEY: str = ""  # optional: only the assistant needs it


@app.get("/settings", dependencies=[Depends(require_session)])
def get_settings():
    env = _read_env_file()
    return {k: env.get(k, "") for k in SETTINGS_KEYS}


@app.post("/settings", dependencies=[Depends(require_session)])
def save_settings(req: SettingsRequest):
    global _client, _logged_in, _login_error
    updates = req.model_dump()
    before = _read_env_file()
    # Re-logging in on every save is what trips AngelOne's rate limiter, so
    # only rebuild the broker session when a broker credential actually moved.
    broker_changed = any(
        k.startswith("ANGELONE_") and before.get(k, "") != v for k, v in updates.items()
    )
    for k, v in updates.items():
        os.environ[k] = v
    _write_env_file(updates)

    if not broker_changed:
        return {"ok": True, "logged_in": _logged_in, "login_error": _login_error}

    _client = AngelOneClient()
    live._client = _client
    _runner._client = _client
    _logged_in = False
    _login_error = None
    try:
        ensure_login()
    except HTTPException:
        pass  # surfaced via /health same as any other login failure
    return {"ok": True, "logged_in": _logged_in, "login_error": _login_error}


# --------------------------------------------------------------------------
# Assistant — Gemini, with the conversation kept server-side
# --------------------------------------------------------------------------
class ChatRequest(BaseModel):
    message: str
    context: dict | None = None  # snapshot of the chart the user is looking at


@app.get("/chat/history", dependencies=[Depends(require_session)])
def chat_history():
    return {"messages": chat_module.store.all(), "configured": bool(os.environ.get("GEMINI_API_KEY"))}


@app.post("/chat", dependencies=[Depends(require_session)])
def chat_send(req: ChatRequest):
    try:
        reply = chat_module.send(req.message, req.context)
    except chat_module.ChatError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"reply": reply, "messages": chat_module.store.all()}


@app.post("/chat/clear", dependencies=[Depends(require_session)])
def chat_clear():
    chat_module.store.clear()
    return {"ok": True}


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
# Last successful candle payload per key, kept all day. AngelOne throttles in
# bursts; serving slightly stale bars beats blanking the chart.
_candle_last_good = _TTLCache(86400.0)


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


def ensure_login(mpin=None):
    """Connects to AngelOne, using `mpin` if given or falling back to .env.
    Only call this from /login (live MPIN entry) or after a Settings save
    (the user just typed fresh credentials there too) — every other route
    must use require_broker() instead, or a stale server restart would let
    background polling silently reconnect with the stored MPIN, bypassing
    the live verification the MPIN gate exists for."""
    global _logged_in, _login_error
    with _api_lock:
        if _logged_in:
            return
        try:
            _client.connect(mpin=mpin)
            _logged_in = True
            _login_error = None
        except Exception as exc:
            _login_error = str(exc)
            raise HTTPException(status_code=502, detail=f"login failed: {exc}")
    live.start()  # streaming feed comes up alongside the REST session


def require_broker():
    """Guards every route except /login and the Settings reconnect: fails
    clean instead of silently establishing a broker session on their behalf."""
    if not _logged_in:
        raise HTTPException(status_code=409, detail="not connected — verify MPIN first")


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "ok": True,
        "logged_in": _logged_in,
        "login_error": _login_error,
        "client_id": _client.client_id if _logged_in else None,
    }


class LoginBrokerRequest(BaseModel):
    mpin: str = Field(min_length=4, max_length=6)


@app.post("/login", dependencies=[Depends(require_session)])
def login(req: LoginBrokerRequest):
    """Requires the user to type their AngelOne MPIN live on every session start —
    it's never read from .env for this call, only used as the fallback for
    internal reconnects (e.g. after a Settings save) that aren't a fresh login."""
    ensure_login(mpin=req.mpin)
    return {"ok": True, "client_id": _client.client_id}


@app.get("/instrument", dependencies=[Depends(require_session)])
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


@app.get("/search", dependencies=[Depends(require_session)])
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


@app.get("/quote", dependencies=[Depends(require_session)])
def quote(symbol: str, exchange: str = "NSE"):
    require_broker()
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


@app.get("/candles", dependencies=[Depends(require_session)])
def candles(symbol: str, exchange: str = "NSE", interval: str = "FIVE_MINUTE", days: int = 1):
    require_broker()
    days = max(1, min(days, 90))
    key = (symbol.upper(), exchange.upper(), interval, days)
    cached = _candle_cache.get(key)
    if cached:
        return cached

    token, tsym, exch = resolve(symbol, exchange)
    start, end = markets.lookback_window(exch, days=days)
    _throttle("candles")
    try:
        with _api_lock:
            raw = _client.get_historical_data(
                token=token,
                exchange=exch,
                interval=interval,
                from_date=start.strftime("%Y-%m-%d %H:%M"),
                to_date=end.strftime("%Y-%m-%d %H:%M"),
            )
    except Exception as exc:
        stale = _candle_last_good.get(key)
        if stale:
            return {**stale, "stale": True, "stale_reason": str(exc)[:200]}
        raise HTTPException(status_code=502, detail=f"could not load candles: {exc}")
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

    prev_high = prev_low = None
    try:
        pstart, pend = markets.previous_session_window(exch)
        _throttle("candles")
        with _api_lock:
            praw = _client.get_historical_data(
                token=token,
                exchange=exch,
                interval="FIFTEEN_MINUTE",
                from_date=pstart.strftime("%Y-%m-%d %H:%M"),
                to_date=pend.strftime("%Y-%m-%d %H:%M"),
            )
        if praw:
            pdf = to_dataframe(praw)
            prev_high = float(pdf["high"].max())
            prev_low = float(pdf["low"].min())
    except Exception:
        pass  # previous-day levels are a nice-to-have, not worth failing the chart over

    out = {
        "symbol": tsym,
        "token": token,
        "exchange": exch,
        "interval": interval,
        "session": start.strftime("%Y-%m-%d")
        if start.date() == end.date()
        else f"{start.strftime('%Y-%m-%d')} → {end.strftime('%Y-%m-%d')}",
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
            "prev_high": prev_high,
            "prev_low": prev_low,
        },
    }
    _candle_cache.put(key, out)
    _candle_last_good.put(key, out)
    return out


# --------------------------------------------------------------------------
# Options — strike chain for the underlying's nearest expiries, with live
# quotes (LTP/OI/volume) and Greeks (delta/gamma/theta/vega/IV) where AngelOne
# has them. Greeks/OI/PCR are populated by AngelOne only during market hours —
# verified live against the API; outside hours the chain still renders with
# strikes and lot sizes, just without those fields.
# --------------------------------------------------------------------------
OPTION_TYPES = {"OPTIDX", "OPTSTK", "OPTFUT", "OPTCUR"}
_chain_cache = _TTLCache(5.0)


@app.get("/options/expiries", dependencies=[Depends(require_session)])
def options_expiries(underlying: str):
    underlying = underlying.upper()
    today = dt.date.today()
    rows = [
        r
        for r in scrip_rows()
        if r.get("name") == underlying and r.get("instrumenttype") in OPTION_TYPES
    ]
    dated = sorted(
        {r["expiry"] for r in rows if markets.parse_expiry(r.get("expiry")) and markets.parse_expiry(r["expiry"]) >= today},
        key=lambda e: markets.parse_expiry(e),
    )
    if not dated:
        raise HTTPException(status_code=404, detail=f"no option chain found for {underlying}")
    return {"underlying": underlying, "expiries": dated[:12]}


@app.get("/options/chain", dependencies=[Depends(require_session)])
def options_chain(underlying: str, expiry: str, exchange: str = "NFO"):
    require_broker()
    underlying = underlying.upper()
    key = (underlying, expiry, exchange)
    cached = _chain_cache.get(key)
    if cached:
        return cached

    rows = [
        r
        for r in scrip_rows()
        if r.get("name") == underlying and r.get("instrumenttype") in OPTION_TYPES and r.get("expiry") == expiry
    ]
    if not rows:
        raise HTTPException(status_code=404, detail="no strikes for that expiry")

    strikes: dict = {}
    for r in rows:
        strike = round(float(r["strike"]) / 100, 2)
        side = "CE" if r["symbol"].endswith("CE") else "PE" if r["symbol"].endswith("PE") else None
        if not side:
            continue
        strikes.setdefault(strike, {})[side] = {
            "token": r["token"],
            "symbol": r["symbol"],
            "lotsize": int(r.get("lotsize") or 1),
        }

    tokens = [v["token"] for pair in strikes.values() for v in pair.values()]
    quotes_by_token = {}
    _throttle("candles")
    try:
        with _api_lock:
            for i in range(0, len(tokens), 50):  # AngelOne caps getMarketData at 50 tokens/call
                chunk = tokens[i : i + 50]
                res = _client.conn.getMarketData("FULL", {exchange: chunk})
                for row in ((res.get("data") or {}).get("fetched") or []):
                    quotes_by_token[str(row.get("symbolToken"))] = row
    except Exception:
        pass  # chain still renders with just strikes/lot sizes if live quotes fail

    greeks_by_symbol = {}
    try:
        with _api_lock:
            gres = _client.conn.optionGreek({"name": underlying, "expirydate": expiry})
        if gres.get("status") and gres.get("data"):
            for g in gres["data"]:
                sym = g.get("tradingSymbol") or g.get("symbol")
                if sym:
                    greeks_by_symbol[sym] = g
    except Exception:
        pass  # Greeks/IV are a nice-to-have, not worth failing the chain over

    # Spot for the local greek solver — the broker's own greeks are usually
    # empty, so IV and the rest are derived from each leg's traded price.
    spot = None
    try:
        spot = float(quote(underlying, "NSE")["ltp"]) or None
    except Exception:
        pass
    expiry_date = markets.parse_expiry(expiry)
    computed_any = False

    out_rows = []
    for strike in sorted(strikes):
        row = {"strike": strike}
        for side in ("CE", "PE"):
            info = strikes[strike].get(side)
            if not info:
                row[side] = None
                continue
            q = quotes_by_token.get(str(info["token"])) or {}
            g = greeks_by_symbol.get(info["symbol"]) or {}
            ltp = _num(q.get("ltp"))

            leg = {
                "iv": _num(g.get("impliedVolatility")),
                "delta": _num(g.get("delta")),
                "gamma": _num(g.get("gamma")),
                "theta": _num(g.get("theta")),
                "vega": _num(g.get("vega")),
            }
            if leg["delta"] is None and spot and expiry_date and ltp:
                local = greeks_mod.solve(ltp, spot, strike, expiry_date, side == "CE")
                if local["delta"] is not None:
                    leg = local
                    computed_any = True

            row[side] = {
                "symbol": info["symbol"],
                "token": info["token"],
                "lotsize": info["lotsize"],
                "ltp": ltp,
                "change_pct": _num(q.get("percentChange")),
                "oi": _num(q.get("opnInterest")),
                "volume": _num(q.get("tradeVolume")),
                **leg,
            }
        out_rows.append(row)

    out = {
        "underlying": underlying,
        "expiry": expiry,
        "exchange": exchange,
        "spot": spot,
        "greeks_source": "computed" if computed_any else "broker",
        "rows": out_rows,
    }
    _chain_cache.put(key, out)
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


@app.get("/positions", dependencies=[Depends(require_session)])
def positions():
    require_broker()
    rows = _book("positions", _client.get_positions) or []
    total = sum(float(r.get("pnl") or 0) for r in rows)
    return {"positions": rows, "total_pnl": total}


class ExitPositionRequest(BaseModel):
    tradingsymbol: str
    symboltoken: str
    exchange: str
    producttype: str = "INTRADAY"
    quantity: int = Field(gt=0)
    side: str = Field(pattern="^(BUY|SELL)$")  # the side that FLATTENS the position, not the original side


@app.post("/positions/exit", dependencies=[Depends(require_session)])
def exit_position(req: ExitPositionRequest):
    """Square off one open position at market. Used by the fast-exit button on
    each position row — still goes through the same confirm modal as any
    order, just pre-filled so exiting a scalp is a single extra click."""
    require_broker()
    _throttle("order")
    with _api_lock:
        resp = _client.place_order(
            tradingsymbol=req.tradingsymbol,
            symboltoken=req.symboltoken,
            transactiontype=req.side,
            quantity=req.quantity,
            exchange=req.exchange,
            ordertype="MARKET",
            producttype=req.producttype,
        )
    _book_cache.put("orders", None)
    _book_cache.put("positions", None)
    return {"ok": True, "response": resp}


@app.post("/positions/square-off-all", dependencies=[Depends(require_session)])
def square_off_all():
    """Flattens every open position at market — the scalping panic button."""
    require_broker()
    rows = _book("positions", _client.get_positions) or []
    results = []
    for r in rows:
        qty = int(float(r.get("netqty") or 0))
        if qty == 0:
            continue
        side = "SELL" if qty > 0 else "BUY"
        _throttle("order")
        try:
            with _api_lock:
                resp = _client.place_order(
                    tradingsymbol=r.get("tradingsymbol"),
                    symboltoken=r.get("symboltoken"),
                    transactiontype=side,
                    quantity=abs(qty),
                    exchange=r.get("exchange", "NSE"),
                    ordertype="MARKET",
                    producttype=r.get("producttype", "INTRADAY"),
                )
            results.append({"symbol": r.get("tradingsymbol"), "ok": True, "response": resp})
        except Exception as exc:
            results.append({"symbol": r.get("tradingsymbol"), "ok": False, "error": str(exc)})
    _book_cache.put("orders", None)
    _book_cache.put("positions", None)
    return {"ok": True, "results": results}


@app.get("/holdings", dependencies=[Depends(require_session)])
def holdings():
    require_broker()
    data = _book("holdings", _client.get_holdings)
    # SmartAPI returns either a list or {holdings: [...], totalholding: {...}}
    if isinstance(data, dict):
        return {"holdings": data.get("holdings") or [], "totals": data.get("totalholding") or {}}
    return {"holdings": data or [], "totals": {}}


@app.get("/funds", dependencies=[Depends(require_session)])
def funds():
    require_broker()
    _throttle("book")
    with _api_lock:
        resp = _client.conn.rmsLimit()
    return resp.get("data") or {}


@app.get("/orders", dependencies=[Depends(require_session)])
def orders():
    require_broker()
    return {"orders": _book("orders", _client.order_book) or []}


@app.get("/trades", dependencies=[Depends(require_session)])
def trades():
    require_broker()
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


@app.post("/order", dependencies=[Depends(require_session)])
def place_order(req: OrderRequest):
    """Places a real order. Only ever called from an explicit user confirmation
    in the renderer — nothing on this server places orders on its own."""
    require_broker()
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


@app.post("/order/cancel", dependencies=[Depends(require_session)])
def cancel_order(req: CancelRequest):
    require_broker()
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


@app.get("/bot/status", dependencies=[Depends(require_session)])
def bot_status():
    return _runner.status()


@app.post("/bot/start", dependencies=[Depends(require_session)])
def bot_start(cfg: bot_module.BotConfig):
    require_broker()
    return _runner.start(cfg)


@app.post("/bot/stop", dependencies=[Depends(require_session)])
def bot_stop():
    return _runner.stop()


@app.get("/bot/logs", dependencies=[Depends(require_session)])
def bot_logs(since: int = 0):
    return _runner.logs(since)


@app.get("/bot/strategies", dependencies=[Depends(require_session)])
def bot_strategies():
    return {"strategies": bot_module.STRATEGY_INFO}


# --------------------------------------------------------------------------
# Streaming socket — ticks and bot events, pushed instead of polled.
# --------------------------------------------------------------------------
@app.get("/feed/status", dependencies=[Depends(require_session)])
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
    if not auth_module.verify_session(ws.cookies.get(SESSION_COOKIE, "")):
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
