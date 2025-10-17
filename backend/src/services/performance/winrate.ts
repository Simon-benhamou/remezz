import { prisma } from '../../db/client.js';

const SCALE_FACTOR = 100_000_000;
const EPSILON = 50n; // ≈5e-7 units with SCALE_FACTOR precision

type NormalizedSide = 'buy' | 'sell';

export type AggregatedFill = {
  ts: Date;
  qty: number;
  side: NormalizedSide;
  realizedPnl: number;
};

export type AggregatedTrade = {
  pnl: bigint;
  ts: Date;
};

function toFixed(value: number | null | undefined): bigint {
  if (value == null || !Number.isFinite(value)) return 0n;
  const scaled = Math.round(value * SCALE_FACTOR);
  return BigInt(scaled);
}

function isZeroish(value: bigint): boolean {
  return value >= -EPSILON && value <= EPSILON;
}

export function aggregateFillsToTrades(fills: AggregatedFill[]): AggregatedTrade[] {
  if (!Array.isArray(fills) || fills.length === 0) return [];

  const sorted = fills.slice().sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let position = 0n;
  let tradePnl = 0n;
  const trades: AggregatedTrade[] = [];

  for (const fill of sorted) {
    const qtyFixed = toFixed(fill.qty);
    const realizedFixed = toFixed(fill.realizedPnl);
    const side: NormalizedSide = fill.side === 'sell' ? 'sell' : 'buy';
    if (qtyFixed === 0n && realizedFixed === 0n) continue;

    const before = isZeroish(position) ? 0n : position;
    const signedQty = side === 'sell' ? -qtyFixed : qtyFixed;
    let after = before + signedQty;
    if (isZeroish(after)) after = 0n;

    if (realizedFixed !== 0n) {
      tradePnl += realizedFixed;
    }

    const beforeSign = before > 0n ? 1 : before < 0n ? -1 : 0;
    const afterSign = after > 0n ? 1 : after < 0n ? -1 : 0;
    const crossed = beforeSign !== 0 && afterSign !== 0 && beforeSign !== afterSign;

    if (crossed || afterSign === 0) {
      trades.push({ pnl: tradePnl, ts: fill.ts });
      tradePnl = 0n;
      position = after;
      continue;
    }

    position = after;
  }

  return trades;
}

export type WinRateOptions = {
  maxTrades?: number;
  minTrades?: number;
  lookbackDays?: number;
  decay?: number;
};

export type WinRateResult = {
  p?: number;
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  raw?: number;
  ewma?: number;
  mode: 'simple' | 'ewma';
};

const MS_PER_DAY = 86_400_000;

function normalizeDate(value: Date | string | number | null | undefined): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function computeEwma(outcomes: number[], decay: number): number | undefined {
  if (!outcomes.length) return undefined;
  const clampedDecay = decay >= 0 && decay <= 1 ? decay : 1;
  if (clampedDecay >= 0.999) {
    return outcomes.reduce((sum, value) => sum + value, 0) / outcomes.length;
  }
  let estimate = outcomes[0];
  for (let i = 1; i < outcomes.length; i += 1) {
    estimate = clampedDecay * estimate + (1 - clampedDecay) * outcomes[i];
  }
  return estimate;
}

export async function getAgentRecentWinRate(
  agentId: string,
  opts: WinRateOptions = {},
): Promise<WinRateResult> {
  if (!agentId || typeof agentId !== 'string') {
    return { p: undefined, trades: 0, wins: 0, losses: 0, breakeven: 0, mode: 'simple' };
  }

  const maxTrades = Math.max(1, Math.floor(opts.maxTrades ?? 200));
  const lookbackDays = Math.max(0, Math.floor(opts.lookbackDays ?? 0));
  const minTrades = Math.max(1, Math.floor(opts.minTrades ?? 1));
  const decay = typeof opts.decay === 'number' ? opts.decay : 1;

  const where: any = { sessionId: agentId, realizedPnl: { not: null } };
  if (lookbackDays > 0) {
    const since = new Date(Date.now() - lookbackDays * MS_PER_DAY);
    where.ts = { gte: since };
  }

  const take = Math.max(maxTrades * 20, 200);
  const fills = await prisma.fill.findMany({
    where,
    orderBy: { ts: 'desc' },
    take,
    select: { ts: true, qty: true, side: true, realizedPnl: true },
  });

  const aggregated = aggregateFillsToTrades(
    fills.map((fill) => ({
      ts: normalizeDate(fill.ts),
      qty: Number(fill.qty ?? 0),
      side: String(fill.side ?? 'buy') === 'sell' ? 'sell' : 'buy',
      realizedPnl: Number(fill.realizedPnl ?? 0),
    })),
  ).sort((a, b) => b.ts.getTime() - a.ts.getTime());

  const trades = aggregated.slice(0, maxTrades);

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  const outcomes: number[] = [];
  for (const trade of trades.slice().reverse()) {
    if (trade.pnl > 0n) {
      wins += 1;
      outcomes.push(1);
    } else if (trade.pnl < 0n) {
      losses += 1;
      outcomes.push(0);
    } else {
      breakeven += 1;
      outcomes.push(0.5);
    }
  }

  const total = trades.length;
  const raw = total > 0 ? wins / total : undefined;
  const ewma = computeEwma(outcomes, decay);
  const mode: 'simple' | 'ewma' = decay < 0.999 ? 'ewma' : 'simple';

  if (!total || total < minTrades) {
    return { p: undefined, trades: total, wins, losses, breakeven, raw, ewma, mode };
  }

  const p = mode === 'ewma' && ewma != null ? ewma : raw;
  return { p: p != null ? Math.max(0, Math.min(1, p)) : undefined, trades: total, wins, losses, breakeven, raw, ewma, mode };
}
