"""Black-Scholes greeks, computed locally.

AngelOne's optionGreek endpoint needs an entitlement most accounts don't have
and returns nulls otherwise, so the chain derives its own from the option's
last traded price. Pure stdlib maths — no scipy.

Conventions match how traders read a chain:
  vega  per 1 percentage point of volatility
  theta per calendar day
  iv    as a percentage
"""

import datetime as dt
import math

# India: expiry is 15:30 IST on the expiry date for index/stock options.
EXPIRY_HOUR, EXPIRY_MINUTE = 15, 30
TRADING_DAYS_YEAR = 365.0
DEFAULT_RATE = 0.065  # approximate India risk-free rate


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def years_to_expiry(expiry: dt.date, now: dt.datetime | None = None) -> float:
    """Fraction of a year until the expiry bell. Never returns exactly zero."""
    now = now or dt.datetime.now()
    end = dt.datetime.combine(expiry, dt.time(EXPIRY_HOUR, EXPIRY_MINUTE))
    seconds = (end - now).total_seconds()
    return max(seconds, 60.0) / (TRADING_DAYS_YEAR * 24 * 3600)


def bs_price(spot, strike, t, vol, is_call, rate=DEFAULT_RATE) -> float:
    if spot <= 0 or strike <= 0 or t <= 0 or vol <= 0:
        return max(0.0, (spot - strike) if is_call else (strike - spot))
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    disc = math.exp(-rate * t)
    if is_call:
        return spot * _norm_cdf(d1) - strike * disc * _norm_cdf(d2)
    return strike * disc * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def implied_vol(price, spot, strike, t, is_call, rate=DEFAULT_RATE):
    """Solve for volatility by bisection — slower than Newton but it cannot
    diverge on the near-worthless far strikes that fill most of a chain."""
    if price is None or price <= 0 or spot <= 0 or strike <= 0 or t <= 0:
        return None

    intrinsic = max(0.0, (spot - strike) if is_call else (strike - spot))
    if price < intrinsic - 1e-6:
        return None  # price below intrinsic: stale or crossed quote

    lo, hi = 1e-4, 5.0
    if bs_price(spot, strike, t, hi, is_call, rate) < price:
        return None  # not solvable inside a sane vol range

    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if bs_price(spot, strike, t, mid, is_call, rate) < price:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-6:
            break
    vol = 0.5 * (lo + hi)
    return vol if 1e-3 < vol < 4.99 else None


def greeks(spot, strike, t, vol, is_call, rate=DEFAULT_RATE) -> dict:
    if not vol or vol <= 0 or t <= 0 or spot <= 0 or strike <= 0:
        return {"delta": None, "gamma": None, "theta": None, "vega": None}

    sqrt_t = math.sqrt(t)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * t) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    disc = math.exp(-rate * t)
    pdf = _norm_pdf(d1)

    delta = _norm_cdf(d1) if is_call else _norm_cdf(d1) - 1.0
    gamma = pdf / (spot * vol * sqrt_t)
    vega = spot * pdf * sqrt_t / 100.0  # per 1% vol move

    theta_year = -(spot * pdf * vol) / (2 * sqrt_t)
    if is_call:
        theta_year -= rate * strike * disc * _norm_cdf(d2)
    else:
        theta_year += rate * strike * disc * _norm_cdf(-d2)

    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 6),
        "theta": round(theta_year / TRADING_DAYS_YEAR, 3),  # per day
        "vega": round(vega, 3),
    }


def solve(ltp, spot, strike, expiry: dt.date, is_call, rate=DEFAULT_RATE, now=None) -> dict:
    """IV + greeks for one leg from its traded price."""
    blank = {"iv": None, "delta": None, "gamma": None, "theta": None, "vega": None}
    if not ltp or not spot:
        return blank
    t = years_to_expiry(expiry, now)
    vol = implied_vol(float(ltp), float(spot), float(strike), t, is_call, rate)
    if vol is None:
        return blank
    return {"iv": round(vol * 100.0, 2), **greeks(float(spot), float(strike), t, vol, is_call, rate)}
