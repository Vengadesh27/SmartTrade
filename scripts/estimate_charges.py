import json
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.client import AngelOneClient

load_dotenv()

client = AngelOneClient()
client.connect()

params = {
    "orders": [
        {
            "product_type": "INTRADAY",
            "transaction_type": "BUY",
            "quantity": "65",
            "exchange": "NFO",
            "price": "56.15",
            "symbol_name": "NIFTY04AUG2624600CE",
            "token": "65871",
        }
    ]
}

result = client.conn.estimateCharges(params)
print(json.dumps(result, indent=2))
