"""
Lightweight technical indicators (EMA, RSI, ATR, ADX, CMF) with no external deps.
Arrays are assumed as Python lists (most-recent last). Functions return floats for last value.
For performance-critical code, replace with vectorized libs (ta, numpy) in your project.
"""
from typing import List, Optional
import math

def ema(values: List[float], period: int) -> Optional[float]:
    if not values or len(values) < period:
        return None
    k = 2 / (period + 1)
    ema_val = sum(values[:period]) / period
    for v in values[period:]:
        ema_val = v * k + ema_val * (1 - k)
    return ema_val

def rsi(closes: List[float], period: int = 14) -> Optional[float]:
    if not closes or len(closes) < period + 1:
        return None
    gains = []
    losses = []
    for i in range(1, len(closes)):
        chg = closes[i] - closes[i-1]
        gains.append(max(chg, 0.0))
        losses.append(max(-chg, 0.0))
    # Wilder smoothing
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain*(period-1) + gains[i]) / period
        avg_loss = (avg_loss*(period-1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))

def true_range(high: float, low: float, prev_close: float) -> float:
    return max(high-low, abs(high-prev_close), abs(low-prev_close))

def atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> Optional[float]:
    if len(highs) < period+1 or len(lows) < period+1 or len(closes) < period+1:
        return None
    trs = []
    for i in range(1, len(closes)):
        trs.append(true_range(highs[i], lows[i], closes[i-1]))
    # Wilder's smoothing
    atr_val = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr_val = (atr_val*(period-1) + tr) / period
    return atr_val

def adx(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> Optional[float]:
    n = len(closes)
    if n < period + 2:
        return None
    plus_dm = []
    minus_dm = []
    trs = []
    for i in range(1, n):
        up = highs[i] - highs[i-1]
        down = lows[i-1] - lows[i]
        plus_dm.append(max(up, 0.0) if up > down and up > 0 else 0.0)
        minus_dm.append(max(down, 0.0) if down > up and down > 0 else 0.0)
        trs.append(true_range(highs[i], lows[i], closes[i-1]))

    # Wilder smoothing
    def smooth(series, period):
        sm = sum(series[:period]) / period
        out = [sm]
        for v in series[period:]:
            sm = (sm*(period-1) + v) / period
            out.append(sm)
        return out

    tr_s = smooth(trs, period)
    plus_s = smooth(plus_dm, period)
    minus_s = smooth(minus_dm, period)

    di_plus = [ (p/tr)*100.0 if tr>0 else 0.0 for p,tr in zip(plus_s, tr_s) ]
    di_minus = [ (m/tr)*100.0 if tr>0 else 0.0 for m,tr in zip(minus_s, tr_s) ]

    dx = []
    for p,m in zip(di_plus, di_minus):
        denom = (p + m)
        dx.append( (abs(p-m)/denom)*100.0 if denom>0 else 0.0 )

    # Smooth DX into ADX
    adx_val = sum(dx[:period]) / period
    for v in dx[period:]:
        adx_val = (adx_val*(period-1) + v) / period
    return adx_val

def cmf(highs: List[float], lows: List[float], closes: List[float], volumes: List[float], period: int = 20) -> Optional[float]:
    n = len(closes)
    if n < period:
        return None
    mfv_sum = 0.0
    vol_sum = 0.0
    for i in range(n-period, n):
        high = highs[i]; low = lows[i]; close = closes[i]; vol = volumes[i]
        if high == low:
            continue
        mfm = ((close - low) - (high - close)) / (high - low) # Money Flow Multiplier
        mfv = mfm * vol
        mfv_sum += mfv
        vol_sum += vol
    return mfv_sum / vol_sum if vol_sum > 0 else 0.0
