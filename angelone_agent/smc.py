"""Smart Money Concepts derived from the session's candles.

Covers the full toolkit the chart draws:

  structure   swing pivots, HH/HL/LH/LL labels, BOS and CHoCH
  imbalance   fair value gaps, plus inversion FVGs once a gap flips
  blocks      order blocks and the breaker blocks they become when they fail
  liquidity   resting buy/sell-side liquidity, equal highs/lows, sweeps
  range       dealing range with premium / equilibrium / discount

Positions are returned as indices into the candle array, which is also the
chart's logical bar index, so the renderer can draw them without re-deriving.
"""

import numpy as np

BULL = "bull"
BEAR = "bear"


def _arrays(df):
    return (
        df["open"].to_numpy(),
        df["high"].to_numpy(),
        df["low"].to_numpy(),
        df["close"].to_numpy(),
    )


def _atr(df, period=14):
    high, low, close = df["high"], df["low"], df["close"]
    prev = close.shift()
    tr = np.maximum(high - low, np.maximum((high - prev).abs(), (low - prev).abs()))
    value = tr.ewm(alpha=1 / period, adjust=False).mean().iloc[-1]
    return float(value) if value == value else 0.0


# --------------------------------------------------------------------------
# structure
# --------------------------------------------------------------------------
def swing_points(df, left=2, right=2):
    """Pivots: a bar whose extreme beats `left` bars back and `right` bars forward."""
    _, high, low, _ = _arrays(df)
    n = len(df)
    highs, lows = [], []
    for i in range(left, n - right):
        wh = high[i - left : i + right + 1]
        wl = low[i - left : i + right + 1]
        if high[i] == wh.max() and wh.argmax() == left:
            highs.append({"index": i, "price": float(high[i])})
        if low[i] == wl.min() and wl.argmin() == left:
            lows.append({"index": i, "price": float(low[i])})
    return highs, lows


def swing_labels(highs, lows):
    """Classify each pivot against the previous one of the same kind."""
    out = []
    for series, up, down in ((highs, "HH", "LH"), (lows, "HL", "LL")):
        prev = None
        for p in series:
            if prev is not None:
                label = up if p["price"] > prev else down
                out.append({"index": p["index"], "price": p["price"], "label": label})
            prev = p["price"]
    return sorted(out, key=lambda x: x["index"])


def market_structure(df, left=2, right=2):
    """BOS continues the prevailing trend; CHoCH is the first break against it.

    A pivot only becomes actionable once its right-hand bars confirm it, so a
    pivot at index i is not usable until bar i + right.
    """
    _, _, _, close = _arrays(df)
    highs, lows = swing_points(df, left, right)
    n = len(df)

    hi, lo = 0, 0
    active_high = active_low = None
    trend = 0
    events = []

    for i in range(n):
        while hi < len(highs) and highs[hi]["index"] + right <= i:
            active_high = highs[hi]
            hi += 1
        while lo < len(lows) and lows[lo]["index"] + right <= i:
            active_low = lows[lo]
            lo += 1

        if active_high and close[i] > active_high["price"]:
            events.append(
                {
                    "index": i,
                    "from": active_high["index"],
                    "price": active_high["price"],
                    "type": "BOS" if trend > 0 else "CHoCH",
                    "side": BULL,
                }
            )
            trend = 1
            active_high = None
        elif active_low and close[i] < active_low["price"]:
            events.append(
                {
                    "index": i,
                    "from": active_low["index"],
                    "price": active_low["price"],
                    "type": "BOS" if trend < 0 else "CHoCH",
                    "side": BEAR,
                }
            )
            trend = -1
            active_low = None

    return events, trend


