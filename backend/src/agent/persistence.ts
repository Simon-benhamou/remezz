import { prisma } from '../db/client.js';
import { broadcast } from '../ws/hub.js';

export async function getActiveSession() {
  return prisma.agentSession.findFirst({ where: { stoppedAt: null }, orderBy: { startedAt: 'desc' } });
}

export async function recordEnter(params: {
  symbol: string;
  side: 'buy'|'sell';
  qty: number;
  entryPrice: number;
  stop?: number;
  tp?: number[];
  leverage?: number;
}) {
  const session = await getActiveSession();
  if (!session) return;
  const clientOrderId = `${session.id}.${params.symbol}.${Date.now()}`;
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: session.id,
      symbol: params.symbol,
      side: params.side,
      type: 'market',
      qty: params.qty,
      price: params.entryPrice,
      sl: params.stop,
      tp: params.tp?.[0],
      leverage: params.leverage,
      status: 'filled',
      source: 'agent',
    }
  });
  await prisma.fill.create({
    data: {
      orderId: order.id,
      price: params.entryPrice,
      qty: params.qty,
      side: params.side,
      fee: 0,
      sessionId: session.id,
    }
  });
  await prisma.position.create({
    data: {
      sessionId: session.id,
      symbol: params.symbol,
      side: params.side,
      entryPrice: params.entryPrice,
      qty: params.qty,
      leverage: params.leverage,
      openedAt: new Date(),
    }
  });
  // Broadcast latest orders snapshot
  const rows = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol);
}

export async function recordExit(params: {
  symbol: string;
  side: 'buy'|'sell';
  exitPrice: number;
  qty: number;
  realizedPnl?: number;
}) {
  const session = await getActiveSession();
  if (!session) return;
  // Fetch last position to carry leverage info to the exit order
  const lastPos = await prisma.position.findFirst({ where: { sessionId: session.id, symbol: params.symbol }, orderBy: { openedAt: 'desc' } });
  // Create a closing fill for journaling
  const clientOrderId = `${session.id}.${params.symbol}.${Date.now()}.exit`;
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: session.id,
      symbol: params.symbol,
      side: params.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      qty: params.qty,
      price: params.exitPrice,
      leverage: lastPos?.leverage,
      status: 'filled',
      source: 'agent',
    }
  });
  await prisma.fill.create({
    data: {
      orderId: order.id,
      price: params.exitPrice,
      qty: params.qty,
      side: order.side,
      realizedPnl: params.realizedPnl,
      sessionId: session.id,
    }
  });
  // Mark position as closed (qty to 0)
  if (lastPos) await prisma.position.update({ where: { id: lastPos.id }, data: { qty: 0, updatedAt: new Date() } });

  const rows = await prisma.order.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol);
}
