process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

await import('ts-node/esm');

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { prisma } = await import('../src/db/client.ts');
const { computeAgentHealth } = await import('../src/monitor/ops.ts');

await prisma.$reset();

const now = Date.now();

await test('agent health surfaces VOS blocked sessions', async () => {
  const session = await prisma.agentSession.create({
    data: {
      symbol: 'BTC/USDT',
      mode: 'paper',
      startedAt: new Date(now - 2 * 60 * 60 * 1000),
    },
  });

  await prisma.agentOpsTelemetry.create({
    data: {
      sessionId: session.id,
      tradeCount24h: 0,
      blockedByVos: true,
      lastBlockedAt: new Date(now - 5 * 60 * 1000),
    },
  });

  const health = await computeAgentHealth(now, {
    agentsSnapshot: [
      { sessionId: session.id, state: 'HALT', mode: 'paper', symbol: 'BTC/USDT', hasPosition: false },
    ],
  });

  const entry = health.agents.find((row) => row.sessionId === session.id);
  assert.ok(entry, 'expected agent to appear in health snapshot');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blockedByVos, true);
  assert.ok(entry.flags.includes('vos_block'));
});

await test('agent health exposes aggressiveness from runtime or profile', async () => {
  const aggressiveSession = await prisma.agentSession.create({
    data: {
      symbol: 'ETH/USDT',
      mode: 'paper',
      startedAt: new Date(now - 3 * 60 * 60 * 1000),
      profileJson: { aggressiveness: 'conservative' },
    },
  });

  const conservativeSession = await prisma.agentSession.create({
    data: {
      symbol: 'SOL/USDT',
      mode: 'paper',
      startedAt: new Date(now - 4 * 60 * 60 * 1000),
      profileJson: { aggressiveness: 'conservative' },
    },
  });

  const health = await computeAgentHealth(now, {
    agentsSnapshot: [
      {
        sessionId: aggressiveSession.id,
        state: 'RUN',
        mode: 'paper',
        symbol: 'ETH/USDT',
        hasPosition: false,
        aggressiveness: 'aggressive',
      },
      {
        sessionId: conservativeSession.id,
        state: 'RUN',
        mode: 'paper',
        symbol: 'SOL/USDT',
        hasPosition: false,
      },
    ],
  });

  const aggressiveEntry = health.agents.find((row) => row.sessionId === aggressiveSession.id);
  assert.ok(aggressiveEntry, 'expected aggressive agent in snapshot');
  assert.equal(aggressiveEntry.aggressiveness, 'aggressive');

  const conservativeEntry = health.agents.find((row) => row.sessionId === conservativeSession.id);
  assert.ok(conservativeEntry, 'expected conservative agent in snapshot');
  assert.equal(conservativeEntry.aggressiveness, 'conservative');
});

await test('agent health falls back to fills when telemetry is stale', async () => {
  const session = await prisma.agentSession.create({
    data: {
      symbol: 'BTC/USDT',
      mode: 'paper',
      startedAt: new Date(now - 5 * 60 * 60 * 1000),
    },
  });

  await prisma.agentOpsTelemetry.create({
    data: {
      sessionId: session.id,
      tradeCount24h: 0,
      blockedByVos: false,
    },
  });

  const order = await prisma.order.create({
    data: {
      clientOrderId: `test_${session.id}`,
      sessionId: session.id,
      symbol: 'BTC/USDT',
      side: 'BUY',
      type: 'market',
      qty: 0.5,
    },
  });

  await prisma.fill.create({
    data: {
      orderId: order.id,
      sessionId: session.id,
      price: 27000,
      qty: 0.5,
      side: 'BUY',
      ts: new Date(now - 30 * 60 * 1000),
    },
  });

  const health = await computeAgentHealth(now, {
    agentsSnapshot: [
      {
        sessionId: session.id,
        state: 'RUN',
        mode: 'paper',
        symbol: 'BTC/USDT',
        hasPosition: false,
      },
    ],
  });

  const entry = health.agents.find((row) => row.sessionId === session.id);
  assert.ok(entry, 'expected agent to appear in snapshot');
  assert.equal(entry.tradeCount24h, 1);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.flags.includes('no_trades'), false);
});

await test('agent health tallies wins and losses from fills', async () => {
  const session = await prisma.agentSession.create({
    data: {
      symbol: 'ETH/USDT',
      mode: 'paper',
      startedAt: new Date(now - 4 * 60 * 60 * 1000),
    },
  });

  const makeOrder = async (suffix) =>
    prisma.order.create({
      data: {
        clientOrderId: `test_${session.id}_${suffix}`,
        sessionId: session.id,
        symbol: 'ETH/USDT',
        side: 'BUY',
        type: 'market',
        qty: 1,
      },
    });

  const [winOrder, lossOrder, evenOrder] = await Promise.all([
    makeOrder('win'),
    makeOrder('loss'),
    makeOrder('even'),
  ]);

  await prisma.fill.create({
    data: {
      orderId: winOrder.id,
      sessionId: session.id,
      price: 1900,
      qty: 1,
      side: 'SELL',
      realizedPnl: 25.5,
      ts: new Date(now - 30 * 60 * 1000),
    },
  });

  await prisma.fill.create({
    data: {
      orderId: lossOrder.id,
      sessionId: session.id,
      price: 1880,
      qty: 1,
      side: 'SELL',
      realizedPnl: -12.25,
      ts: new Date(now - 25 * 60 * 1000),
    },
  });

  await prisma.fill.create({
    data: {
      orderId: evenOrder.id,
      sessionId: session.id,
      price: 1890,
      qty: 1,
      side: 'SELL',
      realizedPnl: 0,
      ts: new Date(now - 20 * 60 * 1000),
    },
  });

  const health = await computeAgentHealth(now, {
    agentsSnapshot: [
      {
        sessionId: session.id,
        state: 'RUN',
        mode: 'paper',
        symbol: 'ETH/USDT',
        hasPosition: false,
      },
    ],
  });

  const entry = health.agents.find((row) => row.sessionId === session.id);
  assert.ok(entry, 'expected session to appear in health results');
  assert.equal(entry.wins24h, 1);
  assert.equal(entry.losses24h, 1);
  assert.equal(entry.breakeven24h, 1);
});
