"""Tiny CLI for running the trained direction classifier."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict

from ccxt_xgboost_module import load_features, load_model, predict_direction

_MODEL = None
_FEATURES = None


def _ensure_loaded():
    global _MODEL, _FEATURES
    if _MODEL is None:
        _MODEL = load_model()
    if _FEATURES is None:
        _FEATURES = load_features()


def predict(features: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_loaded()
    if not isinstance(features, dict):
        raise TypeError("features must be a dictionary")

    missing = [col for col in _FEATURES if col not in features]
    if missing:
        raise ValueError(f"Missing feature columns: {missing}")

    ordered = {key: float(features[key]) for key in _FEATURES}
    return predict_direction(_MODEL, ordered)


def _read_json_payload(args: argparse.Namespace) -> Dict[str, Any]:
    if args.features_json:
        return json.loads(args.features_json)
    payload = sys.stdin.read().strip()
    if not payload:
        raise ValueError("No JSON payload provided")
    return json.loads(payload)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QuantAI direction predictor")
    parser.add_argument("--features-json", dest="features_json", help="JSON object containing indicator values")
    parsed = parser.parse_args(argv)

    try:
        features = _read_json_payload(parsed)
        pred = predict(features)
        if not isinstance(pred, dict) or "prediction" not in pred:
            raise TypeError("predict_direction must return a mapping with 'prediction'")
        payload = {
            "prediction": int(pred.get("prediction", 0)),
            "probability": float(pred.get("probability", 0.5)),
        }
        sys.stdout.write(json.dumps(payload))
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to Node caller
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
