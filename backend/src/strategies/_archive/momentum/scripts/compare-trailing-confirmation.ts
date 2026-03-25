/**
 * Compare Trailing Confirmation: 1 close vs 2 closes
 * 
 * Test si le passage de 2 closes (30min) à 1 close (15min) impacte significativement les résultats
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';

const SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'XRP/USDT:USDT',
  'ADA/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
];

const START_DATE = new Date('2025-01-01');
const END_DATE = new Date('2025-12-31');
const INITIAL_CAPITAL = 1000;
const LEVERAGE = 5;

interface ComparisonResult {
  symbol: string;
  closes1: {
    totalPnl: number;
    winRate: number;
    trades: number;
    avgPnl: number;
    trailExits: number;
  };
  closes2: {
    totalPnl: number;
    winRate: number;
    trades: number;
    avgPnl: number;
    trailExits: number;
  };
  diff: {
    pnlDiff: number;
    winRateDiff: number;
    tradesDiff: number;
  };
}

async function runComparison(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  TRAILING CONFIRMATION COMPARISON: 1 close vs 2 closes');
  console.log('  Period: 2025-01-01 to 2025-12-31');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  const results: ComparisonResult[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\n📊 Testing ${symbol}...`);
    
    try {
      // Test 1: 1 close confirmation (aligned with live/paper)
      console.log(`   → Running with 1 close confirmation...`);
      const result1 = await runBacktest({
        symbols: [symbol],
        startDate: START_DATE,
        endDate: END_DATE,
        initialCapital: INITIAL_CAPITAL,
        leverage: LEVERAGE,
        trailingConfirmCandles: 1,
      });

      // Test 2: 2 closes confirmation (previous backtest default)
      console.log(`   → Running with 2 closes confirmation...`);
      const result2 = await runBacktest({
        symbols: [symbol],
        startDate: START_DATE,
        endDate: END_DATE,
        initialCapital: INITIAL_CAPITAL,
        leverage: LEVERAGE,
        trailingConfirmCandles: 2,
      });

      const trailExits1 = result1.trades.filter(t => t.exitReason === 'TRAIL').length;
      const trailExits2 = result2.trades.filter(t => t.exitReason === 'TRAIL').length;

      const comparison: ComparisonResult = {
        symbol: symbol.replace('/USDT:USDT', ''),
        closes1: {
          totalPnl: result1.summary.totalPnlPct,
          winRate: result1.summary.winRate,
          trades: result1.summary.totalTrades,
          avgPnl: result1.summary.totalPnlPct / result1.summary.totalTrades,
          trailExits: trailExits1,
        },
        closes2: {
          totalPnl: result2.summary.totalPnlPct,
          winRate: result2.summary.winRate,
          trades: result2.summary.totalTrades,
          avgPnl: result2.summary.totalPnlPct / result2.summary.totalTrades,
          trailExits: trailExits2,
        },
        diff: {
          pnlDiff: result1.summary.totalPnlPct - result2.summary.totalPnlPct,
          winRateDiff: result1.summary.winRate - result2.summary.winRate,
          tradesDiff: result1.summary.totalTrades - result2.summary.totalTrades,
        },
      };

      results.push(comparison);

      // Print individual result
      const pnlIcon = comparison.diff.pnlDiff > 0 ? '🟢' : comparison.diff.pnlDiff < 0 ? '🔴' : '⚪';
      console.log(`   ${pnlIcon} ${symbol.replace('/USDT:USDT', '')}: 1-close=${comparison.closes1.totalPnl.toFixed(1)}% vs 2-close=${comparison.closes2.totalPnl.toFixed(1)}% (diff: ${comparison.diff.pnlDiff > 0 ? '+' : ''}${comparison.diff.pnlDiff.toFixed(1)}%)`);

    } catch (error: any) {
      console.error(`   ❌ Error testing ${symbol}: ${error.message}`);
    }
  }

  // Summary table
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY TABLE');
  console.log('═══════════════════════════════════════════════════════════════════\n');

  console.log('┌──────────┬────────────────────┬────────────────────┬──────────────┐');
  console.log('│  Symbol  │   1-Close (15min)  │   2-Close (30min)  │     Diff     │');
  console.log('├──────────┼────────────────────┼────────────────────┼──────────────┤');

  let total1ClosePnl = 0;
  let total2ClosePnl = 0;
  let total1CloseWinRate = 0;
  let total2CloseWinRate = 0;
  let total1CloseTrailExits = 0;
  let total2CloseTrailExits = 0;

  for (const r of results) {
    const pnl1 = `${r.closes1.totalPnl >= 0 ? '+' : ''}${r.closes1.totalPnl.toFixed(1)}% (${r.closes1.winRate.toFixed(0)}%)`;
    const pnl2 = `${r.closes2.totalPnl >= 0 ? '+' : ''}${r.closes2.totalPnl.toFixed(1)}% (${r.closes2.winRate.toFixed(0)}%)`;
    const diff = `${r.diff.pnlDiff >= 0 ? '+' : ''}${r.diff.pnlDiff.toFixed(1)}%`;
    const icon = r.diff.pnlDiff > 5 ? '🟢' : r.diff.pnlDiff < -5 ? '🔴' : '⚪';
    
    console.log(`│ ${r.symbol.padEnd(8)} │ ${pnl1.padEnd(18)} │ ${pnl2.padEnd(18)} │ ${icon} ${diff.padEnd(9)} │`);
    
    total1ClosePnl += r.closes1.totalPnl;
    total2ClosePnl += r.closes2.totalPnl;
    total1CloseWinRate += r.closes1.winRate;
    total2CloseWinRate += r.closes2.winRate;
    total1CloseTrailExits += r.closes1.trailExits;
    total2CloseTrailExits += r.closes2.trailExits;
  }

  console.log('├──────────┼────────────────────┼────────────────────┼──────────────┤');
  
  const avgPnl1 = total1ClosePnl / results.length;
  const avgPnl2 = total2ClosePnl / results.length;
  const avgDiff = avgPnl1 - avgPnl2;
  const avgIcon = avgDiff > 5 ? '🟢' : avgDiff < -5 ? '🔴' : '⚪';
  
  console.log(`│ AVERAGE  │ ${(avgPnl1 >= 0 ? '+' : '') + avgPnl1.toFixed(1) + '%'.padEnd(14)} │ ${(avgPnl2 >= 0 ? '+' : '') + avgPnl2.toFixed(1) + '%'.padEnd(14)} │ ${avgIcon} ${(avgDiff >= 0 ? '+' : '') + avgDiff.toFixed(1) + '%'.padEnd(8)} │`);
  console.log('└──────────┴────────────────────┴────────────────────┴──────────────┘');

  // Trail exits comparison
  console.log('\n📈 TRAILING EXITS COMPARISON:');
  console.log(`   1-Close: ${total1CloseTrailExits} trailing exits total`);
  console.log(`   2-Close: ${total2CloseTrailExits} trailing exits total`);
  console.log(`   Difference: ${total1CloseTrailExits - total2CloseTrailExits} more exits with 1-close`);

  // Conclusion
  console.log('\n═══════════════════════════════════════════════════════════════════');
  console.log('  CONCLUSION');
  console.log('═══════════════════════════════════════════════════════════════════');
  
  if (avgDiff > 5) {
    console.log('  🟢 1-Close (15min) is BETTER - should align backtest to 1 close');
  } else if (avgDiff < -5) {
    console.log('  🔴 2-Close (30min) is BETTER - keep backtest at 2 closes');
    console.log('     Consider enabling realtime trailing in live for parity');
  } else {
    console.log('  ⚪ MINIMAL DIFFERENCE - either setting works');
    console.log('     Recommend 1-close for simplicity (aligns with live/paper)');
  }
  console.log('═══════════════════════════════════════════════════════════════════\n');
}

// Run
runComparison().catch(console.error);
