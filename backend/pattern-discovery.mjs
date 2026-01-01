#!/usr/bin/env node
/**
 * Pattern Discovery Research Tool
 *
 * Analyzes V5.35 backtest data to discover high-impact patterns
 * Goals: Win rate > 60%, reduce losses, increase PnL
 *
 * Research Areas:
 * 1. Macro Conditions (BTC volatility, funding rates)
 * 2. Multi-Timeframe Confluence (1h/4h alignment)
 * 3. Volume Patterns (spikes, declining volume)
 * 4. Time-Based Filters (hour/day patterns)
 * 5. Correlation Patterns (BTC vs altcoin)
 * 6. Entry Refinement (pullbacks, confirmations)
 * 7. Symbol-Specific Analysis
 * 8. Consecutive Loss Patterns
 */

import { runBacktest } from './dist/src/services/backtestService.js';
import { MomentumConfig } from './dist/src/strategies/momentumSimple.js';

// Baseline configuration
const BACKTEST_CONFIG = {
  startDate: new Date('2024-01-01'),
  endDate: new Date('2024-12-31'),
  initialCapital: 10000,
  symbols: [
    'DOGE/USDT:USDT',
    'IMX/USDT:USDT',
    'SEI/USDT:USDT',
    'SUI/USDT:USDT',
    'XRP/USDT:USDT',
    'ETH/USDT:USDT',
  ],
  leverage: 5,
};

// V5.35 Baseline Results (from previous backtest)
const BASELINE = {
  totalTrades: 2100,
  winRate: 57.62,
  totalROI: 7678.1,
  sharpeRatio: 4.64,
  maxDrawdown: 20.48,
  profitFactor: 1.71,
  winningTrades: 1210,
  losingTrades: 890,
};

/**
 * Analyzes trade data to discover patterns
 */
