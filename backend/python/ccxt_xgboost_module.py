"""Utility helpers for training the QuantAI Labs direction classifier.

The module keeps the implementation minimal so it can run inside CI.
It collects OHLCV data via CCXT (with a local CSV cache), prepares
technical indicators, trains an XGBoost classifier and persists the
model alongside the ordered feature list.
"""
from __future__ import annotations

import json
import os
import random
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

from math import exp

try:  # pragma: no cover - optional dependency
    import ccxt  # type: ignore
except Exception:  # pragma: no cover
    ccxt = None  # type: ignore

try:  # Optional heavy deps
    import numpy as np
    import pandas as pd
    import ta  # type: ignore
    from sklearn.metrics import accuracy_score, f1_score
    from sklearn.model_selection import train_test_split
    HAVE_PANDAS = True
except Exception:  # pragma: no cover - fallback path
    np = None  # type: ignore
    pd = None  # type: ignore
    ta = None  # type: ignore
    accuracy_score = None  # type: ignore
    f1_score = None  # type: ignore
    train_test_split = None  # type: ignore
    HAVE_PANDAS = False

try:  # pragma: no cover - optional dependency
    from xgboost import XGBClassifier as NativeXGBClassifier  # type: ignore
    HAVE_XGBOOST = True
except Exception:  # pragma: no cover
    NativeXGBClassifier = None
    HAVE_XGBOOST = False


class XGBClassifier:  # type: ignore
    """Wrapper with a deterministic fallback when xgboost is unavailable."""

    def __init__(self, **kwargs):
        if HAVE_XGBOOST:
            self._native = NativeXGBClassifier(**kwargs)
            self._weights = None
            self._bias = 0.0
        else:
            self._native = None
            self._weights = None
            self._bias = 0.0

    def fit(self, X, y):
        if self._native is not None:
            return self._native.fit(X, y)
        rows = [list(map(float, row)) for row in X]
        targets = [float(val) for val in y]
        if not rows:
            self._weights = []
            self._bias = 0.0
            return self
        pos = [row for row, target in zip(rows, targets) if target >= 0.5]
        neg = [row for row, target in zip(rows, targets) if target < 0.5]
        if not pos:
            pos = rows
        if not neg:
            neg = rows

        def mean_vector(samples):
            return [sum(col) / len(samples) for col in zip(*samples)]

        pos_mean = mean_vector(pos)
        neg_mean = mean_vector(neg)
        self._weights = [p - n for p, n in zip(pos_mean, neg_mean)]
        self._bias = -0.5 * (
            sum(p * p for p in pos_mean) - sum(n * n for n in neg_mean)
        )
        return self

    def predict_proba(self, X):
        if self._native is not None:
            return self._native.predict_proba(X)
        if self._weights is None:
            raise RuntimeError('Model not trained')
        results = []
        for row in X:
            values = list(map(float, row))
            logit = sum(w * v for w, v in zip(self._weights, values)) + self._bias
            prob = 1 / (1 + exp(-logit))
            prob = max(1e-6, min(1 - 1e-6, prob))
            results.append((1 - prob, prob))
        return results

    def predict(self, X):
        probs = self.predict_proba(X)
        return [1 if pair[1] >= 0.5 else 0 for pair in probs]

    def save_model(self, path: Path | str):
        path = Path(path)
        if self._native is not None:
            self._native.save_model(path)
            return
        payload = {
            "weights": list(self._weights) if self._weights is not None else [],
            "bias": float(self._bias),
        }
        path.write_text(json.dumps(payload))

    def load_model(self, path: Path | str):
        path = Path(path)
        if self._native is not None:
            self._native.load_model(path)
            return
        payload = json.loads(path.read_text())
        self._weights = [float(x) for x in payload.get("weights", [])]
        self._bias = float(payload.get("bias", 0.0))

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "ccxt_cache"
MODEL_PATH = Path(__file__).resolve().parent / "xgboost_direction.model"
FEATURE_PATH = Path(__file__).resolve().parent / "features.txt"
METRICS_PATH = Path(__file__).resolve().parent / "training_metrics.json"

DEFAULT_EXCHANGE = "binance"
DEFAULT_SYMBOLS = ("BTC/USDT","ETH/USDT","SOL/USDT","XRP/USDT")
DEFAULT_TIMEFRAME = "15m"
DEFAULT_LOOKBACK_HOURS = 24 * 30  # 30 days

RANDOM_SEED = 42


@dataclass
class TrainingArtifacts:
    model: XGBClassifier
    features: List[str]
    metrics: Dict[str, float]


def _seed_everything(seed: int = RANDOM_SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)


def _cache_path(exchange: str, symbol: str, timeframe: str) -> Path:
    safe_symbol = symbol.replace("/", "_").replace(":", "_")
    filename = f"{exchange.lower()}_{safe_symbol}_{timeframe}.csv"
    return CACHE_DIR / filename


