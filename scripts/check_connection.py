import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.client import AngelOneClient

load_dotenv()

required = ["ANGELONE_API_KEY", "ANGELONE_CLIENT_ID", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET"]
import os

missing = [k for k in required if not os.environ.get(k)]
if missing:
    print(f"FAIL: missing values in .env for: {', '.join(missing)}")
    sys.exit(1)

try:
    client = AngelOneClient()
    client.connect()
    print("OK: connected to AngelOne SmartAPI successfully.")
except Exception as e:
    print(f"FAIL: could not connect — {type(e).__name__}: {e}")
    sys.exit(1)
