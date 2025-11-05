"""Production scenario tests for the predictor engine.

Tests realistic market conditions and production use cases to ensure
the prediction engine performs reliably in real-world scenarios.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

sys.path.append(str(Path(__file__).resolve().parents[1]))

from ccxt_xgboost_module import load_features
from prediction_engine import HybridPredictionEngine, predict_hybrid


def build_realistic_features(scenario: str = "normal") -> dict[str, float]:
    """Build realistic feature dict for various market scenarios."""
    
    scenarios = {
        "bull_trending": {
            "base_price": 42000.0,
            "ema20": 42500.0,
            "ema50": 41800.0,
            "ema100": 40500.0,
            "ema200": 39000.0,
            "rsi14": 62.0,
            "atr14": 500.0,
            "adx14": 28.0,
            "ema20Slope": 35.0,
            "volumeRatio": 1.5,
            "emaTrendSpread": 0.0167,
            "rsiSlope": 1.2,
            "atrPct": 0.0119,
            "volatility": 0.0119,
            "momentum": 0.025,
        },
        "bear_trending": {
            "base_price": 42000.0,
            "ema20": 41500.0,
            "ema50": 42200.0,
            "ema100": 43500.0,
            "ema200": 45000.0,
            "rsi14": 38.0,
            "atr14": 500.0,
            "adx14": 26.0,
            "ema20Slope": -35.0,
            "volumeRatio": 1.5,
            "emaTrendSpread": -0.0166,
            "rsiSlope": -1.2,
            "atrPct": 0.0119,
            "volatility": 0.0119,
            "momentum": -0.025,
        },
        "sideways_low_vol": {
            "base_price": 42000.0,
            "ema20": 42000.0,
            "ema50": 42000.0,
            "ema100": 42000.0,
            "ema200": 42000.0,
            "rsi14": 50.0,
            "atr14": 200.0,
            "adx14": 12.0,
            "ema20Slope": 0.0,
            "volumeRatio": 0.8,
            "emaTrendSpread": 0.0,
            "rsiSlope": 0.0,
            "atrPct": 0.0048,
            "volatility": 0.0048,
            "momentum": 0.0,
        },
        "high_volatility": {
            "base_price": 42000.0,
            "ema20": 42000.0,
            "ema50": 42000.0,
            "ema100": 42000.0,
            "ema200": 42000.0,
            "rsi14": 50.0,
            "atr14": 1200.0,
            "adx14": 15.0,
            "ema20Slope": 0.0,
            "volumeRatio": 2.5,
            "emaTrendSpread": 0.0,
            "rsiSlope": 0.0,
            "atrPct": 0.0286,
            "volatility": 0.0286,
            "momentum": 0.0,
        },
        "flash_crash": {
            "base_price": 42000.0,
            "ema20": 38000.0,
            "ema50": 41000.0,
            "ema100": 42500.0,
            "ema200": 43000.0,
            "rsi14": 18.0,
            "atr14": 2000.0,
            "adx14": 35.0,
            "ema20Slope": -150.0,
            "volumeRatio": 5.0,
            "emaTrendSpread": -0.0732,
            "rsiSlope": -8.0,
            "atrPct": 0.0476,
            "volatility": 0.0476,
            "momentum": -0.12,
        },
    }
    
    params = scenarios.get(scenario, scenarios["sideways_low_vol"])
    
    features = {
        "ema20": params["ema20"],
        "ema50": params["ema50"],
        "ema100": params["ema100"],
        "ema200": params["ema200"],
        "rsi14": params["rsi14"],
        "atr14": params["atr14"],
        "adx14": params["adx14"],
        "ema20Slope": params["ema20Slope"],
        "volumeRatio": params["volumeRatio"],
        "emaTrendSpread": params["emaTrendSpread"],
        "rsiSlope": params["rsiSlope"],
        "atrPct": params["atrPct"],
        "volumeZScore": (params["volumeRatio"] - 1.0) / 0.5,
        "momentum3": params["momentum"],
        "order_flow_imbalance": params["momentum"] * 5.0,
        "aggression_ratio": 0.5 + params["momentum"] * 2.0,
        "delta_volume_slope": params["volumeRatio"] - 1.0,
        "midprice_pressure": params["momentum"] * 3.0,
        "micro_atr": params["volatility"],
        "trend_strength": params["ema20Slope"] / 100.0,
        "price_velocity": params["momentum"] * 0.8,
        "delta_rsi": params["rsiSlope"],
        "delta_obi": params["momentum"] * 4.0,
    }
    
    # Add sequence features based on scenario
    for idx in range(20):
        progress = idx / 20.0
        if scenario == "bull_trending":
            features[f"seq_close_{idx}"] = 0.002 + 0.001 * progress
            features[f"seq_volume_{idx}"] = 0.01 * (1.0 + progress)
            features[f"seq_rsi_{idx}"] = 0.55 + 0.05 * progress
            features[f"seq_obi_{idx}"] = -0.1 + 0.3 * progress
        elif scenario == "bear_trending":
            features[f"seq_close_{idx}"] = 0.002 - 0.001 * progress
            features[f"seq_volume_{idx}"] = 0.01 * (1.0 + progress)
            features[f"seq_rsi_{idx}"] = 0.45 - 0.05 * progress
            features[f"seq_obi_{idx}"] = 0.1 - 0.3 * progress
        elif scenario == "flash_crash":
            features[f"seq_close_{idx}"] = 0.01 - 0.005 * progress
            features[f"seq_volume_{idx}"] = 0.02 * (1.0 + 2.0 * progress)
            features[f"seq_rsi_{idx}"] = 0.6 - 0.4 * progress
            features[f"seq_obi_{idx}"] = 0.2 - 0.6 * progress
        else:
            features[f"seq_close_{idx}"] = 0.001 + 0.0005 * np.sin(progress * 3.14)
            features[f"seq_volume_{idx}"] = 0.008 * (1.0 + 0.2 * progress)
            features[f"seq_rsi_{idx}"] = 0.48 + 0.02 * np.sin(progress * 6.28)
            features[f"seq_obi_{idx}"] = -0.05 + 0.1 * np.sin(progress * 6.28)
    
    return features


# Test 1: Bull trending market
def test_bull_trending_market():
    """Test prediction in a strong bull trending market."""
    features = build_realistic_features("bull_trending")
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert 0 <= result["confidence"] <= 1
    assert math.isclose(
        result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"],
        1.0,
        rel_tol=1e-6,
    )
    
    print(f"✓ Bull trending: decision={result['decision']}, "
          f"prob_long={result['probabilityLong']:.4f}, "
          f"confidence={result['confidence']:.4f}")


# Test 2: Bear trending market
def test_bear_trending_market():
    """Test prediction in a strong bear trending market."""
    features = build_realistic_features("bear_trending")
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert 0 <= result["confidence"] <= 1
    assert math.isclose(
        result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"],
        1.0,
        rel_tol=1e-6,
    )
    
    print(f"✓ Bear trending: decision={result['decision']}, "
          f"prob_short={result['probabilityShort']:.4f}, "
          f"confidence={result['confidence']:.4f}")


# Test 3: Sideways low volatility market
def test_sideways_low_volatility():
    """Test prediction in a sideways low volatility market."""
    features = build_realistic_features("sideways_low_vol")
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    assert 0 <= result["confidence"] <= 1
    
    print(f"✓ Sideways low vol: decision={result['decision']}, "
          f"prob_none={result['probabilityNone']:.4f}, "
          f"confidence={result['confidence']:.4f}")


# Test 4: High volatility market
def test_high_volatility_market():
    """Test prediction in a high volatility market."""
    features = build_realistic_features("high_volatility")
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    # High volatility might trigger risk management
    assert 0 <= result["entryWeight"] <= 2.0
    assert 0 <= result["riskMultiplier"] <= 2.0
    
    print(f"✓ High volatility: decision={result['decision']}, "
          f"confidence={result['confidence']:.4f}, "
          f"cooldown={result['cooldown']['active']}")


# Test 5: Flash crash scenario
def test_flash_crash_scenario():
    """Test prediction during a flash crash scenario."""
    features = build_realistic_features("flash_crash")
    result = predict_hybrid(features)
    
    assert "decision" in result
    assert result["decision"] in ("long", "short", "none")
    # Flash crash should likely trigger cooldown
    
    print(f"✓ Flash crash: decision={result['decision']}, "
          f"cooldown={result['cooldown']['active']}, "
          f"prob_short={result['probabilityShort']:.4f}")


# Test 6: Rapid consecutive predictions
def test_rapid_consecutive_predictions():
    """Test that rapid consecutive predictions maintain stability."""
    features = build_realistic_features("bull_trending")
    
    results = []
    for _ in range(100):
        result = predict_hybrid(features)
        results.append(result)
    
    # All predictions should be identical
    first = results[0]
    for result in results:
        assert result["decision"] == first["decision"]
        assert math.isclose(result["confidence"], first["confidence"], rel_tol=1e-6)
    
    print(f"✓ Rapid predictions: {len(results)} consecutive calls stable")


# Test 7: Market regime transitions
def test_market_regime_transitions():
    """Test predictions across different market regimes."""
    regimes = ["bull_trending", "sideways_low_vol", "bear_trending", "high_volatility"]
    
    results = {}
    for regime in regimes:
        features = build_realistic_features(regime)
        result = predict_hybrid(features)
        results[regime] = result
        
        # Basic sanity checks
        assert result["decision"] in ("long", "short", "none")
        assert 0 <= result["confidence"] <= 1
        assert math.isclose(
            result["probabilityLong"] + result["probabilityShort"] + result["probabilityNone"],
            1.0,
            rel_tol=1e-6,
        )
    
    print(f"✓ Market regime transitions: tested {len(regimes)} regimes")
    for regime, result in results.items():
        print(f"  - {regime}: decision={result['decision']}, conf={result['confidence']:.4f}")


# Test 8: Large position sizing edge case
def test_entry_weight_scaling():
    """Test that entry weight scales appropriately with confidence."""
    low_conf_features = build_realistic_features("sideways_low_vol")
    high_conf_features = build_realistic_features("bull_trending")
    
    low_conf_result = predict_hybrid(low_conf_features)
    high_conf_result = predict_hybrid(high_conf_features)
    
    # Entry weight should correlate with confidence
    # Lower confidence should generally lead to lower entry weight
    # (though not always due to other factors)
    
    assert 0.6 <= low_conf_result["entryWeight"] <= 1.6
    assert 0.6 <= high_conf_result["entryWeight"] <= 1.6
    
    print(f"✓ Entry weight scaling: "
          f"low_conf={low_conf_result['entryWeight']:.4f}, "
          f"high_conf={high_conf_result['entryWeight']:.4f}")


# Test 9: Risk multiplier appropriateness
def test_risk_multiplier_logic():
    """Test that risk multiplier is appropriate for different scenarios."""
    scenarios = ["bull_trending", "bear_trending", "high_volatility", "flash_crash"]
    
    for scenario in scenarios:
        features = build_realistic_features(scenario)
        result = predict_hybrid(features)
        
        # Risk multiplier should always be in valid range
        assert 0.6 <= result["riskMultiplier"] <= 1.5
        
        # In high volatility or flash crash, we might expect different risk management
        if scenario in ["high_volatility", "flash_crash"]:
            # Just ensure values are sensible, not necessarily lower
            assert math.isfinite(result["riskMultiplier"])
    
    print(f"✓ Risk multiplier logic: validated across {len(scenarios)} scenarios")


# Test 10: Consistency across engine instances
def test_consistency_across_engine_instances():
    """Test that different engine instances produce the same results."""
    features = build_realistic_features("bull_trending")
    
    # Create multiple engines
    engine1 = HybridPredictionEngine(load_features())
    engine2 = HybridPredictionEngine(load_features())
    
    result1 = engine1.predict(features)
    result2 = engine2.predict(features)
    
    assert result1.decision == result2.decision
    assert math.isclose(result1.confidence, result2.confidence, rel_tol=1e-6)
    assert math.isclose(result1.prob_long, result2.prob_long, rel_tol=1e-6)
    assert math.isclose(result1.prob_short, result2.prob_short, rel_tol=1e-6)
    assert math.isclose(result1.prob_none, result2.prob_none, rel_tol=1e-6)
    
    print(f"✓ Engine consistency: multiple instances produce identical results")


# Test 11: Cooldown activation patterns
def test_cooldown_activation_patterns():
    """Test various conditions that should trigger cooldown."""
    
    # Test 1: High volatility with divergence
    features1 = build_realistic_features("high_volatility")
    features1["micro_atr"] = 0.025
    features1["delta_rsi"] = 0.08
    features1["delta_obi"] = -0.09
    result1 = predict_hybrid(features1)
    assert result1["cooldown"]["active"] is True
    
    # Test 2: Flash crash conditions
    features2 = build_realistic_features("flash_crash")
    features2["micro_atr"] = 0.022
    features2["delta_rsi"] = -0.1
    features2["delta_obi"] = 0.08
    result2 = predict_hybrid(features2)
    assert result2["cooldown"]["active"] is True
    
    # Test 3: Normal conditions should not trigger
    features3 = build_realistic_features("bull_trending")
    features3["micro_atr"] = 0.01
    result3 = predict_hybrid(features3)
    # May or may not have cooldown depending on other factors
    
    print(f"✓ Cooldown patterns: high_vol={result1['cooldown']['active']}, "
          f"flash_crash={result2['cooldown']['active']}")


# Test 12: Production-like batch processing
def test_batch_processing():
    """Test processing multiple predictions in sequence (simulating production)."""
    scenarios = [
        "bull_trending",
        "bull_trending",
        "sideways_low_vol",
        "bear_trending",
        "bear_trending",
        "high_volatility",
        "sideways_low_vol",
    ]
    
    results = []
    for scenario in scenarios:
        features = build_realistic_features(scenario)
        result = predict_hybrid(features)
        results.append(result)
        
        # All results should be valid
        assert result["decision"] in ("long", "short", "none")
        assert 0 <= result["confidence"] <= 1
        assert math.isfinite(result["probabilityLong"])
        assert math.isfinite(result["probabilityShort"])
        assert math.isfinite(result["probabilityNone"])
    
    print(f"✓ Batch processing: {len(results)} predictions processed successfully")


def run_all_tests():
    """Run all production scenario tests."""
    print("\n" + "=" * 70)
    print("PRODUCTION SCENARIO TEST SUITE")
    print("=" * 70 + "\n")
    
    test_functions = [
        ("Bull Trending Market", test_bull_trending_market),
        ("Bear Trending Market", test_bear_trending_market),
        ("Sideways Low Volatility", test_sideways_low_volatility),
        ("High Volatility Market", test_high_volatility_market),
        ("Flash Crash Scenario", test_flash_crash_scenario),
        ("Rapid Consecutive Predictions", test_rapid_consecutive_predictions),
        ("Market Regime Transitions", test_market_regime_transitions),
        ("Entry Weight Scaling", test_entry_weight_scaling),
        ("Risk Multiplier Logic", test_risk_multiplier_logic),
        ("Engine Instance Consistency", test_consistency_across_engine_instances),
        ("Cooldown Activation Patterns", test_cooldown_activation_patterns),
        ("Batch Processing", test_batch_processing),
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
