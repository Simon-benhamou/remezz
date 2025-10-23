import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { computeEntryNudge } = await import('../../dist/src/quantai/micro/microTrigger.js');

const baseInputs = {
  side: 'long',
  lookbackSec: 15,
  entryNudgeBps: 4,
  lastPrice: 100,
  spreadBps: 2,
  top3BidSizeDelta: 50,
  top3AskSizeDelta: -120,
  priceDeltaBps: 8,
};

const nudged = computeEntryNudge(baseInputs);
assert.equal(nudged, 4, 'Long ask depletion should trigger positive nudge');

const flatInputs = {
  ...baseInputs,
  top3AskSizeDelta: 80,
  top3BidSizeDelta: -10,
};
const zero = computeEntryNudge(flatInputs);
assert.equal(zero, 0, 'Without supportive book shifts the nudge should be zero');

console.log('✅ micro-trigger.mjs passed');
