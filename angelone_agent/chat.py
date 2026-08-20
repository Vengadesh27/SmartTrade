"""Gemini-backed assistant with a persisted conversation.

History lives in a JSON file next to the project so it survives restarts, and
is sent back to Gemini on every turn — the API is stateless, so the whole
conversation is the context.
"""

import datetime as dt
import json
import os
import threading
import uuid

import requests

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
HISTORY_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "chat_history.json"
)

# Keep the request bounded: only the most recent turns are replayed.
MAX_TURNS = 40
MAX_MESSAGE_CHARS = 8000

SYSTEM_INSTRUCTION = """You are the trading assistant inside SmartTrade, an intraday desk for the
Indian markets (NSE and MCX) built on AngelOne SmartAPI. The user is an intraday trader who
follows NIFTY and Crude Oil Mini.

Most turns include a CURRENT CHART block: a live snapshot of exactly what the user is looking at
— symbol, timeframe, the latest bar, every indicator value, support/resistance, previous-day
levels and the smart-money-concept state. Treat it as ground truth and analyse it directly.
Refer to real numbers from it; never invent levels or claim you cannot see the chart when a
snapshot is present.

How to answer:
- Lead with the read: trend, structure and where price sits in the range.
- Cite the specific evidence — which indicators agree, which conflict, and the exact levels that
  matter. Confluence and contradiction are both worth naming.
- Give both scenarios. State what would confirm the bullish case and what would invalidate it,
  with the price levels that decide each.
- Always attach risk: invalidation level, rough R:R, and how position size follows from the stop
  distance. Note when ATR says the stop is wide relative to normal movement.
- Flag data quality problems: too few bars for a 50-period average, VWAP absent on an index,
  indicators still warming up, or a stale session.
- Be concise and concrete. Short paragraphs and tight bullets, numbers over adjectives.

You are an analyst, not a licensed adviser, and you cannot place orders. Explain what the data
supports and the trade-offs involved rather than instructing the user to buy or sell; if asked
outright for a call, give the balanced read and say the decision and sizing are theirs."""


def format_context(ctx: dict) -> str:
    """Render the chart snapshot as a compact, readable block for the model."""
    if not ctx:
        return ""

    def num(v):
        if v is None:
            return "n/a"
        if isinstance(v, (int, float)):
            return f"{v:,.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
        return str(v)

    lines = ["CURRENT CHART", "-------------"]
    lines.append(
        f"{ctx.get('symbol')} on {ctx.get('exchange')} · {ctx.get('interval')} · "
        f"{ctx.get('range_days')}D range · session {ctx.get('session')} · "
        f"market {'open' if ctx.get('market_open') else 'closed'} · {ctx.get('bars')} bars"
    )
    if ctx.get("ltp") is not None:
        lines.append(f"Live LTP: {num(ctx['ltp'])}")

    bar = ctx.get("last_bar") or {}
    if bar:
        lines.append(
            f"Last bar ({bar.get('time')}): O {num(bar.get('open'))} H {num(bar.get('high'))} "
            f"L {num(bar.get('low'))} C {num(bar.get('close'))} Vol {num(bar.get('volume'))}"
        )

    s = ctx.get("summary") or {}
    if s:
        lines.append(
            f"Session: open {num(s.get('open'))} high {num(s.get('high'))} low {num(s.get('low'))} "
            f"last {num(s.get('last'))} ({num(s.get('change_pct'))}% from open) · trend {s.get('trend', 'n/a')}"
        )
        if s.get("prev_high") is not None or s.get("prev_low") is not None:
            lines.append(f"Previous day: high {num(s.get('prev_high'))} low {num(s.get('prev_low'))}")
        if s.get("support"):
            lines.append("Support: " + ", ".join(num(x) for x in s["support"]))
        if s.get("resistance"):
            lines.append("Resistance: " + ", ".join(num(x) for x in s["resistance"]))

    ind = ctx.get("indicators") or {}
    present = {k: v for k, v in ind.items() if v is not None}
    if present:
        lines.append("Indicators (latest bar):")
        lines.append("  " + ", ".join(f"{k} {num(v)}" for k, v in present.items()))
    missing = [k for k, v in ind.items() if v is None]
    if missing:
        lines.append("  not yet available: " + ", ".join(missing))

    smc = ctx.get("smc") or {}
    if smc:
        counts = smc.get("counts") or {}
        if counts:
            lines.append("Smart money: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
        rng = smc.get("range")
        if rng:
            lines.append(
                f"Dealing range: {num(rng.get('bottom'))}–{num(rng.get('top'))}, "
                f"equilibrium {num(rng.get('equilibrium'))}, price in {rng.get('position')}"
            )
        for z in smc.get("open_zones") or []:
            lines.append(f"  unmitigated {z.get('kind')} ({z.get('side')}): {num(z.get('bottom'))}–{num(z.get('top'))}")
        for l in smc.get("liquidity") or []:
            lines.append(f"  resting {l.get('side')} at {num(l.get('price'))}")
        for e in smc.get("equal") or []:
            lines.append(f"  {e.get('side')} at {num(e.get('price'))}")
        for ev in smc.get("recent_structure") or []:
            lines.append(f"  {ev.get('type')} {ev.get('side')} at {num(ev.get('price'))}")

    view = []
    if ctx.get("chart_type"):
        view.append(f"type {ctx['chart_type']}")
    if ctx.get("visible_overlays"):
        view.append("overlays " + ", ".join(ctx["visible_overlays"]))
    if ctx.get("lower_pane"):
        view.append(f"lower pane {ctx['lower_pane']}")
    if view:
        lines.append("User is viewing: " + " · ".join(view))

    return "\n".join(lines)


class ChatError(Exception):
    pass


class ChatStore:
    """Thread-safe, file-backed conversation log."""

    def __init__(self, path=HISTORY_PATH):
        self.path = path
        self._lock = threading.Lock()
        self._messages = self._load()

    def _load(self):
        try:
            with open(self.path) as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []

    def _save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w") as f:
            json.dump(self._messages, f, indent=1)
        os.replace(tmp, self.path)  # atomic, so a crash cannot truncate history

    def all(self):
        with self._lock:
            return list(self._messages)

    def add(self, role, text):
        entry = {
            "id": uuid.uuid4().hex,
            "role": role,
            "text": text,
            "ts": dt.datetime.now().isoformat(timespec="seconds"),
        }
        with self._lock:
            self._messages.append(entry)
            self._save()
        return entry

    def clear(self):
        with self._lock:
            self._messages = []
            self._save()

    def drop_last(self):
        """Roll back the pending user turn when the model call fails."""
        with self._lock:
            if self._messages:
                self._messages.pop()
                self._save()


store = ChatStore()


def _api_key():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise ChatError("GEMINI_API_KEY is not set. Add it in Settings, then try again.")
    return key


def _to_contents(messages):
    """Map stored messages onto Gemini's contents format."""
    return [
        {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["text"]}]}
        for m in messages
        if m.get("text")
    ]


