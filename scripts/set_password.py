"""Set (or reset) the web app's login password.

Run with: python scripts/set_password.py
Prompts for a username and password, writes APP_USERNAME and
APP_PASSWORD_HASH into .env. Also ensures SESSION_SECRET exists.
"""

import getpass
import re
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from angelone_agent.auth import hash_password

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def read_env():
    values = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m:
                values[m.group(1)] = m.group(2)
    return values


def write_env(values):
    text = "\n".join(f"{k}={v}" for k, v in values.items()) + "\n"
    ENV_PATH.write_text(text)
    ENV_PATH.chmod(0o600)


def main():
    username = input("Username: ").strip()
    if not username:
        print("Username cannot be empty.")
        sys.exit(1)
    password = getpass.getpass("Password: ")
    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords do not match.")
        sys.exit(1)
    if len(password) < 8:
        print("Use at least 8 characters.")
        sys.exit(1)

    values = read_env()
    values["APP_USERNAME"] = username
    values["APP_PASSWORD_HASH"] = hash_password(password)
    if not values.get("SESSION_SECRET"):
        values["SESSION_SECRET"] = secrets.token_hex(32)
    write_env(values)
    print(f"Saved. {username} can now log in to the web app.")


if __name__ == "__main__":
    main()
