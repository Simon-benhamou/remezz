"""Comprehensive reliability tests for the predictor engine.

Tests edge cases, boundary conditions, and various market scenarios to ensure
the prediction engine is robust and reliable.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.append(str(Path(__file__).resolve().parents[1]))

from ccxt_xgboost_module import load_features
from prediction_engine import (
    HybridPredictionEngine,
    LSTMSequenceEncoder,
    MetaLearner,
    predict_hybrid,
    _sigmoid,
    _clamp,
)


def build_features(
    base_price: float = 100.0,
    rsi: float = 50.0,
    volatility: float = 0.012,
    momentum: float = 0.0,
    volume_ratio: float = 1.0,
) -> dict[str, float]:
    """Build feature dict with configurable parameters."""
    features = {
        "ema20": base_price * 1.01,
        "ema50": base_price * 0.995,
        "ema100": base_price * 0.98,
        "ema200": base_price * 0.96,
        "rsi14": rsi,
        "atr14": base_price * volatility,
        "adx14": 25.0,
        "ema20Slope": momentum,
        "volumeRatio": volume_ratio,
        "emaTrendSpread": 0.015,
        "rsiSlope": 0.5,
        "atrPct": volatility,
        "volumeZScore": 0.5,
        "momentum3": momentum,
        "order_flow_imbalance": 0.15,
        "aggression_ratio": 0.55,
        "delta_volume_slope": 0.1,
        "midprice_pressure": 0.12,
        "micro_atr": volatility,
        "trend_strength": 0.5,
        "price_velocity": 0.05,
        "delta_rsi": 0.05,
        "delta_obi": -0.05,
    }
    # Add sequence features
    for idx in range(20):
        features[f"seq_close_{idx}"] = 0.015 * idx
        features[f"seq_volume_{idx}"] = 0.008 * idx
        features[f"seq_rsi_{idx}"] = 0.48 + 0.01 * idx
        features[f"seq_obi_{idx}"] = -0.35 + 0.018 * idx
    return features


# Test 1: Extreme RSI values
def test_extreme_rsi_oversold():
    """Test prediction with extremely oversold RSI."""
    features = build_features(rsi=5.0)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert 0 <= result["probabilityLong"] <= 1
    assert 0 <= result["probabilityShort"] <= 1
    assert 0 <= result["probabilityNone"] <= 1
    assert math.isclose(
        result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"],
        1.0,
        rel_tol=1e-6,
    )
    print(f"✓ Extreme oversold RSI: decision={result['decision']}, confidence={result['confidence']:.4f}")


def test_extreme_rsi_overbought():
    """Test prediction with extremely overbought RSI."""
    features = build_features(rsi=95.0)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert 0 <= result["probabilityLong"] <= 1
    assert 0 <= result["probabilityShort"] <= 1
    assert 0 <= result["probabilityNone"] <= 1
    assert math.isclose(
        result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"],
        1.0,
        rel_tol=1e-6,
    )
    print(f"✓ Extreme overbought RSI: decision={result['decision']}, confidence={result['confidence']:.4f}")


# Test 2: Extreme volatility
def test_extreme_high_volatility():
    """Test prediction with extremely high volatility and divergence."""
    features = build_features(volatility=0.08)
    # Add divergence to trigger cooldown
    features["delta_rsi"] = 0.08
    features["delta_obi"] = -0.09
    features["micro_atr"] = 0.08
    
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["cooldown"]["active"] is True, "High volatility with divergence should trigger cooldown"
    assert result["cooldown"]["reason"] == "volatility_divergence"
    assert result["cooldown"]["seconds"] == 180
    print(f"✓ Extreme high volatility: cooldown={result['cooldown']['active']}")


def test_extreme_low_volatility():
    """Test prediction with extremely low volatility."""
    features = build_features(volatility=0.001)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["cooldown"]["active"] is False, "Low volatility should not trigger cooldown"
    print(f"✓ Extreme low volatility: decision={result['decision']}, confidence={result['confidence']:.4f}")


# Test 3: Extreme momentum
def test_extreme_positive_momentum():
    """Test prediction with extremely positive momentum."""
    features = build_features(momentum=0.15)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    # With strong positive momentum, we might expect higher long probability
    print(f"✓ Extreme positive momentum: decision={result['decision']}, prob_long={result['probabilityLong']:.4f}")


def test_extreme_negative_momentum():
    """Test prediction with extremely negative momentum."""
    features = build_features(momentum=-0.15)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    print(f"✓ Extreme negative momentum: decision={result['decision']}, prob_short={result['probabilityShort']:.4f}")


# Test 4: Zero and near-zero values
def test_zero_volume():
    """Test prediction with zero volume ratio."""
    features = build_features(volume_ratio=0.0)
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert math.isfinite(result["confidence"])
    print(f"✓ Zero volume: decision={result['decision']}, confidence={result['confidence']:.4f}")


def test_near_zero_values():
    """Test prediction with near-zero values in multiple features."""
    features = build_features(
        base_price=0.001,
        volatility=0.0001,
        momentum=0.0,
        volume_ratio=0.001,
    )
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert all(math.isfinite(v) for v in [result["probabilityLong"], result["probabilityShort"], result["probabilityNone"]])
    print(f"✓ Near-zero values: all probabilities finite")


# Test 5: Missing sequence features
def test_missing_sequence_features():
    """Test prediction when some sequence features are missing."""
    features = build_features()
    # Remove some sequence features
    for idx in range(10, 20):
        features.pop(f"seq_close_{idx}", None)
        features.pop(f"seq_volume_{idx}", None)
    
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    print(f"✓ Missing sequence features: decision={result['decision']}")


# Test 6: Cooldown activation logic
def test_cooldown_with_divergence():
    """Test cooldown activation with volatility and divergence."""
    features = build_features(volatility=0.02)
    features["delta_rsi"] = 0.08
    features["delta_obi"] = -0.09
    features["micro_atr"] = 0.02
    
    result = predict_hybrid(features)
    
    assert result["cooldown"]["active"] is True
    assert result["cooldown"]["reason"] == "volatility_divergence"
    print(f"✓ Cooldown with divergence: active={result['cooldown']['active']}")


def test_cooldown_no_divergence():
    """Test that cooldown is not activated without divergence."""
    features = build_features(volatility=0.01)
    features["delta_rsi"] = 0.08
    features["delta_obi"] = 0.08  # Same sign, no divergence
    features["micro_atr"] = 0.01
    
    result = predict_hybrid(features)
    
    assert result["cooldown"]["active"] is False
    print(f"✓ No divergence: cooldown={result['cooldown']['active']}")


# Test 7: Probability normalization
def test_probability_sum():
    """Test that probabilities always sum to 1.0 across various scenarios."""
    scenarios = [
        build_features(rsi=10.0, volatility=0.001),
        build_features(rsi=90.0, volatility=0.05),
        build_features(momentum=0.1, volume_ratio=2.5),
        build_features(momentum=-0.1, volume_ratio=0.3),
        build_features(base_price=1000.0, volatility=0.03),
    ]
    
    for idx, features in enumerate(scenarios):
        result = predict_hybrid(features)
        prob_sum = result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"]
        assert math.isclose(prob_sum, 1.0, rel_tol=1e-6), f"Scenario {idx}: prob sum = {prob_sum}"
    
    print(f"✓ Probability normalization: all {len(scenarios)} scenarios sum to 1.0")


# Test 8: Confidence bounds
def test_confidence_bounds():
    """Test that confidence is always between 0 and 1."""
    scenarios = [
        build_features(rsi=5.0),
        build_features(rsi=95.0),
        build_features(volatility=0.08),
        build_features(volatility=0.001),
        build_features(momentum=0.2),
        build_features(momentum=-0.2),
    ]
    
    for features in scenarios:
        result = predict_hybrid(features)
        assert 0 <= result["confidence"] <= 1, f"Confidence out of bounds: {result['confidence']}"
        assert 0 <= result["entryWeight"] <= 2, f"Entry weight out of bounds: {result['entryWeight']}"
        assert 0 <= result["riskMultiplier"] <= 2, f"Risk multiplier out of bounds: {result['riskMultiplier']}"
    
    print(f"✓ Confidence bounds: all values within expected ranges")


# Test 9: LSTM encoder robustness
def test_lstm_encoder_with_zeros():
    """Test LSTM encoder with zero sequence."""
    encoder = LSTMSequenceEncoder(input_size=4)
    zero_sequence = np.zeros((20, 4))
    
    prob, confidence = encoder.encode(zero_sequence)
    
    assert math.isfinite(prob)
    assert math.isfinite(confidence)
    assert 0 <= prob <= 1
    assert 0 <= confidence <= 1
    print(f"✓ LSTM encoder with zeros: prob={prob:.4f}, conf={confidence:.4f}")


def test_lstm_encoder_with_extreme_values():
    """Test LSTM encoder with extreme values."""
    encoder = LSTMSequenceEncoder(input_size=4)
    extreme_sequence = np.random.randn(20, 4) * 100
    
    prob, confidence = encoder.encode(extreme_sequence)
    
    assert math.isfinite(prob)
    assert math.isfinite(confidence)
    assert 0 <= prob <= 1
    assert 0 <= confidence <= 1
    print(f"✓ LSTM encoder with extreme values: prob={prob:.4f}, conf={confidence:.4f}")


def test_lstm_encoder_training():
    """Test LSTM encoder training doesn't cause errors."""
    encoder = LSTMSequenceEncoder(input_size=4)
    sequences = np.random.randn(10, 20, 4)
    targets = np.random.rand(10)
    
    # Should not raise an exception
    encoder.fit(sequences, targets, epochs=5)
    
    # Test prediction after training
    prob, confidence = encoder.encode(sequences[0])
    assert math.isfinite(prob)
    assert math.isfinite(confidence)
    print(f"✓ LSTM encoder training: successful")


