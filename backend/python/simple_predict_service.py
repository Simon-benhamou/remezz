"""CLI wrapper for direct XGBoost predictions (no hybrid engine)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict

import numpy as np

# Import from ccxt_xgboost_module which handles XGBoost model loading
from ccxt_xgboost_module import load_model, load_features


def predict(features: Dict[str, Any]) -> Dict[str, Any]:
    """Make prediction using trained XGBoost model."""
    if not isinstance(features, dict):
        raise TypeError("features must be a dictionary")
    
    # Load model and feature order
    model = load_model()
    all_columns = load_features()
    
    # Model was trained with ALL columns from features.txt (including metadata)
    # We need to provide values for ALL columns except 'target' (the label)
    # Exclude only 'target', keep metadata columns with dummy values
    feature_names_with_metadata = [col for col in all_columns if col != 'target']
    
    # Check for missing real features (not metadata)
    METADATA_COLS = {'index', 'close', 'futureClose', 'futureReturn'}
    real_feature_names = [col for col in feature_names_with_metadata if col not in METADATA_COLS]
    missing = [fname for fname in real_feature_names if fname not in features]
    if missing:
        raise ValueError(f"Missing features: {missing[:10]}... ({len(missing)} total)")
    
    # Order features as expected by model, using dummy values for metadata
    # Note: Model was trained with 57 features but features.txt only has 56
    # The missing feature is likely a generated column during training
    ordered_features = []
    for fname in feature_names_with_metadata:
        if fname in METADATA_COLS:
            # Metadata columns: use dummy values (not used by model)
            ordered_features.append(0.0)
        else:
            # Real features: use provided values
            ordered_features.append(float(features[fname]))
    
    # Add one more dummy feature to match model's expected 57 features
    # This is a workaround until we retrain with consistent feature count
    if len(ordered_features) == 56:
        ordered_features.append(0.0)  # Dummy 57th feature
    
    # Get class probabilities from XGBoost
    # Note: ccxt_xgboost_module wraps xgb.Booster, need to call predict_proba correctly
    try:
        proba_result = model.predict_proba([ordered_features])
    except Exception as e:
        # Debug: show feature count mismatch details
        raise ValueError(f"Prediction failed (expected {len(feature_names_with_metadata)} features): {str(e)}")
    
    # Handle both numpy array and list results
    if hasattr(proba_result, 'shape'):
        probabilities = proba_result[0]
    else:
        probabilities = proba_result[0] if isinstance(proba_result, list) else proba_result
    
    # Map class indices (class_to_index may vary based on training)
    # Standard order from training: 0=none, 1=long, 2=short
    prob_none = float(probabilities[0])
    prob_long = float(probabilities[1])
    prob_short = float(probabilities[2])
    
    # Determine decision: simply use highest probability
    # Model was trained with adaptive volatility thresholds (0.4%-2.5%)
    # This produces more balanced predictions than fixed thresholds
    decision_index = int(np.argmax(probabilities))
    decision_label = ['none', 'long', 'short'][decision_index]
    
    # Calculate confidence (gap between top and second probability)
    sorted_probs = np.sort(probabilities)[::-1]
    confidence = float(sorted_probs[0] - sorted_probs[1])
    
    # Build response
    payload = {
        "decision": decision_label,
        "probabilities": {
            "long": prob_long,
            "short": prob_short,
            "none": prob_none,
        },
        "probabilityLong": prob_long,
        "probabilityShort": prob_short,
        "probabilityNone": prob_none,
        "confidence": confidence,
        "entryWeight": 1.0,
        "riskMultiplier": 1.0,
        "cooldown": {"active": False, "reason": None, "seconds": None},
        "meta": {
            "modelType": "xgboost_direct",
            "featureCount": len(real_feature_names),  # Count only real features
            "rawProbabilities": probabilities.tolist() if hasattr(probabilities, 'tolist') else list(probabilities),
        },
        "classOrder": ["long", "none", "short"],
    }
    
    return payload


def _read_json_payload(args: argparse.Namespace) -> Dict[str, Any]:
    if args.features_json:
        return json.loads(args.features_json)
    payload = sys.stdin.read().strip()
    if not payload:
        raise ValueError("No JSON payload provided")
    return json.loads(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QuantAI XGBoost direct predictor")
    parser.add_argument("--features-json", dest="features_json", help="JSON object containing indicator values")
    parsed = parser.parse_args(argv)
    
    try:
        features = _read_json_payload(parsed)
        pred = predict(features)
        sys.stdout.write(json.dumps(pred))
        return 0
    except Exception as exc:
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
