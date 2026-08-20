"""Password hashing and signed session cookies for the web app's login.

Single-user app, so this is intentionally minimal: PBKDF2 for the password
(stdlib, no bcrypt dependency) and an HMAC-signed, expiring cookie for the
session (stdlib, no JWT library). Both live only in this module so the rest
of the app just calls hash/verify/issue/verify_session.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

PBKDF2_ITERATIONS = 260_000
SESSION_MAX_AGE = 7 * 24 * 3600  # 7 days


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    if not stored_hash or "$" not in stored_hash:
        return False
    salt_hex, digest_hex = stored_hash.split("$", 1)
    salt = bytes.fromhex(salt_hex)
    expected = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return hmac.compare_digest(expected.hex(), digest_hex)


class AttemptLimiter:
    """Fixed-window attempt limiter, keyed by client IP.

    The MPIN is short enough to brute-force, and the reset route has to be
    reachable while logged out, so it gets a hard cap instead of relying on
    the secret's own strength.
    """

    def __init__(self, max_attempts: int = 5, window: int = 900):
        self.max_attempts = max_attempts
        self.window = window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> list[float]:
        recent = [t for t in self._hits.get(key, []) if now - t < self.window]
        self._hits[key] = recent
        return recent

    def blocked_for(self, key: str) -> int:
        """Seconds until this key may try again, or 0 if it may try now."""
        now = time.time()
        with self._lock:
            recent = self._prune(key, now)
            if len(recent) < self.max_attempts:
                return 0
            return int(self.window - (now - min(recent))) + 1

    def remaining(self, key: str) -> int:
        """Attempts left in the current window."""
        with self._lock:
            used = len(self._prune(key, time.time()))
        return max(0, self.max_attempts - used)

    def record_failure(self, key: str) -> None:
        with self._lock:
            now = time.time()
            self._prune(key, now)
            self._hits.setdefault(key, []).append(now)

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


def verify_mpin(supplied: str) -> bool:
    """Constant-time check against the broker MPIN held in the environment."""
    expected = os.environ.get("ANGELONE_MPIN", "")
    if not expected or not supplied:
        return False
    return hmac.compare_digest(str(supplied).strip(), expected.strip())


def _secret() -> bytes:
    key = os.environ.get("SESSION_SECRET", "")
    if not key:
        raise RuntimeError("SESSION_SECRET is not set")
    return key.encode()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def issue_session(username: str) -> str:
    payload = json.dumps({"user": username, "exp": time.time() + SESSION_MAX_AGE}).encode()
    sig = hmac.new(_secret(), payload, hashlib.sha256).digest()
    return f"{_b64(payload)}.{_b64(sig)}"


def verify_session(token: str) -> str | None:
    """Returns the username if the token is valid and unexpired, else None."""
    try:
        payload_b64, sig_b64 = token.split(".", 1)
        payload = _unb64(payload_b64)
        sig = _unb64(sig_b64)
    except Exception:
        return None
    expected_sig = hmac.new(_secret(), payload, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    data = json.loads(payload)
    if data.get("exp", 0) < time.time():
        return None
    return data.get("user")
