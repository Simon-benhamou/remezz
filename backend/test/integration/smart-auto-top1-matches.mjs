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

async function waitForJobCompletion(getSnapshot, jobId, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const snapshot = getSnapshot(jobId);
      if (!snapshot) return;
      if (snapshot.status === 'completed') {
        clearInterval(timer);
        resolve(snapshot);
      } else if (snapshot.status === 'failed') {
        clearInterval(timer);
        reject(
          new Error(
            `Agent start job failed: ${snapshot.error?.code || 'unknown'} - ${snapshot.error?.message || ''}`
          )
        );
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for job ${jobId}`));
      }
    }, 50);
  });
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

  const { enqueueAgentStartJob, getAgentStartJob } = await import('../../dist/src/services/agentStartJob.js');

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

  const { jobId } = enqueueAgentStartJob({ payload, userId: null });
  const snapshot = await waitForJobCompletion(getAgentStartJob, jobId, 20000);

  if (!snapshot?.result) {
    throw new Error('Agent start job did not yield a result');
  }

  const selectedSymbol = normalizeSymbol(snapshot.result.symbol);
  if (!selectedSymbol) {
    throw new Error('Agent start job returned an empty symbol');
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
  const stored = await prisma.agentSession.findUnique({ where: { id: snapshot.result.sessionId } });
  if (!stored) {
    throw new Error('Agent session record not found after creation');
  }

  const persistedSymbol = normalizeSymbol(stored.symbol);
  if (persistedSymbol !== expectedSymbol) {
    throw new Error(`Persisted session symbol ${persistedSymbol} does not match expected ${expectedSymbol}`);
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
