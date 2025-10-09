import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

console.log('🧪 Running stop-all emergency integration test...');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  const { stopAllAgents } = await import('../../dist/src/services/stopAllAgents.js');

  const sessionA = await prisma.agentSession.create({
    data: {
      symbol: 'BTC/USDT:USDT',
      mode: 'paper',
      startBalanceUsd: 10000,
    },
  });

  const sessionB = await prisma.agentSession.create({
    data: {
      symbol: 'ETH/USDT:USDT',
      mode: 'paper',
      startBalanceUsd: 5000,
    },
  });

  await prisma.order.create({
    data: {
      clientOrderId: `ord_${sessionA.id}_1`,
      sessionId: sessionA.id,
      symbol: sessionA.symbol,
      side: 'buy',
      type: 'limit',
      qty: 1,
      status: 'open',
    },
  });

  await prisma.position.create({
    data: {
      sessionId: sessionA.id,
      symbol: sessionA.symbol,
      side: 'buy',
      qty: 1,
      entryPrice: 50000,
    },
  });

  await prisma.order.create({
    data: {
      clientOrderId: `ord_${sessionB.id}_1`,
      sessionId: sessionB.id,
      symbol: sessionB.symbol,
      side: 'sell',
      type: 'limit',
      qty: 2,
      status: 'open',
    },
  });

  await prisma.position.create({
    data: {
      sessionId: sessionB.id,
      symbol: sessionB.symbol,
      side: 'sell',
      qty: 2,
      entryPrice: 3500,
    },
  });

  const outcome = await stopAllAgents({ actorId: 'tester', actorUsername: 'integration-suite' });

  assert(Array.isArray(outcome.results) && outcome.results.length === 2, 'Expected results for two sessions');
  assert(outcome.stoppedSessionIds.includes(sessionA.id) && outcome.stoppedSessionIds.includes(sessionB.id), 'All sessions should be halted');
  assert(typeof outcome.auditLogId === 'string' && outcome.auditLogId.length > 0, 'Audit log ID should be returned');

  const ordersA = await prisma.order.findMany({ where: { sessionId: sessionA.id } });
  assert(ordersA.every((o) => o.status === 'canceled'), 'Session A orders should be canceled');

  const positionsA = await prisma.position.findMany({ where: { sessionId: sessionA.id } });
  assert(positionsA.every((p) => Number(p.qty) === 0), 'Session A positions should be flattened');

  const ordersB = await prisma.order.findMany({ where: { sessionId: sessionB.id } });
  assert(ordersB.every((o) => o.status === 'canceled'), 'Session B orders should be canceled');

  const positionsB = await prisma.position.findMany({ where: { sessionId: sessionB.id } });
  assert(positionsB.every((p) => Number(p.qty) === 0), 'Session B positions should be flattened');

  const sessions = await prisma.agentSession.findMany({ where: { id: { in: outcome.stoppedSessionIds } } });
  assert(sessions.every((s) => s.stoppedAt && s.haltedAt), 'Sessions should have stoppedAt and haltedAt timestamps');

  const auditLogs = await prisma.auditLog.findMany();
  assert(auditLogs.length === 1, 'Exactly one audit log entry expected');
  assert(auditLogs[0].action === 'agent.stop_all', 'Audit log action mismatch');

  const stopAllSummary = outcome.results.find((r) => r.sessionId === sessionA.id);
  assert(stopAllSummary && stopAllSummary.cancelCount >= 1, 'Agent session A should report canceled orders');

  console.log('✅ Stop-all emergency integration test passed.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ Stop-all emergency integration test failed:', error);
  process.exit(1);
}