# Test 10: MetaLearner robustness
def test_meta_learner_with_zeros():
    """Test MetaLearner with zero features."""
    meta = MetaLearner()
    features = np.zeros(11)
    
    result = meta.predict(features)
    
    assert math.isfinite(result)
    assert 0 <= result <= 1
    print(f"✓ MetaLearner with zeros: result={result:.4f}")


def test_meta_learner_with_extreme_values():
    """Test MetaLearner with extreme values."""
    meta = MetaLearner()
    features = np.random.randn(11) * 100
    
    result = meta.predict(features)
    
    assert math.isfinite(result)
    assert 0 <= result <= 1
    print(f"✓ MetaLearner with extreme values: result={result:.4f}")


def test_meta_learner_training():
    """Test MetaLearner training doesn't cause errors."""
    meta = MetaLearner()
    X = np.random.randn(50, 11)
    y = np.random.rand(50)
    
    # Should not raise an exception
    meta.fit(X, y, epochs=10)
    
    # Test prediction after training
    result = meta.predict(X[0])
    assert math.isfinite(result)
    assert 0 <= result <= 1
    print(f"✓ MetaLearner training: successful")


# Test 11: Sequential predictions (stability)
def test_sequential_predictions_stability():
    """Test that sequential predictions are stable and don't diverge."""
    features = build_features()
    
    results = []
    for _ in range(10):
        result = predict_hybrid(features)
        results.append(result)
    
    # All predictions should be identical for the same input
    first = results[0]
    for result in results[1:]:
        assert result["decision"] == first["decision"]
        assert math.isclose(result["confidence"], first["confidence"], rel_tol=1e-6)
        assert math.isclose(result["probabilityLong"], first["probabilityLong"], rel_tol=1e-6)
    
    print(f"✓ Sequential predictions: stable across {len(results)} calls")


