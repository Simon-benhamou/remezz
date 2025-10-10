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
