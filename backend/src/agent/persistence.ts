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
  const round4 = (n:number|undefined)=> (typeof n==='number' ? Math.round(n*1e4)/1e4 : undefined);
  const pctChange = 0; // at entry, 0% change baseline
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: session.id,
      symbol: params.symbol,
      side: params.side,
      type: 'market',
      qty: params.qty,
      price: round4(params.entryPrice)!,
      sl: round4(params.stop),
      tp: round4(params.tp?.[0]),
      leverage: params.leverage,
      pctChange,
      status: 'filled',
      source: 'agent',
    }
  });
  await prisma.fill.create({
    data: {
      orderId: order.id,
      price: round4(params.entryPrice)!,
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
  // Broadcast latest orders for this session only
  const rows = await prisma.order.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, take: 200 });
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
  const round4 = (n:number)=> Math.round(n*1e4)/1e4;
  // Fetch last position to carry leverage info to the exit order
  const lastPos = await prisma.position.findFirst({ where: { sessionId: session.id, symbol: params.symbol }, orderBy: { openedAt: 'desc' } });
  const base = lastPos?.entryPrice || params.exitPrice;
  const dir = (params.side === 'buy') ? 1 : -1; // side is the side closing? in recordExit we flip for order, but original side indicates held position
  const pctChange = base ? (dir * (params.exitPrice - (lastPos?.entryPrice || params.exitPrice)) / (lastPos?.entryPrice || params.exitPrice)) * 100 : 0;
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
      price: round4(params.exitPrice),
      leverage: lastPos?.leverage,
      pctChange,
      status: 'filled',
      source: 'agent',
    }
  });
  await prisma.fill.create({
    data: {
      orderId: order.id,
      price: round4(params.exitPrice),
      qty: params.qty,
      side: order.side,
      realizedPnl: params.realizedPnl,
      sessionId: session.id,
    }
  });
  // Mark position as closed (qty to 0)
  if (lastPos) await prisma.position.update({ where: { id: lastPos.id }, data: { qty: 0, updatedAt: new Date() } });

  const rows = await prisma.order.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol);
}
