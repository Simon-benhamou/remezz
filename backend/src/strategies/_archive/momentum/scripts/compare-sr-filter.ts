/**
 * V5.96 S/R Proximity Filter: Backtest Comparison
 * ================================================
 * Runs backtest WITH and WITHOUT the S/R filter to measure impact.
 * Period: Full 2024-2025 (24 months) for statistical significance.
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

const SYMBOLS = [
  'BTC/USDT:USDT',
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
  'DOT/USDT:USDT',
  'TIA/USDT:USDT',
  'IMX/USDT:USDT',
  'STX/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2024-06-01T00:00:00Z'),
  endDate: new Date('2025-12-31T23:59:59Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

function printSummary(label: string, r: BacktestResult) {
  const s = r.summary;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total Trades:     ${s.totalTrades}`);
  console.log(`  Wins / Losses:    ${s.wins} / ${s.losses}`);
  console.log(`  Win Rate:         ${s.winRate.toFixed(1)}%`);
  console.log(`  ROI:              ${s.totalPnlPct.toFixed(2)}%`);
  console.log(`  Final Capital:    $${s.finalCapital.toFixed(2)}`);
  console.log(`  Sharpe Ratio:     ${s.sharpeRatio.toFixed(2)}`);
  console.log(`  Profit Factor:    ${s.profitFactor.toFixed(2)}`);
  console.log(`  Max Drawdown:     ${s.maxDrawdownPct.toFixed(2)}%`);

  // Per-direction breakdown
  const longTrades = r.trades.filter(t => t.side === 'long');
  const shortTrades = r.trades.filter(t => t.side === 'short');

  const longWins = longTrades.filter(t => t.netPnlPct > 0).length;
  const shortWins = shortTrades.filter(t => t.netPnlPct > 0).length;
  const longWR = longTrades.length > 0 ? (longWins / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortWins / shortTrades.length * 100) : 0;
  const longAvgPnl = longTrades.length > 0 ? longTrades.reduce((s, t) => s + t.netPnlPct, 0) / longTrades.length : 0;
  const shortAvgPnl = shortTrades.length > 0 ? shortTrades.reduce((s, t) => s + t.netPnlPct, 0) / shortTrades.length : 0;

  console.log(`\n  --- By Direction ---`);
  console.log(`  LONG:   ${longTrades.length} trades | WR: ${longWR.toFixed(1)}% | Avg PnL: ${longAvgPnl >= 0 ? '+' : ''}${longAvgPnl.toFixed(2)}%`);
  console.log(`  SHORT:  ${shortTrades.length} trades | WR: ${shortWR.toFixed(1)}% | Avg PnL: ${shortAvgPnl >= 0 ? '+' : ''}${shortAvgPnl.toFixed(2)}%`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     V5.96 S/R PROXIMITY FILTER: BACKTEST COMPARISON                ║');
  console.log('║     Period: Jun 2024 - Dec 2025 (18 months)                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nSymbols: ${SYMBOLS.length}`);
  console.log(`Capital: $${PARAMS.initialCapital} | Leverage: ${PARAMS.leverage}x`);

  // Preload markets (try API first, fallback to minimal)
  console.log('\n🔄 Preloading markets...');
  let ok = false;
  try {
    ok = await preloadMarkets();
  } catch {
    ok = false;
  }
  if (!ok) {
    console.log('   API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('   Markets ready.\n');

  // ---- RUN 1: WITH S/R FILTER (V5.96) ----
  console.log('\n\n🔄 Running backtest WITH S/R filter (V5.96)...');
  const t1 = Date.now();
  const resultWith = await runBacktest(PARAMS);
  console.log(`   Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  // ---- RUN 2: WITHOUT S/R FILTER (BASELINE) ----
  console.log('\n🔄 Running backtest WITHOUT S/R filter (baseline)...');
  const origEnabled = MomentumConfig.SR_PROXIMITY_FILTER.ENABLED;
  (MomentumConfig as any).SR_PROXIMITY_FILTER.ENABLED = false;

  const t2 = Date.now();
  const resultWithout = await runBacktest(PARAMS);
  console.log(`   Done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  // Restore
  (MomentumConfig as any).SR_PROXIMITY_FILTER.ENABLED = origEnabled;

  // ---- PRINT RESULTS ----
  printSummary('BASELINE (No S/R Filter)', resultWithout);
  printSummary('V5.96 (With S/R Filter)', resultWith);

  // ---- COMPARISON ----
  const sW = resultWith.summary;
  const sB = resultWithout.summary;

  console.log(`\n\n${'═'.repeat(70)}`);
  console.log(`  COMPARISON: V5.96 vs BASELINE`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`                         BASELINE       V5.96        DELTA`);
  console.log(`  Trades:           ${sB.totalTrades.toString().padStart(10)}  ${sW.totalTrades.toString().padStart(10)}  ${(sW.totalTrades - sB.totalTrades).toString().padStart(10)}`);
  console.log(`  Win Rate:         ${sB.winRate.toFixed(1).padStart(9)}%  ${sW.winRate.toFixed(1).padStart(9)}%  ${(sW.winRate - sB.winRate) >= 0 ? '+' : ''}${(sW.winRate - sB.winRate).toFixed(1).padStart(8)}pp`);
  console.log(`  ROI:              ${sB.totalPnlPct.toFixed(2).padStart(9)}%  ${sW.totalPnlPct.toFixed(2).padStart(9)}%  ${(sW.totalPnlPct - sB.totalPnlPct) >= 0 ? '+' : ''}${(sW.totalPnlPct - sB.totalPnlPct).toFixed(2).padStart(8)}%`);
  console.log(`  Sharpe:           ${sB.sharpeRatio.toFixed(2).padStart(10)}  ${sW.sharpeRatio.toFixed(2).padStart(10)}  ${(sW.sharpeRatio - sB.sharpeRatio) >= 0 ? '+' : ''}${(sW.sharpeRatio - sB.sharpeRatio).toFixed(2).padStart(10)}`);
  console.log(`  Profit Factor:    ${sB.profitFactor.toFixed(2).padStart(10)}  ${sW.profitFactor.toFixed(2).padStart(10)}  ${(sW.profitFactor - sB.profitFactor) >= 0 ? '+' : ''}${(sW.profitFactor - sB.profitFactor).toFixed(2).padStart(10)}`);
  console.log(`  Max DD:           ${sB.maxDrawdownPct.toFixed(2).padStart(9)}%  ${sW.maxDrawdownPct.toFixed(2).padStart(9)}%  ${(sW.maxDrawdownPct - sB.maxDrawdownPct) >= 0 ? '+' : ''}${(sW.maxDrawdownPct - sB.maxDrawdownPct).toFixed(2).padStart(8)}%`);
  console.log(`  Final Capital:    $${sB.finalCapital.toFixed(0).padStart(9)}  $${sW.finalCapital.toFixed(0).padStart(9)}  $${(sW.finalCapital - sB.finalCapital) >= 0 ? '+' : ''}${(sW.finalCapital - sB.finalCapital).toFixed(0).padStart(8)}`);

  // Per-direction delta
  const longW = resultWith.trades.filter(t => t.side === 'long');
  const longB = resultWithout.trades.filter(t => t.side === 'long');
  const shortW = resultWith.trades.filter(t => t.side === 'short');
  const shortB = resultWithout.trades.filter(t => t.side === 'short');

  const longWR_W = longW.length > 0 ? longW.filter(t => t.netPnlPct > 0).length / longW.length * 100 : 0;
  const longWR_B = longB.length > 0 ? longB.filter(t => t.netPnlPct > 0).length / longB.length * 100 : 0;
  const shortWR_W = shortW.length > 0 ? shortW.filter(t => t.netPnlPct > 0).length / shortW.length * 100 : 0;
  const shortWR_B = shortB.length > 0 ? shortB.filter(t => t.netPnlPct > 0).length / shortB.length * 100 : 0;

  console.log(`\n  --- Direction Breakdown ---`);
  console.log(`  LONG  trades:     ${longB.length.toString().padStart(10)}  ${longW.length.toString().padStart(10)}  ${(longW.length - longB.length).toString().padStart(10)}`);
  console.log(`  LONG  WR:         ${longWR_B.toFixed(1).padStart(9)}%  ${longWR_W.toFixed(1).padStart(9)}%  ${(longWR_W - longWR_B) >= 0 ? '+' : ''}${(longWR_W - longWR_B).toFixed(1).padStart(8)}pp`);
  console.log(`  SHORT trades:     ${shortB.length.toString().padStart(10)}  ${shortW.length.toString().padStart(10)}  ${(shortW.length - shortB.length).toString().padStart(10)}`);
  console.log(`  SHORT WR:         ${shortWR_B.toFixed(1).padStart(9)}%  ${shortWR_W.toFixed(1).padStart(9)}%  ${(shortWR_W - shortWR_B) >= 0 ? '+' : ''}${(shortWR_W - shortWR_B).toFixed(1).padStart(8)}pp`);

  // Filtered trades analysis
  const filteredCount = sB.totalTrades - sW.totalTrades;
  console.log(`\n  --- Filter Impact ---`);
  console.log(`  Trades filtered out: ${filteredCount}`);
  if (filteredCount > 0) {
    console.log(`  Filter removes ${((filteredCount / sB.totalTrades) * 100).toFixed(1)}% of trades`);
  }
  console.log(`  Net effect on ROI: ${(sW.totalPnlPct - sB.totalPnlPct) >= 0 ? '+' : ''}${(sW.totalPnlPct - sB.totalPnlPct).toFixed(2)}%`);

  // Per-trade quality
  const avgPnlWith = sW.totalTrades > 0 ? sW.totalPnlPct / sW.totalTrades : 0;
  const avgPnlBase = sB.totalTrades > 0 ? sB.totalPnlPct / sB.totalTrades : 0;
  console.log(`\n  --- Per-Trade Quality ---`);
  console.log(`  Avg PnL/trade:    ${avgPnlBase.toFixed(3).padStart(9)}%  ${avgPnlWith.toFixed(3).padStart(9)}%  ${(avgPnlWith - avgPnlBase) >= 0 ? '+' : ''}${(avgPnlWith - avgPnlBase).toFixed(3).padStart(8)}%`);
  console.log(`  Avg PnL/trade (LONG):  base=${longB.length > 0 ? (longB.reduce((s,t)=>s+t.netPnlPct,0)/longB.length).toFixed(3) : 'N/A'}%  v5.96=${longW.length > 0 ? (longW.reduce((s,t)=>s+t.netPnlPct,0)/longW.length).toFixed(3) : 'N/A'}%`);
  console.log(`  Avg PnL/trade (SHORT): base=${shortB.length > 0 ? (shortB.reduce((s,t)=>s+t.netPnlPct,0)/shortB.length).toFixed(3) : 'N/A'}%  v5.96=${shortW.length > 0 ? (shortW.reduce((s,t)=>s+t.netPnlPct,0)/shortW.length).toFixed(3) : 'N/A'}%`);

  const verdict = sW.totalPnlPct > sB.totalPnlPct && sW.winRate >= sB.winRate
    ? '✅ S/R FILTER IMPROVES BOTH ROI AND WIN RATE'
    : sW.totalPnlPct > sB.totalPnlPct
    ? '✅ S/R FILTER IMPROVES ROI (Win rate trade-off acceptable)'
    : sW.winRate > sB.winRate
    ? '⚠️  S/R FILTER IMPROVES WIN RATE but ROI decreased'
    : '❌ S/R FILTER UNDERPERFORMS BASELINE';

  console.log(`\n  VERDICT: ${verdict}`);
  console.log(`\n${'═'.repeat(70)}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
