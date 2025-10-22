import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { History } = await import('../../dist/src/quantai/strategies/intradayDual/history.js');

const history = new History({ lambda: 0.97, costsBps: 5, seed: 1337 });

const initial = history.qValues();
assert(Number.isFinite(initial.qL));
assert(Number.isFinite(initial.qS));
assert(Math.abs(initial.qL - initial.qS) < 1e-3, 'initial bias should be neutral');

history.update({ side: 'long', pnl: 120, entryTs: 1_700_000_000_000, exitTs: 1_700_000_060_000 }, -90);
const afterLongWin = history.qValues();
assert(afterLongWin.qL > initial.qL, 'long win should lift qL');

history.update({ side: 'short', pnl: -80, entryTs: 1_700_000_120_000, exitTs: 1_700_000_180_000 }, 95);
const afterShortLoss = history.qValues();
assert(Number.isFinite(afterShortLoss.qS), 'short-side q should remain finite after loss');

for (let i = 0; i < 3; i += 1) {
  const entryTs = 1_700_000_240_000 + i * 60_000;
  history.update({ side: 'long', pnl: -150, entryTs, exitTs: entryTs + 60_000 }, 140);
}

const finalQ = history.qValues();
assert(finalQ.qS > finalQ.qL, 'counterfactual strength on short should outweigh repeated long losses');

console.log('✅ history-adaptive.mjs passed');
