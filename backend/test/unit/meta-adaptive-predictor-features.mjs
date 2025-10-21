import assert from 'node:assert/strict';

const { __testHooks } = await import('../../dist/src/quantai/strategy/metaAdaptiveAgent.js');

const { buildPredictorFeatures } = __testHooks;

const sequence = Array.from({ length: 20 }, (_, idx) => idx * 0.01);
const volumeSeq = Array.from({ length: 20 }, (_, idx) => (idx - 10) * 0.05);
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
  microstructure: {
    orderFlowImbalance: 0.18,
    aggressionRatio: 0.62,
    deltaVolumeSlope: -0.04,
    midpricePressure: 0.11,
    microAtr: 0.017,
    trendStrength: 0.44,
    priceVelocity: 0.03,
    normalizedCloses: sequence,
    normalizedVolumes: volumeSeq,
    rsiSequence: sequence.map(val => val - 0.1),
    obiSequence: sequence.map((val, idx) => val * 0.5 - idx * 0.01),
    deltaRsi: 0.2,
    deltaObi: -0.15,
  },
};

const features = buildPredictorFeatures(snapshot);

assert(features, 'predictor features should be available when inputs are valid');

const mandatoryKeys = [
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
  'order_flow_imbalance',
  'aggression_ratio',
  'delta_volume_slope',
  'midprice_pressure',
  'micro_atr',
  'trend_strength',
  'price_velocity',
  'delta_rsi',
  'delta_obi',
  'rsi14',
  'rsiSlope',
  'volumeRatio',
  'volumeZScore',
  'seq_close_0',
  'seq_close_19',
  'seq_rsi_0',
  'seq_rsi_19',
  'seq_volume_0',
  'seq_volume_19',
  'seq_obi_0',
  'seq_obi_19',
];

for (const key of mandatoryKeys) {
  assert(key in features, `feature ${key} should be present`);
}
assert(Math.abs(features.volumeRatio - 1.2) < 1e-9, 'volumeRatio should reflect current vs MA volume');
assert(Math.abs(features.emaTrendSpread - snapshot.emaTrendSpread) < 1e-9, 'emaTrendSpread should be preserved');
assert(Math.abs(features.rsiSlope - snapshot.rsiSlope) < 1e-9, 'rsiSlope should be preserved');
assert(Math.abs(features.atrPct - 0.02) < 1e-9, 'atrPct should be normalised to a fraction');
assert(Math.abs(features.momentum3 - snapshot.momentum3) < 1e-9, 'momentum3 should be preserved');
assert(Math.abs(features.order_flow_imbalance - snapshot.microstructure.orderFlowImbalance) < 1e-9, 'microstructure imbalance preserved');
assert(Math.abs(features.delta_rsi - snapshot.microstructure.deltaRsi) < 1e-9, 'delta_rsi should mirror snapshot');
assert(Math.abs(features['seq_close_5'] - sequence[5]) < 1e-9, 'sequences must be embedded');
console.log('✅ buildPredictorFeatures emits full feature vector');
