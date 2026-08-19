import logging
import os
import functools

import logzero
import pyotp
import requests
from SmartApi import SmartConnect

# The SmartApi SDK logs full request/response (including password, TOTP, and
# API key headers) at ERROR level when a login call fails. Silence it so
# credentials never get echoed to stdout/stderr.
logzero.loglevel(logging.CRITICAL)

SCRIP_MASTER_URL = "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json"


class AngelOneClient:
    def __init__(self):
        self.api_key = os.environ["ANGELONE_API_KEY"]
        self.client_id = os.environ["ANGELONE_CLIENT_ID"]
        self.mpin = os.environ["ANGELONE_MPIN"]
        self.totp_secret = os.environ["ANGELONE_TOTP_SECRET"]
        self._conn = None

    def connect(self):
        conn = SmartConnect(api_key=self.api_key)
        otp = pyotp.TOTP(self.totp_secret).now()
        result = conn.generateSession(self.client_id, self.mpin, otp)
        if not result.get("status"):
            raise RuntimeError(f"AngelOne login failed: {result.get('message')}")
        self._conn = conn
        return conn

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
