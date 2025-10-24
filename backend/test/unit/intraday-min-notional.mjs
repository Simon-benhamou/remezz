import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { VolatilitySizer } = await import('../../dist/src/quantai/strategies/intradayDual/risk.js');
const { PreciseDecimal } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

const sizer = new VolatilitySizer();

const baseCtx = {
  equityUsd: new PreciseDecimal('1000'),
  regime: 'BOM',
  price: new PreciseDecimal('1'),
  maxLevInstrument: 5,
  maxLevGlobal: 5,
  exposureBudget: 5,
  slippageBps: 2,
  riskReduction: 1,
  riskScale: 1,
  baseRiskPct: 0.0003,
  minNotionalUsd: 10,
};

const adjusted = sizer.compute({
  ...baseCtx,
  stopLossPct: 0.05,
});

assert(adjusted.minNotionalApplied === true, 'Expected min notional bump to apply');
assert.equal(adjusted.droppedReason, undefined, 'Should not drop when min notional fits caps');
assert(adjusted.size.toNumber() >= 9.99 && adjusted.size.toNumber() <= 10.01, 'Size should snap to $10 notional');

const dropped = sizer.compute({
  ...baseCtx,
  stopLossPct: 0.05,
  maxLevInstrument: 0.005,
});

assert.equal(dropped.droppedReason, 'below_min_notional', 'Expected drop reason when caps forbid min size');
assert.equal(dropped.size.toNumber(), 0, 'Size should be zero when dropped');

console.log('✅ intraday-min-notional.mjs passed');
