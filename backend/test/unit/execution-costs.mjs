import assert from 'node:assert/strict';

const { calculateExecutionCosts } = await import('../../dist/src/quantai/executionCosts.js');

const feeModel = { makerFeeBps: 1.8, takerFeeBps: 5 };

const baseInputs = {
  price: 2000,
  qty: 2,
  side: 'buy',
  fees: feeModel,
  impactBpsPerMillion: 4,
  fundingAnnualPct: 8,
  holdMs: 60 * 60 * 1000,
  atr: 50,
  lastPrice: 2000,
};

const makerCosts = calculateExecutionCosts({
  ...baseInputs,
  liquidity: 'maker',
  latencyMs: 50,
});

const takerCosts = calculateExecutionCosts({
  ...baseInputs,
  liquidity: 'taker',
  latencyMs: 50,
});

assert(makerCosts.feeUsd < takerCosts.feeUsd, 'Maker fees should be lower than taker fees');

const zeroLatency = calculateExecutionCosts({
  ...baseInputs,
  liquidity: 'taker',
  latencyMs: 0,
});

const highLatency = calculateExecutionCosts({
  ...baseInputs,
  liquidity: 'taker',
  latencyMs: 200,
});

assert(zeroLatency.latencyUsd < highLatency.latencyUsd, 'Latency cost should increase with higher latency');
assert(Number.isFinite(highLatency.totalUsd), 'Total cost should be finite');

console.log('✅ execution-costs tests passed');
