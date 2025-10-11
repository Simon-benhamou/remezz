import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

console.log('🧪 Running cold restart rehydration integration test...');

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  const { AgentHub } = await import('../../dist/src/agent/hub.js');
  const { rehydrateActiveAgentSessions } = await import('../../dist/src/services/sessionRehydration.js');

  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  const user = await prisma.user.create({
    data: {
      id: 'rehydrate-user',
      username: 'rehydrate',
      email: 'rehydrate@example.com',
      passwordHash: 'hashed',
      role: 'trader',
    },
  });

  const session = await prisma.agentSession.create({
    data: {
      id: 'rehydrate-session',
      symbol: 'BTC/USDT:USDT',
      mode: 'paper',
      userId: user.id,
      profileJson: {
        symbol: 'BTC/USDT:USDT',
        riskPerTradePct: 1.5,
        maxLeverage: 3,
        requestedMaxLeverage: 3,
        dailyLossLimitPct: 3.5,
        budgetFraction: 0.5,
        aggressiveness: 'reactive',
        timestamp: new Date().toISOString(),
        sizingMode: 'risk',
      },
    },
  });

  if (AgentHub.get(session.id)) {
    throw new Error('AgentHub should not contain session before rehydration');
  }

  await rehydrateActiveAgentSessions();

  const agent = AgentHub.get(session.id);
  if (!agent) {
    throw new Error('AgentHub did not rehydrate the session');
  }

  const refreshed = await prisma.agentSession.findUnique({ where: { id: session.id } });
  if (!refreshed || refreshed.needsAttention) {
    throw new Error('Session should not be flagged as needs_attention after successful rehydration');
  }

  console.log('✅ Cold restart rehydration integration test passed.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ Cold restart rehydration test failed:', error);
  process.exit(1);
}
