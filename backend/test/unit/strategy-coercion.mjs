import assert from 'node:assert/strict';

const { normalizeStrategyDraft } = await import('../../dist/src/ai/orchestrator.js');
const { StrategyZ } = await import('../../dist/src/ai/schema.js');

const ctx = { last: 25000, atrPct: 1.8, support: 24500, resistance: 25500 };

const llmStyle = {
  strategyId: 'plan-123',
  symbol: 'BTCUSDT',
  bias: 'long',
  entry: {
    type: 'limit',
    price: 25000,
  },
  stop: { type: 'percent', value: '1.6' },
  target: { type: 'percent', value: '3.4' },
  risk_pct_balance: '1.2',
  max_leverage: 8,
};

const normalized = normalizeStrategyDraft(llmStyle, ctx);

assert(normalized.risk?.stop, 'stop should be mapped into risk object');
assert.equal(normalized.risk.stop.type, 'percent');
assert.equal(normalized.risk.stop.value, 1.6);
assert(normalized.risk?.target, 'target should be mapped into risk object');
assert.equal(normalized.risk.target.value, 3.4);
assert.equal(normalized.risk.risk_pct_balance, 1.2);
assert.equal(normalized.risk.max_leverage, 8);

assert.doesNotThrow(() => StrategyZ.parse(normalized), 'normalized draft should satisfy schema after coercion');

console.log('✅ strategy-coercion.mjs passed');
