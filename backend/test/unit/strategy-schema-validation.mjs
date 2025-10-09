import assert from 'node:assert/strict';

const { StrategyZ } = await import('../../dist/src/ai/schema.js');

const baseStrategy = {
  strategyId: '2024-01-01:BTCUSDT:manual:1',
  symbol: 'BTCUSDT',
  bias: 'long',
  entry: {
    type: 'limit',
    price: 100,
    zone: { min: 99, max: 101 },
  },
  risk: {
    stop: { type: 'percent', value: 1 },
    target: { type: 'percent', value: 2 },
    risk_pct_balance: 1,
    max_leverage: 5,
  },
};

assert.doesNotThrow(() => StrategyZ.parse(baseStrategy), 'baseline strategy should be valid');

assert.throws(
  () => StrategyZ.parse({
    ...baseStrategy,
    entry: { type: 'limit', price: 100 },
  }),
  /zone/i,
  'missing entry zone should be rejected',
);

assert.throws(
  () => StrategyZ.parse({
    ...baseStrategy,
    entry: { ...baseStrategy.entry, zone: { min: 101, max: 101 } },
  }),
  /min < max/i,
  'zero-width zones should be rejected',
);

assert.throws(
  () => StrategyZ.parse({
    ...baseStrategy,
    entry: { ...baseStrategy.entry, zone: { min: 102, max: 101 } },
  }),
  /min < max/i,
  'inverted zones should be rejected',
);

assert.throws(
  () => StrategyZ.parse({
    ...baseStrategy,
    entry: { ...baseStrategy.entry, zone: { min: Number.POSITIVE_INFINITY, max: 105 } },
  }),
  /finite/i,
  'non-finite zone bounds should be rejected',
);

console.log('✅ strategy-schema-validation.mjs passed');

