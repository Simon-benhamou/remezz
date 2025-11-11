/**
 * Test suite for order visibility across multiple active sessions
 * Related to issue: Order exists in database but not visible in monitoring API
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

const { prisma } = await import('../../dist/src/db/client.js');

describe('Order Visibility API', () => {
  const testSessionIds: string[] = [];
  const testOrderIds: string[] = [];

  after(async () => {
    // Cleanup test data
    if (testOrderIds.length > 0) {
      await prisma.order.deleteMany({ where: { id: { in: testOrderIds } } });
    }
    if (testSessionIds.length > 0) {
      await prisma.agentSession.deleteMany({ where: { id: { in: testSessionIds } } });
    }
  });

  it('should return orders from all active sessions when no sessionId specified', async () => {
    // Create two active sessions
    const session1 = await prisma.agentSession.create({
      data: {
        symbol: 'BTC/USDT',
        mode: 'paper',
        startBalanceUsd: 1000,
        stoppedAt: null, // Active
        profileJson: { budgetPct: 100 },
      },
    });
    testSessionIds.push(session1.id);

    const session2 = await prisma.agentSession.create({
      data: {
        symbol: 'ETH/USDT',
        mode: 'paper',
        startBalanceUsd: 1000,
        stoppedAt: null, // Active
        profileJson: { budgetPct: 100 },
      },
    });
    testSessionIds.push(session2.id);

    // Create orders in both sessions
    const order1 = await prisma.order.create({
      data: {
        clientOrderId: `test-order-1-${Date.now()}`,
        sessionId: session1.id,
        symbol: 'BTC/USDT',
        side: 'buy',
        type: 'market',
        qty: 0.01,
        leverage: 1,
      },
    });
    testOrderIds.push(order1.id);

    const order2 = await prisma.order.create({
      data: {
        clientOrderId: `test-order-2-${Date.now()}`,
        sessionId: session2.id,
        symbol: 'ETH/USDT',
        side: 'buy',
        type: 'market',
        qty: 0.1,
        leverage: 1,
      },
    });
    testOrderIds.push(order2.id);

    // Query orders without specifying sessionId
    const orders = await prisma.order.findMany({
      where: {
        sessionId: {
          in: [session1.id, session2.id],
        },
      },
      include: { session: true },
    });

    // Should return orders from both sessions
    assert(orders.length >= 2, `Expected at least 2 orders, got ${orders.length}`);
    
    const foundOrder1 = orders.find(o => o.id === order1.id);
    const foundOrder2 = orders.find(o => o.id === order2.id);
    
    assert(foundOrder1, 'Order from session 1 should be found');
    assert(foundOrder2, 'Order from session 2 should be found');
    assert(foundOrder1.session, 'Order should include session data');
    assert(foundOrder2.session, 'Order should include session data');
  });

  it('should only return orders from specified session when sessionId provided', async () => {
    const session = await prisma.agentSession.create({
      data: {
        symbol: 'XRP/USDT',
        mode: 'paper',
        startBalanceUsd: 1000,
        stoppedAt: null,
        profileJson: { budgetPct: 100 },
      },
    });
    testSessionIds.push(session.id);

    const order = await prisma.order.create({
      data: {
        clientOrderId: `test-order-specific-${Date.now()}`,
        sessionId: session.id,
        symbol: 'XRP/USDT',
        side: 'buy',
        type: 'market',
        qty: 10,
        leverage: 1,
      },
    });
    testOrderIds.push(order.id);

    // Query with specific sessionId
    const orders = await prisma.order.findMany({
      where: { sessionId: session.id },
      include: { session: true },
    });

    assert(orders.length >= 1, 'Should find at least one order');
    const foundOrder = orders.find(o => o.id === order.id);
    assert(foundOrder, 'Specific order should be found');
  });

  it('should not return orders from stopped sessions in all-active query', async () => {
    // Create a stopped session
    const stoppedSession = await prisma.agentSession.create({
      data: {
        symbol: 'SOL/USDT',
        mode: 'paper',
        startBalanceUsd: 1000,
        stoppedAt: new Date(), // Stopped
        profileJson: { budgetPct: 100 },
      },
    });
    testSessionIds.push(stoppedSession.id);

    const orderInStoppedSession = await prisma.order.create({
      data: {
        clientOrderId: `test-order-stopped-${Date.now()}`,
        sessionId: stoppedSession.id,
        symbol: 'SOL/USDT',
        side: 'buy',
        type: 'market',
        qty: 1,
        leverage: 1,
      },
    });
    testOrderIds.push(orderInStoppedSession.id);

    // Query only active sessions
    const activeSessions = await prisma.agentSession.findMany({
      where: { stoppedAt: null },
      select: { id: true },
    });

    const orders = await prisma.order.findMany({
      where: {
        sessionId: { in: activeSessions.map(s => s.id) },
      },
    });

    // Should not include order from stopped session
    const foundStoppedOrder = orders.find(o => o.id === orderInStoppedSession.id);
    assert(!foundStoppedOrder, 'Orders from stopped sessions should not be included');
  });
});
