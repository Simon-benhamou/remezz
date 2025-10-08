import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';
process.env.SMART_AGENT_INIT_MAX_ATTEMPTS = '1';
process.env.SMART_AGENT_INIT_RETRY_BASE_MS = '10';
process.env.SMART_AGENT_INIT_RETRY_MAX_MS = '10';

function waitForJobCompletion(getSnapshot, jobId, timeoutMs = 15000) {
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

function normalize(symbol) {
  if (!symbol) return symbol;
  const base = symbol.split('/')[0];
  return `${base}/USDT`;
}

(async () => {
  try {
    const { prisma } = await import('../../dist/src/db/client.js');
    if (typeof prisma.$reset === 'function') {
      await prisma.$reset();
    }

    const existingSymbols = ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'ADA/USDT:USDT', 'XRP/USDT:USDT'];
    const existingSessions = [];
    for (const symbol of existingSymbols) {
      const session = await prisma.agentSession.create({
        data: {
          symbol,
          mode: 'paper',
          startBalanceUsd: 1500,
          profileJson: {
            maxLeverage: 4,
            aggressiveness: 'reactive',
          },
        },
      });
      existingSessions.push(session);
    }

    const { enqueueAgentStartJob, getAgentStartJob } = await import('../../dist/src/services/agentStartJob.js');

    const payload = {
      mode: 'paper',
      smartAutoMode: true,
      isSmartAgent: true,
      aggressiveness: 'aggressive',
      riskPerTradePct: 1.25,
      maxLeverage: 6,
      dailyLossLimitPct: 4,
      startBalanceUsd: 3000,
      budgetPct: 40,
    };

    const { jobId } = enqueueAgentStartJob({ payload, userId: null });
    const snapshot = await waitForJobCompletion(getAgentStartJob, jobId, 20000);

    if (!snapshot?.result) {
      throw new Error('Smart auto-select job did not return a result');
    }

    const { sessionId, symbol } = snapshot.result;
    if (!sessionId) {
      throw new Error('Smart auto-select job missing session id');
    }

    const normalizedExisting = new Set(existingSessions.map((s) => normalize(s.symbol)));
    const normalizedSelected = normalize(symbol);

    if (!symbol || normalizedExisting.has(normalizedSelected)) {
      throw new Error(`Auto-select reused an active symbol: ${symbol}`);
    }

    const created = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    if (!created) {
      throw new Error('Newly created agent session not found');
    }

    const normalizedCreated = normalize(created.symbol);
    if (normalizedExisting.has(normalizedCreated)) {
      throw new Error(`Persisted session symbol conflicts with existing agents: ${created.symbol}`);
    }

    if (Number((created.profileJson || {}).maxLeverage ?? 0) !== 6) {
      throw new Error('Requested max leverage not applied to session profile');
    }

    console.log('✅ Smart auto-select created a fifth agent on a fresh symbol.');

    if (typeof prisma.$disconnect === 'function') {
      await prisma.$disconnect();
    }
    process.exit(0);
  } catch (error) {
    console.error('❌ Smart auto-select multi-agent integration test failed:', error);
    process.exit(1);
  }
})();
