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
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from decimal import Decimal, getcontext
from math import exp
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

try:  # pragma: no cover - optional dependency
    import ccxt  # type: ignore
except Exception:  # pragma: no cover
    ccxt = None  # type: ignore

try:  # Optional heavy deps
    import numpy as np
    import pandas as pd
    import ta  # type: ignore
    from sklearn.metrics import accuracy_score, f1_score, confusion_matrix, roc_auc_score
    HAVE_PANDAS = True
except Exception:  # pragma: no cover - fallback path
    np = None  # type: ignore
    pd = None  # type: ignore
    ta = None  # type: ignore
    accuracy_score = None  # type: ignore
    f1_score = None  # type: ignore
    confusion_matrix = None  # type: ignore
    roc_auc_score = None  # type: ignore
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
            self._classes: List[int] = []
            self._centroids: Dict[int, List[float]] = {}

    def fit(self, X, y):
        if self._native is not None:
            return self._native.fit(X, y)
        rows = [list(map(float, row)) for row in X]
        targets = [int(val) for val in y]
        if not rows:
            self._classes = []
            self._centroids = {}
            return self
        self._classes = sorted({int(label) for label in targets})
        if not self._classes:
            self._classes = [0]

        def mean_vector(samples: List[List[float]]) -> List[float]:
            if not samples:
                return [0.0 for _ in rows[0]]
            return [sum(col) / len(samples) for col in zip(*samples)]

        overall_mean = mean_vector(rows)
        centroids: Dict[int, List[float]] = {}
        for cls in self._classes:
            samples = [row for row, target in zip(rows, targets) if target == cls]
            if not samples:
                centroids[cls] = list(overall_mean)
            else:
                centroids[cls] = mean_vector(samples)

        # Ensure all expected classes are represented to keep probability vectors aligned.
        for cls in range(len(CLASS_ORDER)):
            if cls not in centroids:
                centroids[cls] = list(overall_mean)
        self._classes = sorted(centroids.keys())
        self._centroids = centroids
        return self

    def predict_proba(self, X):
        if self._native is not None:
            return self._native.predict_proba(X)
        if not self._centroids:
            raise RuntimeError('Model not trained')
        results: List[List[float]] = []
        for row in X:
            values = list(map(float, row))
            scores: List[float] = []
            for cls in self._classes:
                centroid = self._centroids[cls]
                # Negative squared distance for a softmax-friendly score.
                diff = [v - c for v, c in zip(values, centroid)]
                score = -sum(val * val for val in diff)
                scores.append(score)
            max_score = max(scores)
            exp_scores = [exp(score - max_score) for score in scores]
            total = sum(exp_scores)
            if total <= 0:
                probs = [1.0 / len(exp_scores) for _ in exp_scores]
            else:
                probs = [val / total for val in exp_scores]
            results.append(probs)
        return np.asarray(results)

    def predict(self, X):
        probs = self.predict_proba(X)
        if HAVE_XGBOOST:
            return self._native.predict(X)  # type: ignore[attr-defined]
        return [int(np.argmax(pair)) for pair in probs]

    def save_model(self, path: Path | str):
        path = Path(path)
        if self._native is not None:
            self._native.save_model(path)
            return
        payload = {
            "classes": list(self._classes),
            "centroids": {str(cls): list(values) for cls, values in self._centroids.items()},
        }
        path.write_text(json.dumps(payload))

    def load_model(self, path: Path | str):
        path = Path(path)
        if self._native is not None:
            self._native.load_model(path)
            return
        payload = json.loads(path.read_text())
        classes = payload.get("classes", [])
        if not isinstance(classes, list):
            classes = []
        self._classes = [int(cls) for cls in classes]
        centroids_raw = payload.get("centroids", {})
        mapped: Dict[int, List[float]] = {}
        if isinstance(centroids_raw, dict):
            for key, values in centroids_raw.items():
                try:
                    cls = int(key)
                except (TypeError, ValueError):
                    continue
                mapped[cls] = [float(val) for val in values]
        self._centroids = mapped

CACHE_DIR = Path(__file__).resolve().parents[1] / "data" / "ccxt_cache"
MODEL_PATH = Path(__file__).resolve().parent / "xgboost_direction.json"
FEATURE_PATH = Path(__file__).resolve().parent / "features.txt"
METRICS_PATH = Path(__file__).resolve().parent / "training_metrics.json"
METADATA_PATH = Path(__file__).resolve().parent / "predictor_metadata.json"

