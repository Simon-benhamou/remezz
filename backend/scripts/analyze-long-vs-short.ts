/**
 * Analyze LONG vs SHORT performance of the V5.141 momentum strategy
 *
 * Questions answered:
 * 1. LONG vs SHORT split: count, WR%, total PnL, avg PnL/trade
 * 2. Exit reason breakdown by side
 * 3. Monthly breakdown by side
 * 4. grossPnlPct distribution by side (max favorable excursion proxy)
 * 5. Average hold time by side and exit reason
 *
 * Usage: npx tsx scripts/analyze-long-vs-short.ts
 */
import { runBacktestComputation, type BacktestResult, type BacktestTrade } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════
const SYMBOLS = MomentumConfig.SYMBOLS;

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
  postProcess1m: false,
};

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * CANDLE_15M_MS;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  const btcCandlesRegime = btcCandles;
  console.log(`BTC regime: using 15m candles directly (${btcCandlesRegime.length})`);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`No data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
    console.log(`${symbol}: ${allData[symbol].length} candles`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const CANDLE_REGIME_INTERVAL_MS = configTfMin * 60 * 1000;

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS };
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY: Sharpe ratio from array of PnL values
// ═══════════════════════════════════════════════════════════════════════
function calcSharpe(pnlValues: number[]): number {
  if (pnlValues.length < 2) return 0;
  const mean = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
  const variance = pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnlValues.length - 1);
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  // Annualize: assume ~2 trades/day avg, 365 days
  const tradesPerYear = 365 * 2;
  return (mean / std) * Math.sqrt(tradesPerYear);
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY: Max drawdown from trade sequence (running capital)
// ═══════════════════════════════════════════════════════════════════════
function calcMaxDrawdown(trades: BacktestTrade[], initialCapital: number): number {
  if (trades.length === 0) return 0;
  // Sort by exit time
  const sorted = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
  let equity = initialCapital;
  let peak = equity;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY: Normalize exit reason to family
// ═══════════════════════════════════════════════════════════════════════
function exitFamily(reason: string): string {
  if (reason.startsWith('SL')) return 'SL';
  if (reason.startsWith('TRAIL')) return 'TRAIL';
  if (reason.includes('STAGNANT')) return 'STAGNANT';
  if (reason === 'REGIME_CHANGE' || reason === 'MOMENTUM_REVERSAL') return 'REGIME';
  if (reason === 'TIME') return 'TIME';
  if (reason === 'END') return 'END';
  return reason;
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYSIS
// ═══════════════════════════════════════════════════════════════════════

function analyzeByGroup(trades: BacktestTrade[], label: string, initialCapital: number) {
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
  const wr = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const sharpe = calcSharpe(trades.map(t => t.netPnlUsd));
  const dd = calcMaxDrawdown(trades, initialCapital);
  const avgHold = trades.length > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length : 0;
  const grossWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnlUsd, 0) : 0;
  const grossLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.netPnlUsd, 0)) : 0;
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  return { label, count: trades.length, wins: wins.length, losses: losses.length, wr, totalPnl, avgPnl, sharpe, dd, avgHold, pf };
}

function printGroupSummary(g: ReturnType<typeof analyzeByGroup>) {
  console.log(`\n  ${g.label}`);
  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Trades:      ${g.count} (${g.wins}W / ${g.losses}L)`);
  console.log(`  Win Rate:    ${g.wr.toFixed(1)}%`);
  console.log(`  Total PnL:   $${g.totalPnl.toFixed(2)}`);
  console.log(`  Avg PnL:     $${g.avgPnl.toFixed(2)}`);
  console.log(`  Sharpe:      ${g.sharpe.toFixed(2)}`);
  console.log(`  Max DD:      ${g.dd.toFixed(1)}%`);
  console.log(`  Avg Hold:    ${g.avgHold.toFixed(0)} min`);
  console.log(`  Profit Factor: ${g.pf === Infinity ? 'Inf' : g.pf.toFixed(2)}`);
}

