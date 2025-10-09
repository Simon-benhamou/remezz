import 'dotenv/config';
import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARGIN_UTIL_WARN_PCT = '50';
process.env.MARGIN_UTIL_CRITICAL_PCT = '80';
process.env.MARGIN_LIQUIDATION_MIN_DIST_PCT = '10';
process.env.MARGIN_CONCENTRATION_WARN_PCT = '40';

console.log('🧪 Running margin monitor integration test...');

try {
  const { prisma } = await import('../../dist/src/db/client.js');
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  await prisma.agentSession.create({
    data: {
      id: 'sess_margin',
      symbol: 'BTC/USDT',
      mode: 'live',
    },
  });

  const { AgentHub } = await import('../../dist/src/agent/hub.js');
  const { runMarginSweepOnce } = await import('../../dist/src/services/marginMonitor.js');
  const { recentOpsEvents } = await import('../../dist/src/monitor/ops.js');

  const snapshots = [
    {
      freeUsd: 6000,
      equityUsd: 10000,
      committedUsd: 4200,
      maintenanceMarginUsd: 420,
      marginRatio: 0.42,
      positions: [
        { symbol: 'BTC/USDT', side: 'long', qty: 0.4, markPrice: 30000, liquidationPrice: 25000 },
      ],
      correlatedExposure: undefined,
      timestamp: Date.now(),
    },
    {
      freeUsd: 800,
      equityUsd: 10000,
      committedUsd: 9600,
      maintenanceMarginUsd: 1400,
      positions: [
        { symbol: 'BTC/USDT', side: 'long', qty: 0.4, markPrice: 30000, liquidationPrice: 29700 },
      ],
      correlatedExposure: {
        BTC: { key: 'BTC', totalNotionalUsd: 12000, longNotionalUsd: 12000, shortNotionalUsd: 0, positions: ['BTC/USDT'] },
      },
      timestamp: Date.now(),
    },
  ];
  let idx = 0;
  const fakeBroker = {
    mode: 'live',
    async balance() {
      const snapshot = snapshots[Math.min(idx, snapshots.length - 1)];
      idx += 1;
      return snapshot;
    },
  };

  const agentStore = AgentHub.agents || AgentHub['agents'];
  if (!agentStore) {
    throw new Error('AgentHub internal store unavailable');
  }
  agentStore.set('sess_margin', {
    state: 'MANAGE',
    profile: { symbol: 'BTC/USDT', mode: 'live' },
    broker: fakeBroker,
  });

  const safePass = await runMarginSweepOnce({
    thresholds: {
      utilisationWarnPct: 55,
      utilisationCriticalPct: 80,
      minLiquidationDistancePct: 9,
      concentrationWarnPct: 45,
    },
  });
  assert.ok(Array.isArray(safePass));
  assert.equal(safePass[0].assessment.status, 'ok');

  const stressed = await runMarginSweepOnce({
    thresholds: {
      utilisationWarnPct: 55,
      utilisationCriticalPct: 80,
      minLiquidationDistancePct: 9,
      concentrationWarnPct: 45,
    },
  });
  assert.equal(stressed[0].assessment.status, 'critical');

  const marginRows = await prisma.marginSnapshot.findMany({ orderBy: { createdAt: 'asc' } });
  assert.equal(marginRows.length, 2);
  assert.equal(marginRows[1].status, 'critical');
  assert.ok(marginRows[1].recommendedActions?.length);

  const events = recentOpsEvents(5);
  assert.ok(events.some((evt) => evt.source === 'margin_monitor'));

  if (agentStore?.clear) {
    agentStore.clear();
  }
  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
  console.log('✅ margin monitor integration test passed');
} catch (error) {
  console.error('❌ margin monitor integration test failed:', error);
  process.exit(1);
}
