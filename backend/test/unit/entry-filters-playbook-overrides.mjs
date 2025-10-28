import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { EntryFilters } = await import('../../dist/src/quantai/strategies/metaAdaptive/entryFilters.js');

const baseConfig = {
  minAdx: 10,
  minDollarVolume: 100_000,
  minRr: 1.0,
  minAtrPct: 0.05,
  maxSpreadBps: 20,
  confidenceThreshold: 0.5,
  useConfidenceFilter: true,
  playbookOverrides: {
    trend_following: {
      minRr: 1.4,
      minAdx: 20,
      confidenceThreshold: 0.6,
    },
  },
};

const filters = new EntryFilters(baseConfig);

const baseFacts = {
  price: 100,
  atr: 0.8,
  atrPct: 0.8,
  atrBaselinePct: 0.75,
  adx: 22,
  rsi: 55,
  spreadBps: 8,
  dollarVolume: 1_200_000,
  rrToTp1: 1.1,
  rrWeighted: 1.15,
  tpWeightedPct: 0.9,
  stopDistance: 0.8,
  qualityPassHint: true,
  volumeRatio: 1.3,
  modelConfidence: 0.65,
  slopeDirectionalPct: 0.12,
  slopeAbsPct: 0.12,
  cmf: 0.25,
  adxSlope: 0.04,
  diPlus: 24,
  diMinus: 10,
};

const baselineEvaluation = filters.evaluateEntry(baseFacts, {
  playbook: null,
  bias: 'long',
});

assert.equal(baselineEvaluation.ok, true, 'Baseline config should allow entry without playbook override');

const trendEvaluation = filters.evaluateEntry(baseFacts, {
  playbook: 'trend_following',
  bias: 'long',
});

assert.equal(trendEvaluation.ok, false, 'Playbook override should tighten thresholds and block entry');

console.log('✅ entry-filters-playbook-overrides.mjs passed');
