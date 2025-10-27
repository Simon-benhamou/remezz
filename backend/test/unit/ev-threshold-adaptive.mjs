import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { computeAdaptiveEvThreshold } = await import('../../dist/src/agent/state/evThreshold.js');

const tightStop = computeAdaptiveEvThreshold({
  baseThreshold: 3,
  stopPct: 0.92,
  tp1RMultiple: 1.95,
  effectiveAtr: 0.35,
  minAtr: 0.6,
});
assert.equal(tightStop, 1.5, 'Tight stop with strong RR should clamp to 1.5 USD minimum');

const neutral = computeAdaptiveEvThreshold({
  baseThreshold: 3,
  stopPct: 1.8,
  tp1RMultiple: 1.2,
  effectiveAtr: 0.8,
  minAtr: 0.6,
});
assert.equal(neutral, 3, 'Loose stops should retain the base EV threshold');

const strongRr = computeAdaptiveEvThreshold({
  baseThreshold: 6,
  stopPct: 1.2,
  tp1RMultiple: 2.3,
  effectiveAtr: 0.7,
  minAtr: 0.7,
});
assert.ok(strongRr < 6 && strongRr >= 1.5, 'High RR should relax EV requirement without violating floor');

const riskAligned = computeAdaptiveEvThreshold({
  baseThreshold: 4,
  stopPct: 0.95,
  effectiveAtr: 0.6,
  minAtr: 0.6,
  riskUsd: 8,
  rewardMultiplier: 2.5,
});
assert.equal(riskAligned, 20, 'Risk-adjusted EV should respect risk floor even above base threshold');

console.log('✅ ev-threshold-adaptive.mjs passed');