# --------------------------------------------------------------------------
# imbalance
# --------------------------------------------------------------------------
def fair_value_gaps(df, max_zones=40):
    """Three-bar imbalance where bar i and bar i-2 leave an untraded gap.

    Once price trades fully back through it the gap is mitigated; if price then
    closes beyond it, the gap flips polarity and becomes an inversion FVG.
    """
    _, high, low, close = _arrays(df)
    n = len(df)
    zones = []

    for i in range(2, n):
        if low[i] > high[i - 2]:
            bottom, top, side = float(high[i - 2]), float(low[i]), BULL
        elif high[i] < low[i - 2]:
            bottom, top, side = float(high[i]), float(low[i - 2]), BEAR
        else:
            continue

        after_low = low[i + 1 :]
        after_high = high[i + 1 :]
        after_close = close[i + 1 :]

        if side == BULL:
            entered = bool(after_low.size and after_low.min() <= top)
            mitigated = bool(after_low.size and after_low.min() <= bottom)
            inverted = bool(mitigated and after_close.size and after_close[-1] < bottom)
        else:
            entered = bool(after_high.size and after_high.max() >= bottom)
            mitigated = bool(after_high.size and after_high.max() >= top)
            inverted = bool(mitigated and after_close.size and after_close[-1] > top)

        zones.append(
            {
                "kind": "ifvg" if inverted else "fvg",
                "side": (BEAR if side == BULL else BULL) if inverted else side,
                "start": i - 2,
                "end": n - 1,
                "top": top,
                "bottom": bottom,
                "mitigated": mitigated and not inverted,
                "entered": entered,
                "label": "IFVG" if inverted else "FVG",
            }
        )

    return zones[-max_zones:]


# --------------------------------------------------------------------------
# blocks
# --------------------------------------------------------------------------
def order_blocks(df, displacement=1.5, max_zones=20):
    """The last opposing candle before a displacement move.

    When price later breaks through an order block, it flips into a breaker
    block and is expected to hold from the other side.
    """
    open_, high, low, close = _arrays(df)
    body = np.abs(close - open_)
    n = len(df)
    if n < 10:
        return []

    positive = body[body > 0]
    avg_body = float(np.nanmean(positive)) if positive.size else 0.0
    if not avg_body:
        return []

    zones = []
    for i in range(1, n):
        if body[i] < displacement * avg_body:
            continue
        bullish = close[i] > open_[i]

        j = i - 1
        while j >= 0 and ((close[j] > open_[j]) == bullish):
            j -= 1
        if j < 0:
            continue
        if bullish and high[i] <= high[j]:
            continue
        if not bullish and low[i] >= low[j]:
            continue

        side = BULL if bullish else BEAR
        top, bottom = float(high[j]), float(low[j])
        after_low = low[i + 1 :]
        after_high = high[i + 1 :]
        broken = (
            bool(after_low.size and after_low.min() < bottom)
            if side == BULL
            else bool(after_high.size and after_high.max() > top)
        )

        zones.append(
            {
                "kind": "breaker" if broken else "ob",
                "side": (BEAR if side == BULL else BULL) if broken else side,
                "start": j,
                "end": n - 1,
                "top": top,
                "bottom": bottom,
                "mitigated": broken,
                "label": "Breaker" if broken else "OB",
            }
        )

    seen = set()
    unique = []
    for z in reversed(zones):
        if z["start"] in seen:
            continue
        seen.add(z["start"])
        unique.append(z)
    return list(reversed(unique))[-max_zones:]


# --------------------------------------------------------------------------
# liquidity
# --------------------------------------------------------------------------
def liquidity_sweeps(df, left=2, right=2, max_marks=30):
    """A wick through a prior swing that closes back inside — stops taken, no follow-through."""
    _, high, low, close = _arrays(df)
    n = len(df)
    highs, lows = swing_points(df, left, right)
    marks = []

    for pivot in highs:
        level = pivot["price"]
        for i in range(pivot["index"] + right + 1, n):
            if high[i] > level:
                if close[i] < level:
                    marks.append(
                        {"index": i, "side": BEAR, "price": float(high[i]), "level": level, "label": "sweep"}
                    )
                break

    for pivot in lows:
        level = pivot["price"]
        for i in range(pivot["index"] + right + 1, n):
            if low[i] < level:
                if close[i] > level:
                    marks.append(
                        {"index": i, "side": BULL, "price": float(low[i]), "level": level, "label": "sweep"}
                    )
                break

    marks.sort(key=lambda m: m["index"])
    return marks[-max_marks:]


