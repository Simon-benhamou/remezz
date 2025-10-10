import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

console.log('🧪 Running performance monitor inactivity test...');

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  const { clearAlertsMemory, recentAlerts } = await import('../../dist/src/monitor/policy.js');
  const { clearOpsEvents, recentOpsEvents } = await import('../../dist/src/monitor/ops.js');
  const { AgentPerformanceMonitor } = await import('../../dist/scripts/agent-performance-monitor.js');

  clearAlertsMemory();
  clearOpsEvents();

  const now = Date.now();
  const oldDate = new Date(now - 26 * 60 * 60 * 1000);
  await prisma.agentSession.create({
    data: {
      id: 'sess_inactive',
      symbol: 'ETH/USDT',
      mode: 'live',
      startedAt: oldDate,
    },
  });

  const activeOrderId = randomUUID();
  await prisma.agentSession.create({
    data: {
      id: 'sess_active',
      symbol: 'BTC/USDT',
      mode: 'live',
      startedAt: new Date(now - 2 * 60 * 60 * 1000),
    },
  });
  await prisma.order.create({
    data: {
      id: activeOrderId,
      clientOrderId: `client_${activeOrderId}`,
      sessionId: 'sess_active',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      qty: 1,
    },
  });
  await prisma.fill.create({
    data: {
      orderId: activeOrderId,
      sessionId: 'sess_active',
      price: 1000,
      qty: 1,
      side: 'buy',
      ts: new Date(now - 60 * 60 * 1000),
    },
  });

  const monitor = new AgentPerformanceMonitor({
    intervalMinutes: 60,
    enableAlerts: false,
    watchInactivity: true,
  });

  monitor.analyzer.analyzeAllAgents = async () => ({
    globalMetrics: { globalWinRate: 0, globalProfitFactor: 0, activeAgents: 0 },
    alerts: { critical: [], warnings: [], opportunities: [] },
    agentDetails: [],
  });

  await monitor.runAnalysis();
  monitor.stop();

  const alerts = recentAlerts('sess_inactive');
  const inactivityAlert = alerts.find((a) => a.kind === 'inactivity');
  assert.ok(inactivityAlert, 'Expected inactivity alert to be emitted');
  assert.equal(inactivityAlert.sessionId, 'sess_inactive');
  assert.equal(inactivityAlert.severity, 'med');
  assert.ok(inactivityAlert.details?.hoursInactive >= 24, 'Inactivity duration should be at least 24h');

  const opsEvents = recentOpsEvents(10);
  const inactivityEvent = opsEvents.find((evt) => evt.sessionId === 'sess_inactive' && evt.message === 'agent_inactivity');
  assert.ok(inactivityEvent, 'Expected inactivity ops event to be recorded');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }

  console.log('✅ performance monitor inactivity test passed');
} catch (error) {
  console.error('❌ performance monitor inactivity test failed:', error);
  process.exit(1);
}