def load_cached_ohlcv(exchange: str, symbol: str, timeframe: str) -> pd.DataFrame:
    path = _cache_path(exchange, symbol, timeframe)
    if path.exists():
        return pd.read_csv(path, parse_dates=["timestamp"])
    return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])


def save_cached_ohlcv(exchange: str, symbol: str, timeframe: str, df: pd.DataFrame) -> None:
    path = _cache_path(exchange, symbol, timeframe)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)


def fetch_ohlcv(
    exchange_name: str,
    symbol: str,
    timeframe: str,
    start_ts: int,
    end_ts: int,
) -> pd.DataFrame:
    """Fetch OHLCV data between two timestamps inclusive.

    The function keeps requests minimal for CI. When CCXT fails or
    network access is restricted, it returns the cached data slice.
    """

    cache = load_cached_ohlcv(exchange_name, symbol, timeframe)
    if cache.empty:
        cache_start = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc)
        cache_end = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc)
        print(
            f"[ccxt_xgboost_module] cache empty, attempting fetch {exchange_name} {symbol} {timeframe}"
            f" between {cache_start} and {cache_end}",
            file=sys.stderr,
        )

    try:
        exchange_class = getattr(ccxt, exchange_name)
        exchange = exchange_class({"enableRateLimit": True})
        since = start_ts
        all_rows: List[List[float]] = []
        while since < end_ts:
            batch = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since, limit=500)
            if not batch:
                break
            all_rows.extend(batch)
            since = batch[-1][0] + 1
            # Avoid hitting rate limits in CI
            if len(all_rows) >= 2000:
                break
        if not all_rows:
            raise RuntimeError("Empty OHLCV response")
        df = pd.DataFrame(all_rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
        df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
        frames = [frame for frame in (cache, df) if not frame.empty]
        if frames:
            merged = pd.concat(frames, ignore_index=True)
        else:
            merged = pd.DataFrame(columns=df.columns)
        merged = merged.drop_duplicates(subset=["timestamp"], keep="last").sort_values("timestamp")
        save_cached_ohlcv(exchange_name, symbol, timeframe, merged)
        window = merged[(merged["timestamp"] >= pd.to_datetime(start_ts, unit="ms", utc=True)) &
                        (merged["timestamp"] <= pd.to_datetime(end_ts, unit="ms", utc=True))]
        return window.reset_index(drop=True)
    except Exception as error:  # pragma: no cover - network errors expected
        print(
            f"[ccxt_xgboost_module] fetch failed ({error}); falling back to cache",
            file=sys.stderr,
        )
        if cache.empty:
            # Build a small synthetic dataset to keep training deterministic offline
            timestamps = pd.date_range(
                start=pd.to_datetime(start_ts, unit="ms", utc=True),
                end=pd.to_datetime(end_ts, unit="ms", utc=True),
                freq="15min",
            )
            synthetic = pd.DataFrame({
                "timestamp": timestamps,
                "open": np.linspace(100, 110, len(timestamps)),
                "high": np.linspace(101, 111, len(timestamps)),
                "low": np.linspace(99, 109, len(timestamps)),
                "close": np.linspace(100, 111, len(timestamps)) + np.sin(np.linspace(0, 6.28, len(timestamps))),
                "volume": np.linspace(1_000, 1_500, len(timestamps)),
            })
            save_cached_ohlcv(exchange_name, symbol, timeframe, synthetic)
            cache = synthetic
        window = cache[(cache["timestamp"] >= pd.to_datetime(start_ts, unit="ms", utc=True)) &
                       (cache["timestamp"] <= pd.to_datetime(end_ts, unit="ms", utc=True))]
        if window.empty:
            return cache.copy().reset_index(drop=True)
        return window.reset_index(drop=True)


def prepare_dataset(df_raw: pd.DataFrame) -> pd.DataFrame:
    if not HAVE_PANDAS or pd is None or ta is None:
        raise RuntimeError('Dataset preparation requires pandas and ta-lib dependencies')
    """Compute indicators and target labels from OHLCV candles."""

    if df_raw.empty:
        raise ValueError("No OHLCV data available for dataset preparation")

    df = df_raw.sort_values("timestamp").copy()
    df.set_index("timestamp", inplace=True)

    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]

    df["ema20"] = ta.trend.EMAIndicator(close, window=20, fillna=True).ema_indicator()
    df["ema50"] = ta.trend.EMAIndicator(close, window=50, fillna=True).ema_indicator()
    df["ema100"] = ta.trend.EMAIndicator(close, window=100, fillna=True).ema_indicator()
    df["ema200"] = ta.trend.EMAIndicator(close, window=200, fillna=True).ema_indicator()
    df["rsi14"] = ta.momentum.RSIIndicator(close, window=14, fillna=True).rsi()
    df["atr14"] = ta.volatility.AverageTrueRange(high, low, close, window=14, fillna=True).average_true_range()
    df["adx14"] = ta.trend.ADXIndicator(high, low, close, window=14, fillna=True).adx()
    df["ema20Slope"] = df["ema20"].diff()
    df["volumeRatio"] = volume / volume.rolling(window=20, min_periods=1).mean()

    future_close = close.shift(-3)
    df["target"] = (future_close > close).astype(int)

    df = df.dropna().copy()
    df = df.replace([np.inf, -np.inf], np.nan).dropna()

    features = [
        "ema20",
        "ema50",
        "ema100",
        "ema200",
        "rsi14",
        "atr14",
        "adx14",
        "ema20Slope",
        "volumeRatio",
    ]

    dataset = df[features + ["target"]]
    return dataset.reset_index()


