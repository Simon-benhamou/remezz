"""Cron-friendly script to refresh the dataset and retrain the model."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone

import pandas as pd

from ccxt_xgboost_module import (
    DEFAULT_EXCHANGE,
    DEFAULT_LOOKBACK_HOURS,
    DEFAULT_SYMBOL,
    DEFAULT_TIMEFRAME,
    fetch_ohlcv,
    prepare_dataset,
    save_model_and_features,
    train_model,
    _seed_everything,
)


def refresh_cache(exchange: str, symbol: str, timeframe: str, lookback_hours: int) -> pd.DataFrame:
    """Ensure the OHLCV cache contains fresh data for the lookback window."""

    end = datetime.now(tz=timezone.utc)
    start = end - pd.Timedelta(hours=lookback_hours)
    start_ts = int(start.timestamp() * 1000)
    end_ts = int(end.timestamp() * 1000)

    # This call updates the cache internally and returns the window slice
    window = fetch_ohlcv(exchange, symbol, timeframe, start_ts, end_ts)
    return window


def retrain_from_cache(df_raw: pd.DataFrame) -> dict[str, float]:
    dataset = prepare_dataset(df_raw)
    artifacts = train_model(
        dataset,
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
    symbol = os.environ.get("XGB_SYMBOL", DEFAULT_SYMBOL)
    timeframe = os.environ.get("XGB_TIMEFRAME", DEFAULT_TIMEFRAME)
    lookback = int(os.environ.get("XGB_LOOKBACK_HOURS", str(DEFAULT_LOOKBACK_HOURS)))

    _seed_everything()
    raw = refresh_cache(exchange, symbol, timeframe, lookback)
    metrics = retrain_from_cache(raw)
    print(json.dumps({"metrics": metrics}))


if __name__ == "__main__":
    main()
