/**
 * Check PnL variance between live and backtest
 */

import { prisma } from '../src/db/client.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PnL VARIANCE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Get all parity results
  const results = await prisma.tradeParityResult.findMany({
    orderBy: { verifiedAt: 'desc' },
  });

  console.log(`Total results: ${results.length}\n`);

  // Analyze variance
  const variances: { symbol: string; livePnl: number; btPnl: number; diff: number; liveReason: string; btReason: string }[] = [];

  for (const r of results) {
    if (r.livePnlPct !== null && r.btPnlPct !== null) {
      const diff = Math.abs(r.livePnlPct - r.btPnlPct);
      variances.push({
        symbol: r.symbol,
        livePnl: r.livePnlPct,
        btPnl: r.btPnlPct,
        diff,
        liveReason: r.liveExitReason || 'N/A',
        btReason: r.btExitReason || 'N/A',
      });
    }
  }

  // Sort by variance (descending)
  variances.sort((a, b) => b.diff - a.diff);

  console.log('TOP 15 PnL VARIANCES:');
  console.log('─────────────────────────────────────────────────────────────────');
  console.log('Symbol              | Live PnL  | BT PnL    | Diff    | Exit Reason');
  console.log('─────────────────────────────────────────────────────────────────');

  for (const v of variances.slice(0, 15)) {
    const liveStr = (v.livePnl >= 0 ? '+' : '') + v.livePnl.toFixed(2) + '%';
    const btStr = (v.btPnl >= 0 ? '+' : '') + v.btPnl.toFixed(2) + '%';
    console.log(
      `${v.symbol.replace('/USDT:USDT', '').padEnd(18)} | ${liveStr.padStart(9)} | ${btStr.padStart(9)} | ${v.diff.toFixed(2).padStart(6)}% | ${v.liveReason} vs ${v.btReason}`
    );
  }

  // Statistics
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('STATISTICS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const avgDiff = variances.reduce((sum, v) => sum + v.diff, 0) / variances.length;
  const medianDiff = variances[Math.floor(variances.length / 2)]?.diff || 0;
  const maxDiff = variances[0]?.diff || 0;
  const minDiff = variances[variances.length - 1]?.diff || 0;

  console.log(`Average PnL difference: ${avgDiff.toFixed(2)}%`);
  console.log(`Median PnL difference:  ${medianDiff.toFixed(2)}%`);
  console.log(`Max difference:         ${maxDiff.toFixed(2)}%`);
  console.log(`Min difference:         ${minDiff.toFixed(2)}%`);

  // Group by reason mismatch
  const reasonMatches = variances.filter(v => v.liveReason === v.btReason);
  const reasonMismatches = variances.filter(v => v.liveReason !== v.btReason);

  console.log(`\nSame exit reason:      ${reasonMatches.length} trades (avg diff: ${(reasonMatches.reduce((s, v) => s + v.diff, 0) / reasonMatches.length || 0).toFixed(2)}%)`);
  console.log(`Different exit reason: ${reasonMismatches.length} trades (avg diff: ${(reasonMismatches.reduce((s, v) => s + v.diff, 0) / reasonMismatches.length || 0).toFixed(2)}%)`);

  // Check if live consistently underperforms
  const liveWorse = variances.filter(v => v.livePnl < v.btPnl);
  const liveBetter = variances.filter(v => v.livePnl >= v.btPnl);

  console.log(`\nLive worse than BT:    ${liveWorse.length} trades (${(liveWorse.length / variances.length * 100).toFixed(1)}%)`);
  console.log(`Live equal/better:     ${liveBetter.length} trades (${(liveBetter.length / variances.length * 100).toFixed(1)}%)`);

  await prisma.$disconnect();
}

main().catch(console.error);
