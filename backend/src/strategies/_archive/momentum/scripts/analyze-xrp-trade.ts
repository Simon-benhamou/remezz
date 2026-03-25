/**
 * Deep analysis of XRP trade - caught by bounce before full potential
 */
import { prisma } from '../src/db/client.js';

async function analyze() {
  // Get XRP trades from today
  const xrpTrades = await prisma.trade.findMany({
    where: {
      symbol: { contains: 'XRP' },
      entryTs: { gte: new Date('2026-02-04T00:00:00Z') }
    },
    orderBy: { entryTs: 'asc' },
    include: { session: true }
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('XRP TRADE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const t of xrpTrades) {
    const mode = t.session?.mode || 'unknown';
    const pnlLev = (t.roiPct || 0) * (t.leverage || 5) * 100;
    const maxPnl = ((t.maxPnlPct || 0) * 100);
    const missedPnl = maxPnl - pnlLev;
    const duration = Math.round((t.exitTs.getTime() - t.entryTs.getTime()) / 60000);

    console.log(`📊 ${mode.toUpperCase()} XRP ${t.positionSide.toUpperCase()}`);
    console.log(`   Entry:     ${t.entryTs.toISOString()} @ $${t.entryPrice.toFixed(6)}`);
    console.log(`   Exit:      ${t.exitTs.toISOString()} @ ${t.exitPrice?.toFixed(6)}`);
    console.log(`   Duration:  ${duration} minutes`);
    console.log(`   PnL:       ${pnlLev >= 0 ? '+' : ''}${pnlLev.toFixed(2)}%`);
    console.log(`   Max PnL:   ${maxPnl.toFixed(2)}%`);
    console.log(`   Missed:    ${missedPnl.toFixed(2)}%`);
    console.log(`   Exit Reason: ${t.exitReason}`);

    // Calculate trailing stop price that would have triggered
    if (t.positionSide === 'short') {
      // For shorts: trailing triggers when price rises above HWM * (1 + trailDist)
      // If HWM was at max profit point
      const hwmPrice = t.entryPrice * (1 - maxPnl / 100 / (t.leverage || 5));
      console.log(`   HWM Price: $${hwmPrice.toFixed(6)} (at max profit)`);
      console.log(`   Exit/HWM:  ${((t.exitPrice || 0) / hwmPrice * 100 - 100).toFixed(3)}% above HWM`);
    } else {
      const hwmPrice = t.entryPrice * (1 + maxPnl / 100 / (t.leverage || 5));
      console.log(`   HWM Price: $${hwmPrice.toFixed(6)} (at max profit)`);
      console.log(`   Exit/HWM:  ${((t.exitPrice || 0) / hwmPrice * 100 - 100).toFixed(3)}% below HWM`);
    }
    console.log('');
  }

  // Compare paper vs live exits
  const paperTrade = xrpTrades.find(t => t.session?.mode === 'paper');
  const liveTrade = xrpTrades.find(t => t.session?.mode === 'live');

  if (paperTrade && liveTrade) {
    console.log('─── PAPER vs LIVE COMPARISON ───\n');

    const paperPnl = (paperTrade.roiPct || 0) * (paperTrade.leverage || 5) * 100;
    const livePnl = (liveTrade.roiPct || 0) * (liveTrade.leverage || 5) * 100;

    console.log(`Paper Exit: $${paperTrade.exitPrice?.toFixed(6)} (${paperTrade.exitReason})`);
    console.log(`Live Exit:  $${liveTrade.exitPrice?.toFixed(6)} (${liveTrade.exitReason})`);
    console.log(`Exit Price Diff: ${(((liveTrade.exitPrice || 0) - (paperTrade.exitPrice || 0)) / (paperTrade.exitPrice || 1) * 100).toFixed(4)}%`);
    console.log(`PnL Diff: ${(livePnl - paperPnl).toFixed(2)}%`);
    console.log(`Same Exit Reason: ${paperTrade.exitReason === liveTrade.exitReason ? '✅' : '❌'}`);
    console.log(`Same Exit Time: ${Math.abs(paperTrade.exitTs.getTime() - liveTrade.exitTs.getTime()) < 60000 ? '✅' : '❌'} (${Math.round(Math.abs(paperTrade.exitTs.getTime() - liveTrade.exitTs.getTime()) / 1000)}s diff)`);
  }

  // Get recent proactive limit logs if possible
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ANALYSIS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Check if any trades used proactive limit
  for (const t of xrpTrades) {
    if (t.exitReason?.includes('proactive')) {
      console.log(`✅ ${t.session?.mode} used PROACTIVE LIMIT exit`);
    } else {
      console.log(`❌ ${t.session?.mode} did NOT use proactive limit (${t.exitReason})`);
    }
  }
}

analyze().catch(console.error);
