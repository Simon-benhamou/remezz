/**
 * Test NFS_ADAPTIVE on 12-month backtest
 */

import { runBacktest } from '../src/services/backtestService.js';

async function main() {
  console.log('='.repeat(100));
  console.log('12-MONTH NFS_ADAPTIVE COMPARISON');
  console.log('='.repeat(100));

  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date('2026-01-01T00:00:00Z');
  const symbols = ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'];
  const leverage = 4.5;
  const initialCapital = 2000;

  console.log(`\nBacktest period: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Leverage: ${leverage}x`);
  console.log(`Initial capital: $${initialCapital}`);

  // Test 1: Standard exit (V5.61)
  console.log('\n' + '='.repeat(80));
  console.log('TEST 1: STANDARD EXIT (candle close, 2-candle confirm)');
  console.log('='.repeat(80));

  const standardResult = await runBacktest({
    startDate,
    endDate,
    initialCapital,
    symbols,
    leverage,
    nfsAdaptiveTrailing: false,
  });

  console.log(`\n  Total trades: ${standardResult.summary.totalTrades}`);
  console.log(`  Win rate: ${standardResult.summary.winRate.toFixed(1)}%`);
  console.log(`  Total ROI: ${standardResult.summary.totalPnlPct.toFixed(2)}%`);
  console.log(`  Max Drawdown: ${standardResult.summary.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Sharpe: ${standardResult.summary.sharpeRatio.toFixed(2)}`);
  console.log(`  Final capital: $${standardResult.summary.finalCapital.toFixed(2)}`);

  // Test 2: NFS_ADAPTIVE exit
  console.log('\n' + '='.repeat(80));
  console.log('TEST 2: NFS_ADAPTIVE EXIT');
  console.log('='.repeat(80));

  const nfsResult = await runBacktest({
    startDate,
    endDate,
    initialCapital,
    symbols,
    leverage,
    nfsAdaptiveTrailing: true,
  });

  const nfsTrailTrades = nfsResult.trades.filter(t => t.exitReason.startsWith('TRAIL'));
  const nfsHighTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_HIGH');
  const nfsMedTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_MED');
  const nfsLowTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_LOW');

  console.log(`\n  Total trades: ${nfsResult.summary.totalTrades}`);
  console.log(`  Win rate: ${nfsResult.summary.winRate.toFixed(1)}%`);
  console.log(`  Total ROI: ${nfsResult.summary.totalPnlPct.toFixed(2)}%`);
  console.log(`  Max Drawdown: ${nfsResult.summary.maxDrawdownPct.toFixed(2)}%`);
  console.log(`  Sharpe: ${nfsResult.summary.sharpeRatio.toFixed(2)}`);
  console.log(`  Final capital: $${nfsResult.summary.finalCapital.toFixed(2)}`);

  console.log(`\n  TRAIL exits breakdown:`);
  console.log(`    - HIGH confidence: ${nfsHighTrades.length} (exit at trailing stop)`);
  console.log(`    - MEDIUM confidence: ${nfsMedTrades.length} (1-candle, close)`);
  console.log(`    - LOW confidence: ${nfsLowTrades.length} (2-candle, close)`);

  // Comparison
  console.log('\n' + '='.repeat(100));
  console.log('COMPARISON: NFS_ADAPTIVE vs STANDARD');
  console.log('='.repeat(100));

  const roiDiff = nfsResult.summary.totalPnlPct - standardResult.summary.totalPnlPct;
  const wrDiff = nfsResult.summary.winRate - standardResult.summary.winRate;
  const ddDiff = nfsResult.summary.maxDrawdownPct - standardResult.summary.maxDrawdownPct;
  const sharpeDiff = nfsResult.summary.sharpeRatio - standardResult.summary.sharpeRatio;

  console.log(`\n  ROI change:        ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
  console.log(`  Win rate change:   ${wrDiff >= 0 ? '+' : ''}${wrDiff.toFixed(1)}pp`);
  console.log(`  Max DD change:     ${ddDiff >= 0 ? '+' : ''}${ddDiff.toFixed(2)}% (${ddDiff < 0 ? 'improved' : 'worse'})`);
  console.log(`  Sharpe change:     ${sharpeDiff >= 0 ? '+' : ''}${sharpeDiff.toFixed(2)}`);

  if (roiDiff > 0) {
    console.log(`\n  ✅ NFS_ADAPTIVE improves 12-month ROI by ${roiDiff.toFixed(2)}%`);
    console.log(`     From $${standardResult.summary.finalCapital.toFixed(2)} to $${nfsResult.summary.finalCapital.toFixed(2)}`);
  }

  // Monthly breakdown
  console.log('\n' + '='.repeat(100));
  console.log('MONTHLY COMPARISON');
  console.log('='.repeat(100));

  console.log('\n' + '-'.repeat(80));
  console.log('Month'.padEnd(10) + '| Standard ROI'.padEnd(18) + '| NFS ROI'.padEnd(18) + '| Difference');
  console.log('-'.repeat(80));

  for (let i = 0; i < standardResult.monthlyStats.length; i++) {
    const stdMonth = standardResult.monthlyStats[i];
    const nfsMonth = nfsResult.monthlyStats.find(m => m.month === stdMonth.month);
    if (nfsMonth) {
      const diff = nfsMonth.netPnlPct - stdMonth.netPnlPct;
      console.log(
        stdMonth.month.padEnd(10) +
        `| ${stdMonth.netPnlPct >= 0 ? '+' : ''}${stdMonth.netPnlPct.toFixed(2)}%`.padEnd(18) +
        `| ${nfsMonth.netPnlPct >= 0 ? '+' : ''}${nfsMonth.netPnlPct.toFixed(2)}%`.padEnd(18) +
        `| ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}%`
      );
    }
  }
}

main().catch(console.error);
