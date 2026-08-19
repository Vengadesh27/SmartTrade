import datetime as dt
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.client import AngelOneClient
from angelone_agent.analysis import to_dataframe, add_moving_averages, add_rsi, summarize

load_dotenv()

client = AngelOneClient()

INDICES = ["NIFTY", "BANKNIFTY"]

now = dt.datetime.now()
market_open = now.replace(hour=9, minute=15, second=0, microsecond=0)
from_date = market_open
to_date = now

for i, name in enumerate(INDICES):
    if i > 0:
        time.sleep(1.5)
    token, symbol = client.find_index_token(name)
    for attempt in range(3):
        try:
            candles = client.get_historical_data(
                token=token,
                exchange="NSE",
                interval="FIVE_MINUTE",
                from_date=from_date.strftime("%Y-%m-%d %H:%M"),
                to_date=to_date.strftime("%Y-%m-%d %H:%M"),
            )
            break
        except Exception as e:
            if attempt == 2:
                raise
            time.sleep(3)

    if not candles:
        print(f"{symbol} — no data yet for today")
        continue

    df = to_dataframe(candles)
    day_open = df.iloc[0]["open"]
    day_high = df["high"].max()
    day_low = df["low"].min()
    last_close = df.iloc[-1]["close"]
    change = last_close - day_open
    pct = (change / day_open) * 100

    df = add_moving_averages(df, windows=(20, 50))
    df = add_rsi(df)
    result = summarize(df)

    print(f"\n=== {symbol} (intraday, {from_date.strftime('%Y-%m-%d')}) ===")
    print(f"Open: {day_open:.2f}  High: {day_high:.2f}  Low: {day_low:.2f}  Last: {last_close:.2f}")
    print(f"Change from open: {change:+.2f} ({pct:+.2f}%)")
    print(f"Intraday trend (vs 50-period SMA): {result['trend']}")
    if result['rsi'] is not None:
        print(f"RSI(14, 5m): {result['rsi']:.1f} ({result['rsi_note']})")
    print(f"Support levels: {result['support']}")
    print(f"Resistance levels: {result['resistance']}")