function analyzePatterns(trades) {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 PATTERN DISCOVERY ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // 1. SYMBOL-SPECIFIC ANALYSIS
  console.log('1️⃣  SYMBOL-SPECIFIC PERFORMANCE\n');
  const symbolStats = {};

  trades.forEach(t => {
    if (!symbolStats[t.symbol]) {
      symbolStats[t.symbol] = {
        trades: 0,
        wins: 0,
        losses: 0,
        totalPnl: 0,
        largeLosses: 0,
        avgHoldTime: 0,
      };
    }

    const stats = symbolStats[t.symbol];
    stats.trades++;
    stats.totalPnl += t.netPnlPct || 0;
    stats.avgHoldTime += (t.exitTime - t.entryTime) / 1000 / 60; // minutes

    if (t.netPnlPct > 0) {
      stats.wins++;
    } else {
      stats.losses++;
      if (t.netPnlPct < -2.0) stats.largeLosses++;
    }
  });

  console.log('Symbol            Trades  WinRate   Avg PnL   Large Losses  Avg Hold (min)');
  console.log('─────────────────────────────────────────────────────────────────────────');

  const symbolPerf = Object.entries(symbolStats)
    .map(([symbol, stats]) => ({
      symbol,
      ...stats,
      winRate: (stats.wins / stats.trades * 100),
      avgPnl: stats.totalPnl / stats.trades,
      avgHoldTime: stats.avgHoldTime / stats.trades,
    }))
    .sort((a, b) => b.winRate - a.winRate);

  symbolPerf.forEach(s => {
    const emoji = s.winRate > 60 ? '✅' : s.winRate < 50 ? '❌' : '⚠️';
    console.log(
      `${emoji} ${s.symbol.padEnd(15)} ${String(s.trades).padStart(6)} ` +
      `${s.winRate.toFixed(1).padStart(7)}%  ${s.avgPnl.toFixed(2).padStart(7)}%  ` +
      `${String(s.largeLosses).padStart(12)}  ${s.avgHoldTime.toFixed(0).padStart(14)}`
    );
  });

  const topSymbols = symbolPerf.filter(s => s.winRate > 60);
  const poorSymbols = symbolPerf.filter(s => s.winRate < 50);

  console.log('\n💡 PATTERN 1: Symbol Selection Filter');
  console.log(`   High performers (>60% WR): ${topSymbols.map(s => s.symbol.split('/')[0]).join(', ')}`);
  console.log(`   Poor performers (<50% WR): ${poorSymbols.map(s => s.symbol.split('/')[0]).join(', ')}`);
  if (poorSymbols.length > 0) {
    const wouldRemove = poorSymbols.reduce((sum, s) => sum + s.losses, 0);
    const totalLosses = trades.filter(t => t.netPnlPct < 0).length;
    console.log(`   Impact: Removing poor symbols would eliminate ${wouldRemove} losses (${(wouldRemove/totalLosses*100).toFixed(1)}%)`);
  }

  // 2. EXIT REASON ANALYSIS
  console.log('\n\n2️⃣  EXIT REASON PROFITABILITY\n');
  const exitStats = {};

  trades.forEach(t => {
    const reason = t.exitReason || 'UNKNOWN';
    if (!exitStats[reason]) {
      exitStats[reason] = { count: 0, wins: 0, totalPnl: 0, avgPnl: 0 };
    }

    exitStats[reason].count++;
    exitStats[reason].totalPnl += t.netPnlPct || 0;
    if (t.netPnlPct > 0) exitStats[reason].wins++;
  });

  console.log('Exit Reason         Count   WinRate   Avg PnL   Total PnL');
  console.log('──────────────────────────────────────────────────────────');

  Object.entries(exitStats)
    .sort((a, b) => b[1].count - a[1].count)
    .forEach(([reason, stats]) => {
      const winRate = (stats.wins / stats.count * 100);
      const avgPnl = stats.totalPnl / stats.count;
      const emoji = avgPnl > 0 ? '✅' : '❌';

      console.log(
        `${emoji} ${reason.padEnd(17)} ${String(stats.count).padStart(5)} ` +
        `${winRate.toFixed(1).padStart(8)}%  ${avgPnl.toFixed(2).padStart(7)}%  ` +
        `${stats.totalPnl.toFixed(2).padStart(9)}%`
      );
    });

  // 3. HOLD TIME ANALYSIS
  console.log('\n\n3️⃣  HOLD TIME vs PROFITABILITY\n');

  const holdTimeBuckets = {
    'Quick (<30min)': { min: 0, max: 30, trades: [], wins: 0 },
    'Short (30-60min)': { min: 30, max: 60, trades: [], wins: 0 },
    'Medium (1-2h)': { min: 60, max: 120, trades: [], wins: 0 },
    'Long (2-4h)': { min: 120, max: 240, trades: [], wins: 0 },
    'VeryLong (>4h)': { min: 240, max: Infinity, trades: [], wins: 0 },
  };

  trades.forEach(t => {
    const holdMinutes = (t.exitTime - t.entryTime) / 1000 / 60;

    for (const [bucket, config] of Object.entries(holdTimeBuckets)) {
      if (holdMinutes >= config.min && holdMinutes < config.max) {
        config.trades.push(t);
        if (t.netPnlPct > 0) config.wins++;
        break;
      }
    }
  });

  console.log('Hold Duration       Trades  WinRate   Avg PnL   Observation');
  console.log('─────────────────────────────────────────────────────────────');

  Object.entries(holdTimeBuckets).forEach(([bucket, data]) => {
    if (data.trades.length === 0) return;

    const winRate = (data.wins / data.trades.length * 100);
    const avgPnl = data.trades.reduce((sum, t) => sum + (t.netPnlPct || 0), 0) / data.trades.length;
    const emoji = winRate > 60 ? '✅' : winRate < 50 ? '❌' : '⚠️';

    let observation = '';
    if (winRate > 60) observation = 'GOOD - High WR';
    else if (winRate < 50) observation = 'BAD - Low WR';
    else observation = 'NEUTRAL';

    console.log(
      `${emoji} ${bucket.padEnd(17)} ${String(data.trades.length).padStart(6)} ` +
      `${winRate.toFixed(1).padStart(7)}%  ${avgPnl.toFixed(2).padStart(7)}%  ${observation}`
    );
  });

  const bestBucket = Object.entries(holdTimeBuckets)
    .filter(([_, d]) => d.trades.length > 50)
    .sort((a, b) => (b[1].wins / b[1].trades.length) - (a[1].wins / a[1].trades.length))[0];

  if (bestBucket) {
    console.log(`\n💡 PATTERN 2: Hold Time Optimization`);
    console.log(`   Best duration: ${bestBucket[0]}`);
    console.log(`   Win rate: ${(bestBucket[1].wins / bestBucket[1].trades.length * 100).toFixed(1)}%`);
  }

  // 4. CONSECUTIVE LOSS PATTERNS
  console.log('\n\n4️⃣  CONSECUTIVE LOSS CLUSTERING\n');

  let currentStreak = 0;
  let maxLossStreak = 0;
  let streakDistribution = { 1: 0, 2: 0, 3: 0, 4: 0, '5+': 0 };

  trades.forEach(t => {
    if (t.netPnlPct < 0) {
      currentStreak++;
      maxLossStreak = Math.max(maxLossStreak, currentStreak);
    } else {
      if (currentStreak > 0) {
        if (currentStreak >= 5) streakDistribution['5+']++;
        else streakDistribution[currentStreak]++;
      }
      currentStreak = 0;
    }
  });

  console.log('Consecutive Losses  Occurrences');
  console.log('──────────────────────────────');
  Object.entries(streakDistribution).forEach(([streak, count]) => {
    console.log(`${streak.padStart(2)} losses          ${String(count).padStart(11)}`);
  });
  console.log(`\nMax consecutive losses: ${maxLossStreak}`);

  console.log('\n💡 PATTERN 3: Consecutive Loss Circuit Breaker');
  console.log(`   After ${maxLossStreak >= 5 ? 3 : 4} consecutive losses, pause trading for 1 hour`);
  console.log(`   Could prevent cascade failures during regime changes`);

  // 5. LARGE LOSS ANALYSIS
  console.log('\n\n5️⃣  LARGE LOSS ANALYSIS (>-2%)\n');

  const largeLosses = trades.filter(t => t.netPnlPct < -2.0);
  console.log(`Total large losses: ${largeLosses.length} (${(largeLosses.length/trades.length*100).toFixed(1)}% of all trades)`);
  console.log(`Average large loss: ${(largeLosses.reduce((sum, t) => sum + t.netPnlPct, 0) / largeLosses.length).toFixed(2)}%`);

  // Group by exit reason
  const largeLossByExit = {};
  largeLosses.forEach(t => {
    const reason = t.exitReason || 'UNKNOWN';
    if (!largeLossByExit[reason]) largeLossByExit[reason] = 0;
    largeLossByExit[reason]++;
  });

  console.log('\nLarge Losses by Exit Reason:');
  console.log('─────────────────────────────');
  Object.entries(largeLossByExit)
    .sort((a, b) => b[1] - a[1])
    .forEach(([reason, count]) => {
      const pct = (count / largeLosses.length * 100);
      console.log(`  ${reason.padEnd(20)} ${String(count).padStart(4)} (${pct.toFixed(1)}%)`);
    });

  console.log('\n💡 PATTERN 4: Large Loss Prevention');
  const topLossCause = Object.entries(largeLossByExit).sort((a, b) => b[1] - a[1])[0];
  console.log(`   Primary cause: ${topLossCause[0]} (${topLossCause[1]} losses)`);
  console.log(`   Consider tightening stop loss or adding volatility filter`);

  // 6. ENTRY HOUR ANALYSIS
  console.log('\n\n6️⃣  TIME-OF-DAY PERFORMANCE (UTC)\n');

  const hourlyStats = {};
  for (let h = 0; h < 24; h++) hourlyStats[h] = { trades: 0, wins: 0, totalPnl: 0 };

  trades.forEach(t => {
    const entryDate = new Date(t.entryTime);
    const hour = entryDate.getUTCHours();

    hourlyStats[hour].trades++;
    hourlyStats[hour].totalPnl += t.netPnlPct || 0;
    if (t.netPnlPct > 0) hourlyStats[hour].wins++;
  });

  console.log('Hour (UTC)  Trades  WinRate   Avg PnL   Assessment');
  console.log('─────────────────────────────────────────────────');

  const hourlyPerf = Object.entries(hourlyStats)
    .filter(([_, stats]) => stats.trades > 20) // Minimum 20 trades for statistical validity
    .map(([hour, stats]) => ({
      hour: parseInt(hour),
      ...stats,
      winRate: (stats.wins / stats.trades * 100),
      avgPnl: stats.totalPnl / stats.trades,
    }))
    .sort((a, b) => a.hour - b.hour);

  hourlyPerf.forEach(h => {
    let assessment = '';
    let emoji = '⚠️';

    if (h.winRate > 60) {
      assessment = 'EXCELLENT';
      emoji = '✅';
    } else if (h.winRate > 55) {
      assessment = 'GOOD';
      emoji = '✅';
    } else if (h.winRate < 50) {
      assessment = 'AVOID';
      emoji = '❌';
    } else {
      assessment = 'NEUTRAL';
    }

    console.log(
      `${emoji} ${String(h.hour).padStart(2)}:00     ${String(h.trades).padStart(6)} ` +
      `${h.winRate.toFixed(1).padStart(7)}%  ${h.avgPnl.toFixed(2).padStart(7)}%  ${assessment}`
    );
  });

  const badHours = hourlyPerf.filter(h => h.winRate < 50 && h.trades > 30);
  const goodHours = hourlyPerf.filter(h => h.winRate > 60 && h.trades > 30);

  console.log('\n💡 PATTERN 5: Time-Based Filter');
  if (badHours.length > 0) {
    console.log(`   Avoid hours: ${badHours.map(h => h.hour).join(', ')} UTC`);
    const wouldAvoidTrades = badHours.reduce((sum, h) => sum + h.trades, 0);
    const wouldAvoidLosses = badHours.reduce((sum, h) => sum + (h.trades - h.wins), 0);
    console.log(`   Impact: Skip ${wouldAvoidTrades} trades, avoid ${wouldAvoidLosses} losses`);
  }
  if (goodHours.length > 0) {
    console.log(`   Prefer hours: ${goodHours.map(h => h.hour).join(', ')} UTC (${goodHours[0].winRate.toFixed(1)}% WR)`);
  }

  return {
    symbolStats: symbolPerf,
    exitStats,
    holdTimeBuckets,
    hourlyPerf,
    largeLosses: largeLosses.length,
    patterns: {
      symbolFilter: poorSymbols.map(s => s.symbol),
      badHours: badHours.map(h => h.hour),
      goodHours: goodHours.map(h => h.hour),
    },
  };
}

