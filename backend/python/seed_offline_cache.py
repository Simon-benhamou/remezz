"""Utility script to seed CCXT cache with deterministic multi-asset OHLCV data."""
from __future__ import annotations

from datetime import timezone
from pathlib import Path

import numpy as np
import pandas as pd

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "ccxt_cache"
DEFAULT_START = "2024-04-01 00:00"
DEFAULT_PERIODS = 24 * 30  # one month of hourly bars
DEFAULT_FREQ = "1h"

SYMBOL_SPECS: dict[str, tuple[float, int]] = {
    "BTC/USDT": (65_000.0, 42),
    "ETH/USDT": (3_200.0, 1337),
    "SOL/USDT": (180.0, 314),
    "XRP/USDT": (0.62, 2718),
    "BNB/USDT": (550.0, 8119),
    "ADA/USDT": (0.58, 1459),
    "AVAX/USDT": (45.0, 2024),
    "DOGE/USDT": (0.15, 8675309),
    "TON/USDT": (5.4, 999),
    "LINK/USDT": (18.0, 54321),
    "MATIC/USDT": (0.90, 73),
    "DOT/USDT": (7.5, 8080),
    "ATOM/USDT": (9.8, 6464),
    "FIL/USDT": (6.2, 1212),
    "LTC/USDT": (85.0, 404),
    "INJ/USDT": (30.0, 5150),
}


def _generate_symbol_frame(symbol: str, base_price: float, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    timestamps = pd.date_range(DEFAULT_START, periods=DEFAULT_PERIODS, freq=DEFAULT_FREQ, tz=timezone.utc)
    drift = np.linspace(-0.02, 0.03, DEFAULT_PERIODS)
    noise = rng.normal(0.0, 0.55, DEFAULT_PERIODS)
    log_returns = drift + noise * 0.045
    close = np.empty(DEFAULT_PERIODS)
    close[0] = base_price
    for idx in range(1, DEFAULT_PERIODS):
        close[idx] = close[idx - 1] * np.exp(log_returns[idx - 1])
    open_price = close * (1 + rng.normal(0.0, 0.0015, DEFAULT_PERIODS))
    high = np.maximum(open_price, close) * (1 + np.abs(rng.normal(0.001, 0.0006, DEFAULT_PERIODS)))
    low = np.minimum(open_price, close) * (1 - np.abs(rng.normal(0.0012, 0.0007, DEFAULT_PERIODS)))
    volume = np.abs(rng.lognormal(mean=np.log(base_price * 0.65), sigma=0.35, size=DEFAULT_PERIODS))
    return pd.DataFrame({
        "timestamp": timestamps,
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    })


def seed_cache() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    for symbol, (base, seed) in SYMBOL_SPECS.items():
        frame = _generate_symbol_frame(symbol, base, seed)
        filename = f"binance_{symbol.replace('/', '_')}_1h.csv"
        frame.to_csv(CACHE_DIR / filename, index=False)
        resampled = frame.set_index("timestamp").resample("4h").agg(
            {
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }
        )
        resampled = resampled.dropna().reset_index()
        resampled.to_csv(CACHE_DIR / filename.replace("_1h", "_4h"), index=False)


if __name__ == "__main__":
    seed_cache()
    print(f"Seeded OHLCV cache under {CACHE_DIR}")
