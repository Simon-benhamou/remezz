import assert from 'node:assert/strict';

const { detectStrategyShift, describeShift } = await import('../../dist/src/engine/strategyShift.js');

const priceShift = detectStrategyShift({
  price: 105,
  lastPrice: 100,
  zone: { min: 99, max: 101 },
  priceThresholdPct: 2,
  regime: { label: 'TREND', confidence: 0.6 },
  previousRegime: { label: 'TREND', confidence: 0.6 },
  confidenceThreshold: 0.2,
});
assert.equal(priceShift.priceShift, true, 'Price shift should trigger beyond threshold');
assert.equal(priceShift.regimeShift, false, 'Price shift alone should not flip regime');
assert.equal(describeShift(priceShift), 'price', 'Describe price-only shift');

const regimeShift = detectStrategyShift({
  price: 100,
  lastPrice: 100,
  zone: null,
  priceThresholdPct: 5,
  regime: { label: 'RANGE', confidence: 0.75 },
  previousRegime: { label: 'TREND', confidence: 0.55 },
  confidenceThreshold: 0.1,
});
assert.equal(regimeShift.priceShift, false, 'Regime flip should not require price shift');
assert.equal(regimeShift.regimeShift, true, 'Different regime label should count as shift');
assert.equal(describeShift(regimeShift), 'regime', 'Describe regime-only shift');

const confidenceShift = detectStrategyShift({
  price: 100,
  lastPrice: 100,
  zone: null,
  priceThresholdPct: 5,
  regime: { label: 'TREND', confidence: 0.95 },
  previousRegime: { label: 'TREND', confidence: 0.6 },
  confidenceThreshold: 0.3,
});
assert.equal(confidenceShift.regimeShift, true, 'Confidence delta over threshold should trigger shift');

const stable = detectStrategyShift({
  price: 100.4,
  lastPrice: 100,
  zone: { min: 99.8, max: 100.2 },
  priceThresholdPct: 1,
  regime: { label: 'TREND', confidence: 0.55 },
  previousRegime: { label: 'TREND', confidence: 0.52 },
  confidenceThreshold: 0.1,
});
assert.equal(stable.priceShift, false, 'Minor move inside zone should not trigger shift');
assert.equal(stable.regimeShift, false, 'Minor confidence delta should not trigger shift');
assert.equal(describeShift(stable), null, 'No shift description expected');

console.log('✅ strategy-regeneration-shift.mjs passed');