def test_small_feature_variations():
    """Test that small feature variations produce reasonable prediction changes."""
    base_features = build_features()
    base_result = predict_hybrid(base_features)
    
    # Test small variation in RSI
    varied_features = base_features.copy()
    varied_features["rsi14"] += 1.0
    varied_result = predict_hybrid(varied_features)
    
    # Probabilities should not change dramatically for small input changes
    long_diff = abs(varied_result["probabilityLong"] - base_result["probabilityLong"])
    assert long_diff < 0.2, f"Probability changed too much for small input change: {long_diff}"
    
    print(f"✓ Small feature variations: probability change = {long_diff:.4f}")


# Test 12: Helper function tests
def test_sigmoid_function():
    """Test sigmoid function for extreme values."""
    assert math.isclose(_sigmoid(0.0), 0.5, rel_tol=1e-6)
    assert _sigmoid(100.0) < 1.0
    assert _sigmoid(-100.0) > 0.0
    assert _sigmoid(np.array([0.0, 100.0, -100.0])).shape == (3,)
    print(f"✓ Sigmoid function: handles extreme values")


def test_clamp_function():
    """Test clamp function with various inputs."""
    assert _clamp(5.0, 0.0, 10.0) == 5.0
    assert _clamp(-5.0, 0.0, 10.0) == 0.0
    assert _clamp(15.0, 0.0, 10.0) == 10.0
    assert _clamp(float("inf"), 0.0, 10.0) == 0.0
    assert _clamp(float("-inf"), 0.0, 10.0) == 0.0
    assert _clamp(float("nan"), 0.0, 10.0) == 0.0
    print(f"✓ Clamp function: handles all edge cases")