def send(message: str, context: dict | None = None, model: str | None = None) -> dict:
    """Append the user's turn, ask Gemini with full history, store the reply.

    The chart snapshot is attached to the outgoing request only, not saved into
    history — replaying stale market data on every later turn would mislead the
    model. Only the latest turn ever carries live numbers.
    """
    message = (message or "").strip()
    if not message:
        raise ChatError("Message is empty.")
    if len(message) > MAX_MESSAGE_CHARS:
        raise ChatError(f"Message is too long (max {MAX_MESSAGE_CHARS} characters).")

    key = _api_key()
    store.add("user", message)

    history = store.all()[-MAX_TURNS:]
    contents = _to_contents(history)
    block = format_context(context or {})
    if block and contents:
        contents[-1] = {"role": "user", "parts": [{"text": f"{block}\n\n---\n\n{message}"}]}

    payload = {
        "contents": contents,
        "systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 2048},
    }

    used_model = model or DEFAULT_MODEL
    try:
        resp = requests.post(
            f"{API_ROOT}/models/{used_model}:generateContent",
            headers={"x-goog-api-key": key, "Content-Type": "application/json"},
            json=payload,
            timeout=90,
        )
    except requests.RequestException as exc:
        store.drop_last()
        raise ChatError(f"Could not reach Gemini: {exc}")

    if resp.status_code != 200:
        store.drop_last()
        raise ChatError(_describe_error(resp))

    try:
        data = resp.json()
        candidate = (data.get("candidates") or [])[0]
        parts = candidate.get("content", {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts).strip()
    except (ValueError, IndexError, KeyError):
        store.drop_last()
        raise ChatError("Gemini returned a response that could not be read.")

    if not text:
        store.drop_last()
        reason = (resp.json().get("candidates") or [{}])[0].get("finishReason", "")
        raise ChatError(f"Gemini returned an empty reply{f' ({reason})' if reason else ''}.")

    return store.add("assistant", text)


def _describe_error(resp) -> str:
    try:
        detail = resp.json().get("error", {}).get("message", "")
    except ValueError:
        detail = resp.text[:200]
    if resp.status_code in (401, 403):
        return f"Gemini rejected the API key ({resp.status_code}). {detail}"
    if resp.status_code == 429:
        return "Gemini rate limit reached. Wait a moment and try again."
    if resp.status_code == 404:
        return f"Model '{DEFAULT_MODEL}' is not available for this key. {detail}"
    return f"Gemini error {resp.status_code}: {detail}"


def list_models() -> list[str]:
    """Model names this key can call — used to validate configuration."""
    resp = requests.get(f"{API_ROOT}/models", headers={"x-goog-api-key": _api_key()}, timeout=30)
    if resp.status_code != 200:
        raise ChatError(_describe_error(resp))
    out = []
    for m in resp.json().get("models", []):
        if "generateContent" in (m.get("supportedGenerationMethods") or []):
            out.append(m.get("name", "").replace("models/", ""))
    return out
