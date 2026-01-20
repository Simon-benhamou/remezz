/**
 * Check backtest exit realism - analyze proportion of NFS exit types
 * and estimate slippage impact on HIGH confidence exits
 */

import { runBacktest } from '../src/services/backtestService.js';

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT',
  'DOGE/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT',
];

async function analyze() {
  console.log('='.repeat(70));
  console.log('BACKTEST EXIT REALISM ANALYSIS');
  console.log('='.repeat(70));
  console.log('');

  const result = await runBacktest({
    symbols: SYMBOLS,
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-12-31'),
    initialCapital: 10000,
    leverage: 5,
  });

  const trades = result.trades;

  // Count exit reasons
  const exitCounts: Record<string, number> = {};
  const exitPnl: Record<string, number> = {};

  for (const trade of trades) {
    const reason = trade.exitReason || 'UNKNOWN';
    exitCounts[reason] = (exitCounts[reason] || 0) + 1;
    exitPnl[reason] = (exitPnl[reason] || 0) + trade.netPnlUsd;
  }

  console.log('EXIT REASON BREAKDOWN:');
  console.log('-'.repeat(70));
  console.log('Reason                    | Count |   %   |   PnL USD   | Avg PnL');
  console.log('-'.repeat(70));

  const sortedReasons = Object.entries(exitCounts).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    const pct = (count / trades.length * 100).toFixed(1);
    const pnl = exitPnl[reason];
    const avgPnl = pnl / count;
    console.log(
      `${reason.padEnd(25)} | ${count.toString().padStart(5)} | ${pct.padStart(5)}% | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(0).padStart(10)} | ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}`
    );
  }

  console.log('-'.repeat(70));
  console.log(`TOTAL                     | ${trades.length.toString().padStart(5)} | 100.0%`);
  console.log('');

  // Analyze HIGH confidence exits specifically
  const highExits = trades.filter(t => t.exitReason?.includes('NFS_HIGH'));
  const medExits = trades.filter(t => t.exitReason?.includes('NFS_MED'));
  const lowExits = trades.filter(t => t.exitReason?.includes('NFS_LOW'));

  console.log('='.repeat(70));
  console.log('NFS ADAPTIVE BREAKDOWN:');
  console.log('='.repeat(70));
  console.log('');
  console.log(`HIGH confidence (optimistic exit): ${highExits.length} trades (${(highExits.length/trades.length*100).toFixed(1)}%)`);
  console.log(`MEDIUM confidence (realistic):     ${medExits.length} trades (${(medExits.length/trades.length*100).toFixed(1)}%)`);
  console.log(`LOW confidence (conservative):     ${lowExits.length} trades (${(lowExits.length/trades.length*100).toFixed(1)}%)`);
  console.log('');

  // Estimate impact of additional slippage on HIGH exits
  const additionalSlippagePct = 0.10; // 0.1% additional slippage on HIGH exits
  let highPnlReduction = 0;

  for (const trade of highExits) {
    // Estimate notional from margin and leverage (approximate)
    const estimatedNotional = trade.marginUsd * trade.leverage;
    const slippageCost = estimatedNotional * (additionalSlippagePct / 100);
    highPnlReduction += slippageCost;
  }

  console.log('='.repeat(70));
  console.log('SLIPPAGE IMPACT ESTIMATE:');
  console.log('='.repeat(70));
  console.log('');
  console.log(`If HIGH confidence exits had +${additionalSlippagePct}% extra slippage (realistic):`);
  console.log(`  Additional cost: -$${highPnlReduction.toFixed(2)}`);
  console.log(`  Current PnL:     +$${result.summary.totalPnlUsd.toFixed(2)}`);
  console.log(`  Adjusted PnL:    +$${(result.summary.totalPnlUsd - highPnlReduction).toFixed(2)}`);
  console.log(`  Impact:          ${((highPnlReduction / result.summary.totalPnlUsd) * 100).toFixed(1)}% reduction`);
  console.log('');

  console.log('='.repeat(70));
  console.log('CONCLUSION:');
  console.log('='.repeat(70));
  console.log('');

  const highPct = (highExits.length / trades.length * 100);
  const impactPct = (highPnlReduction / result.summary.totalPnlUsd * 100);

  if (highPct < 30 && impactPct < 10) {
    console.log('✅ BACKTEST IS REASONABLY REALISTIC');
    console.log(`   Only ${highPct.toFixed(0)}% of exits are "optimistic" HIGH confidence`);
    console.log(`   Potential slippage impact: ~${impactPct.toFixed(0)}%`);
  } else if (impactPct < 20) {
    console.log('⚠️ BACKTEST IS SLIGHTLY OPTIMISTIC');
    console.log(`   ${highPct.toFixed(0)}% of exits are "optimistic" HIGH confidence`);
    console.log(`   Potential slippage impact: ~${impactPct.toFixed(0)}%`);
  } else {
    console.log('🚨 BACKTEST MAY BE TOO OPTIMISTIC');
    console.log(`   ${highPct.toFixed(0)}% of exits are "optimistic" HIGH confidence`);
    console.log(`   Potential slippage impact: ~${impactPct.toFixed(0)}%`);
  }
  console.log('');
}

analyze().catch(console.error);