DEFAULT_EXCHANGE = "binance"
DEFAULT_SYMBOLS = (
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "XRP/USDT",
    "BNB/USDT",
    "ADA/USDT",
    "AVAX/USDT",
    "DOGE/USDT",
    "TON/USDT",
    "LINK/USDT",
    "MATIC/USDT",
    "DOT/USDT",
)
DEFAULT_TIMEFRAME = "15m"
DEFAULT_LOOKBACK_HOURS = 24 * 180  # 6 months


@dataclass(frozen=True)
class WindowSpec:
    """Describe a historical slice to gather training samples from."""

    timeframe: str
    hours: int
    offset_hours: int = 0

    @property
    def interval_minutes(self) -> int:
        return _timeframe_to_minutes(self.timeframe)

    def bounds(self, anchor: datetime) -> tuple[int, int]:
        """Return (start_ts_ms, end_ts_ms) for this window."""

        end = anchor - timedelta(hours=self.offset_hours)
        start = end - timedelta(hours=self.hours)
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


@dataclass
class PreparedWindow:
    symbol: str
    spec: WindowSpec
    dataset: "pd.DataFrame"


DEFAULT_WINDOW_SPECS: Sequence[WindowSpec] = (
    WindowSpec(DEFAULT_TIMEFRAME, hours=DEFAULT_LOOKBACK_HOURS, offset_hours=0),
)


@dataclass(frozen=True)
class WindowSpec:
    """Describe a historical slice to gather training samples from."""

    timeframe: str
    hours: int
    offset_hours: int = 0

    @property
    def interval_minutes(self) -> int:
        return _timeframe_to_minutes(self.timeframe)

    def bounds(self, anchor: datetime) -> tuple[int, int]:
        """Return (start_ts_ms, end_ts_ms) for this window."""

        end = anchor - timedelta(hours=self.offset_hours)
        start = end - timedelta(hours=self.hours)
        return int(start.timestamp() * 1000), int(end.timestamp() * 1000)


@dataclass
class PreparedWindow:
    symbol: str
    spec: WindowSpec
    dataset: "pd.DataFrame"


DEFAULT_WINDOW_SPECS: Sequence[WindowSpec] = (
    WindowSpec("15m", hours=24 * 90, offset_hours=0),
    WindowSpec("1h", hours=24 * 365, offset_hours=0),
    WindowSpec("4h", hours=24 * 365 * 2, offset_hours=0),
)

RANDOM_SEED = 42
getcontext().prec = 28

CLASS_ORDER = ["long", "none", "short"]
CLASS_TO_INDEX = {label: idx for idx, label in enumerate(CLASS_ORDER)}


@dataclass
class TrainingArtifacts:
    model: XGBClassifier
    features: List[str]
    class_order: List[str]
    calibration: Dict[str, float]
    metrics: Dict[str, float]


def _seed_everything(seed: int = RANDOM_SEED) -> None:
    random.seed(seed)
    np.random.seed(seed)


def _timeframe_to_minutes(timeframe: str) -> int:
    if not timeframe:
        raise ValueError("timeframe cannot be empty")
    unit = timeframe[-1]
    try:
        value = int(timeframe[:-1])
    except ValueError as exc:  # pragma: no cover - validated by caller
        raise ValueError(f"Invalid timeframe value: {timeframe}") from exc
    multipliers = {"m": 1, "h": 60, "d": 60 * 24, "w": 60 * 24 * 7}
    if unit not in multipliers:
        raise ValueError(f"Unsupported timeframe unit: {timeframe}")
    return value * multipliers[unit]


def _timeframe_to_pandas_freq(timeframe: str) -> str:
    unit = timeframe[-1]
    value = timeframe[:-1]
    suffix_map = {"m": "min", "h": "h", "d": "D", "w": "W"}
    if unit not in suffix_map:
        raise ValueError(f"Unsupported timeframe unit: {timeframe}")
    return f"{int(value)}{suffix_map[unit]}"


def _parse_int_list(raw: str | None) -> List[int]:
    if not raw:
        return []
    normalized = raw.replace(";", ",")
    result: List[int] = []
    for part in normalized.split(","):
        chunk = part.strip()
        if not chunk:
            continue
        result.append(int(chunk))
    return result


