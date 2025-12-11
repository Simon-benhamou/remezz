import { prisma } from '../../db/client.js';

type NormalizedSide = 'buy' | 'sell';

type TradeAggregationOptions = {
  sessionId?: string;
  from?: Date | null;
  to?: Date | null;
  limit?: number;
  userId?: string;
};

type FillRecord = {
  ts: Date;
  side: NormalizedSide;
  qty: number;
  price: number;
  fee: number;
  realizedPnl: number;
  orderId: string;
  leverage: number | null;
  symbol: string;
  sessionId: string | null;
  // V5.11: New fields for detailed trade analysis
  exitReason: string | null;
  entryTs: Date | null;
  maxPnlPct: number | null;
};

type TradeSummary = {
  id: string;
  createdAt: Date;
  symbol: string;
  sessionId: string | null;
  positionSide: 'long' | 'short';
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  entryNotional: number | null;
  realizedPnlUsd: number;
  feesUsd: number;
  pctChange: number | null;
  roiPct: number | null;
  leverage: number | null;
  roePct: number | null;
  orderCount: number;
  // V5.11: New fields for detailed trade analysis
  exitReason: string | null;
  durationMinutes: number | null;
  maxPnlPct: number | null;
};

const SCALE = 100_000_000n;
const HALF = SCALE / 2n;

function toFixed(value: number | null | undefined): bigint {
  if (value == null || !Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value * Number(SCALE)));
}

function fromFixed(value: bigint): number {
  return Number(value) / Number(SCALE);
}

function mulFixed(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a * b + HALF) / SCALE;
}

function proportion(total: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n || total === 0n || numerator === 0n) return 0n;
  return (total * numerator + denominator / 2n) / denominator;
}

type TradeState = {
  side: 1 | -1;
  symbol: string;
  sessionId: string | null;
  entryQty: bigint;
  exitQty: bigint;
  entryValue: bigint;
  exitValue: bigint;
  realizedPnl: bigint;
  fees: bigint;
  leverageSum: bigint;
  leverageCount: bigint;
  entryTs: Date;
  exitTs: Date;
  orderIds: Set<string>;
  entryOrderIds: Set<string>;
  exitOrderIds: Set<string>;
  // V5.11: New fields
  exitReason: string | null;
  maxPnlPct: number | null;
};

function createTrade(side: 1 | -1, fill: FillRecord): TradeState {
  return {
    side,
    symbol: fill.symbol,
    sessionId: fill.sessionId,
    entryQty: 0n,
    exitQty: 0n,
    entryValue: 0n,
    exitValue: 0n,
    realizedPnl: 0n,
    fees: 0n,
    leverageSum: 0n,
    leverageCount: 0n,
    entryTs: fill.entryTs ?? fill.ts,  // Use entryTs from fill if available
    exitTs: fill.ts,
    orderIds: new Set([fill.orderId]),
    entryOrderIds: new Set(),
    exitOrderIds: new Set(),
    // V5.11: New fields
    exitReason: null,
    maxPnlPct: null,
  };
}

type AggregatedTrade = TradeSummary & { entryOrderIds: string[]; exitOrderIds: string[] };

