from dataclasses import dataclass
from typing import Literal

@dataclass
class RegimeConfig:
    adx_trend_min: float = 16.0
    neutral_band_bps: float = 10.0  # 0.10% slope threshold for neutrality

def classify_regime(ema_fast: float, ema_slow: float, adx: float, cfg: RegimeConfig) -> Literal["bull", "bear", "range"]:
    if adx is not None and adx < cfg.adx_trend_min:
        return "range"
    if ema_fast is None or ema_slow is None:
        return "range"
    if ema_fast > ema_slow:
        return "bull"
    if ema_fast < ema_slow:
        return "bear"
    return "range"

def select_mode(regime: str) -> Literal["conservative", "aggressive"]:
    # Simple policy: be conservative in 'range', aggressive in trending regimes
    return "conservative" if regime == "range" else "aggressive"