// ═══════════════════════════════════════════════════════════════════════
// EXIT REASON BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════
function printExitBreakdown(trades: BacktestTrade[], label: string) {
  console.log(`\n  Exit Reasons — ${label}`);
  console.log(`  ${'─'.repeat(65)}`);

  // Group by exit family
  const byFamily: Record<string, BacktestTrade[]> = {};
  for (const t of trades) {
    const fam = exitFamily(t.exitReason);
    if (!byFamily[fam]) byFamily[fam] = [];
    byFamily[fam].push(t);
  }

  // Also group by exact reason for detail
  const byExact: Record<string, BacktestTrade[]> = {};
  for (const t of trades) {
    if (!byExact[t.exitReason]) byExact[t.exitReason] = [];
    byExact[t.exitReason].push(t);
  }

  // Print family summary
  console.log(`  ${'Exit Family'.padEnd(18)} ${'Count'.padStart(6)} ${'WR%'.padStart(7)} ${'Tot PnL'.padStart(12)} ${'Avg PnL'.padStart(10)} ${'Avg Hold'.padStart(10)}`);
  console.log(`  ${'─'.repeat(65)}`);

  const families = Object.entries(byFamily).sort((a, b) => b[1].length - a[1].length);
  for (const [fam, ftrades] of families) {
    const wins = ftrades.filter(t => t.netPnlUsd > 0).length;
    const wr = (wins / ftrades.length) * 100;
    const totPnl = ftrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const avgPnl = totPnl / ftrades.length;
    const avgHold = ftrades.reduce((s, t) => s + t.holdMinutes, 0) / ftrades.length;
    console.log(`  ${fam.padEnd(18)} ${String(ftrades.length).padStart(6)} ${wr.toFixed(1).padStart(6)}% $${totPnl.toFixed(2).padStart(11)} $${avgPnl.toFixed(2).padStart(9)} ${avgHold.toFixed(0).padStart(7)} min`);
  }

  // Print exact reason detail
  console.log(`\n  Detailed exit reasons:`);
  console.log(`  ${'Reason'.padEnd(25)} ${'Count'.padStart(6)} ${'WR%'.padStart(7)} ${'Tot PnL'.padStart(12)} ${'Avg PnL'.padStart(10)}`);
  console.log(`  ${'─'.repeat(65)}`);
  const exacts = Object.entries(byExact).sort((a, b) => b[1].length - a[1].length);
  for (const [reason, rtrades] of exacts) {
    const wins = rtrades.filter(t => t.netPnlUsd > 0).length;
    const wr = (wins / rtrades.length) * 100;
    const totPnl = rtrades.reduce((s, t) => s + t.netPnlUsd, 0);
    const avgPnl = totPnl / rtrades.length;
    console.log(`  ${reason.padEnd(25)} ${String(rtrades.length).padStart(6)} ${wr.toFixed(1).padStart(6)}% $${totPnl.toFixed(2).padStart(11)} $${avgPnl.toFixed(2).padStart(9)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MONTHLY BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════
function printMonthlyBreakdown(longs: BacktestTrade[], shorts: BacktestTrade[]) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  MONTHLY BREAKDOWN — LONG vs SHORT`);
  console.log(`${'═'.repeat(80)}`);

  // Gather all months
  const allMonths = new Set<string>();
  for (const t of [...longs, ...shorts]) allMonths.add(t.month);
  const sortedMonths = [...allMonths].sort();

  console.log(`  ${'Month'.padEnd(10)} | ${'LONG'.padEnd(35)} | ${'SHORT'.padEnd(35)} | ${'Better'}`);
  console.log(`  ${''.padEnd(10)} | ${'Cnt'.padStart(4)} ${'WR%'.padStart(6)} ${'PnL'.padStart(12)} ${'AvgPnl'.padStart(10)} | ${'Cnt'.padStart(4)} ${'WR%'.padStart(6)} ${'PnL'.padStart(12)} ${'AvgPnl'.padStart(10)} |`);
  console.log(`  ${'─'.repeat(95)}`);

  let longMonthWins = 0;
  let shortMonthWins = 0;

  for (const m of sortedMonths) {
    const ml = longs.filter(t => t.month === m);
    const ms = shorts.filter(t => t.month === m);

    const lwins = ml.filter(t => t.netPnlUsd > 0).length;
    const lwr = ml.length > 0 ? (lwins / ml.length) * 100 : 0;
    const lpnl = ml.reduce((s, t) => s + t.netPnlUsd, 0);
    const lavg = ml.length > 0 ? lpnl / ml.length : 0;

    const swins = ms.filter(t => t.netPnlUsd > 0).length;
    const swr = ms.length > 0 ? (swins / ms.length) * 100 : 0;
    const spnl = ms.reduce((s, t) => s + t.netPnlUsd, 0);
    const savg = ms.length > 0 ? spnl / ms.length : 0;

    const better = lpnl > spnl ? 'LONG' : lpnl < spnl ? 'SHORT' : 'TIE';
    if (lpnl > spnl) longMonthWins++;
    else if (spnl > lpnl) shortMonthWins++;

    console.log(
      `  ${m.padEnd(10)} | ${String(ml.length).padStart(4)} ${lwr.toFixed(1).padStart(5)}% $${lpnl.toFixed(2).padStart(11)} $${lavg.toFixed(2).padStart(9)}` +
      ` | ${String(ms.length).padStart(4)} ${swr.toFixed(1).padStart(5)}% $${spnl.toFixed(2).padStart(11)} $${savg.toFixed(2).padStart(9)}` +
      ` | ${better}`
    );
  }

  console.log(`  ${'─'.repeat(95)}`);
  console.log(`  Months won by LONG: ${longMonthWins}, by SHORT: ${shortMonthWins}`);
}

// ═══════════════════════════════════════════════════════════════════════
// GROSS PNL % DISTRIBUTION (proxy for max favorable excursion)
// ═══════════════════════════════════════════════════════════════════════
function printPnlDistribution(longs: BacktestTrade[], shorts: BacktestTrade[]) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  GROSS PnL% DISTRIBUTION — LONG vs SHORT`);
  console.log(`  (grossPnlPct = leveraged PnL% on margin before fees)`);
  console.log(`${'═'.repeat(80)}`);

  const quantiles = [0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95];

  function getQuantile(arr: number[], q: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = q * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  const longGross = longs.map(t => t.grossPnlPct);
  const shortGross = shorts.map(t => t.grossPnlPct);
  const longNet = longs.map(t => t.netPnlPct);
  const shortNet = shorts.map(t => t.netPnlPct);

  console.log(`\n  Gross PnL% quantiles:`);
  console.log(`  ${'Quantile'.padEnd(12)} ${'LONG'.padStart(10)} ${'SHORT'.padStart(10)}`);
  console.log(`  ${'─'.repeat(35)}`);
  for (const q of quantiles) {
    const lv = getQuantile(longGross, q);
    const sv = getQuantile(shortGross, q);
    console.log(`  ${`P${(q * 100).toFixed(0)}`.padEnd(12)} ${lv.toFixed(2).padStart(9)}% ${sv.toFixed(2).padStart(9)}%`);
  }

  console.log(`\n  Net PnL% quantiles:`);
  console.log(`  ${'Quantile'.padEnd(12)} ${'LONG'.padStart(10)} ${'SHORT'.padStart(10)}`);
  console.log(`  ${'─'.repeat(35)}`);
  for (const q of quantiles) {
    const lv = getQuantile(longNet, q);
    const sv = getQuantile(shortNet, q);
    console.log(`  ${`P${(q * 100).toFixed(0)}`.padEnd(12)} ${lv.toFixed(2).padStart(9)}% ${sv.toFixed(2).padStart(9)}%`);
  }

  // Big winners / big losers
  const longBigWins = longs.filter(t => t.netPnlPct > 20).length;
  const shortBigWins = shorts.filter(t => t.netPnlPct > 20).length;
  const longBigLoss = longs.filter(t => t.netPnlPct < -10).length;
  const shortBigLoss = shorts.filter(t => t.netPnlPct < -10).length;

  console.log(`\n  Big movers:`);
  console.log(`  Net PnL% > +20% (big wins):   LONG=${longBigWins}   SHORT=${shortBigWins}`);
  console.log(`  Net PnL% < -10% (big losses):  LONG=${longBigLoss}   SHORT=${shortBigLoss}`);

  // Average gross PnL for winners and losers
  const longWinGross = longs.filter(t => t.netPnlUsd > 0);
  const longLossGross = longs.filter(t => t.netPnlUsd <= 0);
  const shortWinGross = shorts.filter(t => t.netPnlUsd > 0);
  const shortLossGross = shorts.filter(t => t.netPnlUsd <= 0);

  console.log(`\n  Average Gross PnL% (winners vs losers):`);
  console.log(`  LONG  winners:  ${longWinGross.length > 0 ? (longWinGross.reduce((s, t) => s + t.grossPnlPct, 0) / longWinGross.length).toFixed(2) : 'N/A'}%  (${longWinGross.length} trades)`);
  console.log(`  LONG  losers:   ${longLossGross.length > 0 ? (longLossGross.reduce((s, t) => s + t.grossPnlPct, 0) / longLossGross.length).toFixed(2) : 'N/A'}%  (${longLossGross.length} trades)`);
  console.log(`  SHORT winners:  ${shortWinGross.length > 0 ? (shortWinGross.reduce((s, t) => s + t.grossPnlPct, 0) / shortWinGross.length).toFixed(2) : 'N/A'}%  (${shortWinGross.length} trades)`);
  console.log(`  SHORT losers:   ${shortLossGross.length > 0 ? (shortLossGross.reduce((s, t) => s + t.grossPnlPct, 0) / shortLossGross.length).toFixed(2) : 'N/A'}%  (${shortLossGross.length} trades)`);
}

// ═══════════════════════════════════════════════════════════════════════
// HOLD TIME BY SIDE AND EXIT REASON
// ═══════════════════════════════════════════════════════════════════════
function printHoldTimeBreakdown(longs: BacktestTrade[], shorts: BacktestTrade[]) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  AVERAGE HOLD TIME — BY SIDE AND EXIT FAMILY`);
  console.log(`${'═'.repeat(80)}`);

  function holdByFamily(trades: BacktestTrade[]): Record<string, { count: number; totalHold: number }> {
    const result: Record<string, { count: number; totalHold: number }> = {};
    for (const t of trades) {
      const fam = exitFamily(t.exitReason);
      if (!result[fam]) result[fam] = { count: 0, totalHold: 0 };
      result[fam].count++;
      result[fam].totalHold += t.holdMinutes;
    }
    return result;
  }

  const longHold = holdByFamily(longs);
  const shortHold = holdByFamily(shorts);
  const allFamilies = new Set([...Object.keys(longHold), ...Object.keys(shortHold)]);

  console.log(`  ${'Exit Family'.padEnd(18)} | ${'LONG'.padEnd(22)} | ${'SHORT'.padEnd(22)}`);
  console.log(`  ${''.padEnd(18)} | ${'Cnt'.padStart(5)} ${'Avg min'.padStart(10)} ${'Hrs'.padStart(6)} | ${'Cnt'.padStart(5)} ${'Avg min'.padStart(10)} ${'Hrs'.padStart(6)}`);
  console.log(`  ${'─'.repeat(70)}`);

  for (const fam of [...allFamilies].sort()) {
    const l = longHold[fam] || { count: 0, totalHold: 0 };
    const s = shortHold[fam] || { count: 0, totalHold: 0 };
    const lAvg = l.count > 0 ? l.totalHold / l.count : 0;
    const sAvg = s.count > 0 ? s.totalHold / s.count : 0;
    console.log(
      `  ${fam.padEnd(18)} | ${String(l.count).padStart(5)} ${lAvg.toFixed(0).padStart(10)} ${(lAvg / 60).toFixed(1).padStart(5)}h` +
      ` | ${String(s.count).padStart(5)} ${sAvg.toFixed(0).padStart(10)} ${(sAvg / 60).toFixed(1).padStart(5)}h`
    );
  }

  // Overall
  const lAvgAll = longs.length > 0 ? longs.reduce((s, t) => s + t.holdMinutes, 0) / longs.length : 0;
  const sAvgAll = shorts.length > 0 ? shorts.reduce((s, t) => s + t.holdMinutes, 0) / shorts.length : 0;
  console.log(`  ${'─'.repeat(70)}`);
  console.log(
    `  ${'ALL'.padEnd(18)} | ${String(longs.length).padStart(5)} ${lAvgAll.toFixed(0).padStart(10)} ${(lAvgAll / 60).toFixed(1).padStart(5)}h` +
    ` | ${String(shorts.length).padStart(5)} ${sAvgAll.toFixed(0).padStart(10)} ${(sAvgAll / 60).toFixed(1).padStart(5)}h`
  );
}

