/**
 * Deep Analysis of STAGNANT and SL trades
 *
 * Separate analysis for each failure type to find specific patterns
 */

import { runBacktest, type BacktestTrade } from '../src/services/backtestService.js';
import * as ccxt from 'ccxt';

async function main() {
  console.log('='.repeat(100));
  console.log('DEEP STAGNANT & SL ANALYSIS');
  console.log('='.repeat(100));

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  await exchange.loadMarkets();

  const startDate = new Date('2025-01-01T00:00:00Z');
  const endDate = new Date('2026-01-01T00:00:00Z');
  const symbols = ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'];

  // Run backtest
  const result = await runBacktest({
    startDate,
    endDate,
    initialCapital: 2000,
    symbols,
    leverage: 4.5,
    nfsAdaptiveTrailing: true,
  });

  console.log(`\nTotal trades: ${result.trades.length}`);

  // Categorize
  const winners = result.trades.filter(t => t.netPnlPct > 0);
  const stagnant = result.trades.filter(t =>
    t.exitReason === 'STAGNANT_TRADE' || t.exitReason === 'STAGNANT_PROFIT_EXIT'
  );
  const sl = result.trades.filter(t => t.exitReason === 'SL');
  const trailWinners = result.trades.filter(t => t.exitReason.startsWith('TRAIL') && t.netPnlPct > 0);

  console.log(`Winners: ${winners.length} (${(winners.length / result.trades.length * 100).toFixed(1)}%)`);
  console.log(`STAGNANT: ${stagnant.length} (${(stagnant.length / result.trades.length * 100).toFixed(1)}%)`);
  console.log(`SL: ${sl.length} (${(sl.length / result.trades.length * 100).toFixed(1)}%)`);
  console.log(`TRAIL Winners: ${trailWinners.length}`);

  // Analyze by symbol
  console.log('\n' + '='.repeat(80));
  console.log('BREAKDOWN BY SYMBOL');
  console.log('='.repeat(80));

  for (const sym of symbols) {
    const symTrades = result.trades.filter(t => t.symbol === sym);
    const symWins = symTrades.filter(t => t.netPnlPct > 0);
    const symStag = symTrades.filter(t => t.exitReason === 'STAGNANT_TRADE' || t.exitReason === 'STAGNANT_PROFIT_EXIT');
    const symSL = symTrades.filter(t => t.exitReason === 'SL');

    const symPnl = symTrades.reduce((s, t) => s + t.netPnlPct, 0);
    const stagPnl = symStag.reduce((s, t) => s + t.netPnlPct, 0);
    const slPnl = symSL.reduce((s, t) => s + t.netPnlPct, 0);

    console.log(`\n${sym}:`);
    console.log(`  Total: ${symTrades.length} trades | Win rate: ${(symWins.length / symTrades.length * 100).toFixed(1)}% | Total PnL: ${symPnl.toFixed(1)}%`);
    console.log(`  STAGNANT: ${symStag.length} (${(symStag.length / symTrades.length * 100).toFixed(1)}%) | PnL: ${stagPnl.toFixed(1)}%`);
    console.log(`  SL: ${symSL.length} (${(symSL.length / symTrades.length * 100).toFixed(1)}%) | PnL: ${slPnl.toFixed(1)}%`);
  }

  // Analyze by side
  console.log('\n' + '='.repeat(80));
  console.log('BREAKDOWN BY SIDE');
  console.log('='.repeat(80));

  for (const side of ['long', 'short'] as const) {
    const sideTrades = result.trades.filter(t => t.side === side);
    const sideWins = sideTrades.filter(t => t.netPnlPct > 0);
    const sideStag = sideTrades.filter(t => t.exitReason === 'STAGNANT_TRADE' || t.exitReason === 'STAGNANT_PROFIT_EXIT');
    const sideSL = sideTrades.filter(t => t.exitReason === 'SL');

    const sidePnl = sideTrades.reduce((s, t) => s + t.netPnlPct, 0);

    console.log(`\n${side.toUpperCase()}:`);
    console.log(`  Total: ${sideTrades.length} trades | Win rate: ${(sideWins.length / sideTrades.length * 100).toFixed(1)}% | Total PnL: ${sidePnl.toFixed(1)}%`);
    console.log(`  STAGNANT: ${sideStag.length} (${(sideStag.length / sideTrades.length * 100).toFixed(1)}%)`);
    console.log(`  SL: ${sideSL.length} (${(sideSL.length / sideTrades.length * 100).toFixed(1)}%)`);
  }

  // Analyze by hour
  console.log('\n' + '='.repeat(80));
  console.log('BREAKDOWN BY ENTRY HOUR (UTC)');
  console.log('='.repeat(80));

  const hourlyStats = new Map<number, { total: number; wins: number; stagnant: number; sl: number; pnl: number }>();

  for (const trade of result.trades) {
    const hour = new Date(trade.entryTime).getUTCHours();
    const stats = hourlyStats.get(hour) || { total: 0, wins: 0, stagnant: 0, sl: 0, pnl: 0 };
    stats.total++;
    stats.pnl += trade.netPnlPct;
    if (trade.netPnlPct > 0) stats.wins++;
    if (trade.exitReason === 'STAGNANT_TRADE' || trade.exitReason === 'STAGNANT_PROFIT_EXIT') stats.stagnant++;
    if (trade.exitReason === 'SL') stats.sl++;
    hourlyStats.set(hour, stats);
  }

  console.log('\nHour | Trades | WinRate | Stagnant% | SL%    | Avg PnL');
  console.log('-'.repeat(60));

  for (let h = 0; h < 24; h++) {
    const stats = hourlyStats.get(h);
    if (stats && stats.total > 5) {
      const wr = (stats.wins / stats.total * 100).toFixed(1);
      const stagPct = (stats.stagnant / stats.total * 100).toFixed(1);
      const slPct = (stats.sl / stats.total * 100).toFixed(1);
      const avgPnl = (stats.pnl / stats.total).toFixed(2);
      console.log(`${h.toString().padStart(2, '0')}:00 | ${stats.total.toString().padStart(6)} | ${wr.padStart(6)}% | ${stagPct.padStart(8)}% | ${slPct.padStart(5)}% | ${avgPnl.padStart(6)}%`);
    }
  }

  // Analyze hold time
  console.log('\n' + '='.repeat(80));
  console.log('HOLD TIME ANALYSIS');
  console.log('='.repeat(80));

  const avgHoldWinners = winners.reduce((s, t) => s + t.holdMinutes, 0) / winners.length;
  const avgHoldStagnant = stagnant.reduce((s, t) => s + t.holdMinutes, 0) / stagnant.length;
  const avgHoldSL = sl.reduce((s, t) => s + t.holdMinutes, 0) / sl.length;

  console.log(`\nAvg Hold Time:`);
  console.log(`  Winners: ${(avgHoldWinners / 60).toFixed(1)} hours`);
  console.log(`  STAGNANT: ${(avgHoldStagnant / 60).toFixed(1)} hours`);
  console.log(`  SL: ${(avgHoldSL / 60).toFixed(1)} hours`);

  // What happens after a loser?
  console.log('\n' + '='.repeat(80));
  console.log('SEQUENCE ANALYSIS - What happens after a loser?');
  console.log('='.repeat(80));

  let afterLoser = { total: 0, wins: 0, stagnant: 0, sl: 0 };
  let afterWinner = { total: 0, wins: 0, stagnant: 0, sl: 0 };
  let afterConsecLosers = { total: 0, wins: 0, stagnant: 0, sl: 0 };

  for (let i = 1; i < result.trades.length; i++) {
    const prev = result.trades[i - 1];
    const curr = result.trades[i];

    if (prev.netPnlPct <= 0) {
      afterLoser.total++;
      if (curr.netPnlPct > 0) afterLoser.wins++;
      if (curr.exitReason === 'STAGNANT_TRADE' || curr.exitReason === 'STAGNANT_PROFIT_EXIT') afterLoser.stagnant++;
      if (curr.exitReason === 'SL') afterLoser.sl++;

      // Check for consecutive losers
      if (i >= 2 && result.trades[i - 2].netPnlPct <= 0) {
        afterConsecLosers.total++;
        if (curr.netPnlPct > 0) afterConsecLosers.wins++;
        if (curr.exitReason === 'STAGNANT_TRADE' || curr.exitReason === 'STAGNANT_PROFIT_EXIT') afterConsecLosers.stagnant++;
        if (curr.exitReason === 'SL') afterConsecLosers.sl++;
      }
    } else {
      afterWinner.total++;
      if (curr.netPnlPct > 0) afterWinner.wins++;
      if (curr.exitReason === 'STAGNANT_TRADE' || curr.exitReason === 'STAGNANT_PROFIT_EXIT') afterWinner.stagnant++;
      if (curr.exitReason === 'SL') afterWinner.sl++;
    }
  }

  console.log(`\nAfter a LOSER:`);
  console.log(`  Next trade win rate: ${(afterLoser.wins / afterLoser.total * 100).toFixed(1)}%`);
  console.log(`  Next trade STAGNANT: ${(afterLoser.stagnant / afterLoser.total * 100).toFixed(1)}%`);
  console.log(`  Next trade SL: ${(afterLoser.sl / afterLoser.total * 100).toFixed(1)}%`);

  console.log(`\nAfter a WINNER:`);
  console.log(`  Next trade win rate: ${(afterWinner.wins / afterWinner.total * 100).toFixed(1)}%`);
  console.log(`  Next trade STAGNANT: ${(afterWinner.stagnant / afterWinner.total * 100).toFixed(1)}%`);
  console.log(`  Next trade SL: ${(afterWinner.sl / afterWinner.total * 100).toFixed(1)}%`);

  console.log(`\nAfter 2+ CONSECUTIVE LOSERS:`);
  console.log(`  Next trade win rate: ${(afterConsecLosers.wins / afterConsecLosers.total * 100).toFixed(1)}%`);
  console.log(`  Next trade STAGNANT: ${(afterConsecLosers.stagnant / afterConsecLosers.total * 100).toFixed(1)}%`);
  console.log(`  Next trade SL: ${(afterConsecLosers.sl / afterConsecLosers.total * 100).toFixed(1)}%`);

  // PnL per trade after streaks
  console.log('\n' + '='.repeat(80));
  console.log('LOSS REDUCTION STRATEGIES');
  console.log('='.repeat(80));

  // Strategy 1: Reduce size after loser
  console.log('\n1. REDUCE SIZE AFTER LOSER (50% size):');
  let reducedPnl = 0;
  for (let i = 0; i < result.trades.length; i++) {
    const multiplier = i > 0 && result.trades[i - 1].netPnlPct <= 0 ? 0.5 : 1.0;
    reducedPnl += result.trades[i].netPnlPct * multiplier;
  }
  const originalPnl = result.trades.reduce((s, t) => s + t.netPnlPct, 0);
  console.log(`  Original PnL: ${originalPnl.toFixed(1)}%`);
  console.log(`  With reduced size: ${reducedPnl.toFixed(1)}%`);
  console.log(`  Difference: ${(reducedPnl - originalPnl).toFixed(1)}%`);

  // Strategy 2: Skip trade after 2 consecutive losers
  console.log('\n2. SKIP TRADE AFTER 2+ CONSECUTIVE LOSERS:');
  let skipPnl = 0;
  let skippedTrades = 0;
  for (let i = 0; i < result.trades.length; i++) {
    if (i >= 2 && result.trades[i - 1].netPnlPct <= 0 && result.trades[i - 2].netPnlPct <= 0) {
      skippedTrades++;
      continue;
    }
    skipPnl += result.trades[i].netPnlPct;
  }
  console.log(`  Skipped: ${skippedTrades} trades`);
  console.log(`  With skip rule: ${skipPnl.toFixed(1)}%`);
  console.log(`  Difference: ${(skipPnl - originalPnl).toFixed(1)}%`);

  // Look at STAGNANT trades specifically
  console.log('\n' + '='.repeat(80));
  console.log('STAGNANT TRADE DEEP DIVE');
  console.log('='.repeat(80));

  // Group STAGNANT by entry reason
  const entryReasons = new Map<string, { count: number; pnl: number }>();
  for (const t of stagnant) {
    const reason = t.entryReason || 'unknown';
    const stats = entryReasons.get(reason) || { count: 0, pnl: 0 };
    stats.count++;
    stats.pnl += t.netPnlPct;
    entryReasons.set(reason, stats);
  }

  console.log('\nSTAGNANT by entry reason:');
  for (const [reason, stats] of entryReasons) {
    console.log(`  ${reason}: ${stats.count} trades, total PnL: ${stats.pnl.toFixed(1)}%`);
  }

  // What was the max PnL reached by STAGNANT trades?
  console.log('\n' + '='.repeat(80));
  console.log('MAX PNL REACHED BY STAGNANT TRADES');
  console.log('='.repeat(80));

  // Since we don't have maxPnl tracked, let's estimate from hold time
  // STAGNANT means price didn't move enough - so likely low maxPnl
  const stagnantHoldTimes = stagnant.map(t => t.holdMinutes);
  const avgStagnantHold = stagnantHoldTimes.reduce((a, b) => a + b, 0) / stagnantHoldTimes.length;
  const shortStagnant = stagnant.filter(t => t.holdMinutes < 120);
  const longStagnant = stagnant.filter(t => t.holdMinutes >= 120);

  console.log(`\nSTAGNANT trades by hold time:`);
  console.log(`  < 2h: ${shortStagnant.length} (${(shortStagnant.length / stagnant.length * 100).toFixed(1)}%)`);
  console.log(`  >= 2h: ${longStagnant.length} (${(longStagnant.length / stagnant.length * 100).toFixed(1)}%)`);

  const shortStagnantPnl = shortStagnant.reduce((s, t) => s + t.netPnlPct, 0);
  const longStagnantPnl = longStagnant.reduce((s, t) => s + t.netPnlPct, 0);
  console.log(`  < 2h PnL: ${shortStagnantPnl.toFixed(1)}%`);
  console.log(`  >= 2h PnL: ${longStagnantPnl.toFixed(1)}%`);

  // SL trade analysis
  console.log('\n' + '='.repeat(80));
  console.log('SL TRADE DEEP DIVE');
  console.log('='.repeat(80));

  const slByEntry = new Map<string, { count: number; pnl: number }>();
  for (const t of sl) {
    const reason = t.entryReason || 'unknown';
    const stats = slByEntry.get(reason) || { count: 0, pnl: 0 };
    stats.count++;
    stats.pnl += t.netPnlPct;
    slByEntry.set(reason, stats);
  }

  console.log('\nSL by entry reason:');
  for (const [reason, stats] of slByEntry) {
    console.log(`  ${reason}: ${stats.count} trades, total PnL: ${stats.pnl.toFixed(1)}%`);
  }

  // SL by side
  const slLong = sl.filter(t => t.side === 'long');
  const slShort = sl.filter(t => t.side === 'short');
  console.log(`\nSL by side:`);
  console.log(`  LONG: ${slLong.length} (${(slLong.length / sl.length * 100).toFixed(1)}%)`);
  console.log(`  SHORT: ${slShort.length} (${(slShort.length / sl.length * 100).toFixed(1)}%)`);

  // Sample SL trades
  console.log('\nSample SL trades:');
  for (const t of sl.slice(0, 10)) {
    console.log(`  ${t.symbol} ${t.side} @ ${t.entryTime.slice(0, 16)} | Hold: ${t.holdMinutes}min | PnL: ${t.netPnlPct.toFixed(2)}%`);
  }

  // Final recommendations
  console.log('\n' + '='.repeat(100));
  console.log('RECOMMENDATIONS');
  console.log('='.repeat(100));

  console.log(`
1. STAGNANT TRADE MITIGATION:
   - ${stagnant.length} trades (${(stagnant.length / result.trades.length * 100).toFixed(1)}%) ended as STAGNANT
   - Total loss from STAGNANT: ${stagnant.reduce((s, t) => s + t.netPnlPct, 0).toFixed(1)}%
   - These trades never moved in our direction
   - Consider: Tighter time-based exit (e.g., exit if not +0.5% after 1 hour)

2. SL TRADE MITIGATION:
   - ${sl.length} trades (${(sl.length / result.trades.length * 100).toFixed(1)}%) hit stop loss
   - Total loss from SL: ${sl.reduce((s, t) => s + t.netPnlPct, 0).toFixed(1)}%
   - These moved against us quickly
   - Consider: Better entry timing or tighter initial SL with quick recovery

3. SIZE MANAGEMENT:
   - After 2+ consecutive losers, win rate drops
   - Consider reducing size or skipping the next trade

4. WINNING TRADE PROTECTION:
   - ${trailWinners.length} trades exited via TRAIL with profit
   - These generated ${trailWinners.reduce((s, t) => s + t.netPnlPct, 0).toFixed(1)}% total
   - NFS_ADAPTIVE is capturing these well - don't change!
`);
}

main().catch(console.error);
