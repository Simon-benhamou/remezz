/**
 * XRP trade analysis - corrected formulas
 * roiPct is stored as percentage (3.77 = 3.77%, not 377%)
 * maxPnlPct is stored as ratio (0.042 = 4.2%)
 */
import { prisma } from '../src/db/client.js';

async function analyze() {
  const xrpTrades = await prisma.trade.findMany({
    where: {
      symbol: { contains: 'XRP' },
      entryTs: { gte: new Date('2026-02-04T00:00:00Z') }
    },
    orderBy: { entryTs: 'asc' },
    include: { session: true }
  });

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('XRP TRADE ANALYSIS (CORRECTED)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const t of xrpTrades) {
    const mode = t.session?.mode || 'unknown';
    const leverage = t.leverage || 5;

    // roiPct is stored as percentage value (3.77 = 3.77%)
    const rawPnlPct = t.roiPct || 0;
    const leveragedPnl = rawPnlPct * leverage;

    // maxPnlPct is stored as ratio (0.042 = 4.2%)
    const maxPnlRaw = (t.maxPnlPct || 0) * 100;
    const maxPnlLev = maxPnlRaw * leverage;

    const missedPnl = maxPnlLev - leveragedPnl;
    const duration = Math.round((t.exitTs.getTime() - t.entryTs.getTime()) / 60000);

    // Calculate actual prices
    let lowPrice: number;
    if (t.positionSide === 'short') {
      // For short: max profit at lowest price
      // maxPnlPct = (entry - low) / entry
      // low = entry * (1 - maxPnlPct)
      lowPrice = t.entryPrice * (1 - (t.maxPnlPct || 0));
    } else {
      lowPrice = t.entryPrice * (1 + (t.maxPnlPct || 0));
    }

    console.log(`📊 ${mode.toUpperCase()} XRP ${t.positionSide.toUpperCase()}`);
    console.log(`   Entry:       ${t.entryTs.toISOString().slice(11,19)} @ $${t.entryPrice.toFixed(6)}`);
    console.log(`   Exit:        ${t.exitTs.toISOString().slice(11,19)} @ $${t.exitPrice?.toFixed(6)}`);
    console.log(`   Duration:    ${duration} min`);
    console.log(`   Raw PnL:     ${rawPnlPct >= 0 ? '+' : ''}${rawPnlPct.toFixed(2)}%`);
    console.log(`   Leveraged:   ${leveragedPnl >= 0 ? '+' : ''}${leveragedPnl.toFixed(2)}% (${leverage}x)`);
    console.log(`   Max PnL:     +${maxPnlLev.toFixed(2)}%`);
    console.log(`   Missed:      ${missedPnl.toFixed(2)}%`);
    console.log(`   Best Price:  $${lowPrice.toFixed(6)} (${t.positionSide === 'short' ? 'low' : 'high'})`);
    console.log(`   Exit Reason: ${t.exitReason}`);

    // Trailing analysis
    const trailDist = 1.5; // Assuming 1.5% trailing distance
    let trailingStopPrice: number;
    if (t.positionSide === 'short') {
      trailingStopPrice = lowPrice * (1 + trailDist / 100);
    } else {
      trailingStopPrice = lowPrice * (1 - trailDist / 100);
    }
    console.log(`   Trail Stop:  $${trailingStopPrice.toFixed(6)} (at max profit, ${trailDist}% dist)`);
    console.log(`   Exit vs Trail: ${(((t.exitPrice || 0) - trailingStopPrice) / trailingStopPrice * 100).toFixed(3)}% diff`);
    console.log('');
  }

  // Paper vs Live comparison
  const paperTrade = xrpTrades.find(t => t.session?.mode === 'paper');
  const liveTrade = xrpTrades.find(t => t.session?.mode === 'live');

  if (paperTrade && liveTrade) {
    console.log('─── PAPER vs LIVE ───\n');
    const exitDiff = ((liveTrade.exitPrice || 0) - (paperTrade.exitPrice || 0));
    const exitDiffPct = exitDiff / (paperTrade.exitPrice || 1) * 100;

    const paperLev = (paperTrade.roiPct || 0) * (paperTrade.leverage || 5);
    const liveLev = (liveTrade.roiPct || 0) * (liveTrade.leverage || 5);
    const pnlDiff = liveLev - paperLev;

    console.log(`Paper Exit: $${paperTrade.exitPrice?.toFixed(6)}`);
    console.log(`Live Exit:  $${liveTrade.exitPrice?.toFixed(6)}`);
    console.log(`Exit Price Diff: $${exitDiff.toFixed(6)} (${exitDiffPct.toFixed(3)}%)`);
    console.log(`PnL Diff: ${pnlDiff.toFixed(2)}% (live worse by this amount)`);
    console.log(`Slippage Impact: For short, higher exit = worse`);
    console.log(`                 Live exit is ${exitDiffPct.toFixed(3)}% higher`);
    console.log(`                 With 5x leverage = ${(exitDiffPct * 5).toFixed(2)}% PnL impact`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('KEY FINDINGS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (paperTrade && liveTrade) {
    const missedPaper = ((paperTrade.maxPnlPct || 0) * 100 - (paperTrade.roiPct || 0)) * (paperTrade.leverage || 5);
    const missedLive = ((liveTrade.maxPnlPct || 0) * 100 - (liveTrade.roiPct || 0)) * (liveTrade.leverage || 5);

    console.log(`1. BOUNCE ANALYSIS:`);
    console.log(`   Paper captured ${((paperTrade.roiPct || 0) / ((paperTrade.maxPnlPct || 1) * 100) * 100).toFixed(1)}% of max potential`);
    console.log(`   Live captured ${((liveTrade.roiPct || 0) / ((liveTrade.maxPnlPct || 1) * 100) * 100).toFixed(1)}% of max potential`);
    console.log(`   Paper missed: ${missedPaper.toFixed(2)}% leveraged PnL`);
    console.log(`   Live missed: ${missedLive.toFixed(2)}% leveraged PnL`);

    console.log(`\n2. SLIPPAGE IMPACT:`);
    const slippage = ((liveTrade.exitPrice || 0) - (paperTrade.exitPrice || 0)) / (paperTrade.exitPrice || 1) * 100;
    console.log(`   Paper exited at theoretical price (NFS HIGH = trailing stop)`);
    console.log(`   Live market order had ${slippage.toFixed(3)}% slippage`);
    console.log(`   This cost ${(slippage * (liveTrade.leverage || 5)).toFixed(2)}% leveraged PnL`);

    console.log(`\n3. PROACTIVE LIMIT STATUS:`);
    console.log(`   Exit reason: ${liveTrade.exitReason}`);
    if (!liveTrade.exitReason?.includes('proactive')) {
      console.log(`   ⚠️ Proactive limit was NOT used`);
      console.log(`   → Either NFS didn't reach threshold, or limit wasn't filled`);
    }
  }
}

analyze().catch(console.error);
