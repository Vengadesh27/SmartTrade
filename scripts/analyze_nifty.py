import datetime as dt
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.client import AngelOneClient
from angelone_agent.analysis import to_dataframe, add_moving_averages, add_rsi, summarize

load_dotenv()

client = AngelOneClient()
token, symbol = client.find_index_token("NIFTY")

to_date = dt.datetime.now()
from_date = to_date - dt.timedelta(days=365)

candles = client.get_historical_data(
    token=token,
    exchange="NSE",
    interval="ONE_DAY",
    from_date=from_date.strftime("%Y-%m-%d %H:%M"),
    to_date=to_date.strftime("%Y-%m-%d %H:%M"),
)

df = to_dataframe(candles)
df = add_moving_averages(df)
df = add_rsi(df)

result = summarize(df)

print(f"{symbol} — last close: {result['last_close']:.2f}")
print(f"Trend: {result['trend']}")
print(f"RSI: {result['rsi']:.1f} ({result['rsi_note']})")
print(f"Support levels: {result['support']}")
print(f"Resistance levels: {result['resistance']}")
