/**
 * V5.145 — Loss Clustering Analysis
 *
 * Hypothesis: losses cluster on bad market days. If we stop trading after
 * N consecutive losses in a day, we can cut DD without hurting PnL much.
 *
 * Usage: npx tsx scripts/analyze-loss-clustering.ts
 */
import { runBacktestComputation, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;

async function loadData() {
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const since = startDate.getTime() - 250 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endDate.getTime());

  const allData: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) continue;
    allData[sym] = sliceCandlesByTime(local.candles, since, endDate.getTime());
  }

  return {
    params: { startDate, endDate, initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: CANDLE_15M_MS,
  };
}

async function main() {
  console.log('V5.145 — Loss Clustering Analysis');
  console.log('═'.repeat(80));

  const data = await loadData();
  const result = await runBacktestComputation(data);
  const trades = result.trades;

  // ═══════════════════════════════════════════════════════════════
  // PART 1: Group trades by exit day
  // ═══════════════════════════════════════════════════════════════
  const byDay: Record<string, { trades: any[]; pnl: number; losses: number; wins: number }> = {};
  for (const t of trades) {
    const day = (t as any).day || t.exitTime?.slice(0, 10) || 'unknown';
    const d = byDay[day] ??= { trades: [], pnl: 0, losses: 0, wins: 0 };
    d.trades.push(t);
    d.pnl += t.netPnlUsd;
    if (t.netPnlUsd > 0) d.wins++;
    else d.losses++;
  }

  const days = Object.keys(byDay).sort();
  const lossDays = days.filter(d => byDay[d].pnl < 0);
  const winDays = days.filter(d => byDay[d].pnl >= 0);

  console.log(`\nTotal trading days: ${days.length}`);
  console.log(`Loss days: ${lossDays.length} (${(lossDays.length / days.length * 100).toFixed(0)}%)`);
  console.log(`Win days: ${winDays.length} (${(winDays.length / days.length * 100).toFixed(0)}%)`);

  // ═══════════════════════════════════════════════════════════════
  // PART 2: Distribution of losses per day
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('LOSSES PER DAY DISTRIBUTION');
  console.log('═'.repeat(80));

  const lossCountDist: Record<number, { days: number; totalLossPnl: number; totalDayPnl: number }> = {};
  for (const day of days) {
    const d = byDay[day];
    const lossCount = d.losses;
    const lossPnl = d.trades.filter((t: any) => t.netPnlUsd < 0).reduce((a: number, t: any) => a + t.netPnlUsd, 0);
    const entry = lossCountDist[lossCount] ??= { days: 0, totalLossPnl: 0, totalDayPnl: 0 };
    entry.days++;
    entry.totalLossPnl += lossPnl;
    entry.totalDayPnl += d.pnl;
  }

  console.log(`${'Losses/day'.padEnd(12)} ${'Days'.padStart(5)} ${'Loss PnL'.padStart(10)} ${'Day Net PnL'.padStart(12)} ${'Avg Loss/day'.padStart(12)}`);
  console.log('-'.repeat(55));
  for (const [count, data] of Object.entries(lossCountDist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(
      `${(count + ' losses').padEnd(12)} ${String(data.days).padStart(5)} ` +
      `$${data.totalLossPnl.toFixed(0).padStart(9)} ` +
      `$${data.totalDayPnl.toFixed(0).padStart(11)} ` +
      `$${(data.totalDayPnl / data.days).toFixed(0).padStart(11)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 3: Worst days analysis
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('TOP 20 WORST DAYS (by PnL)');
  console.log('═'.repeat(80));
  console.log(`${'Day'.padEnd(12)} ${'Trades'.padStart(6)} ${'Wins'.padStart(5)} ${'Loss'.padStart(5)} ${'PnL$'.padStart(8)} ${'Loss PnL'.padStart(10)} ${'Exit Reasons'.padStart(30)}`);
  console.log('-'.repeat(80));

  const sortedDays = [...days].sort((a, b) => byDay[a].pnl - byDay[b].pnl);
  for (const day of sortedDays.slice(0, 20)) {
    const d = byDay[day];
    const exitReasons: Record<string, number> = {};
    for (const t of d.trades) {
      const reason = t.exitReason?.replace('EXIT_', '') || 'unknown';
      exitReasons[reason] = (exitReasons[reason] || 0) + 1;
    }
    const reasonStr = Object.entries(exitReasons).map(([r, c]) => `${r}:${c}`).join(' ');
    const lossPnl = d.trades.filter((t: any) => t.netPnlUsd < 0).reduce((a: number, t: any) => a + t.netPnlUsd, 0);
    console.log(
      `${day.padEnd(12)} ${String(d.trades.length).padStart(6)} ${String(d.wins).padStart(5)} ${String(d.losses).padStart(5)} ` +
      `$${d.pnl.toFixed(0).padStart(7)} $${lossPnl.toFixed(0).padStart(9)} ${reasonStr}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 4: Sequential loss analysis within days
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('SEQUENTIAL LOSSES WITHIN DAYS');
  console.log('If we stop after N losses in a day, how many trades do we skip?');
  console.log('═'.repeat(80));

  // Sort trades by exit time within each day
  for (const day of days) {
    byDay[day].trades.sort((a: any, b: any) => {
      const aTime = a.exitTime || a.exitTs || '';
      const bTime = b.exitTime || b.exitTs || '';
      return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
    });
  }

  // Simulate: after N losses in a day, skip remaining trades
  for (const maxLosses of [1, 2, 3, 4, 5]) {
    let keptTrades = 0;
    let keptPnl = 0;
    let skippedTrades = 0;
    let skippedPnl = 0;
    let skippedLosses = 0;
    let skippedWins = 0;

    for (const day of days) {
      let dailyLosses = 0;
      let stopped = false;

      for (const t of byDay[day].trades) {
        if (stopped) {
          skippedTrades++;
          skippedPnl += t.netPnlUsd;
          if (t.netPnlUsd > 0) skippedWins++;
          else skippedLosses++;
          continue;
        }

        keptTrades++;
        keptPnl += t.netPnlUsd;

        if (t.netPnlUsd < 0) {
          dailyLosses++;
          if (dailyLosses >= maxLosses) {
            stopped = true;
          }
        }
      }
    }

    const baselinePnl = result.summary.totalPnlUsd;
    console.log(
      `\n  Stop after ${maxLosses} loss${maxLosses > 1 ? 'es' : ''}/day:` +
      `\n    Kept:    ${keptTrades} trades, $${keptPnl.toFixed(0)} PnL` +
      `\n    Skipped: ${skippedTrades} trades (${skippedWins}W/${skippedLosses}L), $${skippedPnl.toFixed(0)} PnL` +
      `\n    Net:     $${keptPnl.toFixed(0)} vs baseline $${baselinePnl.toFixed(0)} (${keptPnl > baselinePnl ? '+' : ''}$${(keptPnl - baselinePnl).toFixed(0)})` +
      `\n    Skipped avg: $${skippedTrades > 0 ? (skippedPnl / skippedTrades).toFixed(1) : '0'}/trade`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 5: Loss streaks (consecutive losses across days)
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('CONSECUTIVE LOSS STREAKS (across all trades chronologically)');
  console.log('═'.repeat(80));

  // Sort all trades chronologically
  const sortedTrades = [...trades].sort((a: any, b: any) => {
    const aTime = a.exitTime || a.exitTs || '';
    const bTime = b.exitTime || b.exitTs || '';
    return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
  });

  let currentStreak = 0;
  let maxStreak = 0;
  const streaks: number[] = [];
  let streakPnls: number[][] = [];
  let currentStreakPnls: number[] = [];

  for (const t of sortedTrades) {
    if (t.netPnlUsd < 0) {
      currentStreak++;
      currentStreakPnls.push(t.netPnlUsd);
    } else {
      if (currentStreak > 0) {
        streaks.push(currentStreak);
        streakPnls.push(currentStreakPnls);
        maxStreak = Math.max(maxStreak, currentStreak);
      }
      currentStreak = 0;
      currentStreakPnls = [];
    }
  }
  if (currentStreak > 0) {
    streaks.push(currentStreak);
    streakPnls.push(currentStreakPnls);
  }

  console.log(`Max consecutive losses: ${maxStreak}`);
  console.log(`\nStreak distribution:`);
  const streakDist: Record<number, { count: number; totalPnl: number }> = {};
  for (let i = 0; i < streaks.length; i++) {
    const len = streaks[i];
    const pnl = streakPnls[i].reduce((a, b) => a + b, 0);
    const entry = streakDist[len] ??= { count: 0, totalPnl: 0 };
    entry.count++;
    entry.totalPnl += pnl;
  }
  console.log(`${'Length'.padStart(8)} ${'Count'.padStart(6)} ${'Total PnL'.padStart(10)} ${'Avg PnL'.padStart(10)}`);
  for (const [len, data] of Object.entries(streakDist).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(
      `${(len + ' losses').padStart(8)} ${String(data.count).padStart(6)} $${data.totalPnl.toFixed(0).padStart(9)} $${(data.totalPnl / data.count).toFixed(0).padStart(9)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 6: DD contribution by worst days
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(80));
  console.log('DD CONTRIBUTION: How much do the worst N days cost?');
  console.log('═'.repeat(80));

  const dayPnls = days.map(d => ({ day: d, pnl: byDay[d].pnl, trades: byDay[d].trades.length }));
  dayPnls.sort((a, b) => a.pnl - b.pnl);

  let cumLoss = 0;
  const totalPnl = result.summary.totalPnlUsd;
  for (const n of [1, 2, 3, 5, 7, 10, 15, 20]) {
    const worstN = dayPnls.slice(0, n);
    const worstPnl = worstN.reduce((a, d) => a + d.pnl, 0);
    const withoutWorst = totalPnl - worstPnl;
    console.log(
      `  Remove worst ${String(n).padStart(2)} days: skip $${worstPnl.toFixed(0).padStart(7)} loss → PnL would be $${withoutWorst.toFixed(0).padStart(7)} ` +
      `(+$${(-worstPnl).toFixed(0)}, ${(worstN.reduce((a, d) => a + d.trades, 0))} trades)`
    );
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
