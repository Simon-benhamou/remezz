import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';
process.env.DEFAULT_MAX_LEVERAGE = '8';
process.env.LEVERAGE_CAP_DEFAULT = '6';
process.env.LEVERAGE_CAP_MAJOR = '6';
process.env.LEVERAGE_CAP_ALT = '4';
process.env.LEVERAGE_CAP_MEME = '3';
process.env.LEVERAGE_CONSTRAINT_REFRESH_DISABLED = 'true';

console.log('🧪 Running leverage cap clamp integration test...');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  const {
    clearLeverageCapCache,
  } = await import('../../dist/src/risk/leverageCaps.js');
  const { startAgentCreation } = await import('../../dist/src/services/agentCreationFlow.js');
  const { AgentHub } = await import('../../dist/src/agent/hub.js');

  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  clearLeverageCapCache();

  await prisma.leverageConstraint.create({
    data: {
      symbol: 'BTC/USDT:USDT',
      targetLeverage: 3.2,
      hardCap: 3,
      notes: 'Tighter symbol-specific clamp for test',
    },
  });
  clearLeverageCapCache();

  const startPayload = {
    mode: 'paper',
    symbol: 'BTC/USDT:USDT',
    aggressiveness: 'reactive',
    riskPerTradePct: 1.5,
    maxLeverage: 8,
    dailyLossLimitPct: 3.5,
    startBalanceUsd: 4000,
    budgetPct: 50,
    isSmartAgent: false,
    perps: ['BTC/USDT:USDT'],
  };

  const result = await startAgentCreation(startPayload, null);
  if (!result || result.state !== 'ready') {
    throw new Error(`Unexpected agent creation state: ${result?.state}`);
  }

  const sessionId = result.sessionId;
  await wait(200);
  const agent = AgentHub.get(sessionId);
  if (!agent) {
    throw new Error('AgentHub did not register the created session');
  }

  const profile = agent.profile;
  if (!profile) {
    throw new Error('Agent profile missing after activation');
  }

  const expectedCap = 3; // min(target=3.2, hard=3, mode=8, category=6)
  if (profile.maxLeverage !== expectedCap) {
    throw new Error(`Agent profile maxLeverage expected ${expectedCap} but received ${profile.maxLeverage}`);
  }
  if (profile.requestedMaxLeverage !== 8) {
    throw new Error(`Agent requested leverage should remain 8x but was ${profile.requestedMaxLeverage}`);
  }
  if (!profile.leverageCap || profile.leverageCap.resolved !== expectedCap) {
    throw new Error('Resolved leverage cap metadata missing or incorrect');
  }
  if (profile.leverageCap.constraintSource !== 'symbol') {
    throw new Error(`Constraint source expected symbol but got ${profile.leverageCap.constraintSource}`);
  }
  if (!profile.leverageCap.trimmed) {
    throw new Error('Resolved leverage cap should be flagged as trimmed');
  }

  const session = await prisma.agentSession.findUnique({
    where: { id: sessionId },
  });
  const storedProfile = (session?.profileJson || {});
  if (!storedProfile.leverageCap || storedProfile.leverageCap.resolved !== expectedCap) {
    throw new Error('Stored session profile did not persist leverage cap metadata');
  }
  if (storedProfile.maxLeverage !== expectedCap) {
    throw new Error('Persisted maxLeverage on session does not match resolved cap');
  }

  console.log('✅ Leverage cap clamp integration test passed.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ Leverage cap clamp integration test failed:', error);
  process.exit(1);
}