export function aggregateFillsToLedgerTrades(fills: FillRecord[]): AggregatedTrade[] {
  if (!Array.isArray(fills) || fills.length === 0) return [];
  const sorted = fills.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const trades: AggregatedTrade[] = [];
  let trade: TradeState | null = null;

  for (const fill of sorted) {
    const qtyFixed = toFixed(fill.qty);
    if (qtyFixed === 0n) continue;
    const priceFixed = toFixed(fill.price);
    const feeFixed = toFixed(fill.fee);
    const realizedFixed = toFixed(fill.realizedPnl);
    const leverageFixed = toFixed(fill.leverage ?? 0);
    const sideSign: 1 | -1 = fill.side === 'sell' ? -1 : 1;

    let remainingQty = qtyFixed;
    let remainingFees = feeFixed;
    let remainingRealized = realizedFixed;

    while (remainingQty > 0n) {
      if (!trade) {
        trade = createTrade(sideSign, fill);
      }

      trade.orderIds.add(fill.orderId);

      if (trade.side === sideSign) {
        const portion = remainingQty;
        const feeShare = proportion(remainingFees, portion, remainingQty);
        trade.entryQty += portion;
        trade.entryValue += mulFixed(priceFixed, portion);
        trade.fees += feeShare;
        trade.entryOrderIds.add(fill.orderId);
        if (fill.leverage != null && fill.leverage > 0) {
          trade.leverageSum += leverageFixed;
          trade.leverageCount += 1n;
        }
        remainingFees -= feeShare;
        remainingQty = 0n;
      } else {
        const openQty = trade.entryQty - trade.exitQty;
        const available = openQty > 0n ? openQty : 0n;
        const portion = available > 0n && available < remainingQty ? available : remainingQty;
        if (portion === 0n) {
          // Cannot close further; start a new trade with remaining qty
          trades.push(...finalizeTrade(trade));
          trade = createTrade(sideSign, fill);
          continue;
        }
        const feeShare = proportion(remainingFees, portion, remainingQty);
        const realizedShare = available === 0n || portion === 0n
          ? 0n
          : portion === available
            ? remainingRealized
            : proportion(remainingRealized, portion, remainingQty);
        trade.exitQty += portion;
        trade.exitValue += mulFixed(priceFixed, portion);
        trade.fees += feeShare;
        trade.realizedPnl += realizedShare;
        trade.exitTs = fill.ts;
        trade.exitOrderIds.add(fill.orderId);
        
        // V5.11: Capture exit metadata from the fill
        if (fill.exitReason) {
          trade.exitReason = fill.exitReason;
        }
        if (fill.maxPnlPct != null) {
          trade.maxPnlPct = trade.maxPnlPct != null 
            ? Math.max(trade.maxPnlPct, fill.maxPnlPct) 
            : fill.maxPnlPct;
        }
        if (fill.entryTs) {
          trade.entryTs = fill.entryTs;
        }

        remainingQty -= portion;
        remainingFees -= feeShare;
        remainingRealized -= realizedShare;
        if (remainingRealized < 0n) remainingRealized = 0n;

        if (trade.entryQty === trade.exitQty) {
          trades.push(...finalizeTrade(trade));
          trade = null;
          // Remaining portion (if any) starts a new trade in same loop iteration
          if (remainingQty > 0n) {
            remainingRealized = 0n; // new entry shouldn't inherit realized
            if (!trade) {
              trade = createTrade(sideSign, fill);
            }
          }
        }
      }
    }
  }

  return trades;
}

function finalizeTrade(state: TradeState): AggregatedTrade[] {
  if (!state) return [];
  if (state.entryQty === 0n || state.exitQty === 0n) return [];
  if (state.entryQty !== state.exitQty) return [];

  const entryAvg = (state.entryValue * SCALE + state.entryQty / 2n) / state.entryQty;
  const exitAvg = (state.exitValue * SCALE + state.exitQty / 2n) / state.exitQty;
  const entryNotional = state.entryValue;
  const sideMultiplier = state.side === 1 ? 1n : -1n;
  const priceDiff = state.side === 1 ? exitAvg - entryAvg : entryAvg - exitAvg;
  const priceChange = entryAvg !== 0n ? (priceDiff * SCALE) / entryAvg : 0n;
  const roi = entryNotional !== 0n ? (state.realizedPnl * SCALE) / entryNotional : 0n;
  const leverageAvg = state.leverageCount > 0n
    ? (state.leverageSum + state.leverageCount / 2n) / state.leverageCount
    : 0n;
  const roe = leverageAvg > 0n ? (roi * leverageAvg) / SCALE : roi;

  const id = Array.from(state.exitOrderIds).pop()
    || Array.from(state.entryOrderIds).pop()
    || `${state.sessionId ?? 'session'}-${state.exitTs.getTime()}-${sideMultiplier}`;

  // V5.11: Calculate duration in minutes
  const durationMs = state.exitTs.getTime() - state.entryTs.getTime();
  const durationMinutes = durationMs > 0 ? Math.round(durationMs / 60000) : null;

  return [
    {
      id,
      createdAt: state.exitTs,
      symbol: state.symbol,
      sessionId: state.sessionId,
      positionSide: state.side === 1 ? 'long' : 'short',
      qty: fromFixed(state.entryQty),
      entryPrice: entryAvg === 0n ? null : fromFixed(entryAvg),
      exitPrice: exitAvg === 0n ? null : fromFixed(exitAvg),
      entryNotional: entryNotional === 0n ? null : fromFixed(entryNotional),
      realizedPnlUsd: fromFixed(state.realizedPnl),
      feesUsd: fromFixed(state.fees),
      pctChange: entryAvg === 0n ? null : fromFixed(priceChange) * 100,
      roiPct: entryNotional === 0n ? null : fromFixed(roi) * 100,
      leverage: leverageAvg === 0n ? null : fromFixed(leverageAvg),
      roePct: fromFixed(roe) * 100,
      orderCount: state.orderIds.size,
      entryOrderIds: Array.from(state.entryOrderIds),
      exitOrderIds: Array.from(state.exitOrderIds),
      // V5.11: New fields for detailed trade analysis
      exitReason: state.exitReason,
      durationMinutes,
      maxPnlPct: state.maxPnlPct,
    },
  ];
}