# Test 13: Engine state persistence
def test_engine_state_save_load():
    """Test that engine state can be saved and loaded."""
    engine = HybridPredictionEngine(load_features())
    
    # Make a prediction to ensure engine is initialized
    features = build_features()
    result1 = engine.predict(features)
    
    # Save state
    engine.save_state()
    
    # Create new engine and load state
    engine2 = HybridPredictionEngine(load_features())
    
    # Predictions should be identical
    result2 = engine2.predict(features)
    
    assert result1.decision == result2.decision
    assert math.isclose(result1.confidence, result2.confidence, rel_tol=1e-6)
    print(f"✓ Engine state persistence: save/load successful")


# Test 14: Meta information validation
def test_meta_information_completeness():
    """Test that all expected meta information is present."""
    features = build_features()
    result = predict_hybrid(features)
    
    assert "meta" in result
    meta = result["meta"]
    
    assert "tabular" in meta
    assert "sequenceProb" in meta
    assert "sequenceConfidence" in meta
    assert "metaBlendRatio" in meta
    assert "temperature" in meta
    assert "classOrder" in meta
    assert "featuresUsed" in meta
    
    # Validate featuresUsed contains expected keys
    features_used = meta["featuresUsed"]
    expected_keys = [
        "order_flow_imbalance",
        "aggression_ratio",
        "delta_volume_slope",
        "midprice_pressure",
        "micro_atr",
        "trend_strength",
        "price_velocity",
    ]
    for key in expected_keys:
        assert key in features_used, f"Missing feature in meta: {key}"
    
    print(f"✓ Meta information: all expected fields present")


# Test 15: Bullish scenario
def test_bullish_scenario():
    """Test prediction in clearly bullish conditions."""
    features = build_features(
        rsi=65.0,
        momentum=0.08,
        volume_ratio=1.8,
    )
    features["ema20"] = 105.0
    features["ema50"] = 100.0
    features["ema100"] = 95.0
    features["order_flow_imbalance"] = 0.4
    features["aggression_ratio"] = 0.75
    
    result = predict_hybrid(features)
    
    assert "decision" in result
    # In bullish conditions, we expect higher probability for long
    print(f"✓ Bullish scenario: decision={result['decision']}, prob_long={result['probabilityLong']:.4f}")


