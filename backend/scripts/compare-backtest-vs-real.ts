/**
 * Compare backtest trades vs real trades from Jan 13 2025 onwards.
 * Dumps both side by side for analysis.
 *
 * Run: npx tsx scripts/compare-backtest-vs-real.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const from = new Date('2025-01-13T00:00:00.000Z');
  const to = new Date('2025-02-01T00:00:00.000Z');

  console.log('═══════════════════════════════════════════════════════════');
  console.log('REAL TRADES from DB:', from.toISOString(), '→', to.toISOString());
  console.log('═══════════════════════════════════════════════════════════\n');

  // Get all sessions to find the right one
  const sessions = await prisma.agentSession.findMany({
    where: { mode: { in: ['live', 'paper'] } },
    select: { id: true, mode: true, userId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log('Recent sessions:');
  for (const s of sessions) {
    console.log(`  ${s.id} mode=${s.mode} user=${s.userId} created=${s.createdAt.toISOString()}`);
  }

  // Get all trades in the date range
  const trades = await prisma.trade.findMany({
    where: {
      entryTs: { gte: from },
      exitTs: { lte: to },
    },
    orderBy: { entryTs: 'asc' },
  });

  console.log(`\nTotal trades found: ${trades.length}\n`);

  if (trades.length === 0) {
    console.log('No trades found. Trying broader query...');
    const allTrades = await prisma.trade.findMany({
      orderBy: { entryTs: 'desc' },
      take: 20,
    });
    console.log(`Latest ${allTrades.length} trades in DB:`);
    for (const t of allTrades) {
      console.log(`  ${t.symbol} ${t.positionSide} entry=${t.entryTs?.toISOString()} exit=${t.exitTs?.toISOString()} pnl=$${t.realizedPnlUsd?.toFixed(2)} reason=${t.exitReason}`);
    }
    await prisma.$disconnect();
    return;
  }

  // Summary stats
  const wins = trades.filter(t => (t.realizedPnlUsd ?? 0) > 0).length;
  const totalPnl = trades.reduce((s, t) => s + (t.realizedPnlUsd ?? 0), 0);
  const totalFees = trades.reduce((s, t) => s + (t.feesUsd ?? 0), 0);
  console.log(`Real trades: ${trades.length} | WR: ${(wins/trades.length*100).toFixed(1)}% | PnL: $${totalPnl.toFixed(2)} | Fees: $${totalFees.toFixed(2)}`);

  // By symbol
  const bySymbol = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const cur = bySymbol.get(t.symbol) || { n: 0, pnl: 0, wins: 0 };
    cur.n++;
    cur.pnl += t.realizedPnlUsd ?? 0;
    if ((t.realizedPnlUsd ?? 0) > 0) cur.wins++;
    bySymbol.set(t.symbol, cur);
  }
  console.log('\nBy symbol:');
  for (const [sym, v] of [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${sym}: ${v.n}tr WR${(v.wins/v.n*100).toFixed(0)}% PnL=$${v.pnl.toFixed(2)}`);
  }

  // By exit reason
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of trades) {
    const r = t.exitReason || 'UNKNOWN';
    const cur = byReason.get(r) || { n: 0, pnl: 0 };
    cur.n++;
    cur.pnl += t.realizedPnlUsd ?? 0;
    byReason.set(r, cur);
  }
  console.log('\nBy exit reason:');
  for (const [r, v] of [...byReason.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${r}: ${v.n}tr PnL=$${v.pnl.toFixed(2)} avg=$${(v.pnl/v.n).toFixed(2)}`);
  }

  // By direction
  const longs = trades.filter(t => t.positionSide === 'long' || t.positionSide === 'LONG');
  const shorts = trades.filter(t => t.positionSide === 'short' || t.positionSide === 'SHORT');
  const lw = longs.filter(t => (t.realizedPnlUsd ?? 0) > 0).length;
  const sw = shorts.filter(t => (t.realizedPnlUsd ?? 0) > 0).length;
  console.log(`\nLongs: ${longs.length}tr WR${longs.length ? (lw/longs.length*100).toFixed(0) : 0}% PnL=$${longs.reduce((s,t) => s + (t.realizedPnlUsd??0), 0).toFixed(2)}`);
  console.log(`Shorts: ${shorts.length}tr WR${shorts.length ? (sw/shorts.length*100).toFixed(0) : 0}% PnL=$${shorts.reduce((s,t) => s + (t.realizedPnlUsd??0), 0).toFixed(2)}`);

  // Daily breakdown
  const byDay = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const day = t.entryTs ? t.entryTs.toISOString().slice(0, 10) : 'unknown';
    const cur = byDay.get(day) || { n: 0, pnl: 0, wins: 0 };
    cur.n++;
    cur.pnl += t.realizedPnlUsd ?? 0;
    if ((t.realizedPnlUsd ?? 0) > 0) cur.wins++;
    byDay.set(day, cur);
  }
  console.log('\nDaily breakdown:');
  for (const [day, v] of [...byDay.entries()].sort()) {
    console.log(`  ${day}: ${v.n}tr WR${(v.wins/v.n*100).toFixed(0)}% PnL=$${v.pnl.toFixed(2)}`);
  }

  // Print individual trades
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('INDIVIDUAL TRADES (chronological)');
  console.log('═══════════════════════════════════════════════════════════');
  for (const t of trades) {
    const dur = t.durationMinutes ?? 0;
    console.log(`  ${t.entryTs?.toISOString().slice(0,16)} ${t.symbol.padEnd(16)} ${(t.positionSide??'').padEnd(5)} entry=$${t.entryPrice?.toFixed(4)} exit=$${t.exitPrice?.toFixed(4)} pnl=$${(t.realizedPnlUsd??0).toFixed(2).padStart(8)} ${(t.pctChange??0).toFixed(2)}% ${dur}min ${t.exitReason}`);
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); prisma.$disconnect(); process.exit(1); });
