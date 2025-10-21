import assert from 'node:assert/strict';

const { __testHooks } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

const { buildPredictorFeatures } = __testHooks;

const snapshot = {
  ema20: 105,
  ema50: 100,
  ema100: 98,
  ema200: 95,
  rsi14: 55,
  atr14: 2,
  adx14: 25,
  ema20Slope: 0.4,
  volume: 1200,
  volumeMA: 1000,
  emaTrendSpread: (105 - 100) / 100,
  rsiSlope: 1.2,
  volumeZScore: 0.75,
  momentum3: 0.03,
  last: 100,
  atrPct: 2,
};

const features = buildPredictorFeatures(snapshot);

assert(features, 'predictor features should be available when inputs are valid');

const expectedKeys = [
  'adx14',
  'atr14',
  'atrPct',
  'ema100',
  'ema200',
  'ema20',
  'ema20Slope',
  'ema50',
  'emaTrendSpread',
  'momentum3',
  'rsi14',
  'rsiSlope',
  'volumeRatio',
  'volumeZScore',
];

assert.deepStrictEqual(Object.keys(features).sort(), expectedKeys.sort(), 'feature keys should match python expectations');
assert(Math.abs(features.volumeRatio - 1.2) < 1e-9, 'volumeRatio should reflect current vs MA volume');
assert(Math.abs(features.emaTrendSpread - snapshot.emaTrendSpread) < 1e-9, 'emaTrendSpread should be preserved');
assert(Math.abs(features.rsiSlope - snapshot.rsiSlope) < 1e-9, 'rsiSlope should be preserved');
assert(Math.abs(features.atrPct - 0.02) < 1e-9, 'atrPct should be normalised to a fraction');
assert(Math.abs(features.momentum3 - snapshot.momentum3) < 1e-9, 'momentum3 should be preserved');
console.log('✅ buildPredictorFeatures emits full feature vector');
