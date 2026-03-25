/**
 * V5.63 Test Script - Skip N Trades After 2 Consecutive Losers
 *
 * Tests different values of N to find optimal skip count.
 * Compares: No skip vs Skip 1,2,3,4,5 trades after 2 consecutive losers
 */

import { runBacktest } from '../src/services/backtestService.js';

const SYMBOLS = [
  'BTC/USDT:USDT',
  'ETH/USDT:USDT',
  'SOL/USDT:USDT',
  'XRP/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
  'LTC/USDT:USDT',
  'BCH/USDT:USDT',
  'UNI/USDT:USDT',
  'DOT/USDT:USDT',
  'SUI/USDT:USDT',
  'SEI/USDT:USDT',
  'IMX/USDT:USDT',
  'APT/USDT:USDT',
];

interface Trade {
  netPnlUsd: number;
  netPnlPct: number;
  symbol: string;
  side: string;
  exitReason: string;
}

function simulateSkipRule(trades: Trade[], skipCount: number): {
  totalPnl: number;
  tradesExecuted: number;
  tradesSkipped: number;
  skippedWinners: number;
  skippedLosers: number;
  skippedPnl: number;
  winRate: number;
} {
  let consecutiveLosers = 0;
  let tradesToSkip = 0;

  let totalPnl = 0;
  let tradesExecuted = 0;
  let tradesSkipped = 0;
  let skippedWinners = 0;
  let skippedLosers = 0;
  let skippedPnl = 0;
  let wins = 0;

  for (const trade of trades) {
    const isWinner = trade.netPnlUsd > 0;

    // Check if we should skip this trade
    if (tradesToSkip > 0) {
      // Skip this trade
      tradesSkipped++;
      tradesToSkip--;
      skippedPnl += trade.netPnlUsd;
      if (isWinner) {
        skippedWinners++;
      } else {
        skippedLosers++;
      }

      // Still update consecutive loser count for tracking
      // (the trade happened in history, we're simulating not taking it)
      if (isWinner) {
        consecutiveLosers = 0;
      } else {
        consecutiveLosers++;
        // Check if we need to extend skip
        if (consecutiveLosers >= 2 && skipCount > 0) {
          tradesToSkip = skipCount; // Reset skip counter
        }
      }
      continue;
    }

    // Execute this trade
    tradesExecuted++;
    totalPnl += trade.netPnlUsd;
    if (isWinner) {
      wins++;
      consecutiveLosers = 0;
    } else {
      consecutiveLosers++;
      // Trigger skip rule after 2 consecutive losers
      if (consecutiveLosers >= 2 && skipCount > 0) {
        tradesToSkip = skipCount;
      }
    }
  }

  return {
    totalPnl,
    tradesExecuted,
    tradesSkipped,
    skippedWinners,
    skippedLosers,
    skippedPnl,
    winRate: tradesExecuted > 0 ? (wins / tradesExecuted) * 100 : 0,
  };
}

async function runTest() {
  console.log('='.repeat(80));
  console.log('V5.63 TEST: SKIP N TRADES AFTER 2 CONSECUTIVE LOSERS');
  console.log('='.repeat(80));
  console.log('');

  // First, we need to get trades WITHOUT the skip rule
  // Temporarily the backtest has the rule, so let me note this
  console.log('Running 12-month backtest to get trade history...');
  console.log('NOTE: Current backtest has skip rule active - this test simulates on top');
  console.log('');

  const startDate = new Date('2024-01-01');
  const endDate = new Date('2024-12-31');

  try {
    const result = await runBacktest({
      symbols: SYMBOLS,
      startDate,
      endDate,
      initialCapital: 10000,
      leverage: 5,
    });

    const trades = result.trades as Trade[];

    console.log(`Loaded ${trades.length} trades from backtest`);
    console.log('');

    // Test different skip counts
    const skipCounts = [0, 1, 2, 3, 4, 5, 7, 10];

    console.log('='.repeat(80));
    console.log('RESULTS COMPARISON');
    console.log('='.repeat(80));
    console.log('');
    console.log('Skip N | Trades | Skipped | Win Rate |   PnL USD  | Skipped PnL | Winners/Losers Skipped');
    console.log('-'.repeat(95));

    const baseline = simulateSkipRule(trades, 0);

    for (const skipCount of skipCounts) {
      const result = simulateSkipRule(trades, skipCount);
      const pnlDiff = result.totalPnl - baseline.totalPnl;
      const pnlDiffStr = pnlDiff >= 0 ? `+${pnlDiff.toFixed(2)}` : pnlDiff.toFixed(2);

      console.log(
        `  ${skipCount.toString().padStart(2)}   |  ${result.tradesExecuted.toString().padStart(4)}  |   ${result.tradesSkipped.toString().padStart(4)}  |  ${result.winRate.toFixed(1).padStart(5)}%  | ${result.totalPnl >= 0 ? '+' : ''}${result.totalPnl.toFixed(2).padStart(9)} | ${result.skippedPnl >= 0 ? '+' : ''}${result.skippedPnl.toFixed(2).padStart(10)} |    ${result.skippedWinners}W / ${result.skippedLosers}L`
      );
    }

    console.log('');
    console.log('='.repeat(80));
    console.log('ANALYSIS');
    console.log('='.repeat(80));
    console.log('');

    // Find best skip count
    let bestSkip = 0;
    let bestPnl = baseline.totalPnl;

    for (const skipCount of skipCounts) {
      const result = simulateSkipRule(trades, skipCount);
      if (result.totalPnl > bestPnl) {
        bestPnl = result.totalPnl;
        bestSkip = skipCount;
      }
    }

    console.log(`Baseline (no skip): $${baseline.totalPnl.toFixed(2)} | ${baseline.tradesExecuted} trades | ${baseline.winRate.toFixed(1)}% win rate`);
    console.log('');

    if (bestSkip > 0) {
      const bestResult = simulateSkipRule(trades, bestSkip);
      const improvement = bestResult.totalPnl - baseline.totalPnl;
      console.log(`✅ BEST: Skip ${bestSkip} trades after 2 consecutive losers`);
      console.log(`   PnL: $${bestResult.totalPnl.toFixed(2)} (+$${improvement.toFixed(2)} improvement)`);
      console.log(`   Trades: ${bestResult.tradesExecuted} executed, ${bestResult.tradesSkipped} skipped`);
      console.log(`   Skipped: ${bestResult.skippedWinners} winners, ${bestResult.skippedLosers} losers`);
      console.log(`   Win Rate: ${bestResult.winRate.toFixed(1)}% (was ${baseline.winRate.toFixed(1)}%)`);
    } else {
      console.log('⚠️ No skip rule improves PnL for this dataset');
    }

    console.log('');
    console.log('='.repeat(80));

    return { bestSkip, trades };

  } catch (error) {
    console.error('Backtest failed:', error);
    process.exit(1);
  }
}

runTest().catch(console.error);
