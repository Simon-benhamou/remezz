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
assert([0, 1].includes(prediction), 'Python predictor must return 0 or 1');
console.log(`✅ python predictor returned ${prediction}`);
