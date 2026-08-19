import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.client import AngelOneClient

load_dotenv()

filter_term = sys.argv[1].upper() if len(sys.argv) > 1 else None

client = AngelOneClient()
client.connect()

positions = client.get_positions()
holdings = client.get_holdings()

pos_data = (positions or {}).get("data") or []
hold_data = (holdings or {}).get("data") or []

if filter_term:
    pos_data = [p for p in pos_data if filter_term in (p.get("tradingsymbol") or "").upper()]
    hold_data = [h for h in hold_data if filter_term in (h.get("tradingsymbol") or "").upper()]

print("=== Positions ===")
if not pos_data:
    print("No matching open positions.")
for p in pos_data:
    print(
        f"{p.get('tradingsymbol')} | {p.get('producttype')} | "
        f"qty: {p.get('netqty')} | avg: {p.get('avgnetprice')} | "
        f"ltp: {p.get('ltp')} | pnl: {p.get('pnl')}"
    )

print("\n=== Holdings ===")
if not hold_data:
    print("No matching holdings.")
for h in hold_data:
    print(
        f"{h.get('tradingsymbol')} | qty: {h.get('quantity')} | "
        f"avg: {h.get('averageprice')} | ltp: {h.get('ltp')} | "
        f"pnl: {h.get('profitandloss')}"
    )