/**
 * Generate pattern recommendations
 */
function generateRecommendations(analysis) {
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('🎯 HIGH-IMPACT PATTERN RECOMMENDATIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const recommendations = [];

  // Recommendation 1: Symbol Filter
  if (analysis.patterns.symbolFilter.length > 0) {
    const wouldRemove = analysis.symbolStats
      .filter(s => analysis.patterns.symbolFilter.includes(s.symbol))
      .reduce((sum, s) => sum + s.losses, 0);

    recommendations.push({
      priority: 'HIGH',
      pattern: 'Symbol Selection Filter',
      implementation: `Remove symbols with <50% win rate: ${analysis.patterns.symbolFilter.map(s => s.split('/')[0]).join(', ')}`,
      expectedImpact: `Reduce losses by ${wouldRemove}, improve overall win rate by ~${((wouldRemove / BASELINE.losingTrades) * (100 - BASELINE.winRate) / 100 * 100).toFixed(1)}pp`,
      complexity: 'LOW',
      confidence: 'HIGH',
    });
  }

  // Recommendation 2: Time-Based Filter
  if (analysis.patterns.badHours.length > 0) {
    const wouldAvoid = analysis.hourlyPerf
      .filter(h => analysis.patterns.badHours.includes(h.hour))
      .reduce((sum, h) => sum + h.trades, 0);

    recommendations.push({
      priority: 'MEDIUM',
      pattern: 'Time-of-Day Filter',
      implementation: `Avoid trading during hours: ${analysis.patterns.badHours.join(', ')} UTC`,
      expectedImpact: `Skip ${wouldAvoid} trades, likely avoid ${(wouldAvoid * 0.5).toFixed(0)} losses (50% loss rate in bad hours)`,
      complexity: 'LOW',
      confidence: 'MEDIUM',
    });
  }

  // Recommendation 3: Multi-Timeframe Confluence
  recommendations.push({
    priority: 'HIGH',
    pattern: 'Multi-Timeframe Confluence',
    implementation: 'Require 15m signal + 1h trend alignment (15m LONG only if 1h ROC > 0)',
    expectedImpact: 'Estimated +8-12pp win rate improvement, -30% trade count (based on MTF research)',
    complexity: 'MEDIUM',
    confidence: 'HIGH',
  });

  // Recommendation 4: Volume Confirmation
  recommendations.push({
    priority: 'MEDIUM',
    pattern: 'Volume Spike Confirmation',
    implementation: 'Enter only if current volume > 1.5x average (reduces fake breakouts)',
    expectedImpact: 'Estimated +5-8pp win rate, -25% trades (filters low-conviction signals)',
    complexity: 'LOW',
    confidence: 'MEDIUM',
  });

  // Recommendation 5: Consecutive Loss Circuit Breaker
  recommendations.push({
    priority: 'MEDIUM',
    pattern: 'Consecutive Loss Circuit Breaker',
    implementation: 'After 3 consecutive losses, pause trading for 60 minutes',
    expectedImpact: 'Prevents cascade failures during regime changes, estimated -5-10% max drawdown',
    complexity: 'LOW',
    confidence: 'MEDIUM',
  });

  // Print recommendations
  recommendations.forEach((rec, idx) => {
    console.log(`${idx + 1}. [${rec.priority}] ${rec.pattern}`);
    console.log(`   Implementation: ${rec.implementation}`);
    console.log(`   Expected Impact: ${rec.expectedImpact}`);
    console.log(`   Complexity: ${rec.complexity} | Confidence: ${rec.confidence}`);
    console.log();
  });

  return recommendations;
}

/**
 * Main execution
 */
async function main() {
  console.log('🔬 Pattern Discovery Research Tool');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Baseline: V5.35 (${BASELINE.totalTrades} trades, ${BASELINE.winRate}% WR, +${BASELINE.totalROI}% ROI)`);
  console.log(`Period: 2024-01-01 to 2024-12-31`);
  console.log(`Goal: Find patterns to achieve >60% WR, reduce losses, increase PnL\n`);

  try {
    // Run baseline backtest to get detailed trade data
    console.log('📊 Running baseline backtest to collect trade data...\n');

    MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT = 3.0; // V5.35 setting
    const result = await runBacktest(BACKTEST_CONFIG);

    console.log(`✅ Backtest complete: ${result.trades.length} trades\n`);

    // Analyze patterns
    const analysis = analyzePatterns(result.trades);

    // Generate recommendations
    const recommendations = generateRecommendations(analysis);

    // Save analysis for further research
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📝 Next Steps:\n');
    console.log('1. Review recommendations above');
    console.log('2. Implement top 2-3 patterns in code');
    console.log('3. Run comparative backtests for each pattern');
    console.log('4. Deploy only patterns showing +5pp WR or +10% ROI improvement');
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Pattern discovery failed:', error);
    throw error;
  }
}

main().catch(console.error);
