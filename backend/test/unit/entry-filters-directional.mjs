import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { EntryFilters } = await import('../../dist/src/quantai/strategies/metaAdaptive/entryFilters.js');

const filters = new EntryFilters({
  minAdx: 10,
  minDollarVolume: 0,
  minRr: 1,
  minAtrPct: 0,
  maxSpreadBps: 50,
  confidenceThreshold: 0,
  useConfidenceFilter: false,
  dynamic: {
    directionalFilter: {
      enabled: true,
      minDiTrend: 2.5,
      minRsiTrend: 55,
      rangeNeutralBand: 12,
    },
  },
});

const trendFacts = {
  adx: 28,
  atrPct: 1.1,
  rsi: 58,
  diPlus: 32,
  diMinus: 20,
  rrToTp1: 1.2,
};
const trendEvaluation = filters.evaluateEntry(trendFacts, { bias: 'long' });
assert.equal(trendEvaluation.ok, true, 'Directional filter should accept strong long trend');
assert.match(trendEvaluation.reasons.directionalOk, /OK/, 'Directional status should report OK');

const weakFacts = {
  adx: 27,
  atrPct: 1.0,
  rsi: 47,
  diPlus: 21,
  diMinus: 26,
  rrToTp1: 1.2,
};
const weakEvaluation = filters.evaluateEntry(weakFacts, { bias: 'long' });
assert.equal(weakEvaluation.ok, false, 'Directional filter should reject when DI/Rsi conflict for longs');
assert.match(weakEvaluation.reasons.directionalOk, /FAIL/, 'Directional failure should be explicit');

const rangeFacts = {
  adx: 12,
  atrPct: 0.9,
  rsi: 51,
  diPlus: 19,
  diMinus: 17,
  rrToTp1: 1.1,
};
const rangeEvaluation = filters.evaluateEntry(rangeFacts, { bias: 'long' });
assert.equal(rangeEvaluation.ok, true, 'Directional filter should relax in range regimes with neutral RSI');

const adaptiveFacts = {
  adx: 26,
  atrPct: 0.62,
  atrBaselinePct: 0.34,
  rsi: 56,
  diPlus: 28,
  diMinus: 25.4,
  rrToTp1: 1.3,
  adxSlope: 1.05,
};
const adaptiveEvaluation = filters.evaluateEntry(adaptiveFacts, { bias: 'long' });
assert.equal(adaptiveEvaluation.ok, true, 'Adaptive directional filter should pass marginal DI when slope/ATR support it');
assert.match(
  adaptiveEvaluation.reasons.directionalOk,
  /adaptiveΔ=/,
  'Directional detail should include adaptive delta information',
);

console.log('✅ entry-filters-directional.mjs passed');
