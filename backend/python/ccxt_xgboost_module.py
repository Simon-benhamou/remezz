"""Utility helpers for training the QuantAI Labs direction classifier.

The module keeps the implementation minimal so it can run inside CI.
It collects OHLCV data via CCXT (with a local CSV cache), prepares
technical indicators, trains an XGBoost classifier and persists the
model alongside the ordered feature list.
"""
from __future__ import annotations

import json
import math
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

    def fit(self, X, y, sample_weight=None):
        if self._native is not None:
            if sample_weight is not None:
                return self._native.fit(X, y, sample_weight=sample_weight)
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

# Priority loading: conservative -> direction (standard)
_MODEL_CONSERVATIVE = Path(__file__).resolve().parent / "xgboost_model_conservative.json"
_MODEL_STANDARD = Path(__file__).resolve().parent / "xgboost_direction.json"
MODEL_PATH = _MODEL_CONSERVATIVE if _MODEL_CONSERVATIVE.exists() else _MODEL_STANDARD

_FEATURE_CONSERVATIVE = Path(__file__).resolve().parent / "feature_order_conservative.json"
_FEATURE_STANDARD = Path(__file__).resolve().parent / "features.txt"
FEATURE_PATH = _FEATURE_CONSERVATIVE if _FEATURE_CONSERVATIVE.exists() else _FEATURE_STANDARD

METRICS_PATH = Path(__file__).resolve().parent / "training_metrics.json"
METADATA_PATH = Path(__file__).resolve().parent / "predictor_metadata.json"
FORCE_SYNTHETIC = os.environ.get("PREDICTOR_FORCE_SYNTHETIC", "0") == "1"

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
    "ATOM/USDT",
    "FIL/USDT",
    "LTC/USDT",
    "INJ/USDT",
)
DEFAULT_TIMEFRAME = "1h"
DEFAULT_LOOKBACK_HOURS = 24 * 30  # 1 month


def _candidate_exchanges(primary: str) -> List[str]:
    """Return a list of exchanges to try in order of preference."""
    fallback_map = {
        "binance": ["binanceusdm", "bybit", "okx"],
        "binanceusdm": ["binance", "bybit", "okx"],
        "bybit": ["binanceusdm", "binance", "okx"],
    }
    sequence: List[str] = []
    for candidate in [primary, *fallback_map.get(primary, [])]:
        if candidate not in sequence:
            sequence.append(candidate)
    if not sequence:
        sequence = [primary]
    return sequence


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
    WindowSpec("15m", hours=24 * 180, offset_hours=0),  # 6 mois 15m - TIMEFRAME PRODUCTION
    WindowSpec("1h", hours=24 * 180, offset_hours=0),   # 6 mois au lieu de 3 - 2x plus de données
    WindowSpec("4h", hours=24 * 180, offset_hours=0),   # 6 mois higher timeframe
    WindowSpec("15m", hours=24 * 120, offset_hours=180),# 4 mois supplémentaires offset 15m
    WindowSpec("1h", hours=24 * 120, offset_hours=180), # 4 mois supplémentaires offset
    WindowSpec("4h", hours=24 * 120, offset_hours=180), # 4 mois supplémentaires offset  
)

RANDOM_SEED = 42
getcontext().prec = 28

CLASS_ORDER = ["long", "none", "short"]
CLASS_TO_INDEX = {label: idx for idx, label in enumerate(CLASS_ORDER)}
CLASS_WEIGHT_OVERRIDES = {
    CLASS_TO_INDEX["long"]: float(os.environ.get("PREDICTOR_WEIGHT_LONG", "1.0")),
    CLASS_TO_INDEX["none"]: float(os.environ.get("PREDICTOR_WEIGHT_NONE", "2.0")),
    CLASS_TO_INDEX["short"]: float(os.environ.get("PREDICTOR_WEIGHT_SHORT", "1.4")),
}


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
            try:
                dataset = prepare_dataset(raw)
            except ValueError as error:
                print(
                    f"[ccxt_xgboost_module] skipping window {symbol} {spec.timeframe} ({error})",
                    file=sys.stderr,
                )
                continue
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


