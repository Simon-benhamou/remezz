/**
 * Deep analysis of recent trades - paper vs live comparison
 */
import { prisma } from '../src/db/client.js';

async function analyze() {
  // Get all trades from today
  const allTrades = await prisma.trade.findMany({
    where: {
      entryTs: { gte: new Date('2026-02-05T00:00:00Z') }
    },
    orderBy: { entryTs: 'asc' },
    include: { session: true }
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('DEEP TRADE ANALYSIS - PAPER vs LIVE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Group by symbol and time (to find matching paper/live trades)
  const bySymbolTime: Record<string, typeof allTrades> = {};

  for (const t of allTrades) {
    // Round entry time to nearest 15min to group matching trades
    const entryBucket = Math.floor(t.entryTs.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
    const key = `${t.symbol}_${entryBucket}`;
    if (!bySymbolTime[key]) bySymbolTime[key] = [];
    bySymbolTime[key].push(t);
  }

  // Find pairs where both paper and live exist
  console.log('─── PAIRED TRADES (Same Symbol/Time) ───\n');

  for (const [key, trades] of Object.entries(bySymbolTime)) {
    if (trades.length < 2) continue;

    const paperTrade = trades.find(t => t.session?.mode === 'paper');
    const liveTrade = trades.find(t => t.session?.mode === 'live');

    if (paperTrade && liveTrade) {
      const symbol = paperTrade.symbol.replace('/USDT:USDT', '');
      console.log(`📊 ${symbol} ${paperTrade.positionSide.toUpperCase()}`);
      console.log(`   Entry Time: ${paperTrade.entryTs.toISOString()}`);
      console.log('');

      // Paper details
      const paperPnl = ((paperTrade.roiPct || 0) * (paperTrade.leverage || 5) * 100).toFixed(2);
      const paperMaxPnl = ((paperTrade.maxPnlPct || 0) * 100).toFixed(2);
      const paperDuration = Math.round((paperTrade.exitTs.getTime() - paperTrade.entryTs.getTime()) / 60000);
      console.log(`   PAPER:`);
      console.log(`     Entry: $${paperTrade.entryPrice.toFixed(6)}`);
      console.log(`     Exit:  $${paperTrade.exitPrice?.toFixed(6)} (${paperTrade.exitReason})`);
      console.log(`     PnL:   ${paperPnl}% | Max: ${paperMaxPnl}% | Duration: ${paperDuration}min`);
      console.log('');

      // Live details
      const livePnl = ((liveTrade.roiPct || 0) * (liveTrade.leverage || 5) * 100).toFixed(2);
      const liveMaxPnl = ((liveTrade.maxPnlPct || 0) * 100).toFixed(2);
      const liveDuration = Math.round((liveTrade.exitTs.getTime() - liveTrade.entryTs.getTime()) / 60000);
      console.log(`   LIVE:`);
      console.log(`     Entry: $${liveTrade.entryPrice.toFixed(6)}`);
      console.log(`     Exit:  $${liveTrade.exitPrice?.toFixed(6)} (${liveTrade.exitReason})`);
      console.log(`     PnL:   ${livePnl}% | Max: ${liveMaxPnl}% | Duration: ${liveDuration}min`);
      console.log('');

      // Comparison
      const entryDiff = ((liveTrade.entryPrice - paperTrade.entryPrice) / paperTrade.entryPrice * 100).toFixed(4);
      const exitDiff = paperTrade.exitPrice && liveTrade.exitPrice
        ? ((liveTrade.exitPrice - paperTrade.exitPrice) / paperTrade.exitPrice * 100).toFixed(4)
        : 'N/A';
      const pnlDiff = (parseFloat(livePnl) - parseFloat(paperPnl)).toFixed(2);

      console.log(`   COMPARISON:`);
      console.log(`     Entry price diff: ${entryDiff}% (slippage)`);
      console.log(`     Exit price diff:  ${exitDiff}%`);
      console.log(`     PnL diff:         ${pnlDiff}%`);
      console.log(`     Exit reason same: ${paperTrade.exitReason === liveTrade.exitReason ? '✅' : '❌'}`);
      console.log('');
      console.log('─────────────────────────────────────────────────────────────────');
      console.log('');
    }
  }

  // Show all trades grouped by mode
  console.log('\n─── ALL TRADES BY MODE ───\n');

  const byMode: Record<string, typeof allTrades> = {};
  for (const t of allTrades) {
    const mode = t.session?.mode || 'unknown';
    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push(t);
  }

  for (const [mode, trades] of Object.entries(byMode)) {
    console.log(`\n${mode.toUpperCase()} (${trades.length} trades):`);
    let totalPnl = 0;

    for (const t of trades) {
      const pnlLev = (t.roiPct || 0) * (t.leverage || 5) * 100;
      totalPnl += pnlLev;
      const maxPnl = ((t.maxPnlPct || 0) * 100).toFixed(2);
      const symbol = t.symbol.replace('/USDT:USDT', '');
      const missedPnl = (parseFloat(maxPnl) - pnlLev).toFixed(2);

      console.log(`  ${symbol.padEnd(5)} ${t.positionSide.padEnd(5)}: PnL=${pnlLev.toFixed(2).padStart(7)}% | Max=${maxPnl.padStart(6)}% | Missed=${missedPnl.padStart(6)}% | ${t.exitReason}`);
    }

    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  TOTAL: ${totalPnl.toFixed(2)}%`);
  }
}

analyze().catch(console.error);
