import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

console.log('🧪 Running paper agent lifecycle integration test...');

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
        reject(new Error(`Agent start job failed: ${snapshot.error?.code || 'unknown'} - ${snapshot.error?.message || ''}`));
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

  const { enqueueAgentStartJob, getAgentStartJob } = await import('../../dist/src/services/agentStartJob.js');
  const { AgentHub } = await import('../../dist/src/agent/hub.js');
  const { computeMonitorAnalytics } = await import('../../dist/src/monitor/analytics.js');
  const { buildTechSnapshot } = await import('../../dist/src/ai/tech.js');

  const startPayload = {
    mode: 'paper',
    symbol: 'BTC/USDT:USDT',
    aggressiveness: 'aggressive',
    riskPerTradePct: 1.8,
    maxLeverage: 3,
    dailyLossLimitPct: 3.5,
    startBalanceUsd: 5000,
    budgetPct: 60,
    isSmartAgent: false,
    perps: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
  };

  console.log('📨 Enqueuing agent start job in paper mode...');
  const { jobId } = enqueueAgentStartJob({ payload: startPayload, userId: null });
  const snapshot = await waitForJobCompletion(getAgentStartJob, jobId);

  if (!snapshot?.result || snapshot.result.state !== 'ready') {
    throw new Error(`Unexpected job result state: ${snapshot?.result?.state}`);
  }

  const sessionId = snapshot.result.sessionId;
  console.log(`✅ Agent session created: ${sessionId}`);

  await wait(200);
  const agent = AgentHub.get(sessionId);
  if (!agent) {
    throw new Error('Agent not registered in AgentHub');
  }

  if (agent.profile?.mode !== 'paper') {
    throw new Error(`Agent mode mismatch: expected paper, got ${agent.profile?.mode}`);
  }

  console.log(`🤖 Agent state after activation: ${agent.state}`);
  await AgentHub.onTick(sessionId).catch((error) => {
    throw new Error(`Agent tick processing failed: ${error.message}`);
  });

  const tech = await buildTechSnapshot(agent.profile.symbol);
  if (!Number.isFinite(tech.last)) {
    throw new Error('Technical snapshot did not return a valid last price');
  }
  console.log(`📈 Technical snapshot acquired for ${tech.symbol} @ $${tech.last.toFixed(2)}`);

  const analytics = await computeMonitorAnalytics(sessionId);
  if (!analytics || !analytics.panels || !analytics.health) {
    throw new Error('Monitoring analytics missing expected structure');
  }

  if (analytics.agentState !== agent.state) {
    throw new Error(`Monitoring coherence mismatch: analytics=${analytics.agentState} agent=${agent.state}`);
  }

  if (!Array.isArray(analytics.panels) || analytics.panels.length === 0) {
    throw new Error('Monitoring analytics returned no panels');
  }

  if (analytics.health.level === 'alert') {
    throw new Error('Monitoring health reported alert for fresh paper agent');
  }

  const listed = AgentHub.snapshot().map((a) => a.sessionId);
  if (!listed.includes(sessionId)) {
    throw new Error('AgentHub snapshot does not list the newly created agent');
  }

  console.log('🧪 Agent monitoring health:', analytics.health.level);
  console.log('✅ Paper agent lifecycle integration test passed.');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ Paper agent lifecycle test failed:', error);
  process.exit(1);
}
