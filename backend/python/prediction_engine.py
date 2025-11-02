"""Hybrid directional prediction engine combining XGBoost and a lightweight LSTM."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Sequence, Tuple

import numpy as np

from ccxt_xgboost_module import METADATA_PATH, load_features, load_model


SEQUENCE_LENGTH = 20
LSTM_HIDDEN_SIZE = 8
ENGINE_STATE_PATH = Path(__file__).resolve().parent / "hybrid_state.json"
DEFAULT_CLASS_ORDER = ["long", "none", "short"]
DEFAULT_CALIBRATION = {"temperature": 1.0}


def _sigmoid(x: float | np.ndarray) -> float | np.ndarray:
    if isinstance(x, np.ndarray):
        return 1.0 / (1.0 + np.exp(-np.clip(x, -12, 12)))
    clipped = _clamp(float(x), -12, 12)
    return 1.0 / (1.0 + math.exp(-clipped))


def _clamp(value: float, lower: float, upper: float) -> float:
    if not math.isfinite(value):
        return lower
    return max(lower, min(upper, value))


def _load_predictor_metadata() -> tuple[list[str], Dict[str, float]]:
    if METADATA_PATH.exists():
        try:
            payload = json.loads(METADATA_PATH.read_text())
            classes = payload.get("classOrder") or DEFAULT_CLASS_ORDER
            calibration = payload.get("calibration") or DEFAULT_CALIBRATION
            ordered = [str(label) for label in classes if isinstance(label, str)]
            if not ordered:
                ordered = list(DEFAULT_CLASS_ORDER)
            temperature = float(calibration.get("temperature", 1.0))  # type: ignore[arg-type]
            if not math.isfinite(temperature) or temperature <= 0:
                temperature = DEFAULT_CALIBRATION["temperature"]
            return ordered, {"temperature": temperature}
        except json.JSONDecodeError:
            pass
    return list(DEFAULT_CLASS_ORDER), {"temperature": DEFAULT_CALIBRATION["temperature"]}


def _apply_temperature(probabilities: np.ndarray, temperature: float) -> np.ndarray:
    if temperature <= 0 or not math.isfinite(temperature):
        return probabilities
    stabilized = np.log(np.clip(probabilities, 1e-12, 1.0))
    scaled = stabilized / temperature
    scaled -= np.max(scaled)
    exp_vals = np.exp(scaled)
    total = np.sum(exp_vals)
    if total <= 0:
        return np.full_like(probabilities, 1.0 / max(probabilities.size, 1), dtype=float)
    return exp_vals / total


@dataclass
class HybridPrediction:
    decision: str
    prob_long: float
    prob_short: float
    prob_none: float
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
        self.class_order, calibration = _load_predictor_metadata()
        if not self.class_order:
            self.class_order = list(DEFAULT_CLASS_ORDER)
        self.class_to_index = {label: idx for idx, label in enumerate(self.class_order)}
        self.temperature = float(calibration.get("temperature", 1.0))
        if not math.isfinite(self.temperature) or self.temperature <= 0:
            self.temperature = DEFAULT_CALIBRATION["temperature"]
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

    def _tabular_probabilities(self, features: Dict[str, float]) -> Dict[str, float]:
        row = [float(features.get(key, 0.0)) for key in self.feature_order]
        probs = self.model.predict_proba([row])
        if isinstance(probs, np.ndarray):
            vector = probs[0]
        else:
            vector = np.asarray(probs)[0]
        vector = np.asarray(vector, dtype=float)
        if vector.ndim != 1:
            vector = np.reshape(vector, (-1,))
        if self.temperature:
            vector = _apply_temperature(vector, self.temperature)
        vector = np.clip(vector, 1e-9, None)
        total = float(vector.sum())
        if total <= 0:
            vector = np.full_like(vector, 1.0 / max(len(vector), 1), dtype=float)
        else:
            vector = vector / total
        probabilities: Dict[str, float] = {}
        for label, idx in self.class_to_index.items():
            if idx < vector.size:
                probabilities[label] = float(vector[idx])
        # Ensure all required labels exist even if model omitted them.
        for label in DEFAULT_CLASS_ORDER:
            probabilities.setdefault(label, 1.0 / len(DEFAULT_CLASS_ORDER))
        # Re-normalise to guard against manual inserts.
        normaliser = sum(probabilities.values()) or 1.0
        for label in list(probabilities.keys()):
            probabilities[label] = max(0.0, float(probabilities[label] / normaliser))
        return probabilities

    def predict(self, features: Dict[str, float]) -> HybridPrediction:
        sequence = self._prepare_sequence_tensor(features)
        seq_prob, seq_confidence = self.encoder.encode(sequence)

        tabular_probs = self._tabular_probabilities(features)
        prob_long = float(tabular_probs.get("long", 1 / len(DEFAULT_CLASS_ORDER)))
        prob_none = float(tabular_probs.get("none", 1 / len(DEFAULT_CLASS_ORDER)))
        prob_short = float(tabular_probs.get("short", 1 / len(DEFAULT_CLASS_ORDER)))
        active_mass = max(1e-6, prob_long + prob_short)
        prior_long_ratio = prob_long / active_mass if active_mass > 0 else 0.5

        micro_features = [
            features.get("order_flow_imbalance", 0.0),
            features.get("aggression_ratio", 0.0),
            features.get("delta_volume_slope", 0.0),
            features.get("midprice_pressure", 0.0),
            features.get("micro_atr", 0.0),
            features.get("trend_strength", 0.0),
            features.get("price_velocity", 0.0),
        ]

        meta_inputs = [1.0, prob_long, seq_prob, *micro_features]
        meta_long_ratio = float(self.meta.predict(np.array(meta_inputs, dtype=float)))
        meta_long_ratio = _clamp(meta_long_ratio, 0.0, 1.0)

        blended_ratio = _clamp(0.6 * meta_long_ratio + 0.4 * prior_long_ratio, 0.0, 1.0)
        none_weight = _clamp(0.55 * prob_none + 0.45 * (1.0 - seq_confidence), 0.0, 0.95)
        remaining_mass = max(1e-6, 1.0 - none_weight)
        final_long = remaining_mass * blended_ratio
        final_short = remaining_mass - final_long

        raw_vector = np.array([final_long, none_weight, final_short], dtype=float)
        raw_vector = np.clip(raw_vector, 1e-6, None)
        prob_vector = raw_vector / raw_vector.sum()
        prob_long, prob_none, prob_short = (float(prob_vector[idx]) for idx in range(3))

        sorted_probs = np.sort(prob_vector)[::-1]
        top_gap = float(sorted_probs[0] - sorted_probs[1])
        confidence = float(_clamp(0.5 * seq_confidence + 0.5 * min(1.0, top_gap * 2.5), 0.0, 1.0))

        entry_weight = _clamp(0.7 + confidence * 0.75, 0.6, 1.6)
        risk_multiplier = _clamp(0.75 + confidence * 0.45, 0.6, 1.5)

        volatility = abs(features.get("micro_atr", 0.0))
        rsi_trend = features.get("delta_rsi", 0.0)
        obi_trend = features.get("delta_obi", 0.0)
        divergence = rsi_trend * obi_trend < 0 and abs(rsi_trend) > 0.05 and abs(obi_trend) > 0.05
        cooldown_active = volatility > 0.018 and divergence
        cooldown_seconds = 180 if cooldown_active else None
        cooldown_reason = "volatility_divergence" if cooldown_active else None

        decision_index = int(np.argmax(prob_vector))
        decision_label = ["long", "none", "short"][decision_index]

        meta = {
            "tabular": tabular_probs,
            "sequenceProb": round(seq_prob, 6),
            "sequenceConfidence": round(seq_confidence, 6),
            "metaBlendRatio": round(blended_ratio, 6),
            "temperature": self.temperature,
            "classOrder": list(self.class_order),
            "featuresUsed": {
                "order_flow_imbalance": features.get("order_flow_imbalance", 0.0),
                "aggression_ratio": features.get("aggression_ratio", 0.0),
                "delta_volume_slope": features.get("delta_volume_slope", 0.0),
                "midprice_pressure": features.get("midprice_pressure", 0.0),
                "micro_atr": features.get("micro_atr", 0.0),
                "trend_strength": features.get("trend_strength", 0.0),
                "price_velocity": features.get("price_velocity", 0.0),
            },
        }

        return HybridPrediction(
            decision=decision_label,
            prob_long=prob_long,
            prob_short=prob_short,
            prob_none=prob_none,
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
        "decision": prediction.decision,
        "probabilities": {
            "long": prediction.prob_long,
            "short": prediction.prob_short,
            "none": prediction.prob_none,
        },
        "probabilityLong": prediction.prob_long,
        "probabilityShort": prediction.prob_short,
        "probabilityNone": prediction.prob_none,
        "confidence": prediction.confidence,
        "entryWeight": prediction.entry_weight,
        "riskMultiplier": prediction.risk_multiplier,
        "cooldown": {
            "active": prediction.cooldown_active,
            "reason": prediction.cooldown_reason,
            "seconds": prediction.cooldown_seconds,
        },
        "meta": prediction.meta,
        "classOrder": list(engine.class_order),
    }


__all__ = ["predict_hybrid", "HybridPredictionEngine", "LSTMSequenceEncoder", "MetaLearner"]
