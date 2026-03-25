/**
 * Test NFS_ADAPTIVE trailing exit in official backtest
 *
 * Compares results with and without NFS_ADAPTIVE enabled
 */

import { runBacktest } from '../src/services/backtestService.js';

async function main() {
  console.log('='.repeat(100));
  console.log('NFS_ADAPTIVE BACKTEST COMPARISON');
  console.log('='.repeat(100));

  const startDate = new Date('2025-10-01T00:00:00Z');
  const endDate = new Date('2026-01-01T00:00:00Z');
  const symbols = ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'];
  const leverage = 4.5;
  const initialCapital = 2000;

  console.log(`\nBacktest period: ${startDate.toISOString().slice(0, 10)} to ${endDate.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Leverage: ${leverage}x`);
  console.log(`Initial capital: $${initialCapital}`);

  // Run with standard exit (V5.61 - candle close with 2-candle confirm)
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

  const standardTrailTrades = standardResult.trades.filter(t => t.exitReason === 'TRAIL');
  const standardWins = standardTrailTrades.filter(t => t.netPnlPct > 0);
  const standardAvgPnl = standardTrailTrades.length > 0
    ? standardTrailTrades.reduce((s, t) => s + t.netPnlPct, 0) / standardTrailTrades.length
    : 0;

  console.log(`\nResults:`);
  console.log(`  Total trades: ${standardResult.trades.length}`);
  console.log(`  TRAIL trades: ${standardTrailTrades.length}`);
  console.log(`  TRAIL win rate: ${(standardWins.length / standardTrailTrades.length * 100).toFixed(1)}%`);
  console.log(`  TRAIL avg PnL: ${standardAvgPnl.toFixed(2)}%`);
  console.log(`  Total ROI: ${standardResult.summary.totalPnlPct.toFixed(2)}%`);
  console.log(`  Final capital: $${standardResult.summary.finalCapital.toFixed(2)}`);

  // Run with NFS_ADAPTIVE exit
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

  const nfsTrailTrades = nfsResult.trades.filter(t =>
    t.exitReason.startsWith('TRAIL')
  );
  const nfsHighTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_HIGH');
  const nfsMedTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_MED');
  const nfsLowTrades = nfsResult.trades.filter(t => t.exitReason === 'TRAIL_NFS_LOW');
  const nfsWins = nfsTrailTrades.filter(t => t.netPnlPct > 0);
  const nfsAvgPnl = nfsTrailTrades.length > 0
    ? nfsTrailTrades.reduce((s, t) => s + t.netPnlPct, 0) / nfsTrailTrades.length
    : 0;

  console.log(`\nResults:`);
  console.log(`  Total trades: ${nfsResult.trades.length}`);
  console.log(`  TRAIL trades: ${nfsTrailTrades.length}`);
  console.log(`    - HIGH confidence: ${nfsHighTrades.length} (exit at trailing stop)`);
  console.log(`    - MEDIUM confidence: ${nfsMedTrades.length} (1-candle, close)`);
  console.log(`    - LOW confidence: ${nfsLowTrades.length} (2-candle, close)`);
  console.log(`  TRAIL win rate: ${(nfsWins.length / nfsTrailTrades.length * 100).toFixed(1)}%`);
  console.log(`  TRAIL avg PnL: ${nfsAvgPnl.toFixed(2)}%`);
  console.log(`  Total ROI: ${nfsResult.summary.totalPnlPct.toFixed(2)}%`);
  console.log(`  Final capital: $${nfsResult.summary.finalCapital.toFixed(2)}`);

  // NFS breakdown
  if (nfsHighTrades.length > 0) {
    const highAvgPnl = nfsHighTrades.reduce((s, t) => s + t.netPnlPct, 0) / nfsHighTrades.length;
    const highWins = nfsHighTrades.filter(t => t.netPnlPct > 0);
    console.log(`\n  HIGH confidence breakdown:`);
    console.log(`    Win rate: ${(highWins.length / nfsHighTrades.length * 100).toFixed(1)}%`);
    console.log(`    Avg PnL: ${highAvgPnl.toFixed(2)}%`);
  }
  if (nfsMedTrades.length > 0) {
    const medAvgPnl = nfsMedTrades.reduce((s, t) => s + t.netPnlPct, 0) / nfsMedTrades.length;
    const medWins = nfsMedTrades.filter(t => t.netPnlPct > 0);
    console.log(`\n  MEDIUM confidence breakdown:`);
    console.log(`    Win rate: ${(medWins.length / nfsMedTrades.length * 100).toFixed(1)}%`);
    console.log(`    Avg PnL: ${medAvgPnl.toFixed(2)}%`);
  }
  if (nfsLowTrades.length > 0) {
    const lowAvgPnl = nfsLowTrades.reduce((s, t) => s + t.netPnlPct, 0) / nfsLowTrades.length;
    const lowWins = nfsLowTrades.filter(t => t.netPnlPct > 0);
    console.log(`\n  LOW confidence breakdown:`);
    console.log(`    Win rate: ${(lowWins.length / nfsLowTrades.length * 100).toFixed(1)}%`);
    console.log(`    Avg PnL: ${lowAvgPnl.toFixed(2)}%`);
  }

  // Comparison
  console.log('\n' + '='.repeat(100));
  console.log('COMPARISON: NFS_ADAPTIVE vs STANDARD');
  console.log('='.repeat(100));

  const roiDiff = nfsResult.summary.totalPnlPct - standardResult.summary.totalPnlPct;
  const winRateDiff = (nfsWins.length / nfsTrailTrades.length - standardWins.length / standardTrailTrades.length) * 100;
  const avgPnlDiff = nfsAvgPnl - standardAvgPnl;

  console.log(`\n  ROI change:        ${roiDiff >= 0 ? '+' : ''}${roiDiff.toFixed(2)}%`);
  console.log(`  Win rate change:   ${winRateDiff >= 0 ? '+' : ''}${winRateDiff.toFixed(1)}pp`);
  console.log(`  Avg PnL change:    ${avgPnlDiff >= 0 ? '+' : ''}${avgPnlDiff.toFixed(2)}%`);

  if (roiDiff > 0) {
    console.log(`\n  ✅ NFS_ADAPTIVE improves ROI by ${roiDiff.toFixed(2)}%`);
  } else if (roiDiff < 0) {
    console.log(`\n  ⚠️ NFS_ADAPTIVE reduces ROI by ${Math.abs(roiDiff).toFixed(2)}%`);
  }

  // Sample trades comparison
  console.log('\n' + '='.repeat(100));
  console.log('SAMPLE TRAIL TRADES (NFS_ADAPTIVE)');
  console.log('='.repeat(100));

  for (const trade of nfsTrailTrades.slice(0, 10)) {
    console.log(`\n${trade.symbol} ${trade.side.toUpperCase()} @ ${trade.entryTime.slice(0, 16)}`);
    console.log(`  Entry: $${trade.entryPrice.toFixed(4)}`);
    console.log(`  Exit:  $${trade.exitPrice.toFixed(4)} (${trade.exitReason})`);
    console.log(`  PnL:   ${trade.netPnlPct >= 0 ? '+' : ''}${trade.netPnlPct.toFixed(2)}%`);
  }
}

main().catch(console.error);
