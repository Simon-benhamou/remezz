/**
 * XRP trade analysis - FINAL corrected version
 * Both roiPct and maxPnlPct are stored as percentage values (4.2 = 4.2%)
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
  console.log('XRP TRADE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const t of xrpTrades) {
    const mode = t.session?.mode || 'unknown';
    const leverage = t.leverage || 5;

    // Both stored as percentage (3.77 = 3.77%)
    const rawPnl = t.roiPct || 0;
    const maxPnl = t.maxPnlPct || 0;
    const levPnl = rawPnl * leverage;
    const maxLevPnl = maxPnl * leverage;
    const missedPnl = maxLevPnl - levPnl;

    const duration = Math.round((t.exitTs.getTime() - t.entryTs.getTime()) / 60000);

    // Calculate the lowest price reached (for short)
    let bestPrice: number;
    if (t.positionSide === 'short') {
      // maxPnl% = (entry - low) / entry * 100
      // low = entry * (1 - maxPnl/100)
      bestPrice = t.entryPrice * (1 - maxPnl / 100);
    } else {
      bestPrice = t.entryPrice * (1 + maxPnl / 100);
    }

    console.log(`📊 ${mode.toUpperCase()} XRP ${t.positionSide.toUpperCase()}`);
    console.log(`   Entry:       ${t.entryTs.toISOString().slice(11,19)} @ $${t.entryPrice.toFixed(6)}`);
    console.log(`   Exit:        ${t.exitTs.toISOString().slice(11,19)} @ $${t.exitPrice?.toFixed(6)}`);
    console.log(`   Duration:    ${duration} min`);
    console.log(`   Raw PnL:     ${rawPnl >= 0 ? '+' : ''}${rawPnl.toFixed(2)}%`);
    console.log(`   Leveraged:   ${levPnl >= 0 ? '+' : ''}${levPnl.toFixed(2)}% (${leverage}x)`);
    console.log(`   Max Raw:     +${maxPnl.toFixed(2)}%`);
    console.log(`   Max Lev:     +${maxLevPnl.toFixed(2)}%`);
    console.log(`   Missed:      ${missedPnl.toFixed(2)}%`);
    console.log(`   Best Price:  $${bestPrice.toFixed(6)} (${t.positionSide === 'short' ? 'lowest' : 'highest'})`);
    console.log(`   Exit Reason: ${t.exitReason}`);

    // Trailing analysis - assuming 1.5% trailing distance
    const trailDist = 1.5;
    let trailStopPrice: number;
    if (t.positionSide === 'short') {
      // For short: trailing stop = lowPrice * (1 + trailDist%)
      trailStopPrice = bestPrice * (1 + trailDist / 100);
    } else {
      trailStopPrice = bestPrice * (1 - trailDist / 100);
    }
    console.log(`   Trail Stop:  $${trailStopPrice.toFixed(6)} (at HWM, ${trailDist}% dist)`);

    const exitVsTrail = ((t.exitPrice || 0) - trailStopPrice) / trailStopPrice * 100;
    console.log(`   Exit vs Trail: ${exitVsTrail >= 0 ? '+' : ''}${exitVsTrail.toFixed(3)}% diff`);
    console.log('');
  }

  const paperTrade = xrpTrades.find(t => t.session?.mode === 'paper');
  const liveTrade = xrpTrades.find(t => t.session?.mode === 'live');

  if (paperTrade && liveTrade) {
    console.log('─── PAPER vs LIVE COMPARISON ───\n');

    const paperPnl = (paperTrade.roiPct || 0) * (paperTrade.leverage || 5);
    const livePnl = (liveTrade.roiPct || 0) * (liveTrade.leverage || 5);
    const exitDiff = ((liveTrade.exitPrice || 0) - (paperTrade.exitPrice || 0));
    const exitDiffPct = exitDiff / (paperTrade.exitPrice || 1) * 100;

    console.log(`Paper Exit:     $${paperTrade.exitPrice?.toFixed(6)} → ${paperPnl.toFixed(2)}% lev PnL`);
    console.log(`Live Exit:      $${liveTrade.exitPrice?.toFixed(6)} → ${livePnl.toFixed(2)}% lev PnL`);
    console.log(`Exit Diff:      $${exitDiff.toFixed(6)} (${exitDiffPct.toFixed(3)}%)`);
    console.log(`PnL Diff:       ${(livePnl - paperPnl).toFixed(2)}%`);
    console.log(`\nFor SHORT: higher exit price = worse`);
    console.log(`Live exited ${exitDiffPct.toFixed(3)}% higher → ${(exitDiffPct * 5).toFixed(2)}% PnL loss`);

    // Captured ratio
    const paperCaptured = (paperTrade.roiPct || 0) / (paperTrade.maxPnlPct || 1) * 100;
    const liveCaptured = (liveTrade.roiPct || 0) / (liveTrade.maxPnlPct || 1) * 100;

    console.log(`\n─── CAPTURE EFFICIENCY ───\n`);
    console.log(`Paper captured: ${paperCaptured.toFixed(1)}% of max potential`);
    console.log(`Live captured:  ${liveCaptured.toFixed(1)}% of max potential`);
    console.log(`Paper missed:   ${((paperTrade.maxPnlPct || 0) - (paperTrade.roiPct || 0)) * 5}% lev PnL`);
    console.log(`Live missed:    ${((liveTrade.maxPnlPct || 0) - (liveTrade.roiPct || 0)) * 5}% lev PnL`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ROOT CAUSE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (liveTrade) {
    console.log(`Exit reason: ${liveTrade.exitReason}`);

    if (liveTrade.exitReason === 'TRAILING_NFS_HIGH_15M') {
      console.log(`\n⚡ NFS HIGH EXIT TRIGGERED`);
      console.log(`   This means NFS score was HIGH (>60) with immediate exit`);
      console.log(`   Paper: Uses theoretical trailing stop price`);
      console.log(`   Live: Uses MARKET ORDER at current price`);
      console.log(`\n🎯 WHY PROACTIVE LIMIT DIDN'T WORK:`);
      console.log(`   1. Maybe NFS didn't hit threshold (50) before breach`);
      console.log(`   2. Or price was too far from trailing (>0.3%) when HIGH`);
      console.log(`   3. Or the limit order was cancelled before fill`);
    }

    if (!liveTrade.exitReason?.includes('proactive')) {
      console.log(`\n❌ PROACTIVE LIMIT WAS NOT USED`);
      console.log(`   The trade exited via market order, not limit`);
      console.log(`   This caused slippage between paper and live`);
    }
  }
}

analyze().catch(console.error);