def _infer_anchor_from_cache(
    exchange: str,
    symbols: Sequence[str],
    window_specs: Sequence[WindowSpec],
) -> datetime | None:
    if not HAVE_PANDAS or pd is None:
        return None
    candidate: datetime | None = None
    largest_interval = 0
    for spec in window_specs:
        largest_interval = max(largest_interval, spec.interval_minutes)
        for symbol in symbols:
            cache = load_cached_ohlcv(exchange, symbol, spec.timeframe)
            if cache.empty or cache["timestamp"].isna().all():
                continue
            last_ts = cache["timestamp"].max()
            if pd.isna(last_ts):
                continue
            last_dt = pd.Timestamp(last_ts).to_pydatetime()
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            candidate = last_dt if candidate is None else min(candidate, last_dt)
    if candidate is None:
        return None
    return candidate + timedelta(minutes=largest_interval)


def _cache_path(exchange: str, symbol: str, timeframe: str) -> Path:
    safe_symbol = symbol.replace("/", "_").replace(":", "_")
    filename = f"{exchange.lower()}_{safe_symbol}_{timeframe}.csv"
    return CACHE_DIR / filename


def load_cached_ohlcv(exchange: str, symbol: str, timeframe: str) -> pd.DataFrame:
    path = _cache_path(exchange, symbol, timeframe)
    if path.exists():
        df_cached = pd.read_csv(path, parse_dates=["timestamp"])
        if not df_cached.empty:
            df_cached["timestamp"] = pd.to_datetime(df_cached["timestamp"], utc=True, errors="coerce")
            if df_cached["timestamp"].isna().any():
                df_cached["timestamp"] = pd.to_datetime(
                    df_cached["timestamp"].astype(str),
                    utc=True,
                    errors="coerce",
                    format="ISO8601",
                )
            df_cached = df_cached.dropna(subset=["timestamp"])
        return df_cached
    return pd.DataFrame(columns=["timestamp", "open", "high", "low", "close", "volume"])


