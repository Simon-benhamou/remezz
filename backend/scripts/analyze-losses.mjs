#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const symbolMap = {
  BTCUSDT: ['BTCUSDT', 'BTC/USDT', 'BTC/USDT:USDT', 'BTCUSDT.P'],
  WOOUSDT: ['WOOUSDT', 'WOO/USDT', 'WOO/USDT:USDT', 'WOOUSDT.P']
};

function avg(values) {
  const nums = values.filter(v => typeof v === 'number' && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

async function enrichOrder(order, aliases) {
  let position = null;
  if (order.sessionId) {
    position = await prisma.position.findFirst({
      where: {
        sessionId: order.sessionId,
        symbol: { in: aliases },
        openedAt: order.createdAt ? { lte: order.createdAt } : undefined
      },
      orderBy: { openedAt: 'desc' }
    });
  }

  const stopDistance = (position?.entryPrice != null && position?.stopPrice != null)
    ? Math.abs(position.entryPrice - position.stopPrice)
    : null;
  const stopDistancePct = (stopDistance != null && position?.entryPrice)
    ? (stopDistance / position.entryPrice) * 100
    : null;

  const pctChange = typeof order.pctChange === 'number'
    ? order.pctChange
    : (position?.entryPrice
      ? ((order.price - position.entryPrice) / position.entryPrice) * (position.side === 'buy' ? 100 : -100)
      : null);

  const fills = await prisma.fill.findMany({
    where: { orderId: order.id },
    orderBy: { ts: 'asc' }
  });

  const fillSummary = fills.length
    ? {
        count: fills.length,
        avgPrice: avg(fills.map(f => f.price)) ?? null,
        totalQty: fills.reduce((sum, f) => sum + (f.qty || 0), 0),
        realizedPnl: fills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0)
      }
    : { count: 0, avgPrice: null, totalQty: null, realizedPnl: null };

  return {
    id: order.id,
    createdAt: order.createdAt,
    sessionId: order.sessionId,
    side: position?.side || null,
    exitPrice: order.price,
    pctChange: pctChange != null ? Number(pctChange.toFixed(2)) : null,
    stopDistance: stopDistance != null ? Number(stopDistance.toFixed(4)) : null,
    stopDistancePct: stopDistancePct != null ? Number(stopDistancePct.toFixed(2)) : null,
    latencyMs: order.latencyMs ?? null,
    slippageBps: order.slippageBps != null ? Number(order.slippageBps.toFixed(2)) : null,
    fillSummary,
  };
}

async function analyzeSymbol(symbol) {
  const aliases = symbolMap[symbol] || [symbol];
  const orders = await prisma.order.findMany({
    where: {
      symbol: { in: aliases },
      clientOrderId: { contains: '.exit' }
    },
    orderBy: { createdAt: 'desc' },
    take: 20
  });

  if (!orders.length) {
    console.log(`No exit orders found for ${symbol}`);
    return;
  }

  const enriched = await Promise.all(orders.map(o => enrichOrder(o, aliases)));

  console.log(`\n=== ${symbol} exit analysis (${enriched.length} orders) ===`);
  for (const row of enriched) {
    const { createdAt, sessionId, exitPrice, pctChange, stopDistance, stopDistancePct, latencyMs, slippageBps, side, fillSummary } = row;
    console.log(`- ${createdAt.toISOString()} | session ${sessionId}`);
    console.log(`  side=${side || 'n/a'} price=${exitPrice?.toFixed?.(4) ?? exitPrice}`);
    console.log(`  pctChange=${pctChange ?? 'n/a'}% stop=${stopDistance ?? 'n/a'} (${stopDistancePct ?? 'n/a'}%) latency=${latencyMs ?? 'n/a'}ms slippage=${slippageBps ?? 'n/a'}bps`);
    if (fillSummary.count) {
      console.log(`  fills=${fillSummary.count} avgPrice=${fillSummary.avgPrice?.toFixed?.(4) ?? fillSummary.avgPrice} qty=${fillSummary.totalQty ?? 'n/a'} pnl=${fillSummary.realizedPnl ?? 'n/a'}`);
    } else {
      console.log('  fills=0');
    }
  }

  const pctValues = enriched.map(r => r.pctChange).filter(v => v != null);
  const stopValues = enriched.map(r => r.stopDistance).filter(v => v != null);
  const latencyValues = enriched.map(r => r.latencyMs).filter(v => v != null);
  const slippageValues = enriched.map(r => r.slippageBps).filter(v => v != null);

  const summary = {
    count: enriched.length,
    avgPctChange: avg(pctValues)?.toFixed(2) ?? null,
    worstPctChange: pctValues.length ? Math.min(...pctValues).toFixed(2) : null,
    avgStopDistance: avg(stopValues)?.toFixed(4) ?? null,
    avgStopPct: avg(enriched.map(r => r.stopDistancePct).filter(v => v != null))?.toFixed(2) ?? null,
    avgLatencyMs: avg(latencyValues)?.toFixed(0) ?? null,
    avgSlippageBps: avg(slippageValues)?.toFixed(2) ?? null,
  };

  console.log('Summary:', summary);
}

(async () => {
  try {
    for (const symbol of Object.keys(symbolMap)) {
      await analyzeSymbol(symbol);
    }
  } catch (error) {
    console.error('Failed to analyze losses:', error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