def _expand_values(values: Sequence[int], length: int, fallback: int) -> List[int]:
    if length <= 0:
        return []
    if not values:
        return [fallback] * length
    if len(values) == 1 and length > 1:
        return list(values) * length
    if len(values) < length:
        tail = values[-1]
        return list(values) + [tail] * (length - len(values))
    return list(values[:length])


def _parse_window_specs_env(raw: str) -> Sequence[WindowSpec]:
    if not raw:
        raise ValueError("XGB_WINDOW_SPECS cannot be empty")
    specs: List[WindowSpec] = []
    for chunk in raw.replace(";", ",").split(","):
        piece = chunk.strip()
        if not piece:
            continue
        parts = [part.strip() for part in piece.split(":") if part.strip()]
        if len(parts) < 2:
            raise ValueError(
                "Each window spec must provide at least timeframe and hours (e.g. '15m:720:0')"
            )
        timeframe = parts[0]
        hours = int(parts[1])
        offset = int(parts[2]) if len(parts) > 2 else 0
        specs.append(WindowSpec(timeframe=timeframe, hours=hours, offset_hours=offset))
    if not specs:
        raise ValueError("No valid window specs parsed from environment string")
    return specs


def resolve_window_specs(
    timeframe: str | None = None,
    timeframes: Sequence[str] | None = None,
    lookback_hours: str | None = None,
    offset_hours: str | None = None,
    window_specs: str | None = None,
) -> Sequence[WindowSpec]:
    """Resolve the collection of windows the training run should cover."""

    if window_specs:
        return tuple(_parse_window_specs_env(window_specs))

    frames: List[str] = []
    if timeframes:
        frames = [value.strip() for value in timeframes if value.strip()]
    elif timeframe:
        frames = [timeframe.strip()]

    if not frames:
        return tuple(DEFAULT_WINDOW_SPECS)

    lookbacks = _expand_values(
        _parse_int_list(lookback_hours), len(frames), DEFAULT_LOOKBACK_HOURS
    )
    offsets = _expand_values(_parse_int_list(offset_hours), len(frames), 0)

    return tuple(
        WindowSpec(timeframe=frame, hours=hours, offset_hours=offset)
        for frame, hours, offset in zip(frames, lookbacks, offsets)
    )


def collect_prepared_windows(
    exchange: str,
    symbols: Sequence[str],
    window_specs: Sequence[WindowSpec],
    anchor: datetime | None = None,
) -> List[PreparedWindow]:
    if not HAVE_PANDAS or pd is None:
        raise RuntimeError('Preparing windows requires pandas to be installed')

    anchor_dt = anchor or datetime.now(tz=timezone.utc)
    prepared: List[PreparedWindow] = []
    for spec in window_specs:
        start_ts, end_ts = spec.bounds(anchor_dt)
        for symbol in symbols:
            raw = fetch_ohlcv(exchange, symbol, spec.timeframe, start_ts, end_ts)
            dataset = prepare_dataset(raw)
            prepared.append(PreparedWindow(symbol=symbol, spec=spec, dataset=dataset))
    return prepared


