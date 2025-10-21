import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { ExecutionPlanner } = await import('../../dist/src/quantai/intraday/execution.js');

const planner = new ExecutionPlanner();

const orderBook = {
  timestamp: Date.now(),
  bids: [
    { price: 99.5, size: 10_000 },
    { price: 99.4, size: 8_000 },
  ],
  asks: [
    { price: 100.5, size: 9_000 },
    { price: 100.6, size: 7_500 },
  ],
};

const basePlan = planner.plan({ regime: 'BOM', orderBook, atrPct: 0.002, sizeUsd: 25_000, slippageBps: 3 });
assert.equal(basePlan.mode, 'maker', 'Expected maker mode with healthy metrics');

planner.ingest({ fillRate: 0.45, slippageBps: 9 });
const adjustedPlan = planner.plan({ regime: 'BOM', orderBook, atrPct: 0.002, sizeUsd: 25_000, slippageBps: 3 });
assert.equal(adjustedPlan.mode, 'taker', 'High observed slippage should force taker mode');

for (let i = 0; i < 5; i++) {
  planner.ingest({ fillRate: 0.95, slippageBps: 2 });
}
const recoveryPlan = planner.plan({ regime: 'MR', orderBook, atrPct: 0.0018, sizeUsd: 15_000, slippageBps: 2 });
assert.notEqual(recoveryPlan.mode, 'taker', 'Improved metrics should allow passive execution');

console.log('✅ execution-planner.mjs passed');