export async function listAggregatedTrades(opts: TradeAggregationOptions): Promise<AggregatedTrade[]> {
  const sessionId = opts.sessionId?.trim() ? opts.sessionId.trim() : undefined;
  const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(500, Math.floor(Number(opts.limit)))) : 200;
  const fromDate = opts.from instanceof Date ? opts.from : opts.from ? new Date(opts.from) : null;
  const toDate = opts.to instanceof Date ? opts.to : opts.to ? new Date(opts.to) : null;
  const userId = opts.userId?.trim() ? opts.userId.trim() : undefined;

  // If userId is provided, first get all user's session IDs
  let allowedSessionIds: string[] | undefined;
  if (userId) {
    const userSessions = await prisma.agentSession.findMany({
      where: { userId },
      select: { id: true },
    });
    allowedSessionIds = userSessions.map(s => s.id);
    if (allowedSessionIds.length === 0) {
      // User has no sessions, return empty array
      return [];
    }
  }

  const where: any = {};
  if (sessionId) {
    where.sessionId = sessionId;
  } else if (allowedSessionIds) {
    where.sessionId = { in: allowedSessionIds };
  }
  if (fromDate || toDate) {
    where.ts = {};
    if (fromDate && !Number.isNaN(fromDate.getTime())) where.ts.gte = fromDate;
    if (toDate && !Number.isNaN(toDate.getTime())) where.ts.lt = toDate;
  }

  const take = Math.min(4000, Math.max(limit * 25, 300));
  const raw = await prisma.fill.findMany({
    where,
    orderBy: { ts: 'desc' },
    take,
    include: {
      order: {
        select: {
          id: true,
          symbol: true,
          leverage: true,
          sessionId: true,
        },
      },
    },
  });

  const mapped: FillRecord[] = raw.map((fill) => ({
    ts: fill.ts,
    side: String(fill.side) === 'sell' ? 'sell' : 'buy',
    qty: Number(fill.qty ?? 0),
    price: Number(fill.price ?? 0),
    fee: Number(fill.fee ?? 0),
    realizedPnl: Number(fill.realizedPnl ?? 0),
    orderId: fill.order?.id ?? fill.orderId,
    leverage: fill.order?.leverage ?? null,
    symbol: fill.order?.symbol ?? '',
    sessionId: fill.order?.sessionId ?? fill.sessionId ?? null,
    // V5.11: New fields for detailed trade analysis
    exitReason: (fill as any).exitReason ?? null,
    entryTs: (fill as any).entryTs ?? null,
    maxPnlPct: (fill as any).maxPnlPct != null ? Number((fill as any).maxPnlPct) : null,
  }));

  const aggregated = aggregateFillsToLedgerTrades(mapped);
  const sorted = aggregated.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // Don't slice - already limited by take (4000 fills → ~2000 trades max)
  // Slicing here cuts old but valid trades when many exist
  return sorted;
}