def assemble_training_dataframe(prepared_windows: Sequence[PreparedWindow]) -> "pd.DataFrame":
    if not HAVE_PANDAS or pd is None:
        raise RuntimeError('Assembling training data requires pandas to be installed')
    if not prepared_windows:
        raise ValueError("No prepared windows provided for training")

    frames: List[pd.DataFrame] = []
    for idx, prepared in enumerate(prepared_windows):
        frame = prepared.dataset.copy()
        frame["symbol"] = prepared.symbol
        frame["windowIndex"] = idx
        frame["timeframeMinutes"] = prepared.spec.interval_minutes
        frame["windowOffsetHours"] = prepared.spec.offset_hours
        frame["windowHours"] = prepared.spec.hours
        frames.append(frame)

    combined = pd.concat(frames, ignore_index=True)
    return combined.drop(
        columns=[
            "symbol",
            "windowIndex",
            "timeframeMinutes",
            "windowOffsetHours",
            "windowHours",
        ],
        errors="ignore",
    )


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
            freq = _timeframe_to_pandas_freq(timeframe)
            timestamps = pd.date_range(
                start=pd.to_datetime(start_ts, unit="ms", utc=True),
                end=pd.to_datetime(end_ts, unit="ms", utc=True),
                freq=freq,
            )
            if len(timestamps) == 0:
                timestamps = pd.date_range(
                    start=pd.to_datetime(start_ts, unit="ms", utc=True),
                    periods=64,
                    freq=freq,
                )

            seed_source = f"{exchange_name}:{symbol}:{timeframe}:{start_ts}:{end_ts}".encode()
            seed = zlib.crc32(seed_source)
            rng = np.random.default_rng(seed)

            trend = np.full(len(timestamps), 100.0)
            cycle = np.sin(np.linspace(0, 24 * np.pi, len(timestamps))) * 1.8
            walk = rng.normal(0.0, 0.4, len(timestamps)).cumsum() * 0.12
            close = trend + cycle + walk
            open_delta = rng.normal(0.0, 0.3, len(timestamps))
            open_prices = close + open_delta
            spread = np.abs(rng.normal(0.6, 0.25, len(timestamps))) + 0.05
            high = np.maximum(close, open_prices) + spread
            low = np.minimum(close, open_prices) - spread
            low = np.clip(low, 0.01, None)
            volume = rng.uniform(800, 2200, len(timestamps))

            synthetic = pd.DataFrame({
                "timestamp": timestamps,
                "open": open_prices,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
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
    df["emaTrendSpread"] = (df["ema20"] - df["ema50"]) / df["ema50"].replace(0, np.nan)
    df["rsiSlope"] = df["rsi14"].diff()
    df["atrPct"] = df["atr14"] / close.replace(0, np.nan)
    df["volumeZScore"] = (volume - volume.rolling(window=40, min_periods=1).mean()) / volume.rolling(window=40, min_periods=1).std(ddof=0)
    df["momentum3"] = close.pct_change(periods=3)

    # Multi-timeframe approximations (rolling over intra-series windows)
    df["atrPct_1h"] = df["atrPct"].rolling(window=4, min_periods=1).mean()
    df["atrPct_4h"] = df["atrPct"].rolling(window=16, min_periods=1).mean()
    df["rsi14_1h"] = df["rsi14"].rolling(window=4, min_periods=1).mean()
    df["rsi14_4h"] = df["rsi14"].rolling(window=16, min_periods=1).mean()
    df["emaRatio_20_200"] = df["ema20"] / df["ema200"].replace(0, np.nan)
    df["trendStrength"] = (df["ema20"] - df["ema100"]) / df["ema100"].replace(0, np.nan)
    df["volatilityRegime"] = df["atrPct"].rolling(window=20, min_periods=1).mean()
    df["spreadProxy"] = (df["high"] - df["low"]) / close.replace(0, np.nan)
    df["microImbalance"] = df["momentum3"].rolling(window=5, min_periods=1).mean()
    df["mtfAgreement"] = np.sign(df["ema20"] - df["ema50"]) + np.sign(df["ema50"] - df["ema100"]) + np.sign(df["ema100"] - df["ema200"])

    horizon = int(os.environ.get("PREDICTOR_FUTURE_HORIZON", "12"))
    horizon = max(1, min(64, horizon))
    gamma = float(os.environ.get("PREDICTOR_LABEL_GAMMA", "0.45"))
    future_close = close.shift(-horizon)
    df["futureClose"] = future_close
    future_return = (future_close - close) / close.replace(0, np.nan)
    atr_threshold = df["atrPct"].rolling(window=horizon, min_periods=1).mean()
    theta = gamma * atr_threshold
    df["futureReturn"] = future_return

    long_mask = future_return >= theta
    short_mask = future_return <= -theta
    target = np.full(len(df), 1, dtype=int)  # default none class index
    target[long_mask] = 0
    target[short_mask] = 2
    df["target"] = target
    df["targetLabel"] = np.where(long_mask, "long", np.where(short_mask, "short", "none"))

    df = df.dropna().copy()
    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    df = df.reset_index()

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
        "emaTrendSpread",
        "rsiSlope",
        "atrPct",
        "atrPct_1h",
        "atrPct_4h",
        "rsi14_1h",
        "rsi14_4h",
        "volumeZScore",
        "momentum3",
        "emaRatio_20_200",
        "trendStrength",
        "volatilityRegime",
        "spreadProxy",
        "microImbalance",
        "mtfAgreement",
    ]

    dataset = df[["timestamp", "close", "futureClose", "futureReturn"] + features + ["target", "targetLabel"]]
    return dataset.reset_index()


def _ensure_minimum_class_coverage(
    X_train: "pd.DataFrame",
    y_train: "pd.Series",
) -> Tuple["pd.DataFrame", "pd.Series"]:
    """Duplicate representative samples so each class is present at least once."""

    unique_classes = set(int(label) for label in y_train.unique())
    if len(unique_classes) == len(CLASS_ORDER):
        return X_train, y_train
    baseline_row = X_train.mean(axis=0)
    if baseline_row.isnull().any():
        baseline_row = X_train.fillna(0).iloc[0]
    additions = []
    targets: List[int] = []
    for idx in range(len(CLASS_ORDER)):
        if idx in unique_classes:
            continue
        additions.append(baseline_row)
        targets.append(idx)
    if additions:
        synthetic = pd.DataFrame(additions, columns=X_train.columns)  # type: ignore[arg-type]
        X_train = pd.concat([X_train, synthetic], ignore_index=True)
        y_train = pd.concat([y_train, pd.Series(targets)], ignore_index=True)
    return X_train, y_train


def _apply_temperature_scaling(probabilities: "np.ndarray", temperature: float) -> "np.ndarray":
    if temperature <= 0 or not np.isfinite(temperature):
        return probabilities
    logits = np.log(np.clip(probabilities, 1e-12, 1.0))
    scaled = logits / temperature
    max_vals = np.max(scaled, axis=1, keepdims=True)
    exp_scaled = np.exp(scaled - max_vals)
    sums = np.sum(exp_scaled, axis=1, keepdims=True)
    return exp_scaled / np.clip(sums, 1e-12, None)


def _temperature_search(
    probabilities: "np.ndarray",
    labels: "np.ndarray",
) -> Tuple[float, float, "np.ndarray"]:
    if len(probabilities) == 0:
        return 1.0, float("nan"), probabilities
    best_temperature = 1.0
    best_nll = float("inf")
    best_probs = probabilities
    for temperature in np.linspace(0.5, 4.5, 41):
        calibrated = _apply_temperature_scaling(probabilities, float(temperature))
        nll = -float(
            np.mean(
                np.log(
                    np.clip(
                        calibrated[np.arange(len(labels)), labels],
                        1e-12,
                        1.0,
                    )
                )
            )
        )
        if not np.isfinite(nll):
            continue
        if nll < best_nll:
            best_nll = nll
            best_temperature = float(temperature)
            best_probs = calibrated
    return best_temperature, best_nll, best_probs


def train_model(data: pd.DataFrame, params: Dict[str, float | int | str]) -> TrainingArtifacts:
    if not HAVE_PANDAS or accuracy_score is None or f1_score is None:
        raise RuntimeError('Model training requires scikit-learn and pandas')
    if data.empty:
        raise ValueError("Training dataset is empty")

    feature_exclusions = {
        "timestamp",
        "target",
        "targetLabel",
        "close",
        "futureClose",
        "futureReturn",
        "index",
    }
    features = [col for col in data.columns if col not in feature_exclusions]
    X = data[features]
    y = data["target"]

    split_index = max(1, int(len(X) * 0.8))
    if split_index >= len(X):
        split_index = max(1, len(X) - 1)

    X_train = X.iloc[:split_index]
    y_train = y.iloc[:split_index]
    X_test = X.iloc[split_index:]
    y_test = y.iloc[split_index:]
    closes_test = data["close"].iloc[split_index:]
    future_test = data["futureClose"].iloc[split_index:]
    timestamps_test = data["timestamp"].iloc[split_index:]

    if X_test.empty:
        raise ValueError("Insufficient samples for validation split")

    X_train, y_train = _ensure_minimum_class_coverage(X_train, y_train)

    model = XGBClassifier(
        objective="multi:softprob",
        eval_metric="mlogloss",
        num_class=len(CLASS_ORDER),
        seed=RANDOM_SEED,
        **params,
    )
    model.fit(X_train, y_train)

    preds = model.predict(X_test)
    accuracy = float(accuracy_score(y_test, preds))
    f1_macro = float(f1_score(y_test, preds, average="macro", zero_division=0))
    f1_per_class = f1_score(
        y_test,
        preds,
        labels=list(range(len(CLASS_ORDER))),
        average=None,
        zero_division=0,
    )
    if any(value != value for value in (accuracy, f1_macro)):  # NaN guard
        raise ValueError("Training metrics produced NaN; aborting")

    prob_matrix = model.predict_proba(X_test)
    if not isinstance(prob_matrix, np.ndarray):
        prob_matrix = np.asarray(prob_matrix)
    if prob_matrix.ndim != 2 or prob_matrix.shape[1] != len(CLASS_ORDER):
        raise ValueError(f"Expected probability matrix with {len(CLASS_ORDER)} columns, got {prob_matrix.shape}")
    temperature, calibrated_nll, calibrated_probs = _temperature_search(prob_matrix, y_test.to_numpy(dtype=int))

    try:
        roc_auc = float(roc_auc_score(y_test, prob_matrix, multi_class="ovr"))
    except Exception:
        roc_auc = float("nan")

    base_log_loss = -float(
        np.mean(
            np.log(
                np.clip(
                    prob_matrix[np.arange(len(y_test)), y_test.to_numpy(dtype=int)],
                    1e-12,
                    1.0,
                )
            )
        )
    )

    confusion = confusion_matrix(
        y_test,
        preds,
        labels=list(range(len(CLASS_ORDER))),
    )

    metrics: Dict[str, float] = {
        "accuracy": accuracy,
        "f1Macro": f1_macro,
        "f1Long": float(f1_per_class[CLASS_TO_INDEX["long"]]) if len(f1_per_class) > CLASS_TO_INDEX["long"] else 0.0,
        "f1None": float(f1_per_class[CLASS_TO_INDEX["none"]]) if len(f1_per_class) > CLASS_TO_INDEX["none"] else 0.0,
        "f1Short": float(f1_per_class[CLASS_TO_INDEX["short"]]) if len(f1_per_class) > CLASS_TO_INDEX["short"] else 0.0,
        "rocAucMacro": roc_auc if np.isfinite(roc_auc) else 0.0,
        "logLoss": base_log_loss,
        "calibratedLogLoss": calibrated_nll if np.isfinite(calibrated_nll) else base_log_loss,
        "calibrationTemperature": temperature,
    }

    for actual_idx, actual_label in enumerate(CLASS_ORDER):
        for pred_idx, pred_label in enumerate(CLASS_ORDER):
            metrics[f"confusion_{actual_label}_pred_{pred_label}"] = float(confusion[actual_idx, pred_idx])

    backtest_metrics = compute_prediction_backtest_metrics(
        timestamps_test.reset_index(drop=True),
        closes_test.reset_index(drop=True),
        future_test.reset_index(drop=True),
        y_test.reset_index(drop=True),
        calibrated_probs,
    )

    metrics.update(backtest_metrics)

    if any(value != value for value in metrics.values()):
        raise ValueError("Training metrics produced NaN; aborting")

    calibration_payload = {"temperature": float(temperature)}

    return TrainingArtifacts(
        model=model,
        features=features,
        class_order=list(CLASS_ORDER),
        calibration=calibration_payload,
        metrics=metrics,
    )


def compute_prediction_backtest_metrics(
    timestamps: "pd.Series",
    closes: "pd.Series",
    future_closes: "pd.Series",
    targets: "pd.Series",
    probabilities,
    long_threshold: float = 0.55,
    short_threshold: float = 0.55,
    position_scale: float = 0.01,
) -> Dict[str, float]:
    """Evaluate sequential predictive performance and derive risk metrics."""

    prob_matrix = np.asarray(probabilities)
    if prob_matrix.ndim != 2 or prob_matrix.shape[1] != len(CLASS_ORDER):
        raise ValueError("compute_prediction_backtest_metrics expects probability matrix shaped (n_samples, n_classes)")

    if len(prob_matrix) != len(closes):
        raise ValueError("Probabilities and price series length mismatch")

    equity = Decimal("1")
    peak = equity
    equity_curve: List[Decimal] = [equity]
    trade_returns: List[Decimal] = []
    wins = 0
    trade_count = 0
    long_trades = 0
    short_trades = 0
    long_wins = 0
    short_wins = 0
    neutral_skips = 0
    directional_hits = 0

    for idx, row_probs in enumerate(prob_matrix):
        close = float(closes.iloc[idx])
        future_close = float(future_closes.iloc[idx])
        ts = timestamps.iloc[idx]
        if not isinstance(ts, datetime):
            ts = pd.Timestamp(ts).to_pydatetime()
        price_decimal = Decimal(str(close))
        future_decimal = Decimal(str(future_close))
        if price_decimal == 0:
            continue
        if not np.all(np.isfinite(row_probs)):
            continue

        scale = Decimal(str(position_scale))
        prob_long = float(row_probs[CLASS_TO_INDEX["long"]])
        prob_short = float(row_probs[CLASS_TO_INDEX["short"]])
        if prob_long >= long_threshold and prob_long >= prob_short:
            ret = ((future_decimal - price_decimal) / price_decimal) * scale
            direction = 1
            long_trades += 1
        elif prob_short >= short_threshold and prob_short > prob_long:
            ret = ((price_decimal - future_decimal) / price_decimal) * scale
            direction = -1
            short_trades += 1
        else:
            neutral_skips += 1
            continue

        trade_count += 1
        trade_returns.append(ret)
        if ret >= Decimal("0"):
            wins += 1
            if direction == 1:
                long_wins += 1
            else:
                short_wins += 1
        target_value = int(targets.iloc[idx]) if idx < len(targets) else 0
        if (direction == 1 and target_value == CLASS_TO_INDEX["long"]) or (
            direction == -1 and target_value == CLASS_TO_INDEX["short"]
        ):
            directional_hits += 1
        equity = equity * (Decimal("1") + ret)
        if equity > peak:
            peak = equity
        equity_curve.append(equity)

    if not trade_returns:
        return {
            "winRate": 0.0,
            "expectancy": 0.0,
            "gainLossRatio": 0.0,
            "trades": 0.0,
            "cagr": 0.0,
            "maxDrawdown": 0.0,
            "sharpe": 0.0,
        }

    expectancy = float(sum(trade_returns) / len(trade_returns))
    wins_series = [ret for ret in trade_returns if ret >= 0]
    losses_series = [ret for ret in trade_returns if ret < 0]
    avg_win = float(sum(wins_series) / len(wins_series)) if wins_series else 0.0
    avg_loss = float(sum(losses_series) / len(losses_series)) if losses_series else 0.0
    gain_loss_ratio = abs(avg_win / avg_loss) if losses_series else float("inf")
    win_rate = wins / trade_count if trade_count else 0.0
    directional_accuracy = directional_hits / trade_count if trade_count else 0.0
    long_win_rate = long_wins / long_trades if long_trades else 0.0
    short_win_rate = short_wins / short_trades if short_trades else 0.0

    start_time = pd.Timestamp(timestamps.iloc[0]).to_pydatetime()
    end_time = pd.Timestamp(timestamps.iloc[-1]).to_pydatetime()
    duration_seconds = max((end_time - start_time).total_seconds(), 1.0)
    years = Decimal(str(duration_seconds)) / Decimal(str(365 * 24 * 3600))
    if years <= 0:
        years = Decimal("1") / Decimal("365")
    cagr = float((equity_curve[-1] / equity_curve[0]) ** (Decimal("1") / years) - Decimal("1"))

    max_drawdown = Decimal("0")
    peak_value = equity_curve[0]
    for value in equity_curve[1:]:
        if value > peak_value:
            peak_value = value
        drawdown = (peak_value - value) / peak_value if peak_value != 0 else Decimal("0")
        if drawdown > max_drawdown:
            max_drawdown = drawdown

    returns_float = [float(ret) for ret in trade_returns]
    mean_return = sum(returns_float) / len(returns_float)
    variance = sum((ret - mean_return) ** 2 for ret in returns_float) / len(returns_float)
    sharpe = float("inf") if variance == 0 else mean_return / (variance ** 0.5)

    metrics = {
        "winRate": float(win_rate),
        "expectancy": expectancy,
        "gainLossRatio": float(gain_loss_ratio if np.isfinite(gain_loss_ratio) else 0.0),
        "trades": float(trade_count),
        "cagr": cagr,
        "maxDrawdown": float(max_drawdown),
        "sharpe": float(sharpe if np.isfinite(sharpe) else 0.0),
        "directionalAccuracy": float(directional_accuracy),
        "longTrades": float(long_trades),
        "shortTrades": float(short_trades),
        "longWinRate": float(long_win_rate),
        "shortWinRate": float(short_win_rate),
        "neutralDecisions": float(neutral_skips),
    }

    if any(value != value for value in metrics.values()):
        raise ValueError("Backtest metrics produced NaN; aborting")

    return metrics


def save_model_and_features(artifacts: TrainingArtifacts) -> None:
    artifacts.model.save_model(MODEL_PATH)
    FEATURE_PATH.write_text("\n".join(artifacts.features))
    METRICS_PATH.write_text(json.dumps(artifacts.metrics, indent=2))
    metadata_payload = {
        "classOrder": artifacts.class_order,
        "calibration": artifacts.calibration,
        "metrics": artifacts.metrics,
        "features": artifacts.features,
        "savedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    METADATA_PATH.write_text(json.dumps(metadata_payload, indent=2))


def load_features() -> List[str]:
    if FEATURE_PATH.exists():
        return [line.strip() for line in FEATURE_PATH.read_text().splitlines() if line.strip()]
    raise FileNotFoundError("features.txt not found")


def load_model() -> XGBClassifier:
    model = XGBClassifier()
    model.load_model(MODEL_PATH)
    return model


def predict_direction(model: XGBClassifier, latest_row) -> dict:
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

    probabilities = model.predict_proba([ordered])
    if not isinstance(probabilities, np.ndarray):
        probabilities = np.asarray(probabilities)
    row = probabilities[0]
    prob_long = float(row[CLASS_TO_INDEX["long"]])
    prob_short = float(row[CLASS_TO_INDEX["short"]])
    decision = 1 if prob_long >= prob_short else 0
    payload = {
        "prediction": decision,
        "probability": prob_long,
        "bearProbability": prob_short,
        "probabilities": {label: float(row[idx]) for label, idx in CLASS_TO_INDEX.items()},
    }
    return payload


def run_training_workflow(
    exchange: str = DEFAULT_EXCHANGE,
    symbols: Sequence[str] = DEFAULT_SYMBOLS,
    timeframe: str = DEFAULT_TIMEFRAME,
    lookback_hours: int = DEFAULT_LOOKBACK_HOURS,
    window_specs: Sequence[WindowSpec] | None = None,
    anchor: datetime | None = None,
) -> TrainingArtifacts:
    if not HAVE_PANDAS:
        raise RuntimeError('Training workflow requires pandas/numpy/ta/scikit-learn packages')
    _seed_everything()
    if window_specs is not None:
        specs = list(window_specs)
    elif timeframe != DEFAULT_TIMEFRAME or lookback_hours != DEFAULT_LOOKBACK_HOURS:
        specs = [WindowSpec(timeframe=timeframe, hours=lookback_hours, offset_hours=0)]
    else:
        specs = list(DEFAULT_WINDOW_SPECS)

    prepared_windows = collect_prepared_windows(exchange, symbols, specs, anchor=anchor)
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

    timeframe_values: Sequence[str] | None = None
    if timeframes_env:
        timeframe_values = tuple(
            part.strip()
            for part in timeframes_env.replace(";", ",").split(",")
            if part.strip()
        )
        if not timeframe_values:
            timeframe_values = None

    if lookback_env and any(sep in lookback_env for sep in (",", ";")):
        lookback_default = DEFAULT_LOOKBACK_HOURS
    else:
        lookback_default = int(lookback_env) if lookback_env else DEFAULT_LOOKBACK_HOURS
    timeframe_effective = timeframe_single or DEFAULT_TIMEFRAME

    window_specs = resolve_window_specs(
        timeframe=timeframe_single,
        timeframes=timeframe_values,
        lookback_hours=lookback_env,
        offset_hours=offset_env,
        window_specs=window_specs_env,
    )

    artifacts = run_training_workflow(
        exchange,
        symbols,
        timeframe=timeframe_effective,
        lookback_hours=lookback_default,
        window_specs=window_specs,
    )
    print(json.dumps({"metrics": artifacts.metrics, "features": artifacts.features}))


if __name__ == "__main__":
    main()
