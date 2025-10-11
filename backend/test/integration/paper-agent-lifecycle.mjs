import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

console.log('🧪 Vérification du cycle de vie d\'un agent paper...');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  const { startAgentCreation } = await import('../../dist/src/services/agentCreationFlow.js');
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

  const result = await startAgentCreation(startPayload, null);
  assert.ok(result, 'Le flux de création doit retourner un résultat.');
  assert.equal(result.state, 'ready', 'Le flux doit aboutir à un agent prêt.');

  const sessionId = result.sessionId;
  assert.ok(sessionId, 'La création doit fournir un identifiant de session.');

  await wait(200);
  const agent = AgentHub.get(sessionId);
  assert.ok(agent, 'L\'agent doit être enregistré dans l\'AgentHub.');
  assert.equal(agent.profile?.mode, 'paper', 'Le profil doit rester en mode paper.');

  await assert.doesNotReject(
    () => AgentHub.onTick(sessionId),
    'L\'agent doit pouvoir traiter un tick immédiatement après la création.'
  );

  const tech = await buildTechSnapshot(agent.profile.symbol);
  assert.ok(Number.isFinite(tech.last), 'Le snapshot technique doit contenir un dernier prix valide.');

  const analytics = await computeMonitorAnalytics(sessionId);
  assert.ok(analytics?.panels?.length, 'Les analytics doivent inclure au moins un panneau.');
  assert.ok(analytics.health, 'Les analytics doivent exposer un état de santé.');
  assert.equal(
    analytics.agentState,
    agent.state,
    'L\'état rapporté par la surveillance doit correspondre à l\'agent.'
  );
  assert.notEqual(
    analytics.health.level,
    'alert',
    'Un agent fraîchement créé ne doit pas être en alerte.'
  );

  const listed = AgentHub.snapshot().map((a) => a.sessionId);
  assert.ok(listed.includes(sessionId), 'Le snapshot de l\'hub doit référencer la session créée.');

  console.log('✅ Cycle de vie paper validé (création, tick, monitoring).');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ Paper agent lifecycle test failed:', error);
  process.exit(1);
}
