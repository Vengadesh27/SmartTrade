import datetime as dt
import functools
import json
import logging
import os

import logzero
import pyotp
import requests
from SmartApi import SmartConnect

# The SmartApi SDK logs full request/response (including password, TOTP, and
# API key headers) at ERROR level when a login call fails. Silence it so
# credentials never get echoed to stdout/stderr.
logzero.loglevel(logging.CRITICAL)

SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"

SESSION_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "broker_session.json"
)
# AngelOne refresh tokens are day-scoped; past this we make the user re-verify
# rather than sit on a token the broker will reject anyway.
SESSION_MAX_AGE_HOURS = 12


class AngelOneClient:
    def __init__(self):
        self.api_key = os.environ["ANGELONE_API_KEY"]
        self.client_id = os.environ["ANGELONE_CLIENT_ID"]
        self.mpin = os.environ["ANGELONE_MPIN"]
        self.totp_secret = os.environ["ANGELONE_TOTP_SECRET"]
        self._conn = None

    def connect(self, mpin=None):
        """mpin defaults to the one in .env; pass one explicitly to require the
        user to re-enter and verify it live instead of trusting the stored value."""
        conn = SmartConnect(api_key=self.api_key)
        otp = pyotp.TOTP(self.totp_secret).now()
        result = conn.generateSession(self.client_id, mpin or self.mpin, otp)
        if not result.get("status"):
            raise RuntimeError(f"AngelOne login failed: {result.get('message')}")
        self._conn = conn
        self.save_session()
        return conn

    # ------------------------------------------------------------------
    # Session persistence — lets a backend restart resume without a fresh MPIN
    # ------------------------------------------------------------------
    def save_session(self):
        """Persist the broker tokens so a restart can resume the session.

        Written 0600 into data/ (gitignored). These tokens grant full access to
        the trading account for the rest of the day — treat the file like a
        credential.
        """
        conn = self._conn
        if not conn:
            return
        payload = {
            "client_id": self.client_id,
            "api_key": self.api_key,
            "access_token": getattr(conn, "access_token", None),
            "refresh_token": getattr(conn, "refresh_token", None),
            "feed_token": getattr(conn, "feed_token", None),
            "saved_at": dt.datetime.now().isoformat(timespec="seconds"),
        }
        if not payload["refresh_token"]:
            return
        os.makedirs(os.path.dirname(SESSION_PATH), exist_ok=True)
        tmp = f"{SESSION_PATH}.tmp"
        with open(tmp, "w") as f:
            json.dump(payload, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, SESSION_PATH)

    def _load_session(self):
        try:
            with open(SESSION_PATH) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        # Credentials may have been changed in Settings since this was written.
        if data.get("client_id") != self.client_id or data.get("api_key") != self.api_key:
            return None
        try:
            age = dt.datetime.now() - dt.datetime.fromisoformat(data["saved_at"])
        except (KeyError, ValueError):
            return None
        if age > dt.timedelta(hours=SESSION_MAX_AGE_HOURS):
            return None
        return data if data.get("refresh_token") else None

    def resume(self):
        """Rebuild the session from saved tokens. True if the broker accepted it.

        Never raises — a failed resume just means the MPIN gate is shown.
        """
        data = self._load_session()
        if not data:
            return False
        try:
            conn = SmartConnect(api_key=self.api_key)
            conn.setUserId(self.client_id)
            conn.setAccessToken(data["access_token"])
            conn.setRefreshToken(data["refresh_token"])
            conn.setFeedToken(data.get("feed_token"))
            # Exchanging the refresh token both renews the JWT and proves the
            # saved session is still good.
            result = conn.generateToken(data["refresh_token"])
            if not result or not result.get("status"):
                return False
            self._conn = conn
            self.save_session()
            return True
        except Exception:
            return False

    def clear_session(self):
        try:
            os.remove(SESSION_PATH)
        except OSError:
            pass

    @property
    def conn(self):
        if self._conn is None:
            self.connect()
        return self._conn

    @functools.lru_cache(maxsize=1)
    def _scrip_master(self):
        return requests.get(SCRIP_MASTER_URL, timeout=30).json()

    def find_token(self, symbol, exch_seg="NSE"):
        symbol = symbol.upper()
        for row in self._scrip_master():
            if row.get("exch_seg") == exch_seg and row.get("symbol", "").upper() in (
                symbol,
                f"{symbol}-EQ",
            ):
                return row["token"], row["symbol"]
        raise ValueError(f"No token found for {symbol} on {exch_seg}")

    def find_index_token(self, name, exch_seg="NSE"):
        name = name.upper()
        for row in self._scrip_master():
            if row.get("exch_seg") == exch_seg and row.get("instrumenttype") == "AMXIDX" \
                    and row.get("name", "").upper() == name:
                return row["token"], row["symbol"]
        raise ValueError(f"No index token found for {name} on {exch_seg}")

    def get_historical_data(self, token, exchange, interval, from_date, to_date):
        params = {
            "exchange": exchange,
            "symboltoken": token,
            "interval": interval,
            "fromdate": from_date,
            "todate": to_date,
        }
        resp = self.conn.getCandleData(params)
        return resp["data"]

    def get_holdings(self):
        return self.conn.holding()

    def get_positions(self):
        return self.conn.position()

    def get_ltp(self, exchange, symbol, token):
        return self.conn.ltpData(exchange, symbol, token)

    def place_order(
        self,
        *,
        tradingsymbol,
        symboltoken,
        transactiontype,
        quantity,
        exchange="NSE",
        ordertype="MARKET",
        producttype="INTRADAY",
        duration="DAY",
        price=0,
        triggerprice=0,
        variety="NORMAL",
    ):
        """Place a live order. transactiontype: BUY/SELL. You call this yourself —
        it is never invoked automatically by the agent."""
        params = {
            "variety": variety,
            "tradingsymbol": tradingsymbol,
            "symboltoken": symboltoken,
            "transactiontype": transactiontype.upper(),
            "exchange": exchange,
            "ordertype": ordertype,
            "producttype": producttype,
            "duration": duration,
            "price": price,
            "triggerprice": triggerprice,
            "quantity": quantity,
        }
        return self.conn.placeOrder(params)

    def modify_order(self, *, order_id, **kwargs):
        params = {"orderid": order_id, "variety": kwargs.pop("variety", "NORMAL"), **kwargs}
        return self.conn.modifyOrder(params)

    def cancel_order(self, order_id, variety="NORMAL"):
        return self.conn.cancelOrder(order_id, variety)

    def order_book(self):
        return self.conn.orderBook()

    def trade_book(self):
        return self.conn.tradeBook()