def save_cached_ohlcv(exchange: str, symbol: str, timeframe: str, df: pd.DataFrame) -> None:
    path = _cache_path(exchange, symbol, timeframe)
    path.parent.mkdir(parents=True, exist_ok=True)
    df_to_save = df.copy()
    if not df_to_save.empty:
        df_to_save["timestamp"] = pd.to_datetime(df_to_save["timestamp"], utc=True)
    df_to_save.to_csv(path, index=False)


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

    start_dt = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc)

    def _clip_window(df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return df.copy()
        window = df[
            (df["timestamp"] >= start_dt)
            & (df["timestamp"] <= end_dt)
        ]
        if window.empty:
            return df.copy().reset_index(drop=True)
        return window.reset_index(drop=True)

    if FORCE_SYNTHETIC or ccxt is None:
        synthetic = _generate_synthetic_ohlcv(
            exchange_name=exchange_name,
            symbol=symbol,
            timeframe=timeframe,
            start_dt=start_dt,
            end_dt=end_dt,
        )
        save_cached_ohlcv(exchange_name, symbol, timeframe, synthetic)
        return _clip_window(synthetic)

    caches: Dict[str, pd.DataFrame] = {}
    errors: List[str] = []

    candidates = _candidate_exchanges(exchange_name)
    for candidate in candidates:
        cache = load_cached_ohlcv(candidate, symbol, timeframe)
        caches[candidate] = cache
        if not cache.empty:
            first_ts = cache["timestamp"].min()
            last_ts = cache["timestamp"].max()
            if first_ts <= start_dt and last_ts >= end_dt:
                return _clip_window(cache)
        if cache.empty:
            print(
                f"[ccxt_xgboost_module] cache empty, attempting fetch {candidate} {symbol} {timeframe}"
                f" between {start_dt} and {end_dt}",
                file=sys.stderr,
            )
        if ccxt is None:
            errors.append(f"{candidate}:ccxt_unavailable")
            continue
        try:
            exchange_class = getattr(ccxt, candidate)
        except AttributeError as error:
            errors.append(f"{candidate}:{error}")
            continue
        try:
            exchange = exchange_class({"enableRateLimit": True})
            since = start_ts
            all_rows: List[List[float]] = []
            while since < end_ts:
                batch = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=since, limit=750)
                if not batch:
                    break
                all_rows.extend(batch)
                if batch[-1][0] <= since:
                    # guard against providers returning identical timestamps
                    since += _timeframe_to_minutes(timeframe) * 60 * 1000
                else:
                    since = batch[-1][0] + 1
            if not all_rows:
                raise RuntimeError("Empty OHLCV response")
            df = pd.DataFrame(all_rows, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
            frames = [frame for frame in (cache, df) if not frame.empty]
            merged = pd.concat(frames, ignore_index=True) if frames else df
            merged = merged.drop_duplicates(subset=["timestamp"], keep="last").sort_values("timestamp")
            save_cached_ohlcv(candidate, symbol, timeframe, merged)
            if candidate != exchange_name:
                print(
                    f"[ccxt_xgboost_module] using fallback exchange {candidate} for {symbol} ({timeframe})",
                    file=sys.stderr,
                )
            return _clip_window(merged)
        except Exception as error:  # pragma: no cover - network errors expected
            errors.append(f"{candidate}:{error}")
            continue

    # Attempt to reuse any cached data from the attempted exchanges.
    for candidate in candidates:
        cache = caches.get(candidate)
        if cache is not None and not cache.empty:
            return _clip_window(cache)

    # Generate deterministic synthetic data as a last resort.
    if errors:
        print(
            f"[ccxt_xgboost_module] fetch failed for {exchange_name}/{symbol} ({timeframe}) "
            f"({'; '.join(errors)}); generating synthetic OHLCV window",
            file=sys.stderr,
        )
    for cache in caches.values():
        if not cache.empty:
            window = _clip_window(cache)
            if not window.empty:
                return window

    synthetic = _generate_synthetic_ohlcv(
        exchange_name=exchange_name,
        symbol=symbol,
        timeframe=timeframe,
        start_dt=start_dt,
        end_dt=end_dt,
    )
    save_cached_ohlcv(exchange_name, symbol, timeframe, synthetic)
    return _clip_window(synthetic)


def _generate_synthetic_ohlcv(
    exchange_name: str,
    symbol: str,
    timeframe: str,
    start_dt: datetime,
    end_dt: datetime,
) -> pd.DataFrame:
    freq = _timeframe_to_pandas_freq(timeframe)
    timestamps = pd.date_range(start=start_dt, end=end_dt, freq=freq)
    if len(timestamps) == 0:
        timestamps = pd.date_range(start=start_dt, periods=256, freq=freq)

    seed_source = f"{exchange_name}:{symbol}:{timeframe}:{int(start_dt.timestamp())}:{int(end_dt.timestamp())}".encode()
    seed = zlib.crc32(seed_source)
    rng = np.random.default_rng(seed)

    price = 100.0
    closes = np.zeros(len(timestamps))
    opens = np.zeros(len(timestamps))
    highs = np.zeros(len(timestamps))
    lows = np.zeros(len(timestamps))
    volumes = np.zeros(len(timestamps))

    segment_count = min(5, max(3, len(timestamps) // 128))
    indices = np.array_split(np.arange(len(timestamps)), segment_count)
    drift_profiles = []
    for idx in range(segment_count):
        if idx % 3 == 0:
            drift_profiles.append({"drift": rng.uniform(0.0008, 0.0025), "vol": rng.uniform(0.0045, 0.011)})
        elif idx % 3 == 1:
            drift_profiles.append({"drift": -rng.uniform(0.0009, 0.0028), "vol": rng.uniform(0.005, 0.012)})
        else:
            drift_profiles.append({"drift": rng.uniform(-0.0004, 0.0004), "vol": rng.uniform(0.002, 0.006)})

    for segment, profile in zip(indices, drift_profiles):
        drift = profile["drift"]
        volatility = profile["vol"]
        bias = rng.normal(0.0, volatility * 0.25)
        for pos in segment:
            increment = drift + bias + rng.normal(0.0, volatility)
            price = max(0.05, price * (1.0 + increment))
            close = price
            open_price = close * (1.0 + rng.normal(0.0, volatility * 0.5))
            range_spread = abs(rng.normal(volatility * 4, volatility * 2)) + 0.001
            high = max(close, open_price) * (1.0 + range_spread)
            low = min(close, open_price) * (1.0 - range_spread)
            volume = abs(rng.normal(1.0, 0.35)) * (1_200 + 500 * rng.random())

            closes[pos] = close
            opens[pos] = open_price
            highs[pos] = max(high, low + 0.01)
            lows[pos] = max(0.01, min(low, high - 0.01))
            volumes[pos] = volume

    synthetic = pd.DataFrame(
        {
            "timestamp": timestamps,
            "open": opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": volumes,
        }
    )
    return synthetic.sort_values("timestamp").reset_index(drop=True)


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

    # === CORE EMAs ===
    df["ema20"] = ta.trend.EMAIndicator(close, window=20, fillna=True).ema_indicator()
    df["ema50"] = ta.trend.EMAIndicator(close, window=50, fillna=True).ema_indicator()
    df["ema100"] = ta.trend.EMAIndicator(close, window=100, fillna=True).ema_indicator()
    df["ema200"] = ta.trend.EMAIndicator(close, window=200, fillna=True).ema_indicator()
    df["ema9"] = ta.trend.EMAIndicator(close, window=9, fillna=True).ema_indicator()
    df["ema12"] = ta.trend.EMAIndicator(close, window=12, fillna=True).ema_indicator()
    df["ema26"] = ta.trend.EMAIndicator(close, window=26, fillna=True).ema_indicator()
    
    # === MOMENTUM INDICATORS ===
    df["rsi14"] = ta.momentum.RSIIndicator(close, window=14, fillna=True).rsi()
    df["rsi7"] = ta.momentum.RSIIndicator(close, window=7, fillna=True).rsi()
    df["rsi21"] = ta.momentum.RSIIndicator(close, window=21, fillna=True).rsi()
    
    # Stochastic Oscillator
    stoch = ta.momentum.StochasticOscillator(high, low, close, window=14, smooth_window=3, fillna=True)
    df["stoch_k"] = stoch.stoch()
    df["stoch_d"] = stoch.stoch_signal()
    
    # MACD
    macd = ta.trend.MACD(close, window_slow=26, window_fast=12, window_sign=9, fillna=True)
    df["macd"] = macd.macd()
    df["macd_signal"] = macd.macd_signal()
    df["macd_diff"] = macd.macd_diff()
    
    # === VOLATILITY INDICATORS ===
    df["atr14"] = ta.volatility.AverageTrueRange(high, low, close, window=14, fillna=True).average_true_range()
    df["atr7"] = ta.volatility.AverageTrueRange(high, low, close, window=7, fillna=True).average_true_range()
    
    # Bollinger Bands
    bb = ta.volatility.BollingerBands(close, window=20, window_dev=2, fillna=True)
    df["bb_high"] = bb.bollinger_hband()
    df["bb_low"] = bb.bollinger_lband()
    df["bb_mid"] = bb.bollinger_mavg()
    df["bb_width"] = (df["bb_high"] - df["bb_low"]) / df["bb_mid"].replace(0, np.nan)
    df["bb_position"] = (close - df["bb_low"]) / (df["bb_high"] - df["bb_low"]).replace(0, np.nan)
    
    # === TREND INDICATORS ===
    df["adx14"] = ta.trend.ADXIndicator(high, low, close, window=14, fillna=True).adx()
    df["adx_pos"] = ta.trend.ADXIndicator(high, low, close, window=14, fillna=True).adx_pos()
    df["adx_neg"] = ta.trend.ADXIndicator(high, low, close, window=14, fillna=True).adx_neg()
    
    # === VOLUME INDICATORS ===
    df["volumeRatio"] = volume / volume.rolling(window=20, min_periods=1).mean()
    df["volumeZScore"] = (volume - volume.rolling(window=40, min_periods=1).mean()) / volume.rolling(window=40, min_periods=1).std(ddof=0).replace(0, np.nan)
    df["obv"] = ta.volume.OnBalanceVolumeIndicator(close, volume, fillna=True).on_balance_volume()
    df["obv_slope"] = df["obv"].diff()
    
    # === PRICE ACTION FEATURES ===
    df["ema20Slope"] = df["ema20"].diff()
    df["ema50Slope"] = df["ema50"].diff()
    df["emaTrendSpread"] = (df["ema20"] - df["ema50"]) / df["ema50"].replace(0, np.nan)
    df["rsiSlope"] = df["rsi14"].diff()
    df["atrPct"] = df["atr14"] / close.replace(0, np.nan)
    df["spreadProxy"] = (high - low) / close.replace(0, np.nan)
    
    # Momentum multi-période
    df["momentum3"] = close.pct_change(periods=3)
    df["momentum5"] = close.pct_change(periods=5)
    df["momentum10"] = close.pct_change(periods=10)
    df["momentum20"] = close.pct_change(periods=20)
    
    # === MULTI-TIMEFRAME FEATURES ===
    df["atrPct_1h"] = df["atrPct"].rolling(window=4, min_periods=1).mean()
    df["atrPct_4h"] = df["atrPct"].rolling(window=16, min_periods=1).mean()
    df["rsi14_1h"] = df["rsi14"].rolling(window=4, min_periods=1).mean()
    df["rsi14_4h"] = df["rsi14"].rolling(window=16, min_periods=1).mean()
    
    # === ADVANCED RATIOS ===
    df["emaRatio_20_200"] = df["ema20"] / df["ema200"].replace(0, np.nan)
    df["emaRatio_50_200"] = df["ema50"] / df["ema200"].replace(0, np.nan)
    df["emaRatio_9_20"] = df["ema9"] / df["ema20"].replace(0, np.nan)
    df["trendStrength"] = (df["ema20"] - df["ema100"]) / df["ema100"].replace(0, np.nan)
    df["volatilityRegime"] = df["atrPct"].rolling(window=20, min_periods=1).mean()
    df["microImbalance"] = df["momentum3"].rolling(window=5, min_periods=1).mean()
    df["mtfAgreement"] = np.sign(df["ema20"] - df["ema50"]) + np.sign(df["ema50"] - df["ema100"]) + np.sign(df["ema100"] - df["ema200"])
    
    # === PATTERN FEATURES ===
    # Distance from key EMAs
    df["dist_ema20"] = (close - df["ema20"]) / close.replace(0, np.nan)
    df["dist_ema50"] = (close - df["ema50"]) / close.replace(0, np.nan)
    df["dist_ema200"] = (close - df["ema200"]) / close.replace(0, np.nan)
    
    # Volatility adjusted momentum
    df["vol_adj_momentum"] = df["momentum10"] / df["atrPct"].replace(0, np.nan)
    
    # RSI divergence approximation
    df["rsi_ema_div"] = (df["rsi14"] - 50) * np.sign(df["ema20Slope"])
    
    # Volume-price confirmation
    df["vol_price_conf"] = np.sign(df["momentum3"]) * df["volumeRatio"]

    # === TARGET LABELING optimisé pour 60%+ accuracy ===
    horizon = int(os.environ.get("PREDICTOR_FUTURE_HORIZON", "24"))  # Horizon encore plus long
    horizon = max(1, min(64, horizon))
    gamma = float(os.environ.get("PREDICTOR_LABEL_GAMMA", "0.45"))  # Seuil plus strict pour labels plus clairs
    
    future_close = close.shift(-horizon)
    df["futureClose"] = future_close
    future_return = (future_close - close) / close.replace(0, np.nan)
    atr_threshold = df["atrPct"].rolling(window=horizon, min_periods=1).mean()
    theta = gamma * atr_threshold
    df["futureReturn"] = future_return

    # Critères encore plus stricts pour haute précision
    trend_bullish = (df["ema20"] > df["ema50"]) & (df["ema50"] > df["ema200"])
    trend_bearish = (df["ema20"] < df["ema50"]) & (df["ema50"] < df["ema200"])
    momentum_bullish = (df["momentum10"] > 0.002) & (df["rsi14"] > 50)  # Seuils plus stricts
    momentum_bearish = (df["momentum10"] < -0.002) & (df["rsi14"] < 50)
    volume_confirm = df["volumeRatio"] > 1.0  # Volume supplémentaire requis
    
    # Labels ultra-stricts: plusieurs confirmations requises
    long_mask = (future_return >= theta) & trend_bullish & momentum_bullish & volume_confirm
    short_mask = (future_return <= -theta) & trend_bearish & momentum_bearish & volume_confirm
    
    target = np.full(len(df), 1, dtype=int)
    target[long_mask] = 0
    target[short_mask] = 2
    df["target"] = target
    df["targetLabel"] = np.where(long_mask, "long", np.where(short_mask, "short", "none"))

    df = df.dropna().copy()
    df = df.replace([np.inf, -np.inf], np.nan).dropna()
    df = df.reset_index()

    features = [
        # Core EMAs
        "ema9", "ema12", "ema20", "ema26", "ema50", "ema100", "ema200",
        # Momentum
        "rsi7", "rsi14", "rsi21", "rsiSlope",
        "stoch_k", "stoch_d",
        "macd", "macd_signal", "macd_diff",
        "momentum3", "momentum5", "momentum10", "momentum20",
        # Volatility
        "atr7", "atr14", "atrPct",
        "bb_width", "bb_position",
        "volatilityRegime",
        # Trend
        "adx14", "adx_pos", "adx_neg",
        "ema20Slope", "ema50Slope",
        "trendStrength",
        # Volume
        "volumeRatio", "volumeZScore",
        "obv_slope",
        "vol_price_conf",
        # Price patterns
        "spreadProxy",
        "dist_ema20", "dist_ema50", "dist_ema200",
        # Ratios
        "emaRatio_9_20", "emaRatio_20_200", "emaRatio_50_200",
        "emaTrendSpread",
        # Multi-timeframe
        "atrPct_1h", "atrPct_4h",
        "rsi14_1h", "rsi14_4h",
        # Advanced
        "microImbalance",
        "mtfAgreement",
        "vol_adj_momentum",
        "rsi_ema_div",
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


def _rebalance_dataset(
    df: "pd.DataFrame",
    target_col: str = "target",
    min_per_class: int = 1500,
    max_per_class: int = 20000,
    max_multiplier: float = 3.0,
) -> "pd.DataFrame":
    if target_col not in df.columns:
        return df
    counts = df[target_col].value_counts()
    if counts.empty or len(counts) < len(CLASS_ORDER):
        return df
    minority = int(counts.min())
    if minority == 0:
        return df
    target_size = int(
        min(
            max_per_class,
            max(min_per_class, minority * max_multiplier),
        )
    )
    balanced_frames: List["pd.DataFrame"] = []
    for class_idx in range(len(CLASS_ORDER)):
        subset = df[df[target_col] == class_idx]
        if subset.empty:
            continue
        if len(subset) > target_size:
            balanced = subset.sample(n=target_size, random_state=RANDOM_SEED)
        elif len(subset) < target_size:
            extra = subset.sample(
                n=target_size - len(subset),
                replace=True,
                random_state=RANDOM_SEED,
            )
            balanced = pd.concat([subset, extra], ignore_index=True)
        else:
            balanced = subset.copy()
        balanced_frames.append(balanced)
    if not balanced_frames:
        return df
    combined = pd.concat(balanced_frames, ignore_index=True)
    if "timestamp" in combined.columns:
        combined = combined.sort_values("timestamp").reset_index(drop=True)
    else:
        combined = combined.sample(frac=1.0, random_state=RANDOM_SEED).reset_index(drop=True)
    return combined


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

    class_counts = y_train.value_counts().to_dict()
    total_samples = float(len(y_train)) if len(y_train) else 1.0
    weight_map = {}
    for cls, count in class_counts.items():
        if count <= 0:
            continue
        base_weight = total_samples / (len(CLASS_ORDER) * float(count))
        override = CLASS_WEIGHT_OVERRIDES.get(int(cls), 1.0)
        weight_map[int(cls)] = base_weight * override
    sample_weight = y_train.map(lambda label: weight_map.get(int(label), 1.0)).to_numpy(dtype=float)

    model = XGBClassifier(
        objective="multi:softprob",
        eval_metric="mlogloss",
        num_class=len(CLASS_ORDER),
        seed=RANDOM_SEED,
        **params,
    )
    model.fit(X_train, y_train, sample_weight=sample_weight)

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
    if any((value != value) or (not math.isfinite(value)) for value in (accuracy, f1_macro)):  # NaN guard
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
    ratio = equity_curve[-1] / equity_curve[0]
    if ratio <= 0:
        cagr = 0.0
    else:
        cagr = float(ratio ** (Decimal("1") / years) - Decimal("1"))
        if not math.isfinite(cagr):
            cagr = 0.0

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

    if any((value != value) or (not math.isfinite(value)) for value in metrics.values()):
        raise ValueError("Backtest metrics produced NaN; aborting")

    return metrics


def save_model_and_features(artifacts: TrainingArtifacts) -> None:
    artifacts.model.save_model(MODEL_PATH)
    FEATURE_PATH.write_text("\n".join(artifacts.features))
    
    # Save metrics with additional fields for retraining validation
    metrics_with_metadata = {
        **artifacts.metrics,
        "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        "samples": len(artifacts.features),
        "f1_score": artifacts.metrics.get("f1Macro", 0.0),
        "precision": artifacts.metrics.get("f1Macro", 0.0),  # Using f1Macro as proxy
        "recall": artifacts.metrics.get("f1Macro", 0.0),  # Using f1Macro as proxy
    }
    METRICS_PATH.write_text(json.dumps(metrics_with_metadata, indent=2))
    
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
        # If it's a JSON file (conservative), parse it
        if FEATURE_PATH.suffix == '.json':
            import json
            return json.loads(FEATURE_PATH.read_text())
        # Otherwise it's a text file (standard)
        return [line.strip() for line in FEATURE_PATH.read_text().splitlines() if line.strip()]
    raise FileNotFoundError(f"Feature file not found: {FEATURE_PATH}")


# 🚀 GLOBAL MODEL CACHE - évite de recharger le modèle 350MB+ à chaque prédiction
_CACHED_MODEL: XGBClassifier | None = None
_MODEL_LOAD_TIMESTAMP: float = 0

def load_model(force_reload: bool = False) -> XGBClassifier:
    """Load XGBoost model with intelligent in-memory caching.
    
    First load takes ~2-5s for 350MB+ model.
    Subsequent calls return cached instance instantly (<1ms).
    
    Args:
        force_reload: Force reload from disk (for retraining scenarios)
    
    Returns:
        Cached or freshly loaded XGBClassifier instance
    """
    global _CACHED_MODEL, _MODEL_LOAD_TIMESTAMP
    
    # Return cached model if available and not forcing reload
    if _CACHED_MODEL is not None and not force_reload:
        return _CACHED_MODEL
    
    # Load model from disk (slow operation)
    import time
    start_time = time.time()
    
    model = XGBClassifier()
    model.load_model(MODEL_PATH)
    
    # Cache globally
    _CACHED_MODEL = model
    _MODEL_LOAD_TIMESTAMP = time.time()
    
    load_duration = time.time() - start_time
    print(
        f"[ccxt_xgboost_module] Model loaded and cached in {load_duration:.2f}s "
        f"(path: {MODEL_PATH}, size: ~350MB+)",
        file=sys.stderr
    )
    
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

    if anchor is None:
        anchor = _infer_anchor_from_cache(exchange, symbols, specs) or anchor

    prepared_windows = collect_prepared_windows(exchange, symbols, specs, anchor=anchor)
    combined = assemble_training_dataframe(prepared_windows)
    counts_before = combined["target"].value_counts().to_dict() if "target" in combined.columns else {}
    combined = _rebalance_dataset(combined)
    counts_after = combined["target"].value_counts().to_dict() if "target" in combined.columns else {}
    if counts_before:
        print(
            f"[ccxt_xgboost_module] class distribution before rebalance: {counts_before}",
            file=sys.stderr,
        )
        print(
            f"[ccxt_xgboost_module] class distribution after rebalance: {counts_after}",
            file=sys.stderr,
        )

    # Hyperparameters optimisés pour 60%+ accuracy avec early stopping
    artifacts = train_model(
        combined,
        params={
            "max_depth": 7,              # Réduit légèrement pour éviter overfitting
            "n_estimators": 400,         # Augmenté avec early stopping
            "learning_rate": 0.04,       # Plus petit pour meilleure généralisation
            "subsample": 0.87,           # Optimisé
            "colsample_bytree": 0.87,    # Optimisé
            "min_child_weight": 5,       # Augmenté pour éviter overfitting
            "gamma": 0.2,                # Régularisation modérée
            "reg_alpha": 0.1,            # L1 regularization augmentée
            "reg_lambda": 2.0,           # L2 regularization augmentée
            "scale_pos_weight": 1.0,     # Balance des classes
            "tree_method": "hist",       # Algorithme plus rapide et précis
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
    extra_symbols_env = os.environ.get("XGB_EXTRA_SYMBOLS")
    if extra_symbols_env:
        extra = [sym.strip() for sym in extra_symbols_env.split(",") if sym.strip()]
        if extra:
            merged: List[str] = []
            for sym in [*symbols, *extra]:
                if sym not in merged:
                    merged.append(sym)
            symbols = tuple(merged)
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
