import { prisma } from '../db/client.js';
import { broadcast } from '../ws/hub.js';
import { recomputeKpi } from '../metrics/kpi.js';
import { finalizeDecisionOutcome } from '../learning/decisionMemory.js';
import type { CircuitBreakerState } from '../quantai/index.js';

const POSITION_QTY_EPSILON = 1e-6;

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
  
  // Recompute KPIs after position entry
  try {
    await recomputeKpi(params.sessionId);
  } catch (error) {
    console.error('Failed to recompute KPI after entry:', error);
  }
}

export async function loadActivePosition(sessionId: string) {
  return prisma.position.findFirst({
    where: { sessionId, qty: { gt: 0 } },
    orderBy: { openedAt: 'desc' },
  });
}

function serializeCircuitBreakerState(state: CircuitBreakerState) {
  return {
    consecutiveLosses: state.consecutiveLosses,
    consecutiveWins: state.consecutiveWins,
    tradesToday: state.tradesToday,
    equityStartDay: state.equityStartDay,
    cooldownUntil: state.cooldownUntil ? state.cooldownUntil.toISOString() : null,
    lastTradeDay: state.lastTradeDay,
    dayStartAt: state.dayStartAt ? state.dayStartAt.toISOString() : null,
    dailyLossActive: state.dailyLossActive,
    dailyLossTriggeredAt: state.dailyLossTriggeredAt ? state.dailyLossTriggeredAt.toISOString() : null,
    dailyLossRecoveryWinsRemaining: state.dailyLossRecoveryWinsRemaining,
  };
}

function deserializeCircuitBreakerState(raw: any): CircuitBreakerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const toNumber = (value: any, fallback = 0) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  const toDate = (value: any) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  return {
    consecutiveLosses: Math.max(0, Math.floor(toNumber((raw as any).consecutiveLosses, 0))),
    consecutiveWins: Math.max(0, Math.floor(toNumber((raw as any).consecutiveWins, 0))),
    tradesToday: Math.max(0, Math.floor(toNumber((raw as any).tradesToday, 0))),
    equityStartDay: (raw as any).equityStartDay != null && Number.isFinite(Number((raw as any).equityStartDay))
      ? Number((raw as any).equityStartDay)
      : null,
    cooldownUntil: toDate((raw as any).cooldownUntil),
    lastTradeDay: typeof (raw as any).lastTradeDay === 'string'
      ? ((raw as any).lastTradeDay.trim().length > 0 ? (raw as any).lastTradeDay : null)
      : (raw as any).lastTradeDay != null && Number.isFinite(Number((raw as any).lastTradeDay))
        ? String(Math.floor(Number((raw as any).lastTradeDay)))
        : null,
    dayStartAt: toDate((raw as any).dayStartAt),
    dailyLossActive: Boolean((raw as any).dailyLossActive),
    dailyLossTriggeredAt: toDate((raw as any).dailyLossTriggeredAt),
    dailyLossRecoveryWinsRemaining: Math.max(0, Math.floor(toNumber((raw as any).dailyLossRecoveryWinsRemaining, 0))),
  };
}

export async function loadCircuitBreakerState(sessionId: string): Promise<CircuitBreakerState | null> {
  if (!sessionId) return null;
  try {
    const row = await prisma.agentOpsTelemetry.findUnique({
      where: { sessionId },
      select: { circuitState: true },
    });
    if (!row?.circuitState) return null;
    return deserializeCircuitBreakerState(row.circuitState);
  } catch (error) {
    console.warn('Failed to load circuit breaker state:', error);
    return null;
  }
}

export async function persistCircuitBreakerState(sessionId: string, state: CircuitBreakerState): Promise<void> {
  if (!sessionId) return;
  try {
    const payload = serializeCircuitBreakerState(state);
    await prisma.agentOpsTelemetry.upsert({
      where: { sessionId },
      update: { circuitState: payload },
      create: { sessionId, circuitState: payload },
    });
  } catch (error) {
    console.warn('Failed to persist circuit breaker state:', error);
  }
}

type ProtectiveSnapshot = {
  slOrderId: string | null;
  tpOrderId: string | null;
  qty?: number | null;
  side?: 'buy'|'sell'|null;
};

export async function recordExit(params: {
  sessionId: string;
  symbol: string;
  side: 'buy'|'sell';
  exitPrice: number;
  qty: number;
  realizedPnl?: number;
  feeUsd?: number;
  requestedPrice?: number;
  requestedQty?: number;
  latencyMs?: number;
  slippageBps?: number;
  fillRatio?: number;
  cancelCount?: number;
  attempts?: number;
  reason?: string;
  diagnostics?: any;
  protectiveSnapshot?: ProtectiveSnapshot | null;
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
  const feeRounded = typeof params.feeUsd === 'number' && Number.isFinite(params.feeUsd)
    ? Math.max(0, Math.round(params.feeUsd * 1e6) / 1e6)
    : 0;

  await prisma.fill.create({
    data: {
      orderId: order.id,
      price: round4(params.exitPrice),
      qty: params.qty,
      side: order.side,
      realizedPnl: params.realizedPnl,
      fee: feeRounded,
      sessionId: params.sessionId,
    }
  });

  if (params.reason || params.diagnostics || params.protectiveSnapshot) {
    try {
      await prisma.triggerLog.create({
        data: {
          sessionId: params.sessionId,
          symbol: params.symbol,
          kind: 'exit_diagnostic',
          payload: {
            orderId: order.id,
            exitPrice: round4(params.exitPrice),
            realizedPnl: params.realizedPnl ?? null,
            reason: params.reason ?? null,
            protectiveSnapshot: params.protectiveSnapshot ?? null,
            diagnostics: params.diagnostics ?? null,
            capturedAt: new Date().toISOString(),
          },
        }
      });
    } catch (error) {
      console.warn('Failed to persist exit diagnostics snapshot:', error);
    }
  }
  // Adjust remaining position qty (supports partial exits)
  if (lastPos) {
    const existingQty = Number(lastPos.qty || 0);
    const exitQty = Number(params.qty || 0);
    const remaining = existingQty - exitQty;
    const adjustedQty = Math.abs(remaining) <= POSITION_QTY_EPSILON
      ? 0
      : Math.max(0, Math.round(remaining * 1e8) / 1e8);
    await prisma.position.update({
      where: { id: lastPos.id },
      data: {
        qty: adjustedQty,
        updatedAt: new Date(),
      }
    });
  }

  const rows = await prisma.order.findMany({ where: { sessionId: params.sessionId }, orderBy: { createdAt: 'desc' }, take: 200 });
  broadcast('orders', rows, params.symbol, params.sessionId);
  
  // Recompute KPIs after position exit
  try {
    await recomputeKpi(params.sessionId);
  } catch (error) {
    console.error('Failed to recompute KPI after exit:', error);
  }

  try {
    await finalizeDecisionOutcome(params.sessionId, params.realizedPnl ?? 0);
  } catch (error) {
    console.warn('Failed to finalize decision outcome:', error);
  }

  return order;
}
