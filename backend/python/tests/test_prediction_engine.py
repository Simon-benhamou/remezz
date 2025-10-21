from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1]))

from ccxt_xgboost_module import load_features
from prediction_engine import HybridPredictionEngine, predict_hybrid


def build_features(prob: float = 0.62) -> dict[str, float]:
    base = {
        "ema20": 101.0,
        "ema50": 99.5,
        "ema100": 98.0,
        "ema200": 96.0,
        "rsi14": 58.0,
        "atr14": 1.4,
        "adx14": 26.0,
        "ema20Slope": 0.4,
        "volumeRatio": 1.2,
        "emaTrendSpread": 0.015,
        "rsiSlope": 0.6,
        "atrPct": 0.012,
        "volumeZScore": 0.8,
        "momentum3": 0.03,
        "order_flow_imbalance": 0.2,
        "aggression_ratio": 0.6,
        "delta_volume_slope": 0.12,
        "midprice_pressure": 0.15,
        "micro_atr": 0.016,
        "trend_strength": 0.55,
        "price_velocity": 0.08,
        "delta_rsi": 0.07,
        "delta_obi": -0.09,
    }
    for idx in range(20):
        base[f"seq_close_{idx}"] = 0.02 * idx
        base[f"seq_volume_{idx}"] = 0.01 * idx
        base[f"seq_rsi_{idx}"] = 0.5 + 0.01 * idx
        base[f"seq_obi_{idx}"] = (-0.4 + 0.02 * idx)
    scale = prob / 0.62
    for key in ("order_flow_imbalance", "aggression_ratio", "price_velocity"):
        base[key] *= scale
    return base


def test_predict_hybrid_signature():
    prediction = predict_hybrid(build_features())
    assert "probability" in prediction
    assert "confidence" in prediction
    assert "entryWeight" in prediction
    assert "riskMultiplier" in prediction
    assert "cooldown" in prediction
    assert isinstance(prediction["cooldown"], dict)
    assert 0 <= prediction["probability"] <= 1
    assert math.isclose(prediction["probability"] + prediction["bearProbability"], 1, rel_tol=1e-6)


def test_confidence_increases_with_signal_strength():
    weaker = predict_hybrid(build_features(0.51))
    stronger = predict_hybrid(build_features(0.72))
    assert stronger["confidence"] >= weaker["confidence"]
    assert stronger["entryWeight"] >= weaker["entryWeight"]


def test_engine_object_prediction():
    engine = HybridPredictionEngine(load_features())
    result = engine.predict(build_features())
    assert result.prediction in (0, 1)
    assert 0 <= result.bullish_probability <= 1
