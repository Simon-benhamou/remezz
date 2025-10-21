"""Hybrid directional prediction engine combining XGBoost and a lightweight LSTM."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Sequence, Tuple

import numpy as np

from ccxt_xgboost_module import load_features, load_model


SEQUENCE_LENGTH = 20
LSTM_HIDDEN_SIZE = 8
ENGINE_STATE_PATH = Path(__file__).resolve().parent / "hybrid_state.json"


def _sigmoid(x: float | np.ndarray) -> float | np.ndarray:
    if isinstance(x, np.ndarray):
        return 1.0 / (1.0 + np.exp(-np.clip(x, -12, 12)))
    clipped = _clamp(float(x), -12, 12)
    return 1.0 / (1.0 + math.exp(-clipped))


def _clamp(value: float, lower: float, upper: float) -> float:
    if not math.isfinite(value):
        return lower
    return max(lower, min(upper, value))


@dataclass
class HybridPrediction:
    prediction: int
    bullish_probability: float
    bearish_probability: float
    confidence: float
    entry_weight: float
    risk_multiplier: float
    cooldown_active: bool
    cooldown_reason: str | None
    cooldown_seconds: int | None
    meta: Dict[str, Any]


class LSTMSequenceEncoder:
    """Tiny gated recurrent encoder specialised for 20-candle sequences."""

    def __init__(self, input_size: int, hidden_size: int = LSTM_HIDDEN_SIZE, seed: int = 1337):
        rng = np.random.default_rng(seed)
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.W = rng.normal(0, 0.2, size=(4, hidden_size, input_size))
        self.U = rng.normal(0, 0.2, size=(4, hidden_size, hidden_size))
        self.b = np.zeros((4, hidden_size))
        self.output_weights = rng.normal(0, 0.4, size=(hidden_size,))
        self.output_bias = 0.0

    def _forward(self, sequence: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        h = np.zeros((self.hidden_size,), dtype=float)
        c = np.zeros((self.hidden_size,), dtype=float)
        for step in sequence:
            x = step.astype(float)
            gates = []
            for gate_index in range(4):
                Wx = self.W[gate_index] @ x
                Uh = self.U[gate_index] @ h
                gates.append(Wx + Uh + self.b[gate_index])
            i = _sigmoid(gates[0])
            f = _sigmoid(gates[1])
            o = _sigmoid(gates[2])
            g = np.tanh(gates[3])
            c = f * c + i * g
            h = o * np.tanh(c)
        return h, c

    def encode(self, sequence: np.ndarray) -> Tuple[float, float]:
        hidden, _cell = self._forward(sequence)
        logit = float(hidden @ self.output_weights + self.output_bias)
        seq_prob = _sigmoid(_clamp(logit, -12, 12))
        confidence = float(min(1.0, abs(logit) / 4.0))
        return seq_prob, confidence

    def fit(self, sequences: np.ndarray, targets: np.ndarray, epochs: int = 25, lr: float = 0.05) -> None:
        if len(sequences) == 0:
            return
        targets = targets.astype(float)
        for _ in range(max(1, epochs)):
            grad_w = np.zeros_like(self.output_weights)
            grad_b = 0.0
            for seq, target in zip(sequences, targets):
                hidden, _ = self._forward(seq)
                logit = float(hidden @ self.output_weights + self.output_bias)
                prob = _sigmoid(_clamp(logit, -12, 12))
                error = prob - target
                grad_w += error * hidden
                grad_b += error
            grad_w /= len(sequences)
            grad_b /= len(sequences)
            self.output_weights -= lr * grad_w
            self.output_bias -= lr * grad_b

    def to_json(self) -> Dict[str, Any]:
        return {
            "input_size": self.input_size,
            "hidden_size": self.hidden_size,
            "W": self.W.tolist(),
            "U": self.U.tolist(),
            "b": self.b.tolist(),
            "output_weights": self.output_weights.tolist(),
            "output_bias": self.output_bias,
        }

    @classmethod
    def from_json(cls, payload: Dict[str, Any]) -> "LSTMSequenceEncoder":
        encoder = cls(int(payload.get("input_size", 4)), int(payload.get("hidden_size", LSTM_HIDDEN_SIZE)))
        encoder.W = np.array(payload.get("W", encoder.W.tolist()), dtype=float)
        encoder.U = np.array(payload.get("U", encoder.U.tolist()), dtype=float)
        encoder.b = np.array(payload.get("b", encoder.b.tolist()), dtype=float)
        encoder.output_weights = np.array(payload.get("output_weights", encoder.output_weights.tolist()), dtype=float)
        encoder.output_bias = float(payload.get("output_bias", encoder.output_bias))
        return encoder


class MetaLearner:
    def __init__(self):
        self.weights = np.array([0.1, 0.45, 0.35, 0.12, 0.1, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03], dtype=float)
        self.bias = -0.2

    def predict(self, features: Sequence[float]) -> float:
        vector = np.array(list(features), dtype=float)
        if vector.size != self.weights.size:
            vector = np.resize(vector, self.weights.size)
        logit = float(vector @ self.weights + self.bias)
        return _sigmoid(_clamp(logit, -12, 12))

    def fit(self, X: np.ndarray, y: np.ndarray, lr: float = 0.05, epochs: int = 150) -> None:
        if len(X) == 0:
            return
        for _ in range(max(1, epochs)):
            logits = X @ self.weights + self.bias
            probs = 1.0 / (1.0 + np.exp(-np.clip(logits, -12, 12)))
            errors = probs - y
            grad_w = (errors[:, None] * X).mean(axis=0)
            grad_b = float(errors.mean())
            self.weights -= lr * grad_w
            self.bias -= lr * grad_b

    def to_json(self) -> Dict[str, Any]:
        return {"weights": self.weights.tolist(), "bias": self.bias}

    @classmethod
    def from_json(cls, payload: Dict[str, Any]) -> "MetaLearner":
        learner = cls()
        learner.weights = np.array(payload.get("weights", learner.weights.tolist()), dtype=float)
        learner.bias = float(payload.get("bias", learner.bias))
        return learner


class HybridPredictionEngine:
    def __init__(self, feature_order: Sequence[str]):
        self.feature_order = list(feature_order)
        self.model = load_model()
        self.meta = MetaLearner()
        self.encoder = LSTMSequenceEncoder(input_size=4)
        self._load_state()

    def _load_state(self) -> None:
        if not ENGINE_STATE_PATH.exists():
            return
        try:
            payload = json.loads(ENGINE_STATE_PATH.read_text())
        except json.JSONDecodeError:
            return
        if "meta" in payload:
            self.meta = MetaLearner.from_json(payload["meta"])
        if "encoder" in payload:
            self.encoder = LSTMSequenceEncoder.from_json(payload["encoder"])

    def save_state(self) -> None:
        payload = {"meta": self.meta.to_json(), "encoder": self.encoder.to_json()}
        ENGINE_STATE_PATH.write_text(json.dumps(payload, indent=2))

    @staticmethod
    def _extract_sequence(features: Dict[str, float], prefix: str) -> np.ndarray:
        values = [features.get(f"{prefix}{idx}", 0.0) for idx in range(SEQUENCE_LENGTH)]
        return np.array(values, dtype=float)

    def _prepare_sequence_tensor(self, features: Dict[str, float]) -> np.ndarray:
        close_seq = self._extract_sequence(features, "seq_close_")
        volume_seq = self._extract_sequence(features, "seq_volume_")
        rsi_seq = self._extract_sequence(features, "seq_rsi_")
        obi_seq = self._extract_sequence(features, "seq_obi_")
        stacked = np.stack([close_seq, volume_seq, rsi_seq, obi_seq], axis=1)
        return stacked.astype(float)

    def _tabular_probability(self, features: Dict[str, float]) -> float:
        row = []
        for key in self.feature_order:
            value = float(features.get(key, 0.0))
            row.append(value)
        probs = self.model.predict_proba([row])
        return float(probs[0][1])

    def predict(self, features: Dict[str, float]) -> HybridPrediction:
        sequence = self._prepare_sequence_tensor(features)
        seq_prob, seq_confidence = self.encoder.encode(sequence)

        xgb_prob = self._tabular_probability(features)

        micro_features = [
            features.get("order_flow_imbalance", 0.0),
            features.get("aggression_ratio", 0.0),
            features.get("delta_volume_slope", 0.0),
            features.get("midprice_pressure", 0.0),
            features.get("micro_atr", 0.0),
            features.get("trend_strength", 0.0),
            features.get("price_velocity", 0.0),
        ]

        meta_inputs = [1.0, xgb_prob, seq_prob, *micro_features]
        blended_prob = self.meta.predict(np.array(meta_inputs, dtype=float))

        bullish_prob = float(_clamp(blended_prob, 1e-6, 1 - 1e-6))
        bearish_prob = 1.0 - bullish_prob
        confidence = float(min(1.0, 0.55 * abs(bullish_prob - 0.5) * 2 + 0.45 * seq_confidence))

        entry_weight = _clamp(0.7 + confidence * 0.8, 0.6, 1.6)
        risk_multiplier = _clamp(0.75 + confidence * 0.5, 0.6, 1.5)

        volatility = abs(features.get("micro_atr", 0.0))
        rsi_trend = features.get("delta_rsi", 0.0)
        obi_trend = features.get("delta_obi", 0.0)
        divergence = rsi_trend * obi_trend < 0 and abs(rsi_trend) > 0.05 and abs(obi_trend) > 0.05
        cooldown_active = volatility > 0.018 and divergence
        cooldown_seconds = 180 if cooldown_active else None
        cooldown_reason = None
        if cooldown_active:
            cooldown_reason = "volatility_divergence"

        meta = {
            "xgb_prob": round(xgb_prob, 6),
            "seq_prob": round(seq_prob, 6),
            "seq_confidence": round(seq_confidence, 6),
            "features_used": {
                "order_flow_imbalance": features.get("order_flow_imbalance", 0.0),
                "aggression_ratio": features.get("aggression_ratio", 0.0),
                "delta_volume_slope": features.get("delta_volume_slope", 0.0),
                "midprice_pressure": features.get("midprice_pressure", 0.0),
                "micro_atr": features.get("micro_atr", 0.0),
                "trend_strength": features.get("trend_strength", 0.0),
                "price_velocity": features.get("price_velocity", 0.0),
            },
        }

        prediction = 1 if bullish_prob >= 0.5 else 0

        return HybridPrediction(
            prediction=prediction,
            bullish_probability=bullish_prob,
            bearish_probability=bearish_prob,
            confidence=confidence,
            entry_weight=entry_weight,
            risk_multiplier=risk_multiplier,
            cooldown_active=cooldown_active,
            cooldown_reason=cooldown_reason,
            cooldown_seconds=cooldown_seconds,
            meta=meta,
        )


_ENGINE: HybridPredictionEngine | None = None


def _get_engine() -> HybridPredictionEngine:
    global _ENGINE
    if _ENGINE is None:
        feature_order = load_features()
        _ENGINE = HybridPredictionEngine(feature_order)
    return _ENGINE


def predict_hybrid(features: Dict[str, float]) -> Dict[str, Any]:
    engine = _get_engine()
    prediction = engine.predict(features)
    return {
        "prediction": prediction.prediction,
        "probability": prediction.bullish_probability,
        "bearProbability": prediction.bearish_probability,
        "confidence": prediction.confidence,
        "entryWeight": prediction.entry_weight,
        "riskMultiplier": prediction.risk_multiplier,
        "cooldown": {
            "active": prediction.cooldown_active,
            "reason": prediction.cooldown_reason,
            "seconds": prediction.cooldown_seconds,
        },
        "meta": prediction.meta,
    }


__all__ = ["predict_hybrid", "HybridPredictionEngine", "LSTMSequenceEncoder", "MetaLearner"]