def liquidity_levels(df, highs, lows, max_levels=12):
    """Untapped swing highs/lows — resting buy-side and sell-side liquidity."""
    _, high, low, _ = _arrays(df)
    n = len(df)
    out = []
    for p in highs:
        rest = high[p["index"] + 1 :]
        if not (rest.size and rest.max() > p["price"]):
            out.append({"index": p["index"], "price": p["price"], "side": "BSL", "end": n - 1})
    for p in lows:
        rest = low[p["index"] + 1 :]
        if not (rest.size and rest.min() < p["price"]):
            out.append({"index": p["index"], "price": p["price"], "side": "SSL", "end": n - 1})
    out.sort(key=lambda x: x["index"])
    return out[-max_levels:]


def equal_levels(df, highs, lows, max_pairs=8):
    """Equal highs/lows — paired pivots within a tick of each other, a liquidity magnet."""
    tol = _atr(df) * 0.1
    if tol <= 0:
        return []
    pairs = []
    for series, side in ((highs, "EQH"), (lows, "EQL")):
        for a in range(len(series) - 1):
            for b in range(a + 1, len(series)):
                if series[b]["index"] - series[a]["index"] < 2:
                    continue
                if abs(series[a]["price"] - series[b]["price"]) <= tol:
                    pairs.append(
                        {
                            "side": side,
                            "start": series[a]["index"],
                            "end": series[b]["index"],
                            "price": float((series[a]["price"] + series[b]["price"]) / 2),
                        }
                    )
                    break
    pairs.sort(key=lambda x: x["end"])
    return pairs[-max_pairs:]


# --------------------------------------------------------------------------
# dealing range
# --------------------------------------------------------------------------
def premium_discount(df, highs, lows):
    """The current dealing range split into premium / equilibrium / discount."""
    if not highs or not lows:
        return None
    swing_high = max(highs[-3:], key=lambda p: p["price"])
    swing_low = min(lows[-3:], key=lambda p: p["price"])
    top, bottom = swing_high["price"], swing_low["price"]
    if top <= bottom:
        return None
    start = min(swing_high["index"], swing_low["index"])
    mid = (top + bottom) / 2
    close = float(df["close"].iloc[-1])
    return {
        "start": start,
        "end": len(df) - 1,
        "top": top,
        "bottom": bottom,
        "equilibrium": mid,
        "position": "premium" if close > mid else "discount",
        "pct": (close - bottom) / (top - bottom) * 100,
    }


# --------------------------------------------------------------------------
def analyse(df, left=2, right=2):
    """Everything the chart's SMC layer needs, in one call."""
    if len(df) < 8:
        return {
            "zones": [],
            "sweeps": [],
            "structure": [],
            "swings": [],
            "liquidity": [],
            "equal": [],
            "range": None,
            "trend": 0,
            "counts": {},
        }

    highs, lows = swing_points(df, left, right)
    fvg = fair_value_gaps(df)
    blocks = order_blocks(df)
    structure, trend = market_structure(df, left, right)
    sweeps = liquidity_sweeps(df, left, right)
    pools = liquidity_levels(df, highs, lows)
    equal = equal_levels(df, highs, lows)
    rng = premium_discount(df, highs, lows)

    return {
        "zones": fvg + blocks,
        "sweeps": sweeps,
        "structure": structure[-12:],
        "swings": swing_labels(highs, lows)[-16:],
        "liquidity": pools,
        "equal": equal,
        "range": rng,
        "trend": trend,
        "counts": {
            "fvg": sum(1 for z in fvg if z["kind"] == "fvg"),
            "fvg_open": sum(1 for z in fvg if z["kind"] == "fvg" and not z["mitigated"]),
            "ifvg": sum(1 for z in fvg if z["kind"] == "ifvg"),
            "ob": sum(1 for z in blocks if z["kind"] == "ob"),
            "breaker": sum(1 for z in blocks if z["kind"] == "breaker"),
            "sweeps": len(sweeps),
            "bos": sum(1 for e in structure if e["type"] == "BOS"),
            "choch": sum(1 for e in structure if e["type"] == "CHoCH"),
        },
    }
