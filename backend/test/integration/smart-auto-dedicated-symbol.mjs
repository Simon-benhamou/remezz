import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';
process.env.SMART_AGENT_INIT_MAX_ATTEMPTS = '1';
process.env.SMART_AGENT_INIT_RETRY_BASE_MS = '10';
process.env.SMART_AGENT_INIT_RETRY_MAX_MS = '10';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  const existing = await prisma.agentSession.create({
    data: {
      symbol: 'BNB/USDT:USDT',
      mode: 'paper',
      startBalanceUsd: 1000,
      profileJson: {
        maxLeverage: 4,
        aggressiveness: 'reactive',
      },
    },
  });

  const { startAgentCreation } = await import('../../dist/src/services/agentCreationFlow.js');

  const payload = {
    mode: 'paper',
    smartAutoMode: true,
    isSmartAgent: true,
    aggressiveness: 'aggressive',
    riskPerTradePct: 1.5,
    maxLeverage: 8,
    dailyLossLimitPct: 3.5,
    startBalanceUsd: 2500,
    budgetPct: 50,
  };

  const result = await startAgentCreation(payload, null);

  if (!result) {
    throw new Error('Smart auto-select flow did not return a result');
  }

  const { sessionId, symbol } = result;
  if (!sessionId) {
    throw new Error('Smart auto-select job missing session id');
  }

  if (!symbol || /^BNB\//i.test(symbol)) {
    throw new Error(`Auto-select reused existing symbol: ${symbol}`);
  }

  if (sessionId === existing.id) {
    throw new Error('Auto-select reused the existing session record');
  }

  await wait(100);
  const created = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!created) {
    throw new Error('Newly created agent session not found');
  }

  if (!created.symbol || /^BNB\//i.test(created.symbol)) {
    throw new Error(`Persisted symbol reused existing asset: ${created.symbol}`);
  }

  const profile = (created.profileJson || {});
  const leverage = Number(profile.maxLeverage ?? 0);
  const requested = Number(profile.requestedMaxLeverage ?? profile.maxLeverage ?? 0);
  const cap = profile.leverageCap || {};
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new Error(`Resolved leverage missing or invalid: ${leverage}`);
  }
  if (requested !== 8) {
    throw new Error(`Requested leverage should remain 8x but was ${requested}`);
  }
  if (Math.abs(Number(cap.resolved ?? leverage) - leverage) > 1e-6) {
    throw new Error('Resolved leverage cap metadata mismatch with stored leverage');
  }
  if (!cap.trimmed) {
    throw new Error('Expected leverage cap to indicate trimming for smart auto-select');
  }
  if (leverage + 1e-9 >= requested) {
    throw new Error(`Resolved leverage ${leverage}x should be below requested ${requested}x after trimming`);
  }

  console.log('✅ Smart auto-select created a new symbol with trimmed leverage cap.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
  process.exit(0);
} catch (error) {
  console.error('❌ Smart auto-select integration test failed:', error);
  process.exit(1);
}
