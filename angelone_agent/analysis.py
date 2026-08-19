import numpy as np
import pandas as pd


def to_dataframe(candles):
    df = pd.DataFrame(candles, columns=["datetime", "open", "high", "low", "close", "volume"])
    df["datetime"] = pd.to_datetime(df["datetime"])
    return df.set_index("datetime")


# ---------------------------------------------------------------- overlays
def add_moving_averages(df, windows=(20, 50, 200)):
    for w in windows:
        df[f"sma_{w}"] = df["close"].rolling(w).mean()
    return df


def add_emas(df, windows=(9, 21)):
    for w in windows:
        df[f"ema_{w}"] = df["close"].ewm(span=w, adjust=False).mean()
    return df


def add_bollinger(df, period=20, mult=2.0):
    mid = df["close"].rolling(period).mean()
    sd = df["close"].rolling(period).std()
    df["bb_mid"] = mid
    df["bb_upper"] = mid + mult * sd
    df["bb_lower"] = mid - mult * sd
    return df


def add_vwap(df):
    """Session VWAP. Indices report zero volume, so it stays undefined there."""
    vol = df["volume"].astype(float)
    if vol.sum() <= 0:
        df["vwap"] = np.nan
        return df
    typical = (df["high"] + df["low"] + df["close"]) / 3
    df["vwap"] = (typical * vol).cumsum() / vol.cumsum().replace(0, np.nan)
    return df


# ---------------------------------------------------------------- oscillators
def add_rsi(df, period=14):
    delta = df["close"].diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss
    df["rsi"] = 100 - (100 / (1 + rs))
    return df


def add_macd(df, fast=12, slow=26, signal=9):
    ema_fast = df["close"].ewm(span=fast, adjust=False).mean()
    ema_slow = df["close"].ewm(span=slow, adjust=False).mean()
    df["macd"] = ema_fast - ema_slow
    df["macd_signal"] = df["macd"].ewm(span=signal, adjust=False).mean()
    df["macd_hist"] = df["macd"] - df["macd_signal"]
    return df


def true_range(df):
    prev_close = df["close"].shift()
    return pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)


def add_atr(df, period=14):
    # Wilder's smoothing, the conventional ATR
    df["atr"] = true_range(df).ewm(alpha=1 / period, adjust=False).mean()
    return df


def add_stochastic(df, period=14, smooth=3):
    low_n = df["low"].rolling(period).min()
    high_n = df["high"].rolling(period).max()
    span = (high_n - low_n).replace(0, np.nan)
    df["stoch_k"] = 100 * (df["close"] - low_n) / span
    df["stoch_d"] = df["stoch_k"].rolling(smooth).mean()
    return df


def add_supertrend(df, period=10, mult=3.0):
    """Classic Supertrend: ATR bands that ratchet and flip on close crossings."""
    if "atr" not in df:
        add_atr(df, period)
    atr = true_range(df).ewm(alpha=1 / period, adjust=False).mean()
    hl2 = (df["high"] + df["low"]) / 2
    upper = (hl2 + mult * atr).to_numpy()
    lower = (hl2 - mult * atr).to_numpy()
    close = df["close"].to_numpy()

    n = len(df)
    final_up = np.full(n, np.nan)
    final_low = np.full(n, np.nan)
    trend = np.zeros(n, dtype=int)
    st = np.full(n, np.nan)

    for i in range(n):
        if i == 0:
            final_up[i], final_low[i] = upper[i], lower[i]
            trend[i] = 1
            st[i] = lower[i]
            continue
        # bands only tighten while the trend holds
        final_up[i] = (
            min(upper[i], final_up[i - 1]) if close[i - 1] <= final_up[i - 1] else upper[i]
        )
        final_low[i] = (
            max(lower[i], final_low[i - 1]) if close[i - 1] >= final_low[i - 1] else lower[i]
        )
        if close[i] > final_up[i - 1]:
            trend[i] = 1
        elif close[i] < final_low[i - 1]:
            trend[i] = -1
        else:
            trend[i] = trend[i - 1]
        st[i] = final_low[i] if trend[i] == 1 else final_up[i]

    # The first `period` bars are ATR warm-up: the bands sit far from price and
    # would otherwise stretch the chart's price scale. Publish them as NaN.
    warmup = min(period, n)
    st[:warmup] = np.nan
    trend_out = trend.astype(float)
    trend_out[:warmup] = np.nan

    df["supertrend"] = st
    df["supertrend_dir"] = trend_out
    return df


def add_indicators(df, fast=20, slow=50):
    """Everything the desk chart can draw, in one pass."""
    add_moving_averages(df, windows=(fast, slow))
    add_emas(df)
    add_bollinger(df)
    add_vwap(df)
    add_rsi(df)
    add_macd(df)
    add_atr(df)
    add_stochastic(df)
    add_supertrend(df)
    return df


# ---------------------------------------------------------------- summary
def find_support_resistance(df, window=10, lookback=120):
    recent = df.tail(lookback)
    highs = recent["high"]
    lows = recent["low"]
    resistance_points = highs[(highs == highs.rolling(window, center=True).max())].dropna()
    support_points = lows[(lows == lows.rolling(window, center=True).min())].dropna()
    return {
        "resistance": sorted(resistance_points.unique())[-5:],
        "support": sorted(support_points.unique())[:5],
    }


def _clean(value):
    """NaN -> None so the JSON payload stays valid."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def summarize(df):
    last = df.iloc[-1]
    trend = "uptrend" if last["close"] > last.get("sma_50", last["close"]) else "downtrend"
    rsi = _clean(last.get("rsi"))
    rsi_note = None
    if rsi is not None:
        rsi_note = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"

    macd_note = None
    macd, macd_sig = _clean(last.get("macd")), _clean(last.get("macd_signal"))
    if macd is not None and macd_sig is not None:
        macd_note = "bullish" if macd > macd_sig else "bearish"

    st_dir = last.get("supertrend_dir")
    st_note = None
    if st_dir is not None and st_dir == st_dir:
        st_note = "long" if int(st_dir) > 0 else "short"

    levels = find_support_resistance(df)
    return {
        "last_close": _clean(last["close"]),
        "trend": trend,
        "rsi": rsi,
        "rsi_note": rsi_note,
        "macd": macd,
        "macd_signal": macd_sig,
        "macd_note": macd_note,
        "atr": _clean(last.get("atr")),
        "vwap": _clean(last.get("vwap")),
        "stoch_k": _clean(last.get("stoch_k")),
        "stoch_d": _clean(last.get("stoch_d")),
        "supertrend": _clean(last.get("supertrend")),
        "supertrend_note": st_note,
        "support": levels["support"],
        "resistance": levels["resistance"],
    }
