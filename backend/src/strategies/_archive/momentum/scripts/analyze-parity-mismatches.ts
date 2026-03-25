/**
 * Analyze Parity Mismatches
 * =========================
 * Investigate trades where backtest exit reason differs from live,
 * specifically focusing on "END" exit reasons.
 */

import { prisma } from '../src/db/client.js';
import { verifyTrade } from '../src/services/parityVerificationService.js';
import { runBacktest } from '../src/services/backtestService.js';

interface MismatchAnalysis {
  tradeId: string;
  symbol: string;
  side: string;
  entryTs: Date;
  exitTs: Date;
  liveExitReason: string;
  btExitReason: string | null;
  livePnlPct: number;
  btPnlPct: number | null;
  pnlDiff: number | null;
  durationMinutes: number | null;
  analysis: string;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PARITY MISMATCH ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. Get all parity results with mismatches
  const parityResults = await prisma.tradeParityResult.findMany({
    where: {
      overallMatch: false,
    },
    orderBy: {
      verifiedAt: 'desc',
    },
    take: 50,
  });

  console.log(`Found ${parityResults.length} mismatched parity results\n`);

  // 2. Categorize mismatches by exit reason
  const endMismatches = parityResults.filter(p => p.btExitReason === 'END');
  const exitReasonMismatches = parityResults.filter(p =>
    p.btExitReason !== 'END' &&
    p.liveExitReason !== p.btExitReason &&
    p.btExitReason !== null
  );
  const pnlOnlyMismatches = parityResults.filter(p =>
    p.liveExitReason === p.btExitReason &&
    !p.pnlMatch
  );

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('MISMATCH CATEGORIES');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`  END exits (backtest ended early):    ${endMismatches.length}`);
  console.log(`  Exit reason mismatches:              ${exitReasonMismatches.length}`);
  console.log(`  PnL only mismatches (same reason):   ${pnlOnlyMismatches.length}`);
  console.log(`  Total:                               ${parityResults.length}\n`);

  // 3. Analyze END mismatches
  if (endMismatches.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('END EXIT MISMATCHES (Backtest ended before position closed)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const p of endMismatches.slice(0, 10)) {
      const trade = await prisma.trade.findUnique({ where: { id: p.tradeId } });
      if (!trade) continue;

      console.log(`Trade: ${p.symbol} ${p.side.toUpperCase()}`);
      console.log(`  Entry: ${p.liveEntryTs.toISOString()}`);
      console.log(`  Exit:  ${p.liveExitTs.toISOString()}`);
      console.log(`  Live Reason:  ${p.liveExitReason}`);
      console.log(`  BT Reason:    ${p.btExitReason}`);
      console.log(`  Live PnL:     ${p.livePnlPct?.toFixed(2)}%`);
      console.log(`  BT PnL:       ${p.btPnlPct?.toFixed(2) ?? 'N/A'}%`);
      console.log(`  Duration:     ${trade.durationMinutes} minutes`);
      console.log('');
    }
  }

  // 4. Analyze exit reason mismatches
  if (exitReasonMismatches.length > 0) {
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('EXIT REASON MISMATCHES (Different exit conditions triggered)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Group by reason pairs
    const reasonPairs = new Map<string, typeof exitReasonMismatches>();
    for (const p of exitReasonMismatches) {
      const key = `${p.liveExitReason} → ${p.btExitReason}`;
      if (!reasonPairs.has(key)) {
        reasonPairs.set(key, []);
      }
      reasonPairs.get(key)!.push(p);
    }

    console.log('Reason Pair Distribution:');
    for (const [key, items] of reasonPairs.entries()) {
      console.log(`  ${key}: ${items.length} trades`);
    }
    console.log('');

    // Show details of first few
    for (const p of exitReasonMismatches.slice(0, 5)) {
      const trade = await prisma.trade.findUnique({ where: { id: p.tradeId } });
      if (!trade) continue;

      console.log(`Trade: ${p.symbol} ${p.side.toUpperCase()}`);
      console.log(`  Entry: ${p.liveEntryTs.toISOString()}`);
      console.log(`  Exit:  ${p.liveExitTs.toISOString()}`);
      console.log(`  Live Reason:  ${p.liveExitReason}`);
      console.log(`  BT Reason:    ${p.btExitReason}`);
      console.log(`  Live PnL:     ${p.livePnlPct?.toFixed(2)}%`);
      console.log(`  BT PnL:       ${p.btPnlPct?.toFixed(2) ?? 'N/A'}%`);
      console.log(`  PnL Diff:     ${((p.livePnlPct || 0) - (p.btPnlPct || 0)).toFixed(2)}%`);
      console.log('');
    }
  }

  // 5. Get recent trades for detailed analysis
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('RECENT TRADES (Last 30 days)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentTrades = await prisma.trade.findMany({
    where: {
      exitTs: { gte: thirtyDaysAgo },
    },
    orderBy: { exitTs: 'desc' },
    take: 20,
  });

  console.log(`Found ${recentTrades.length} recent trades\n`);

  // Group by exit reason
  const reasonCounts = new Map<string, number>();
  for (const t of recentTrades) {
    const reason = t.exitReason || 'UNKNOWN';
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }

  console.log('Exit Reason Distribution:');
  for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const pct = ((count / recentTrades.length) * 100).toFixed(1);
    console.log(`  ${reason.padEnd(25)} ${count.toString().padStart(3)} (${pct}%)`);
  }

  // 6. Show last 5 trades in detail
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('LAST 5 TRADES - DETAILED');
  console.log('═══════════════════════════════════════════════════════════════\n');

  for (const trade of recentTrades.slice(0, 5)) {
    const parityResult = await prisma.tradeParityResult.findUnique({
      where: { tradeId: trade.id },
    });

    console.log(`[${trade.symbol}] ${trade.positionSide.toUpperCase()} | ${trade.exitReason}`);
    console.log(`  Entry:    ${trade.entryTs.toISOString()} @ $${trade.entryPrice.toFixed(4)}`);
    console.log(`  Exit:     ${trade.exitTs.toISOString()} @ $${trade.exitPrice.toFixed(4)}`);
    console.log(`  Duration: ${trade.durationMinutes} min | MaxPnL: ${trade.maxPnlPct?.toFixed(2)}%`);
    console.log(`  PnL:      ${trade.roiPct && trade.roiPct >= 0 ? '+' : ''}${trade.roiPct?.toFixed(2)}% ($${trade.realizedPnlUsd.toFixed(2)})`);

    if (parityResult) {
      const matchIcon = parityResult.overallMatch ? '✅' : '❌';
      console.log(`  Parity:   ${matchIcon} BT=${parityResult.btExitReason} (${parityResult.btPnlPct?.toFixed(2)}%)`);
      if (!parityResult.overallMatch) {
        console.log(`  Mismatch: ${parityResult.mismatchDetails || 'N/A'}`);
      }
    } else {
      console.log(`  Parity:   ⚠️ Not verified`);
    }
    console.log('');
  }

  // 7. Analysis summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ANALYSIS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Calculate match rates
  const allParityResults = await prisma.tradeParityResult.findMany({
    where: {
      verifiedAt: { gte: thirtyDaysAgo },
    },
  });

  const matchedCount = allParityResults.filter(p => p.overallMatch).length;
  const totalVerified = allParityResults.length;
  const matchRate = totalVerified > 0 ? (matchedCount / totalVerified * 100) : 0;

  console.log(`Total Verified Trades:    ${totalVerified}`);
  console.log(`Matched:                  ${matchedCount} (${matchRate.toFixed(1)}%)`);
  console.log(`Mismatched:               ${totalVerified - matchedCount} (${(100 - matchRate).toFixed(1)}%)`);

  // Key insights
  console.log('\n--- Key Insights ---\n');

  if (endMismatches.length > 0) {
    console.log(`⚠️ ${endMismatches.length} trades have END mismatch - backtest data window too short`);
  }

  const trailMismatches = parityResults.filter(p =>
    (p.liveExitReason === 'TRAIL' && p.btExitReason !== 'TRAIL') ||
    (p.liveExitReason !== 'TRAIL' && p.btExitReason === 'TRAIL')
  );
  if (trailMismatches.length > 0) {
    console.log(`⚠️ ${trailMismatches.length} trades have TRAILING mismatch - timing/detection difference`);
  }

  const slMismatches = parityResults.filter(p =>
    (p.liveExitReason === 'SL' && p.btExitReason !== 'SL') ||
    (p.liveExitReason !== 'SL' && p.btExitReason === 'SL')
  );
  if (slMismatches.length > 0) {
    console.log(`⚠️ ${slMismatches.length} trades have STOPLOSS mismatch - SL detection difference`);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ANALYSIS COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');

}

main().catch(console.error);
