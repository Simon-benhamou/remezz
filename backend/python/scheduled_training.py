"""Cron-friendly script to refresh the dataset and retrain the model."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import pandas as pd

from ccxt_xgboost_module import (
    DEFAULT_EXCHANGE,
    DEFAULT_LOOKBACK_HOURS,
    DEFAULT_SYMBOLS,
    DEFAULT_TIMEFRAME,
    fetch_ohlcv,
    prepare_dataset,
    save_model_and_features,
    train_model,
    _seed_everything,
)


def refresh_cache(
    exchange: str,
    symbols: tuple[str, ...] | list[str],
    timeframe: str,
    lookback_hours: int,
) -> list[tuple[str, pd.DataFrame]]:
    """Ensure the OHLCV cache contains fresh data for each symbol."""

    end = datetime.now(tz=timezone.utc)
    start = end - pd.Timedelta(hours=lookback_hours)
    start_ts = int(start.timestamp() * 1000)
    end_ts = int(end.timestamp() * 1000)

    windows: list[tuple[str, pd.DataFrame]] = []
    for symbol in symbols:
        window = fetch_ohlcv(exchange, symbol, timeframe, start_ts, end_ts)
        windows.append((symbol, window))
    return windows


def retrain_from_cache(frames: list[tuple[str, pd.DataFrame]]) -> dict[str, float]:
    datasets: list[pd.DataFrame] = []
    for symbol, frame in frames:
        dataset = prepare_dataset(frame)
        dataset = dataset.copy()
        dataset["symbol"] = symbol
        datasets.append(dataset)

    if not datasets:
        raise ValueError("No OHLCV data available for retraining")

    combined = pd.concat(datasets, ignore_index=True)
    combined = combined.drop(columns=["symbol"], errors="ignore")

    artifacts = train_model(
        combined,
        params={
            "max_depth": 4,
            "n_estimators": 120,
            "learning_rate": 0.15,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
        },
    )
    save_model_and_features(artifacts)
    return artifacts.metrics


def main() -> None:
    exchange = os.environ.get("XGB_EXCHANGE", DEFAULT_EXCHANGE)
    symbols_env = os.environ.get("XGB_SYMBOLS")
    if symbols_env:
        symbols = tuple(sym.strip() for sym in symbols_env.split(",") if sym.strip())
    else:
        symbol_single = os.environ.get("XGB_SYMBOL")
        if symbol_single:
            symbols = (symbol_single,)
        else:
            symbols = DEFAULT_SYMBOLS
    timeframe = os.environ.get("XGB_TIMEFRAME", DEFAULT_TIMEFRAME)
    lookback = int(os.environ.get("XGB_LOOKBACK_HOURS", str(DEFAULT_LOOKBACK_HOURS)))

    _seed_everything()
    frames = refresh_cache(exchange, symbols, timeframe, lookback)
    metrics = retrain_from_cache(frames)
    print(json.dumps({"metrics": metrics}))


if __name__ == "__main__":
    main()
