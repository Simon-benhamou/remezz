import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';

type EntryLot = { qty: number; createdAt: Date };

function percentile(samples: number[], p: number) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

export function computeRoiBreakdown(
  startBalance: number,
  realizedPnlUsd: number,
  unrealizedPnlUsd: number,
) {
  const start = Number.isFinite(startBalance) ? startBalance : 0;
  const realized = Number.isFinite(realizedPnlUsd) ? realizedPnlUsd : 0;
  const unrealized = Number.isFinite(unrealizedPnlUsd) ? unrealizedPnlUsd : 0;
  const total = realized + unrealized;
  const realizedPct = start > 0 ? (realized / start) * 100 : 0;
  const netPct = start > 0 ? (total / start) * 100 : 0;
  return { realizedPct, netPct };
}

export async function recomputeKpi(sessionId: string) {
  const session = await prisma.agentSession.findUnique({ where: { id: sessionId } });
  if (!session) return;

  const fillAgg = await prisma.fill.aggregate({
    where: { sessionId, realizedPnl: { not: null } },
    _sum: { realizedPnl: true, fee: true },
  });
  const realizedGross = Number(fillAgg._sum.realizedPnl || 0);
  const totalFees = Number(fillAgg._sum.fee || 0);
  const realized = realizedGross - totalFees;

  let unrealized = 0;
  const pos = await prisma.position.findFirst({ where: { sessionId, qty: { gt: 0 } }, orderBy: { openedAt: 'desc' } });
  if (pos && pos.qty && pos.entryPrice) {
    try {
      const t = await getTicker(pos.symbol);
      const last = Number(t?.last || 0);
      if (last > 0) {
        const dir = pos.side === 'buy' ? 1 : -1;
        unrealized = dir * (last - pos.entryPrice) * pos.qty;
      }
    } catch (error) {
      console.warn(`[recomputeKpi] Failed to get ticker for ${pos.symbol}:`, error);
    }
  }

  const startBal = Number(session.startBalanceUsd || 0);
  const { realizedPct: roiPct, netPct: netRoiPct } = computeRoiBreakdown(
    startBal,
    realized,
    unrealized,
  );

  const orders = await prisma.order.findMany({
    where: { sessionId, source: 'agent' },
    include: { fills: true },
    orderBy: { createdAt: 'asc' },
  });

  const openStacks = new Map<string, EntryLot[]>();
  const returnsPct: number[] = [];
  const holdSamples: number[] = [];
  const symbolStats = new Map<string, { returns: number[]; partial: { count: number; wins: number } }>();

  let wins = 0;
  let losses = 0;
  let tradeCount = 0;
  let partialCount = 0;
  let partialWins = 0;

  const EPS = 1e-8;

  for (const order of orders) {
    const qty = Number(order.qty || 0);
    if (!(qty > EPS)) continue;
    const symbol = order.symbol;
    let stack = openStacks.get(symbol);
    if (!stack) {
      stack = [];
      openStacks.set(symbol, stack);
    }

    const isExit = order.clientOrderId?.endsWith('.exit');
    const status = String(order.status || '').toLowerCase();

    if (!isExit) {
      if (status.includes('filled')) {
        stack.push({ qty, createdAt: new Date(order.createdAt) });
      }
      continue;
    }

    if (!stack.length) continue;

    tradeCount += 1;
    const exitDate = new Date(order.createdAt);
    let exitQty = qty;
    const beforeQty = stack.reduce((sum, lot) => sum + lot.qty, 0);

    while (exitQty > EPS && stack.length) {
      const lot = stack[0];
      const used = Math.min(lot.qty, exitQty);
      const holdMin = (exitDate.getTime() - lot.createdAt.getTime()) / 60000;
      if (Number.isFinite(holdMin) && holdMin >= 0) holdSamples.push(holdMin);
      lot.qty -= used;
      exitQty -= used;
      if (lot.qty <= EPS) stack.shift();
    }

    const afterQty = stack.reduce((sum, lot) => sum + lot.qty, 0);
    const isPartial = afterQty > EPS;
    const retPct = Number(order.pctChange || 0);
    if (retPct > 0) wins += 1; else if (retPct < 0) losses += 1;
    returnsPct.push(retPct);

    let stats = symbolStats.get(symbol);
    if (!stats) {
      stats = { returns: [], partial: { count: 0, wins: 0 } };
      symbolStats.set(symbol, stats);
    }
    stats.returns.push(retPct);

    if (isPartial) {
      partialCount += 1;
      stats.partial.count += 1;
      if (retPct > 0) {
        partialWins += 1;
        stats.partial.wins += 1;
      }
    }
  }

  const winRate = tradeCount ? (wins / tradeCount) * 100 : 0;
  const expectancy = returnsPct.length ? returnsPct.reduce((a, b) => a + b, 0) / returnsPct.length : 0;

  const returnsDec = returnsPct.map((p) => p / 100);
  const meanDec = returnsDec.length ? returnsDec.reduce((a, b) => a + b, 0) / returnsDec.length : 0;
  const varianceDec = returnsDec.length ? returnsDec.reduce((acc, r) => acc + Math.pow(r - meanDec, 2), 0) / returnsDec.length : 0;
  const variancePct = varianceDec * 10000;
  const stdPct = Math.sqrt(varianceDec) * 100;

  let peak = 1;
  let equity = 1;
  let maxDrawdown = 0;
  for (const r of returnsDec) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (equity - peak) / peak : 0;
    if (dd < maxDrawdown) maxDrawdown = dd;
  }
  const maxDrawdownPct = Math.abs(maxDrawdown) * 100;

  const avgHoldingMin = holdSamples.length ? holdSamples.reduce((a, b) => a + b, 0) / holdSamples.length : 0;
  const medianHold = percentile(holdSamples, 0.5);
  const p75Hold = percentile(holdSamples, 0.75);
  const partialWinRate = partialCount ? (partialWins / partialCount) * 100 : null;

  const bySymbol = Object.fromEntries(Array.from(symbolStats.entries()).map(([symbol, data]) => {
    const arr = data.returns;
    const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const winsSymbol = arr.filter((v) => v > 0).length;
    const winRateSymbol = arr.length ? (winsSymbol / arr.length) * 100 : 0;
    const partialRate = data.partial.count ? (data.partial.wins / data.partial.count) * 100 : null;
    return [symbol, { trades: arr.length, winRate: winRateSymbol, expectancy: avg, partialWinRate: partialRate }];
  }));

  const stats = {
    variancePct,
    stdPct,
    partialCount,
    partialWinRate,
    trades: tradeCount,
    wins,
    losses,
    returnsSample: returnsPct.length,
    medianHoldMin: medianHold,
    p75HoldMin: p75Hold,
    bySymbol,
    netRoiPct,
  };

  await prisma.sessionKpi.upsert({
    where: { sessionId },
    update: {
      realizedPnlUsd: realized,
      unrealizedPnlUsd: unrealized,
      roiPct,
      winRate,
      expectancy,
      maxDrawdownPct,
      avgHoldingMin,
      stats,
      lastUpdated: new Date(),
    },
    create: {
      sessionId,
      realizedPnlUsd: realized,
      unrealizedPnlUsd: unrealized,
      roiPct,
      winRate,
      expectancy,
      maxDrawdownPct,
      avgHoldingMin,
      stats,
    },
  });
}
