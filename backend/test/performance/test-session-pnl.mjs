import 'dotenv/config';
import assert from 'node:assert/strict';
import express from 'express';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

console.log('🧪 Running session PnL aggregation regression test...');

const sessionId = 'sess_session_perf';
let server;
let prisma;

try {
  ({ prisma } = await import('../../dist/src/db/client.js'));
  if (typeof prisma.$reset === 'function') {
    await prisma.$reset();
  }

  await prisma.agentSession.create({
    data: {
      id: sessionId,
      symbol: 'BTC/USDT',
      mode: 'paper',
      startBalanceUsd: 5000,
    },
  });

  const exitOne = await prisma.order.create({
    data: {
      id: 'ord_exit_one',
      clientOrderId: `${sessionId}.exit.1`,
      sessionId,
      symbol: 'BTC/USDT',
      side: 'sell',
      type: 'market',
      status: 'filled',
      qty: 0.1,
      price: 30250,
    },
  });

  const exitTwo = await prisma.order.create({
    data: {
      id: 'ord_exit_two',
      clientOrderId: `${sessionId}.exit.2`,
      sessionId,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      status: 'filled',
      qty: 0.1,
      price: 29800,
    },
  });

  await prisma.order.create({
    data: {
      id: 'ord_entry_hidden',
      clientOrderId: `${sessionId}.entry.1`,
      sessionId,
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'market',
      status: 'filled',
      qty: 0.1,
      price: 30000,
    },
  });

  await prisma.fill.create({
    data: {
      orderId: exitOne.id,
      price: 30250,
      qty: 0.1,
      fee: 1.2,
      realizedPnl: 45,
      side: 'sell',
      sessionId: null,
    },
  });

  await prisma.fill.create({
    data: {
      orderId: exitTwo.id,
      price: 29800,
      qty: 0.1,
      fee: 0.8,
      realizedPnl: -30,
      side: 'buy',
      sessionId: null,
    },
  });

  const { router: perfRouter } = await import('../../dist/src/routes/perf.js');
  const app = express();
  app.use(express.json());
  app.use('/api/perf', perfRouter);
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'string' ? parseInt(address.split(':').pop() || '0', 10) : address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const response = await fetch(`${baseUrl}/api/perf/session-metrics?sessionId=${sessionId}`);
  assert.equal(response.status, 200, 'session metrics endpoint should respond 200');
  const payload = await response.json();
  assert.ok(Array.isArray(payload), 'session metrics response should be an array');
  const metrics = payload.find((row) => row.sessionId === sessionId);
  assert.ok(metrics, 'session metrics should contain the seeded session');

  assert.ok(Math.abs(Number(metrics.realizedPnlUsd) - 15) < 1e-8, 'realized PnL should sum fills');
  assert.ok(Math.abs(Number(metrics.feesUsd) - 2) < 1e-8, 'fees should aggregate from fills');
  assert.ok(Math.abs(Number(metrics.netPnlUsd) - 13) < 1e-8, 'net PnL should be realized minus fees');
  assert.equal(Number(metrics.tradeCount), 2, 'trade count should include both exit orders');
  assert.ok(Math.abs(Number(metrics.roiPct) - 0.26) < 1e-6, 'ROI should be computed from net PnL over starting balance');

  if (server && typeof server.close === 'function') {
    server.close();
  }
  if (prisma && typeof prisma.$disconnect === 'function') {
    await prisma.$disconnect();
  }
  console.log('✅ session PnL aggregation regression test passed');
} catch (error) {
  if (typeof server !== 'undefined' && server && typeof server.close === 'function') {
    try { server.close(); } catch {}
  }
  if (prisma && typeof prisma.$disconnect === 'function') {
    try { await prisma.$disconnect(); } catch {}
  }
  console.error('❌ session PnL aggregation regression test failed:', error);
  process.exit(1);
}
