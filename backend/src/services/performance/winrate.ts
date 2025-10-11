import { prisma } from '../../db/client.js';

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

  const take = Math.max(maxTrades * 4, 100);
  const fills = await prisma.fill.findMany({
    where,
    orderBy: { ts: 'desc' },
    take,
    select: { orderId: true, realizedPnl: true, ts: true },
  });

  const orderMap = new Map<string, { pnl: number; ts: Date }>();
  for (const fill of fills) {
    const orderId = fill.orderId;
    if (!orderId) continue;
    const pnl = Number(fill.realizedPnl ?? 0);
    const ts = normalizeDate(fill.ts);
    const existing = orderMap.get(orderId);
    if (existing) {
      existing.pnl += pnl;
      if (existing.ts < ts) existing.ts = ts;
    } else {
      orderMap.set(orderId, { pnl, ts });
    }
  }

  const aggregated = Array.from(orderMap.values()).sort((a, b) => b.ts.getTime() - a.ts.getTime());
  const trades = aggregated.slice(0, maxTrades);

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  const outcomes: number[] = [];
  for (const trade of trades.slice().reverse()) {
    if (trade.pnl > 0) {
      wins += 1;
      outcomes.push(1);
    } else if (trade.pnl < 0) {
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
