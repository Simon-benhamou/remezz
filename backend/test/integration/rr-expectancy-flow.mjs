import 'dotenv/config';
import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

console.log('🧪 Running RR expectancy integration test...');

const {
  prisma,
} = await import('../../dist/src/db/client.js');
const {
  resolveRrExpectancyConfig,
  rrMinFromWinrate,
  blendRR,
  applyHysteresis,
} = await import('../../dist/src/risk/rrExpectancy.js');
const { getAgentRecentWinRate } = await import('../../dist/src/services/performance/winrate.js');
const { EntryFilters } = await import('../../dist/src/quantai/strategies/metaAdaptive/entryFilters.js');

async function seedSession(sessionId, symbol, wins, losses) {
  await prisma.agentSession.create({
    data: {
      id: sessionId,
      symbol,
      mode: 'paper',
      rrFloor: 1.0,
      rrCeil: 2.0,
      rrBaseMin: 1.3,
      rrExpectancy: {
        enabled: true,
        minTrades: 50,
        lookbackDays: 30,
        decay: 1.0,
        safetyMult: 1.0,
        blend: 0.5,
        hysteresis: 0.05,
      },
      profileJson: { riskPerTradePct: 1.0 },
    },
  });
  const total = wins + losses;
  for (let i = 0; i < total; i += 1) {
    const order = await prisma.order.create({
      data: {
        sessionId,
        clientOrderId: `${sessionId}-order-${i}`,
        symbol,
        side: 'sell',
        type: 'market',
        qty: 1,
        status: 'filled',
        createdAt: new Date(Date.now() - (total - i) * 60000),
        updatedAt: new Date(Date.now() - (total - i) * 60000),
      },
    });
    const pnl = i < wins ? 50 : -40;
    await prisma.fill.create({
      data: {
        orderId: order.id,
        sessionId,
        price: 1,
        qty: 1,
        side: 'sell',
        realizedPnl: pnl,
        ts: new Date(Date.now() - (total - i) * 60000),
      },
    });
  }
}

async function scenario({ sessionId, wins, losses, rrTest, expectPass }) {
  const cfg = resolveRrExpectancyConfig({
    rrFloor: 1.0,
    rrCeil: 2.0,
    rrBaseMin: 1.3,
    rrExpectancy: { decay: 1.0 },
  });
  const winrate = await getAgentRecentWinRate(sessionId, {
    maxTrades: 200,
    minTrades: 50,
    decay: cfg.decay,
    lookbackDays: cfg.lookbackDays,
  });
  assert(winrate.trades === wins + losses, 'Trade count mismatch');
  assert(winrate.p != null, 'Expected probability to be defined');

  const rrDyn = rrMinFromWinrate(winrate.p, cfg);
  const theoretical = Math.round(((1 - winrate.p) / winrate.p) * 100) / 100;
  const theoreticalClamped = Math.max(cfg.rrFloor, Math.min(cfg.rrCeil, theoretical));
  const theoreticalRounded = Math.round(theoreticalClamped * 100) / 100;
  assert.equal(
    rrDyn,
    theoreticalRounded,
    `Dynamic RR should follow expectancy formula ((1-p)/p) within bounds: got ${rrDyn}, expected ${theoreticalRounded}`,
  );

  const blended = blendRR(cfg.rrBaseMin, rrDyn, cfg.blend);
  const clamped = Math.max(cfg.rrFloor, Math.min(cfg.rrCeil, blended));
  const effective = applyHysteresis(undefined, clamped, cfg.hysteresis);
  assert.equal(
    effective,
    clamped,
    `Hysteresis should not change the first computed threshold (expected ${clamped}, got ${effective})`,
  );

  const filters = new EntryFilters({
    minAdx: 18,
    minDollarVolume: 1,
    minRr: cfg.rrBaseMin,
    minAtrPct: 0,
    maxSpreadBps: 100,
    confidenceThreshold: 0,
    useConfidenceFilter: false,
  });
  const entryFacts = {
    adx: 25,
    dollarVolume: 5,
    atr: 1,
    price: 100,
    spreadBps: 10,
    rrToTp1: rrTest,
  };
  const result = filters.evaluateEntry(entryFacts, { minRr: effective, rrSummary: '' });
  if (expectPass) {
    assert(result.ok, `Expected RR ${rrTest} to pass with effective ${effective}`);
  } else {
    assert(!result.ok, `Expected RR ${rrTest} to fail with effective ${effective}`);
  }
  return { winrate, effective, rrDyn, blended };
}

try {
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  } else {
    await prisma.fill.deleteMany();
    await prisma.order.deleteMany();
    await prisma.agentSession.deleteMany();
  }

  await seedSession('sess-dyn-1', 'BTC/USDT', 72, 48);
  const highWin = await scenario({ sessionId: 'sess-dyn-1', wins: 72, losses: 48, rrTest: 1.2, expectPass: true });
  assert.equal(highWin.effective, 1.15, 'Effective RR should blend toward dynamic threshold at high win rate');
  assert.equal(highWin.rrDyn, 1.0, 'Dynamic RR should clamp to floor when expectancy < floor');

  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  } else {
    await prisma.fill.deleteMany();
    await prisma.order.deleteMany();
    await prisma.agentSession.deleteMany();
  }

  await seedSession('sess-dyn-2', 'ETH/USDT', 54, 66);
  const lowWin = await scenario({ sessionId: 'sess-dyn-2', wins: 54, losses: 66, rrTest: 1.1, expectPass: false });
  assert.equal(lowWin.rrDyn, 1.22, 'Dynamic RR should match expectancy formula at 45% win rate');
  assert.equal(lowWin.effective, 1.26, 'Effective RR should tighten above 1.1 when win rate is 45%');

  console.log('✅ RR expectancy integration test passed');

  if (typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
} catch (error) {
  console.error('❌ RR expectancy integration test failed:', error);
  process.exit(1);
}
