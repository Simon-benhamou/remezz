"""Cron-friendly script to refresh the dataset and retrain the model."""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Sequence

from ccxt_xgboost_module import (
    DEFAULT_EXCHANGE,
    DEFAULT_SYMBOLS,
    DEFAULT_WINDOW_SPECS,
    PreparedWindow,
    WindowSpec,
    assemble_training_dataframe,
    collect_prepared_windows,
    resolve_window_specs,
    save_model_and_features,
    train_model,
    _seed_everything,
)


def refresh_cache(
    exchange: str,
    symbols: Sequence[str],
    window_specs: Sequence[WindowSpec],
    anchor: datetime | None = None,
) -> list[PreparedWindow]:
    """Collect prepared windows while ensuring the cache is refreshed."""

    return collect_prepared_windows(exchange, symbols, window_specs, anchor=anchor)


def retrain_from_cache(prepared_windows: Sequence[PreparedWindow]) -> TrainingArtifacts:
    combined = assemble_training_dataframe(prepared_windows)
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
    return artifacts


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
    timeframe_single = os.environ.get("XGB_TIMEFRAME")
    timeframes_env = os.environ.get("XGB_TIMEFRAMES")
    window_specs_env = os.environ.get("XGB_WINDOW_SPECS")
    lookback_env = os.environ.get("XGB_LOOKBACK_HOURS")
    offset_env = os.environ.get("XGB_OFFSET_HOURS")

    timeframe_values: tuple[str, ...] | None = None
    if timeframes_env:
        timeframe_values = tuple(
            part.strip()
            for part in timeframes_env.replace(";", ",").split(",")
            if part.strip()
        )
        if not timeframe_values:
            timeframe_values = None

    window_specs = resolve_window_specs(
        timeframe=timeframe_single,
        timeframes=timeframe_values,
        lookback_hours=lookback_env,
        offset_hours=offset_env,
        window_specs=window_specs_env,
    )
    if not window_specs:
        window_specs = DEFAULT_WINDOW_SPECS

    _seed_everything()
    frames = refresh_cache(exchange, symbols, tuple(window_specs))
    artifacts = retrain_from_cache(frames)
    payload = {
        "metrics": artifacts.metrics,
        "classOrder": artifacts.class_order,
        "calibration": artifacts.calibration,
        "featureCount": len(artifacts.features),
    }
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
