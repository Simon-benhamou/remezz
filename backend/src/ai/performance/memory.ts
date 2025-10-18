import { prisma } from '../../db/client.js';

const PERFORMANCE_LOOKBACK = 40;

export interface PerformanceSnapshot {
  sample: number;
  winRate: number | null;
  expectancyUsd: number | null;
  profitFactor: number | null;
  avgSlippageBps: number | null;
  avgFillRate: number | null;
  lastTradeAt: number | null;
}

export async function fetchPerformanceSnapshot(symbol: string): Promise<PerformanceSnapshot> {
  const orders = await prisma.order.findMany({
    where: {
      symbol,
      status: { in: ['filled', 'FILLED', 'partially_filled', 'PARTIALLY_FILLED'] },
    },
    orderBy: { createdAt: 'desc' },
    take: PERFORMANCE_LOOKBACK,
    select: {
      createdAt: true,
      fillRatio: true,
      slippageBps: true,
      fills: { select: { realizedPnl: true } },
      status: true,
    },
  });

  if (!orders.length) {
    return {
      sample: 0,
      winRate: null,
      expectancyUsd: null,
      profitFactor: null,
      avgSlippageBps: null,
      avgFillRate: null,
      lastTradeAt: null,
    };
  }

  let wins = 0;
  let losses = 0;
  let totalProfitCents = BigInt(0);
  let totalLossCents = BigInt(0);
  let totalNetCents = BigInt(0);
  let fillRateSum = 0;
  let fillRateCount = 0;
  let slippageSum = 0;
  let slippageCount = 0;
  let lastTradeAt: number | null = null;

  for (const order of orders) {
    const createdAt = order.createdAt instanceof Date
      ? order.createdAt.getTime()
      : new Date(order.createdAt as any).getTime();
    if (!Number.isNaN(createdAt)) {
      if (lastTradeAt == null || createdAt > lastTradeAt) {
        lastTradeAt = createdAt;
      }
    }

    const fillRatioRaw = order.fillRatio != null
      ? Number(order.fillRatio)
      : String(order.status || '').toLowerCase() === 'filled'
        ? 1
        : null;
    if (fillRatioRaw != null && Number.isFinite(fillRatioRaw)) {
      fillRateSum += fillRatioRaw;
      fillRateCount += 1;
    }

    if (order.slippageBps != null && Number.isFinite(Number(order.slippageBps))) {
      slippageSum += Number(order.slippageBps);
      slippageCount += 1;
    }

    let orderPnlCents = BigInt(0);
    for (const fill of order.fills) {
      const pnl = Number(fill?.realizedPnl ?? 0);
      if (!Number.isFinite(pnl) || pnl === 0) continue;
      orderPnlCents += BigInt(Math.round(pnl * 100));
    }

    totalNetCents += orderPnlCents;
    if (orderPnlCents > 0) {
      wins += 1;
      totalProfitCents += orderPnlCents;
    } else if (orderPnlCents < 0) {
      losses += 1;
      totalLossCents += -orderPnlCents;
    }
  }

  const sample = orders.length;
  const winRate = sample > 0 ? (wins / sample) * 100 : null;
  const expectancyUsd = sample > 0 ? Number(totalNetCents) / 100 / sample : null;
  const profitFactor = totalLossCents > 0
    ? Number(totalProfitCents) / Number(totalLossCents)
    : (totalProfitCents > 0 ? Infinity : null);
  const avgFillRate = fillRateCount > 0 ? fillRateSum / fillRateCount : null;
  const avgSlippageBps = slippageCount > 0 ? slippageSum / slippageCount : null;

  return {
    sample,
    winRate,
    expectancyUsd,
    profitFactor,
    avgSlippageBps,
    avgFillRate,
    lastTradeAt,
  };
}

