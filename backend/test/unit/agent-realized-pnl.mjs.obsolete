import assert from 'node:assert/strict';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state/index.js');

function buildPosition({ side, entry, qty }) {
  return {
    side,
    entry,
    qty,
    stop: entry * 0.9,
    tp: [],
    openedAt: Date.now(),
    extended: false,
  };
}

{
  const agent = new ReboundRejectionAgent();
  agent.pos = buildPosition({ side: 'buy', entry: 0.0039, qty: 409_836.0656 });
  const flatExit = agent.calculateRealizedPnL(0.0039, agent.pos.qty);
  assert.equal(flatExit.toFixed(8), '0.00000000');

  const lossExit = agent.calculateRealizedPnL(0.0038, agent.pos.qty);
  const expectedLoss = -0.0001 * agent.pos.qty;
  assert.ok(Math.abs(lossExit - expectedLoss) < 1e-6, `expected ${expectedLoss}, got ${lossExit}`);
}

{
  const agent = new ReboundRejectionAgent();
  agent.pos = buildPosition({ side: 'sell', entry: 0.0039, qty: 200_000 });
  const profitExit = agent.calculateRealizedPnL(0.0038, 100_000);
  const expectedProfit = (0.0039 - 0.0038) * 100_000;
  assert.ok(Math.abs(profitExit - expectedProfit) < 1e-6, `expected ${expectedProfit}, got ${profitExit}`);
}

console.log('agent-realized-pnl ✅');