// ═══════════════════════════════════════════════════════════════════════
// PER-SYMBOL LONG vs SHORT
// ═══════════════════════════════════════════════════════════════════════
function printPerSymbol(trades: BacktestTrade[]) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  PER-SYMBOL — LONG vs SHORT`);
  console.log(`${'═'.repeat(80)}`);

  const bySymbol: Record<string, BacktestTrade[]> = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }

  console.log(`  ${'Symbol'.padEnd(18)} | ${'LONG'.padEnd(35)} | ${'SHORT'.padEnd(35)}`);
  console.log(`  ${''.padEnd(18)} | ${'Cnt'.padStart(4)} ${'WR%'.padStart(6)} ${'PnL'.padStart(12)} ${'AvgPnl'.padStart(10)} | ${'Cnt'.padStart(4)} ${'WR%'.padStart(6)} ${'PnL'.padStart(12)} ${'AvgPnl'.padStart(10)}`);
  console.log(`  ${'─'.repeat(90)}`);

  const symbols = Object.keys(bySymbol).sort();
  for (const sym of symbols) {
    const syml = bySymbol[sym].filter(t => t.side === 'long');
    const syms = bySymbol[sym].filter(t => t.side === 'short');

    const lwins = syml.filter(t => t.netPnlUsd > 0).length;
    const lwr = syml.length > 0 ? (lwins / syml.length) * 100 : 0;
    const lpnl = syml.reduce((s, t) => s + t.netPnlUsd, 0);
    const lavg = syml.length > 0 ? lpnl / syml.length : 0;

    const swins = syms.filter(t => t.netPnlUsd > 0).length;
    const swr = syms.length > 0 ? (swins / syms.length) * 100 : 0;
    const spnl = syms.reduce((s, t) => s + t.netPnlUsd, 0);
    const savg = syms.length > 0 ? spnl / syms.length : 0;

    console.log(
      `  ${sym.padEnd(18)} | ${String(syml.length).padStart(4)} ${lwr.toFixed(1).padStart(5)}% $${lpnl.toFixed(2).padStart(11)} $${lavg.toFixed(2).padStart(9)}` +
      ` | ${String(syms.length).padStart(4)} ${swr.toFixed(1).padStart(5)}% $${spnl.toFixed(2).padStart(11)} $${savg.toFixed(2).padStart(9)}`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  LONG vs SHORT Analysis — V5.141 Momentum Strategy');
  console.log('  Period: Jan 2025 - Dec 2025 | Capital: $2,000 | Leverage: 5x');
  console.log(`  Symbols: ${SYMBOLS.join(', ')}`);
  console.log('═══════════════════════════════════════════════════════════════════');

  console.log('\nLoading data...');
  const data = await loadData();

  console.log('\nRunning backtest...');
  const t0 = Date.now();
  const result = await runBacktestComputation({
    params: PARAMS,
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandlesRegime,
    allData: data.allData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Backtest completed in ${elapsed}s — ${result.trades.length} trades`);

  const trades = result.trades;
  const longs = trades.filter(t => t.side === 'long');
  const shorts = trades.filter(t => t.side === 'short');

  // ─── 0. Overall summary ───
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  OVERALL SUMMARY`);
  console.log(`${'═'.repeat(80)}`);
  const s = result.summary;
  console.log(`  Trades: ${s.totalTrades} (${s.longTrades}L / ${s.shortTrades}S)`);
  console.log(`  LONG %: ${((s.longTrades / s.totalTrades) * 100).toFixed(1)}%  |  SHORT %: ${((s.shortTrades / s.totalTrades) * 100).toFixed(1)}%`);
  console.log(`  WR: ${s.winRate.toFixed(1)}% | PnL: $${s.totalPnlUsd.toFixed(2)} | DD: ${s.maxDrawdownPct.toFixed(1)}% | Sharpe: ${s.sharpeRatio.toFixed(2)} | PF: ${s.profitFactor.toFixed(2)}`);
  console.log(`  Final Capital: $${s.finalCapital.toFixed(2)} | Fees: $${s.totalFeesUsd.toFixed(2)}`);

  // ─── 1. LONG vs SHORT split ───
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 1: LONG vs SHORT SPLIT`);
  console.log(`${'═'.repeat(80)}`);

  const longStats = analyzeByGroup(longs, 'LONG trades', PARAMS.initialCapital);
  const shortStats = analyzeByGroup(shorts, 'SHORT trades', PARAMS.initialCapital);
  printGroupSummary(longStats);
  printGroupSummary(shortStats);

  // Verdict
  console.log(`\n  ${'─'.repeat(50)}`);
  const pnlDiff = longStats.totalPnl - shortStats.totalPnl;
  const wrDiff = longStats.wr - shortStats.wr;
  console.log(`  PnL diff (LONG - SHORT):  $${pnlDiff.toFixed(2)}`);
  console.log(`  WR diff (LONG - SHORT):   ${wrDiff > 0 ? '+' : ''}${wrDiff.toFixed(1)}pp`);
  if (shortStats.totalPnl < 0) {
    console.log(`  >>> SHORT side is NEGATIVE ($${shortStats.totalPnl.toFixed(2)}) — dragging LONG down`);
  } else if (longStats.totalPnl < 0) {
    console.log(`  >>> LONG side is NEGATIVE ($${longStats.totalPnl.toFixed(2)}) — dragging SHORT down`);
  } else {
    console.log(`  >>> Both sides profitable — no drag`);
  }

  // ─── 2. Exit reason breakdown ───
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  SECTION 2: EXIT REASON BREAKDOWN BY SIDE`);
  console.log(`${'═'.repeat(80)}`);
  printExitBreakdown(longs, 'LONG');
  printExitBreakdown(shorts, 'SHORT');

  // ─── 3. Monthly breakdown ───
  printMonthlyBreakdown(longs, shorts);

  // ─── 4. PnL distribution ───
  printPnlDistribution(longs, shorts);

  // ─── 5. Hold time by side + exit ───
  printHoldTimeBreakdown(longs, shorts);

  // ─── 6. Per-symbol ───
  printPerSymbol(trades);

  // ─── Final verdict ───
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  FINAL VERDICT`);
  console.log(`${'═'.repeat(80)}`);

  const longPctOfPnl = s.totalPnlUsd !== 0 ? (longStats.totalPnl / s.totalPnlUsd * 100) : 0;
  const shortPctOfPnl = s.totalPnlUsd !== 0 ? (shortStats.totalPnl / s.totalPnlUsd * 100) : 0;

  console.log(`  LONG  contributes ${longPctOfPnl.toFixed(1)}% of total PnL ($${longStats.totalPnl.toFixed(2)})`);
  console.log(`  SHORT contributes ${shortPctOfPnl.toFixed(1)}% of total PnL ($${shortStats.totalPnl.toFixed(2)})`);

  if (longStats.totalPnl > 0 && shortStats.totalPnl < 0) {
    const penalty = Math.abs(shortStats.totalPnl);
    console.log(`  SHORT is LOSING money — costing $${penalty.toFixed(2)} (${(penalty / longStats.totalPnl * 100).toFixed(1)}% of LONG gains)`);
    console.log(`  If SHORT was disabled, LONG-only PnL = $${longStats.totalPnl.toFixed(2)}`);
  } else if (shortStats.totalPnl > 0 && longStats.totalPnl < 0) {
    const penalty = Math.abs(longStats.totalPnl);
    console.log(`  LONG is LOSING money — costing $${penalty.toFixed(2)} (${(penalty / shortStats.totalPnl * 100).toFixed(1)}% of SHORT gains)`);
    console.log(`  If LONG was disabled, SHORT-only PnL = $${shortStats.totalPnl.toFixed(2)}`);
  } else {
    console.log(`  Both sides profitable — the strategy works on both market directions.`);
    const ratio = longStats.totalPnl > shortStats.totalPnl
      ? `LONG generates ${(longStats.totalPnl / shortStats.totalPnl).toFixed(1)}x more PnL than SHORT`
      : `SHORT generates ${(shortStats.totalPnl / longStats.totalPnl).toFixed(1)}x more PnL than LONG`;
    console.log(`  ${ratio}`);
  }
  console.log('');
}

main().catch(console.error);
