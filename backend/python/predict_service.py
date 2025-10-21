"""CLI wrapper exposing the hybrid prediction engine to NodeJS."""
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict

from prediction_engine import predict_hybrid


def predict(features: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(features, dict):
        raise TypeError("features must be a dictionary")

    sanitized = {key: float(value) for key, value in features.items()}
    return predict_hybrid(sanitized)


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
            raise TypeError("predict_hybrid must return a mapping with 'prediction'")
        payload = {
            "prediction": int(pred.get("prediction", 0)),
            "probability": float(pred.get("probability", 0.5)),
            "bearProbability": float(pred.get("bearProbability", 1 - float(pred.get("probability", 0.5)))),
            "confidence": float(pred.get("confidence", 0.0)),
            "entryWeight": float(pred.get("entryWeight", 1.0)),
            "riskMultiplier": float(pred.get("riskMultiplier", 1.0)),
            "cooldown": pred.get("cooldown", {"active": False, "reason": None, "seconds": None}),
            "meta": pred.get("meta", {}),
        }
        sys.stdout.write(json.dumps(payload))
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to Node caller
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
