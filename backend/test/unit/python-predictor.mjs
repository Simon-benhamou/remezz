import assert from 'node:assert/strict';

const { getPrediction } = await import('../../dist/src/quantai/pythonPredictor.js');

const sampleFeatures = {
  ema20: 101.2,
  ema50: 100.8,
  ema100: 100.4,
  ema200: 99.9,
  rsi14: 55.1,
  atr14: 1.2,
  adx14: 25.5,
  ema20Slope: 0.15,
  volumeRatio: 1.1,
};

const prediction = await getPrediction(sampleFeatures);
assert(['long', 'short', 'none'].includes(prediction.decision), 'Python predictor must return a valid decision');
const probs = prediction.probabilities;
const totalProb = probs.long + probs.short + probs.none;
assert(Math.abs(totalProb - 1) < 1e-6, 'Probabilities should sum to 1');
assert(prediction.probabilityLong >= 0 && prediction.probabilityLong <= 1, 'Long probability must be within [0,1]');
assert(prediction.probabilityShort >= 0 && prediction.probabilityShort <= 1, 'Short probability must be within [0,1]');
assert(prediction.probabilityNone >= 0 && prediction.probabilityNone <= 1, 'None probability must be within [0,1]');
console.log(`✅ python predictor decision=${prediction.decision} (P_long=${(prediction.probabilityLong * 100).toFixed(1)}%)`);
