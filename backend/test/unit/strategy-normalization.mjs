import assert from 'node:assert/strict';

const { normalizeStrategyDraft } = await import('../../dist/src/ai/orchestrator.js');
const { StrategyZ } = await import('../../dist/src/ai/schema.js');

const ctx = { last: 100, atrPct: 1.2, support: 98, resistance: 104 };

const collapsed = {
  strategyId: '2024-01-01:BTCUSDT:manual:2',
  symbol: 'BTCUSDT',
  bias: 'long',
  entry: {
    type: 'limit',
    price: 100,
    zone: { min: 100, max: 100 },
  },
  risk: {
    stop: { type: 'percent', value: 1 },
    target: { type: 'percent', value: 2 },
    risk_pct_balance: 1,
    max_leverage: 5,
  },
  confidence: 0.35,
};

const normalized = normalizeStrategyDraft(collapsed, ctx);

assert(normalized.entry.zone.min < normalized.entry.zone.max, 'collapsed zone should be expanded');
const width = normalized.entry.zone.max - normalized.entry.zone.min;
assert(width > 0.01, 'expanded zone should span a meaningful band');

assert.equal(
  normalized.risk.risk_pct_balance,
  0.25,
  'risk sizing should scale down for low confidence',
);

assert.doesNotThrow(() => StrategyZ.parse(normalized), 'normalized draft should satisfy schema');

const confident = normalizeStrategyDraft({
  ...collapsed,
  confidence: 0.9,
  entry: { ...collapsed.entry },
  risk: { ...collapsed.risk },
}, ctx);

assert.equal(
  confident.risk.risk_pct_balance,
  1,
  'high confidence should preserve base risk sizing',
);

console.log('✅ strategy-normalization.mjs passed');