def train_model(data: pd.DataFrame, params: Dict[str, float | int | str]) -> TrainingArtifacts:
    if not HAVE_PANDAS or train_test_split is None or accuracy_score is None or f1_score is None:
        raise RuntimeError('Model training requires scikit-learn and pandas')
    if data.empty:
        raise ValueError("Training dataset is empty")

    features = [col for col in data.columns if col not in {"timestamp", "target"}]
    X = data[features]
    y = data["target"]

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.2,
        shuffle=False,
    )

    model = XGBClassifier(
        objective="binary:logistic",
        eval_metric="logloss",
        seed=RANDOM_SEED,
        **params,
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    accuracy = float(accuracy_score(y_test, preds))
    f1 = float(f1_score(y_test, preds))
    if any(map(lambda value: value != value, (accuracy, f1))):  # NaN check without math dependency
        raise ValueError("Training metrics produced NaN; aborting")

    metrics = {
        "accuracy": accuracy,
        "f1": f1,
    }

    return TrainingArtifacts(model=model, features=features, metrics=metrics)


def save_model_and_features(artifacts: TrainingArtifacts) -> None:
    artifacts.model.save_model(MODEL_PATH)
    FEATURE_PATH.write_text("\n".join(artifacts.features))
    METRICS_PATH.write_text(json.dumps(artifacts.metrics, indent=2))


def load_features() -> List[str]:
    if FEATURE_PATH.exists():
        return [line.strip() for line in FEATURE_PATH.read_text().splitlines() if line.strip()]
    raise FileNotFoundError("features.txt not found")


def load_model() -> XGBClassifier:
    model = XGBClassifier()
    model.load_model(MODEL_PATH)
    return model


def predict_direction(model: XGBClassifier, latest_row) -> int:
    features = load_features()
    if HAVE_PANDAS and pd is not None and isinstance(latest_row, pd.DataFrame):  # type: ignore
        if latest_row.empty:
            raise ValueError("latest_row is empty")
        ordered = [float(latest_row.iloc[-1][col]) for col in features]
    elif isinstance(latest_row, dict):
        missing = [col for col in features if col not in latest_row]
        if missing:
            raise ValueError(f"Missing features: {missing}")
        ordered = [float(latest_row[col]) for col in features]
    else:
        raise TypeError('latest_row must be a DataFrame or dict of features')

    probs = model.predict_proba([ordered])
    prob = probs[0][1]
    return int(prob >= 0.5)


def run_training_workflow(
    exchange: str = DEFAULT_EXCHANGE,
    symbols: List[str] | tuple[str, ...] = DEFAULT_SYMBOLS,
    timeframe: str = DEFAULT_TIMEFRAME,
    lookback_hours: int = DEFAULT_LOOKBACK_HOURS,
) -> TrainingArtifacts:
    if not HAVE_PANDAS:
        raise RuntimeError('Training workflow requires pandas/numpy/ta/scikit-learn packages')
    _seed_everything()
    end = datetime.now(tz=timezone.utc)
    start = end - pd.Timedelta(hours=lookback_hours)
    start_ts = int(start.timestamp() * 1000)
    end_ts = int(end.timestamp() * 1000)

    datasets: List[pd.DataFrame] = []
    for symbol in symbols:
        raw = fetch_ohlcv(exchange, symbol, timeframe, start_ts, end_ts)
        prepared = prepare_dataset(raw)
        prepared = prepared.copy()
        prepared["symbol"] = symbol
        datasets.append(prepared)

    if not datasets:
        raise ValueError("No symbols provided for training workflow")

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
    timeframe = os.environ.get("XGB_TIMEFRAME", DEFAULT_TIMEFRAME)
    lookback = int(os.environ.get("XGB_LOOKBACK_HOURS", str(DEFAULT_LOOKBACK_HOURS)))

    artifacts = run_training_workflow(exchange, symbols, timeframe, lookback)
    print(json.dumps({"metrics": artifacts.metrics, "features": artifacts.features}))


if __name__ == "__main__":
    main()
