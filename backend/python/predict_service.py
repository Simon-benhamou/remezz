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
        if not isinstance(pred, dict):
            raise TypeError("predict_hybrid must return a mapping")
        probabilities = pred.get("probabilities") or {
            "long": float(pred.get("probability", 0.5)),
            "short": float(pred.get("bearProbability", 0.5)),
            "none": float(pred.get("probabilityNone", 0.0)),
        }
        decision = pred.get("decision")
        if decision not in ("long", "short", "none"):
            decision = "long" if float(probabilities.get("long", 0.5)) >= float(probabilities.get("short", 0.5)) else "short"
        payload = {
            "decision": decision,
            "probabilities": {
                "long": float(probabilities.get("long", pred.get("probability", 0.5))),
                "short": float(probabilities.get("short", pred.get("bearProbability", 0.5))),
                "none": float(probabilities.get("none", pred.get("probabilityNone", 0.0))),
            },
            "probabilityLong": float(pred.get("probabilityLong", probabilities.get("long", 0.5))),
            "probabilityShort": float(pred.get("probabilityShort", probabilities.get("short", 0.5))),
            "probabilityNone": float(pred.get("probabilityNone", probabilities.get("none", 0.0))),
            "confidence": float(pred.get("confidence", 0.0)),
            "entryWeight": float(pred.get("entryWeight", 1.0)),
            "riskMultiplier": float(pred.get("riskMultiplier", 1.0)),
            "cooldown": pred.get("cooldown", {"active": False, "reason": None, "seconds": None}),
            "meta": pred.get("meta", {}),
            "classOrder": pred.get("classOrder"),
        }
        payload["prediction"] = payload["decision"]
        sys.stdout.write(json.dumps(payload))
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to Node caller
        sys.stderr.write(json.dumps({"error": str(exc)}) + "\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
