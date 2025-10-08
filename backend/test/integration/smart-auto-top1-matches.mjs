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

function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  const upper = symbol.toUpperCase();
  if (upper.includes(':USDT')) return upper;
  if (upper.endsWith('/USDT')) return `${upper}:USDT`;
  return upper;
}

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  } else {
    await prisma.agentSession.deleteMany({});
  }

  const { scanIntelligentOpportunities } = await import('../../dist/src/services/intelligentAgent.js');

  const ranked = await scanIntelligentOpportunities(undefined, { aggressiveness: 'aggressive' });
  if (!ranked || ranked.length === 0) {
    throw new Error('Ranking returned no opportunities to compare against');
  }

  const topRanked = ranked[0];
  const expectedSymbol = normalizeSymbol(topRanked.symbol);
  if (!expectedSymbol) {
    throw new Error('Top ranked opportunity missing symbol');
  }

  const formattedScore =
    typeof topRanked.score === 'number' ? topRanked.score.toFixed(2) : topRanked.score ?? 'n/a';
  console.log(`🏆 Top ranked opportunity: ${expectedSymbol} (score=${formattedScore})`);

  const { startAgentCreation } = await import('../../dist/src/services/agentCreationFlow.js');

  const payload = {
    mode: 'paper',
    smartAutoMode: true,
    isSmartAgent: true,
    aggressiveness: 'aggressive',
    riskPerTradePct: 1.5,
    maxLeverage: 6,
    dailyLossLimitPct: 3,
    startBalanceUsd: 1500,
    budgetPct: 40,
  };

  const result = await startAgentCreation(payload, null);

  if (!result) {
    throw new Error('Agent creation did not yield a result');
  }

  const selectedSymbol = normalizeSymbol(result.symbol);
  if (!selectedSymbol) {
    throw new Error('Agent creation returned an empty symbol');
  }

  if (selectedSymbol !== expectedSymbol) {
    throw new Error(
      `Selected symbol ${selectedSymbol} does not match top ranked ${expectedSymbol}. Ranked sample: ${ranked
        .slice(0, 3)
        .map((r) => r.symbol)
        .join(', ')}`
    );
  }

  await wait(100);
  const stored = await prisma.agentSession.findUnique({ where: { id: result.sessionId } });
  if (!stored) {
    throw new Error('Agent session record not found after creation');
  }

  const persistedSymbol = normalizeSymbol(stored.symbol);
  if (persistedSymbol !== expectedSymbol) {
    throw new Error(`Persisted session symbol ${persistedSymbol} does not match expected ${expectedSymbol}`);
  }

  if (!result.selection?.autoSelected) {
    throw new Error('Result did not mark selection as auto-selected');
  }

  console.log('✅ Agent auto-selection matched the top ranked opportunity.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
  process.exit(0);
} catch (error) {
  console.error('❌ Smart auto top-ranked comparison failed:', error);
  process.exit(1);
}
