"""Exchange trading hours and contract-expiry helpers.

Equity and commodity sessions differ by hours, so anything that asks for
"today's session" has to ask per exchange — MCX crude runs to 23:30 while NSE
closes at 15:30.
"""

import datetime as dt

# exchange -> (open, close) in IST
SESSIONS = {
    "NSE": (dt.time(9, 15), dt.time(15, 30)),
    "BSE": (dt.time(9, 15), dt.time(15, 30)),
    "NFO": (dt.time(9, 15), dt.time(15, 30)),
    "BFO": (dt.time(9, 15), dt.time(15, 30)),
    "CDS": (dt.time(9, 0), dt.time(17, 0)),
    "MCX": (dt.time(9, 0), dt.time(23, 30)),
}

DEFAULT_SESSION = (dt.time(9, 15), dt.time(15, 30))


def session_times(exchange="NSE"):
    return SESSIONS.get((exchange or "NSE").upper(), DEFAULT_SESSION)


def session_window(exchange="NSE", now=None):
    """Return (start, end) datetimes covering the current or most recent session.

    Before the open we fall back to the previous weekday, so the app always has
    a session to draw instead of an empty chart.
    """
    now = now or dt.datetime.now()
    open_t, close_t = session_times(exchange)
    start = now.replace(hour=open_t.hour, minute=open_t.minute, second=0, microsecond=0)
    end = now.replace(hour=close_t.hour, minute=close_t.minute, second=0, microsecond=0)

    if now < start:
        prev = start - dt.timedelta(days=1)
        while prev.weekday() >= 5:
            prev -= dt.timedelta(days=1)
        return prev, prev.replace(hour=close_t.hour, minute=close_t.minute)
    return start, min(now, end)


def lookback_window(exchange="NSE", now=None, days=1):
    """Return (start, end) spanning the last `days` trading days up to the
    current/most-recent session — start is the open time `days` trading days
    back (skipping weekends), end is session_window's usual end.
    """
    now = now or dt.datetime.now()
    _, end = session_window(exchange, now)
    open_t = session_times(exchange)[0]

    cursor = end
    remaining = max(1, days)
    while remaining > 1:
        cursor -= dt.timedelta(days=1)
        if cursor.weekday() < 5:
            remaining -= 1
    start = cursor.replace(hour=open_t.hour, minute=open_t.minute, second=0, microsecond=0)
    return start, end


def previous_session_window(exchange="NSE", now=None):
    """Return (start, end) for the trading day before the one session_window gives."""
    now = now or dt.datetime.now()
    start, _ = session_window(exchange, now)
    prev = start - dt.timedelta(days=1)
    while prev.weekday() >= 5:
        prev -= dt.timedelta(days=1)
    open_t, close_t = session_times(exchange)
    prev_start = prev.replace(hour=open_t.hour, minute=open_t.minute, second=0, microsecond=0)
    prev_end = prev.replace(hour=close_t.hour, minute=close_t.minute, second=0, microsecond=0)
    return prev_start, prev_end


def is_open(exchange="NSE", now=None):
    now = now or dt.datetime.now()
    if now.weekday() >= 5:
        return False
    open_t, close_t = session_times(exchange)
    return open_t <= now.time() <= close_t


def default_square_off(exchange="NSE"):
    """Fifteen minutes before the close — a sane intraday flat-by time."""
    _, close_t = session_times(exchange)
    close_dt = dt.datetime(2000, 1, 1, close_t.hour, close_t.minute) - dt.timedelta(minutes=15)
    return close_dt.strftime("%H:%M")


def parse_expiry(value):
    """'19AUG2026' -> date. Returns None when the row has no expiry."""
    if not value:
        return None
    try:
        return dt.datetime.strptime(value.strip(), "%d%b%Y").date()
    except ValueError:
        return None
