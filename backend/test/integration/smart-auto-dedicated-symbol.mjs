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

async function waitForJobCompletion(getSnapshot, jobId, timeoutMs = 15000) {
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

  const { enqueueAgentStartJob, getAgentStartJob } = await import('../../dist/src/services/agentStartJob.js');

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

  const { jobId } = enqueueAgentStartJob({ payload, userId: null });
  const snapshot = await waitForJobCompletion(getAgentStartJob, jobId, 20000);

  if (!snapshot?.result) {
    throw new Error('Smart auto-select job did not return a result');
  }

  const { sessionId, symbol } = snapshot.result;
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

  const leverage = Number((created.profileJson || {}).maxLeverage ?? 0);
  if (leverage !== 8) {
    throw new Error(`Max leverage not persisted from request: expected 8, received ${leverage}`);
  }

  console.log('✅ Smart auto-select created a new symbol with requested leverage.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
  process.exit(0);
} catch (error) {
  console.error('❌ Smart auto-select integration test failed:', error);
  process.exit(1);
}
