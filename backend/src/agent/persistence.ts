import { prisma } from '../db/client.js';
import { broadcast } from '../ws/hub.js';

export async function recordEnter(params: {
  sessionId: string;
  symbol: string;
  side: 'buy'|'sell';
  qty: number;
  entryPrice: number;
  stop?: number;
  tp?: number[];
  leverage?: number;
  requestedPrice?: number;
  requestedQty?: number;
  latencyMs?: number;
  slippageBps?: number;
  fillRatio?: number;
  cancelCount?: number;
  attempts?: number;
  slOrderId?: string;
  tpOrderId?: string;
}) {
  const clientOrderId = `${params.sessionId}.${params.symbol}.${Date.now()}`;
  const round4 = (n:number|undefined)=> (typeof n==='number' ? Math.round(n*1e4)/1e4 : undefined);
  const pctChange = 0; // at entry, 0% change baseline
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: params.sessionId,
      symbol: params.symbol,
      side: params.side,
      type: 'market',
      qty: params.qty,
      requestedQty: params.requestedQty ?? params.qty,
      price: round4(params.entryPrice)!,
      requestedPrice: round4(params.requestedPrice),
      sl: round4(params.stop),
      tp: round4(params.tp?.[0]),
      leverage: params.leverage,
      pctChange,
      latencyMs: params.latencyMs != null ? Math.round(params.latencyMs) : undefined,
      slippageBps: params.slippageBps,
      fillRatio: params.fillRatio,
      cancelCount: params.cancelCount,
      attempts: params.attempts,
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
      sessionId: params.sessionId,
    }
  });
  await prisma.position.create({
    data: {
      sessionId: params.sessionId,
      symbol: params.symbol,
      side: params.side,
      entryPrice: params.entryPrice,
      qty: params.qty,
      leverage: params.leverage,
      openedAt: new Date(),
      stopPrice: params.stop,
      takeProfit: params.tp ? params.tp as any : undefined,
      slOrderId: params.slOrderId,
      tpOrderId: params.tpOrderId,
      lastProtectiveSyncAt: (params.stop || (params.tp && params.tp.length)) ? new Date() : undefined,
      protectiveStatus: (params.stop || (params.tp && params.tp.length)) ? 'synced' : undefined,
    }
  });
  // Broadcast latest orders for this session only
  const rows = await prisma.order.findMany({ where: { sessionId: params.sessionId }, orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol, params.sessionId);
}

export async function updateProtectiveSnapshot(params: {
  sessionId: string;
  symbol: string;
  stopPrice?: number | null;
  takeProfit?: number[] | null;
  slOrderId?: string | null;
  tpOrderId?: string | null;
  status?: string;
}) {
  try {
    const pos = await prisma.position.findFirst({ where: { sessionId: params.sessionId, symbol: params.symbol, qty: { gt: 0 } }, orderBy: { openedAt: 'desc' } });
    if (!pos) return;
    await prisma.position.update({
      where: { id: pos.id },
      data: {
        stopPrice: params.stopPrice !== undefined ? params.stopPrice : pos.stopPrice,
        takeProfit: params.takeProfit ? params.takeProfit as any : (params.takeProfit === null ? undefined : pos.takeProfit),
        slOrderId: params.slOrderId !== undefined ? params.slOrderId || null : pos.slOrderId,
        tpOrderId: params.tpOrderId !== undefined ? params.tpOrderId || null : pos.tpOrderId,
        lastProtectiveSyncAt: new Date(),
        protectiveStatus: params.status || 'synced',
      }
    });
  } catch {}
}

export async function loadActivePosition(sessionId: string) {
  return prisma.position.findFirst({
    where: { sessionId, qty: { gt: 0 } },
    orderBy: { openedAt: 'desc' },
  });
}

export async function recordExit(params: {
  sessionId: string;
  symbol: string;
  side: 'buy'|'sell';
  exitPrice: number;
  qty: number;
  realizedPnl?: number;
  requestedPrice?: number;
  requestedQty?: number;
  latencyMs?: number;
  slippageBps?: number;
  fillRatio?: number;
  cancelCount?: number;
  attempts?: number;
}) {
  const round4 = (n:number)=> Math.round(n*1e4)/1e4;
  // Fetch last position to carry leverage info to the exit order
  const lastPos = await prisma.position.findFirst({ where: { sessionId: params.sessionId, symbol: params.symbol }, orderBy: { openedAt: 'desc' } });
  const base = lastPos?.entryPrice || params.exitPrice;
  const dir = (params.side === 'buy') ? 1 : -1; // side is the side closing? in recordExit we flip for order, but original side indicates held position
  const pctChange = base ? (dir * (params.exitPrice - (lastPos?.entryPrice || params.exitPrice)) / (lastPos?.entryPrice || params.exitPrice)) * 100 : 0;
  // Create a closing fill for journaling
  const clientOrderId = `${params.sessionId}.${params.symbol}.${Date.now()}.exit`;
  const order = await prisma.order.create({
    data: {
      clientOrderId,
      sessionId: params.sessionId,
      symbol: params.symbol,
      side: params.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      qty: params.qty,
      requestedQty: params.requestedQty ?? params.qty,
      price: round4(params.exitPrice),
      requestedPrice: typeof params.requestedPrice === 'number' ? round4(params.requestedPrice) : undefined,
      leverage: lastPos?.leverage,
      pctChange,
      latencyMs: params.latencyMs != null ? Math.round(params.latencyMs) : undefined,
      slippageBps: params.slippageBps,
      fillRatio: params.fillRatio,
      cancelCount: params.cancelCount,
      attempts: params.attempts,
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
      sessionId: params.sessionId,
    }
  });
  // Adjust remaining position qty (supports partial exits)
  if (lastPos) {
    const newQty = Math.max(0, (Number(lastPos.qty || 0) - Number(params.qty || 0)));
    await prisma.position.update({
      where: { id: lastPos.id },
      data: {
        qty: newQty,
        updatedAt: new Date(),
      }
    });
  }

  const rows = await prisma.order.findMany({ where: { sessionId: params.sessionId }, orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol, params.sessionId);
}