# Test 16: Bearish scenario
def test_bearish_scenario():
    """Test prediction in clearly bearish conditions."""
    features = build_features(
        rsi=35.0,
        momentum=-0.08,
        volume_ratio=1.8,
    )
    features["ema20"] = 95.0
    features["ema50"] = 100.0
    features["ema100"] = 105.0
    features["order_flow_imbalance"] = -0.4
    features["aggression_ratio"] = 0.25
    
    result = predict_hybrid(features)
    
    assert "decision" in result
    # In bearish conditions, we expect higher probability for short
    print(f"✓ Bearish scenario: decision={result['decision']}, prob_short={result['probabilityShort']:.4f}")


# Test 17: Neutral/sideways scenario
def test_neutral_scenario():
    """Test prediction in neutral/sideways conditions."""
    features = build_features(
        rsi=50.0,
        momentum=0.0,
        volume_ratio=1.0,
    )
    features["ema20"] = 100.0
    features["ema50"] = 100.0
    features["ema100"] = 100.0
    features["order_flow_imbalance"] = 0.0
    features["aggression_ratio"] = 0.5
    
    result = predict_hybrid(features)
    
    assert "decision" in result
    # In neutral conditions, we might expect higher probability for none
    print(f"✓ Neutral scenario: decision={result['decision']}, prob_none={result['probabilityNone']:.4f}")


def run_all_tests():
    """Run all reliability tests."""
    print("\n" + "=" * 70)
    print("PREDICTOR ENGINE RELIABILITY TEST SUITE")
    print("=" * 70 + "\n")
    
    test_functions = [
        # Extreme values
        ("Extreme RSI - Oversold", test_extreme_rsi_oversold),
        ("Extreme RSI - Overbought", test_extreme_rsi_overbought),
        ("Extreme High Volatility", test_extreme_high_volatility),
        ("Extreme Low Volatility", test_extreme_low_volatility),
        ("Extreme Positive Momentum", test_extreme_positive_momentum),
        ("Extreme Negative Momentum", test_extreme_negative_momentum),
        
        # Zero and near-zero values
        ("Zero Volume", test_zero_volume),
        ("Near-Zero Values", test_near_zero_values),
        
        # Missing features
        ("Missing Sequence Features", test_missing_sequence_features),
        
        # Cooldown logic
        ("Cooldown with Divergence", test_cooldown_with_divergence),
        ("Cooldown without Divergence", test_cooldown_no_divergence),
        
        # Probability validation
        ("Probability Normalization", test_probability_sum),
        ("Confidence Bounds", test_confidence_bounds),
        
        # LSTM encoder
        ("LSTM Encoder - Zeros", test_lstm_encoder_with_zeros),
        ("LSTM Encoder - Extreme Values", test_lstm_encoder_with_extreme_values),
        ("LSTM Encoder - Training", test_lstm_encoder_training),
        
        # MetaLearner
        ("MetaLearner - Zeros", test_meta_learner_with_zeros),
        ("MetaLearner - Extreme Values", test_meta_learner_with_extreme_values),
        ("MetaLearner - Training", test_meta_learner_training),
        
        # Stability
        ("Sequential Predictions Stability", test_sequential_predictions_stability),
        ("Small Feature Variations", test_small_feature_variations),
        
        # Helper functions
        ("Sigmoid Function", test_sigmoid_function),
        ("Clamp Function", test_clamp_function),
        
        # State persistence
        ("Engine State Persistence", test_engine_state_save_load),
        
        # Meta information
        ("Meta Information Completeness", test_meta_information_completeness),
        
        # Market scenarios
        ("Bullish Scenario", test_bullish_scenario),
        ("Bearish Scenario", test_bearish_scenario),
        ("Neutral Scenario", test_neutral_scenario),
    ]
    
    passed = 0
    failed = 0
    
    for name, test_func in test_functions:
        try:
            test_func()
            passed += 1
        except AssertionError as e:
            print(f"✗ {name} FAILED: {e}")
            failed += 1
        except Exception as e:
            print(f"✗ {name} ERROR: {e}")
            failed += 1
    
    print("\n" + "=" * 70)
    print(f"RESULTS: {passed} passed, {failed} failed out of {passed + failed} tests")
    print("=" * 70 + "\n")
    
    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
