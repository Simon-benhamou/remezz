/**
 * analyze-november-2025.ts — Deep analysis of November 2025 performance
 *
 * Runs V5.145 backtest for full year, extracts November trades,
 * compares BTC market conditions month-by-month, and identifies
 * what specifically made November bad.
 *
 * Usage:
 *   cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsx scripts/analyze-november-2025.ts
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import { calcSMA, calcATR, calcADX } from '../src/strategies/momentumSimple.js';

// ============================================================================
// CONFIG
// ============================================================================
const SYMBOLS = MomentumConfig.SYMBOLS;
const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T23:59:59.999Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ============================================================================
// HELPERS
// ============================================================================
const padR = (s: string, n: number) => s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
const padL = (s: string, n: number) => s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s;
const pct = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
const usd = (v: number) => (v >= 0 ? '+' : '') + '$' + v.toFixed(0);
const divider = (title: string) => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(80));
};

type Candle = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * 15 * 60 * 1000; // warmup for indicators
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');

  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandlesRegime = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`  WARN: No data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// BTC MONTHLY MARKET STATS (from 15m candles)
// ============================================================================
interface MonthlyBtcStats {
  month: string;
  monthIdx: number;
  openPrice: number;
  closePrice: number;
  highPrice: number;
  lowPrice: number;
  priceChangePct: number;
  rangePct: number; // (high-low)/open * 100
  avgAtrPct: number;
  avgAdx: number;
  bullCandles: number;
  bearCandles: number;
  bullRatio: number;
  regimeFlips: number;
  avgVolume: number;
  volatilityScore: number; // composite
}

function computeMonthlyBtcStats(btcCandles: Candle[]): MonthlyBtcStats[] {
  const stats: MonthlyBtcStats[] = [];

  for (let m = 0; m < 12; m++) {
    const monthStart = new Date(Date.UTC(2025, m, 1)).getTime();
    const monthEnd = new Date(Date.UTC(2025, m + 1, 1)).getTime();

    // Get candles for this month
    const monthCandles = btcCandles.filter(c => c.timestamp >= monthStart && c.timestamp < monthEnd);
    if (monthCandles.length === 0) continue;

    // Price stats
    const openPrice = monthCandles[0].open;
    const closePrice = monthCandles[monthCandles.length - 1].close;
    const highPrice = Math.max(...monthCandles.map(c => c.high));
    const lowPrice = Math.min(...monthCandles.map(c => c.low));
    const priceChangePct = ((closePrice - openPrice) / openPrice) * 100;
    const rangePct = ((highPrice - lowPrice) / openPrice) * 100;

    // ATR% — compute ATR on rolling 14-candle windows, then average
    const atrValues: number[] = [];
    for (let i = 14; i < monthCandles.length; i++) {
      const window = monthCandles.slice(i - 14, i + 1);
      const atr = calcATR(window, 14);
      if (atr !== null && atr > 0) {
        atrValues.push((atr / window[window.length - 1].close) * 100);
      }
    }
    const avgAtrPct = atrValues.length > 0 ? atrValues.reduce((a, b) => a + b, 0) / atrValues.length : 0;

    // ADX — compute ADX on rolling windows
    const adxValues: number[] = [];
    for (let i = 30; i < monthCandles.length; i += 4) { // sample every 4 candles for speed
      const window = monthCandles.slice(Math.max(0, i - 30), i + 1);
      const adx = calcADX(window, 14);
      if (adx > 0) adxValues.push(adx);
    }
    const avgAdx = adxValues.length > 0 ? adxValues.reduce((a, b) => a + b, 0) / adxValues.length : 0;

    // Regime — use SMA200 on 15m candles (same as strategy)
    // For each candle, determine if BTC is above/below SMA200 on the available data
    // We need 200+ candles before this month for SMA200
    let bullCandles = 0;
    let bearCandles = 0;
    let regimeFlips = 0;
    let prevRegime: 'bull' | 'bear' | null = null;

    for (const candle of monthCandles) {
      // Find this candle's index in the full array
      const idx = btcCandles.indexOf(candle);
      if (idx < 200) continue;

      const closes = btcCandles.slice(idx - 199, idx + 1).map(c => c.close);
      const sma200 = calcSMA(closes, 200);
      if (sma200 === null) continue;

      const regime = candle.close > sma200 ? 'bull' : 'bear';
      if (regime === 'bull') bullCandles++;
      else bearCandles++;

      if (prevRegime !== null && regime !== prevRegime) regimeFlips++;
      prevRegime = regime;
    }

    const totalRegimeCandles = bullCandles + bearCandles;
    const bullRatio = totalRegimeCandles > 0 ? bullCandles / totalRegimeCandles : 0;

    // Volume
    const avgVolume = monthCandles.reduce((s, c) => s + c.volume, 0) / monthCandles.length;

    // Composite volatility score
    const volatilityScore = avgAtrPct * 100 + rangePct;

    stats.push({
      month: `2025-${String(m + 1).padStart(2, '0')}`,
      monthIdx: m,
      openPrice, closePrice, highPrice, lowPrice,
      priceChangePct, rangePct,
      avgAtrPct, avgAdx,
      bullCandles, bearCandles, bullRatio,
      regimeFlips, avgVolume,
      volatilityScore,
    });
  }

  return stats;
}

// ============================================================================
// TRADE ANALYSIS
// ============================================================================
interface TradeStats {
  trades: any[];
  count: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgHoldMinutes: number;
  longCount: number;
  shortCount: number;
  longPnl: number;
  shortPnl: number;
  longWR: number;
  shortWR: number;
  exitReasons: Record<string, { count: number; pnl: number; avgPnl: number }>;
  symbolBreakdown: Record<string, { count: number; pnl: number; wr: number }>;
}

function analyzeTradeGroup(trades: any[]): TradeStats {
  const count = trades.length;
  const wins = trades.filter(t => t.netPnlUsd > 0).length;
  const losses = count - wins;
  const winRate = count > 0 ? (wins / count) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const avgPnl = count > 0 ? totalPnl / count : 0;
  const avgHoldMinutes = count > 0 ? trades.reduce((s, t) => s + t.holdMinutes, 0) / count : 0;

  const longTrades = trades.filter(t => t.side === 'long');
  const shortTrades = trades.filter(t => t.side === 'short');
  const longPnl = longTrades.reduce((s, t) => s + t.netPnlUsd, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.netPnlUsd, 0);
  const longWR = longTrades.length > 0 ? (longTrades.filter(t => t.netPnlUsd > 0).length / longTrades.length) * 100 : 0;
  const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => t.netPnlUsd > 0).length / shortTrades.length) * 100 : 0;

  const exitReasons: Record<string, { count: number; pnl: number; avgPnl: number }> = {};
  for (const t of trades) {
    const r = t.exitReason || 'UNKNOWN';
    if (!exitReasons[r]) exitReasons[r] = { count: 0, pnl: 0, avgPnl: 0 };
    exitReasons[r].count++;
    exitReasons[r].pnl += t.netPnlUsd;
  }
  for (const r of Object.values(exitReasons)) {
    r.avgPnl = r.count > 0 ? r.pnl / r.count : 0;
  }

  const symbolBreakdown: Record<string, { count: number; pnl: number; wr: number }> = {};
  for (const t of trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    if (!symbolBreakdown[sym]) symbolBreakdown[sym] = { count: 0, pnl: 0, wr: 0 };
    symbolBreakdown[sym].count++;
    symbolBreakdown[sym].pnl += t.netPnlUsd;
    if (t.netPnlUsd > 0) symbolBreakdown[sym].wr++;
  }

  return {
    trades, count, wins, losses, winRate, totalPnl, avgPnl, avgHoldMinutes,
    longCount: longTrades.length, shortCount: shortTrades.length,
    longPnl, shortPnl, longWR, shortWR,
    exitReasons, symbolBreakdown,
  };
}

function getMonthKey(trade: any): string {
  return trade.exitTime.slice(0, 7); // "2025-01"
}

function getWeekKey(trade: any): string {
  const d = new Date(trade.exitTime);
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - dayOfWeek + 1);
  return d.toISOString().slice(0, 10);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== November 2025 Deep Analysis (V5.145) ===\n');

  // ── 1. Load data ─────────────────────────────────────────────────────
  console.log('Loading candle data...');
  const data = await loadData();
  console.log(`  BTC 15m candles: ${data.btcCandles.length}`);
  console.log(`  Symbols: ${SYMBOLS.length}`);

  // ── 2. Run backtest ──────────────────────────────────────────────────
  console.log('\nRunning full year 2025 backtest...');
  const input: BacktestComputationInput = {
    params: PARAMS,
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandlesRegime,
    allData: data.allData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };

  const result = await runBacktestComputation(input);
  const allTrades = result.trades;
  console.log(`  Total: ${allTrades.length} trades, ${usd(result.summary.totalPnlUsd)} PnL, ${result.summary.winRate.toFixed(1)}% WR, DD ${result.summary.maxDrawdownPct.toFixed(1)}%`);

  // ── 3. BTC monthly market stats ──────────────────────────────────────
  divider('SECTION 1: BTC MONTHLY MARKET CONDITIONS');

  const btcStats = computeMonthlyBtcStats(data.btcCandles);

  console.log('\n' + [
    padR('Month', 10), padL('Open$', 8), padL('Close$', 8), padL('Chg%', 8),
    padL('Range%', 8), padL('ATR%', 7), padL('ADX', 5),
    padL('Bull%', 7), padL('Flips', 6), padL('AvgVol', 10),
  ].join(' | '));
  console.log('-'.repeat(105));

  for (const s of btcStats) {
    const monthLabel = `${MONTH_NAMES[s.monthIdx]} 2025`;
    const highlight = s.monthIdx === 10 ? ' <<<' : '';
    console.log([
      padR(monthLabel, 10),
      padL(s.openPrice.toFixed(0), 8),
      padL(s.closePrice.toFixed(0), 8),
      padL(pct(s.priceChangePct), 8),
      padL(s.rangePct.toFixed(1) + '%', 8),
      padL(s.avgAtrPct.toFixed(3), 7),
      padL(s.avgAdx.toFixed(0), 5),
      padL((s.bullRatio * 100).toFixed(0) + '%', 7),
      padL(String(s.regimeFlips), 6),
      padL(s.avgVolume.toFixed(0), 10),
    ].join(' | ') + highlight);
  }

  // Highlight November vs average
  const nov = btcStats.find(s => s.monthIdx === 10);
  const otherMonths = btcStats.filter(s => s.monthIdx !== 10);
  if (nov && otherMonths.length > 0) {
    const avgOther = (key: keyof MonthlyBtcStats) => {
      const vals = otherMonths.map(s => s[key] as number);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    console.log(`\n--- November vs Rest-of-Year Averages ---`);
    console.log(`  Price change:  Nov ${pct(nov.priceChangePct)} vs avg ${pct(avgOther('priceChangePct'))}`);
    console.log(`  Range:         Nov ${nov.rangePct.toFixed(1)}% vs avg ${avgOther('rangePct').toFixed(1)}%`);
    console.log(`  ATR% (vol):    Nov ${nov.avgAtrPct.toFixed(3)} vs avg ${avgOther('avgAtrPct').toFixed(3)}`);
    console.log(`  ADX (trend):   Nov ${nov.avgAdx.toFixed(0)} vs avg ${avgOther('avgAdx').toFixed(0)}`);
    console.log(`  Bull ratio:    Nov ${(nov.bullRatio * 100).toFixed(0)}% vs avg ${(avgOther('bullRatio') * 100).toFixed(0)}%`);
    console.log(`  Regime flips:  Nov ${nov.regimeFlips} vs avg ${avgOther('regimeFlips').toFixed(1)}`);
  }

  // ── 4. Monthly trade performance ─────────────────────────────────────
  divider('SECTION 2: MONTHLY TRADE PERFORMANCE');

  const byMonth = new Map<string, any[]>();
  for (const t of allTrades) {
    const mk = getMonthKey(t);
    if (!byMonth.has(mk)) byMonth.set(mk, []);
    byMonth.get(mk)!.push(t);
  }

  console.log('\n' + [
    padR('Month', 10), padL('#Tr', 5), padL('Wins', 5), padL('WR%', 7),
    padL('PnL$', 10), padL('AvgPnl$', 9), padL('AvgHold', 8),
    padL('L/S', 8), padL('L_PnL$', 9), padL('S_PnL$', 9),
  ].join(' | '));
  console.log('-'.repeat(110));

  let cumPnl = 0;
  for (const [month, trades] of [...byMonth.entries()].sort()) {
    const s = analyzeTradeGroup(trades);
    cumPnl += s.totalPnl;
    const highlight = month === '2025-11' ? ' <<<' : '';
    console.log([
      padR(month, 10),
      padL(String(s.count), 5),
      padL(String(s.wins), 5),
      padL(s.winRate.toFixed(1), 7),
      padL(usd(s.totalPnl), 10),
      padL(usd(s.avgPnl), 9),
      padL(Math.round(s.avgHoldMinutes) + 'm', 8),
      padL(`${s.longCount}/${s.shortCount}`, 8),
      padL(usd(s.longPnl), 9),
      padL(usd(s.shortPnl), 9),
    ].join(' | ') + highlight);
  }

  // ── 5. November trades deep-dive ─────────────────────────────────────
  divider('SECTION 3: NOVEMBER 2025 DEEP DIVE');

  const novTrades = allTrades.filter(t => getMonthKey(t) === '2025-11');
  const restTrades = allTrades.filter(t => getMonthKey(t) !== '2025-11');
  const novStats = analyzeTradeGroup(novTrades);
  const restStats = analyzeTradeGroup(restTrades);

  console.log('\n--- November vs Rest of Year ---');
  console.log(`  Metric              November          Rest of Year`);
  console.log(`  Trades:             ${padL(String(novStats.count), 6)}                ${padL(String(restStats.count), 6)}`);
  console.log(`  Win rate:           ${padL(novStats.winRate.toFixed(1) + '%', 6)}                ${padL(restStats.winRate.toFixed(1) + '%', 6)}`);
  console.log(`  Total PnL:          ${padL(usd(novStats.totalPnl), 8)}              ${padL(usd(restStats.totalPnl), 8)}`);
  console.log(`  Avg PnL/trade:      ${padL(usd(novStats.avgPnl), 8)}              ${padL(usd(restStats.avgPnl), 8)}`);
  console.log(`  Avg hold:           ${padL(Math.round(novStats.avgHoldMinutes) + 'm', 6)}                ${padL(Math.round(restStats.avgHoldMinutes) + 'm', 6)}`);
  console.log(`  Long WR:            ${padL(novStats.longWR.toFixed(1) + '%', 6)}                ${padL(restStats.longWR.toFixed(1) + '%', 6)}`);
  console.log(`  Short WR:           ${padL(novStats.shortWR.toFixed(1) + '%', 6)}                ${padL(restStats.shortWR.toFixed(1) + '%', 6)}`);
  console.log(`  Long PnL:           ${padL(usd(novStats.longPnl), 8)}              ${padL(usd(restStats.longPnl), 8)}`);
  console.log(`  Short PnL:          ${padL(usd(novStats.shortPnl), 8)}              ${padL(usd(restStats.shortPnl), 8)}`);
  console.log(`  L/S ratio:          ${padL(`${novStats.longCount}/${novStats.shortCount}`, 8)}              ${padL(`${restStats.longCount}/${restStats.shortCount}`, 8)}`);

  // ── 5a. Exit reason breakdown November vs rest ───────────────────────
  console.log('\n--- Exit Reason Breakdown ---');
  console.log([
    padR('Exit Reason', 25), padL('#Nov', 5), padL('PnL$', 8), padL('Avg$', 7),
    '|', padL('#Rest', 6), padL('PnL$', 9), padL('Avg$', 7),
  ].join(' '));
  console.log('-'.repeat(90));

  const allReasons = new Set([...Object.keys(novStats.exitReasons), ...Object.keys(restStats.exitReasons)]);
  for (const reason of [...allReasons].sort()) {
    const nv = novStats.exitReasons[reason] || { count: 0, pnl: 0, avgPnl: 0 };
    const rs = restStats.exitReasons[reason] || { count: 0, pnl: 0, avgPnl: 0 };
    console.log([
      padR(reason, 25),
      padL(String(nv.count), 5),
      padL(usd(nv.pnl), 8),
      padL(usd(nv.avgPnl), 7),
      '|',
      padL(String(rs.count), 6),
      padL(usd(rs.pnl), 9),
      padL(usd(rs.avgPnl), 7),
    ].join(' '));
  }

  // ── 5b. Per-symbol performance November vs rest ──────────────────────
  console.log('\n--- Per-Symbol Performance: November vs Rest ---');
  console.log([
    padR('Symbol', 10),
    padL('#Nov', 5), padL('NovWR%', 7), padL('NovPnL$', 9),
    '|',
    padL('#Rest', 6), padL('RestWR%', 8), padL('RestPnL$', 10),
    '|', padL('Delta$', 8),
  ].join(' '));
  console.log('-'.repeat(95));

  const allSymbols = new Set([...Object.keys(novStats.symbolBreakdown), ...Object.keys(restStats.symbolBreakdown)]);
  for (const sym of [...allSymbols].sort()) {
    const nv = novStats.symbolBreakdown[sym] || { count: 0, pnl: 0, wr: 0 };
    const rs = restStats.symbolBreakdown[sym] || { count: 0, pnl: 0, wr: 0 };
    const nvWR = nv.count > 0 ? (nv.wr / nv.count * 100).toFixed(1) : 'N/A';
    const rsWR = rs.count > 0 ? (rs.wr / rs.count * 100).toFixed(1) : 'N/A';
    const avgPnlNov = nv.count > 0 ? nv.pnl / nv.count : 0;
    console.log([
      padR(sym, 10),
      padL(String(nv.count), 5),
      padL(nvWR, 7),
      padL(usd(nv.pnl), 9),
      '|',
      padL(String(rs.count), 6),
      padL(rsWR, 8),
      padL(usd(rs.pnl), 10),
      '|',
      padL(usd(nv.pnl - (rs.count > 0 ? rs.pnl / 11 * 1 : 0)), 8), // approx delta vs avg month
    ].join(' '));
  }

  // ── 5c. LONG vs SHORT in November ────────────────────────────────────
  console.log('\n--- LONG vs SHORT in November ---');
  const novLong = novTrades.filter(t => t.side === 'long');
  const novShort = novTrades.filter(t => t.side === 'short');

  for (const [label, group] of [['LONG', novLong], ['SHORT', novShort]] as const) {
    if (group.length === 0) { console.log(`  ${label}: no trades`); continue; }
    const wins = group.filter(t => t.netPnlUsd > 0).length;
    const pnl = group.reduce((s, t) => s + t.netPnlUsd, 0);
    const avgHold = group.reduce((s, t) => s + t.holdMinutes, 0) / group.length;
    const exitCounts: Record<string, number> = {};
    for (const t of group) exitCounts[t.exitReason] = (exitCounts[t.exitReason] || 0) + 1;
    const topExits = Object.entries(exitCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r, c]) => `${r}(${c})`).join(', ');

    console.log(`  ${label}: ${group.length} trades, WR ${(wins / group.length * 100).toFixed(1)}%, PnL ${usd(pnl)}, avg hold ${Math.round(avgHold)}m`);
    console.log(`    Top exits: ${topExits}`);
  }

  // ── 5d. Win rate by week within November ─────────────────────────────
  console.log('\n--- Week-by-Week Within November ---');
  const novByWeek = new Map<string, any[]>();
  for (const t of novTrades) {
    const wk = getWeekKey(t);
    if (!novByWeek.has(wk)) novByWeek.set(wk, []);
    novByWeek.get(wk)!.push(t);
  }

  console.log([padR('Week', 12), padL('#Tr', 5), padL('WR%', 7), padL('PnL$', 10), padL('L/S', 8), padL('AvgHold', 8)].join(' | '));
  console.log('-'.repeat(65));

  for (const [week, trades] of [...novByWeek.entries()].sort()) {
    const wins = trades.filter(t => t.netPnlUsd > 0).length;
    const pnlW = trades.reduce((s, t) => s + t.netPnlUsd, 0);
    const longC = trades.filter(t => t.side === 'long').length;
    const shortC = trades.filter(t => t.side === 'short').length;
    const avgHold = trades.reduce((s, t) => s + t.holdMinutes, 0) / trades.length;
    console.log([
      padR(week, 12),
      padL(String(trades.length), 5),
      padL((wins / trades.length * 100).toFixed(1), 7),
      padL(usd(pnlW), 10),
      padL(`${longC}/${shortC}`, 8),
      padL(Math.round(avgHold) + 'm', 8),
    ].join(' | '));
  }

  // ── 5e. Average trade PnL per month ──────────────────────────────────
  divider('SECTION 4: AVERAGE TRADE PnL PER MONTH');
  console.log('\n' + [padR('Month', 10), padL('AvgPnl$', 9), padL('AvgPnl%', 9), padL('MedPnl$', 9), padL('Best$', 9), padL('Worst$', 9)].join(' | '));
  console.log('-'.repeat(70));

  for (const [month, trades] of [...byMonth.entries()].sort()) {
    if (trades.length === 0) continue;
    const pnls = trades.map(t => t.netPnlUsd).sort((a, b) => a - b);
    const avgPnlUsd = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const avgPnlPct = trades.reduce((s, t) => s + t.netPnlPct, 0) / trades.length;
    const median = pnls[Math.floor(pnls.length / 2)];
    const best = pnls[pnls.length - 1];
    const worst = pnls[0];
    const highlight = month === '2025-11' ? ' <<<' : '';
    console.log([
      padR(month, 10),
      padL(usd(avgPnlUsd), 9),
      padL(pct(avgPnlPct), 9),
      padL(usd(median), 9),
      padL(usd(best), 9),
      padL(usd(worst), 9),
    ].join(' | ') + highlight);
  }

  // ── 6. BTC regime during November weeks ──────────────────────────────
  divider('SECTION 5: BTC PRICE ACTION DURING NOVEMBER');

  // Get BTC price at each week start
  console.log('\n--- BTC Weekly Price During November ---');
  const novStart = new Date('2025-11-01T00:00:00Z').getTime();
  const novEnd = new Date('2025-12-01T00:00:00Z').getTime();
  const novBtcCandles = data.btcCandles.filter(c => c.timestamp >= novStart && c.timestamp < novEnd);

  // Daily BTC summary
  const dailyBtc = new Map<string, { open: number; close: number; high: number; low: number; candles: Candle[] }>();
  for (const c of novBtcCandles) {
    const day = new Date(c.timestamp).toISOString().slice(0, 10);
    if (!dailyBtc.has(day)) {
      dailyBtc.set(day, { open: c.open, close: c.close, high: c.high, low: c.low, candles: [] });
    }
    const d = dailyBtc.get(day)!;
    d.close = c.close;
    d.high = Math.max(d.high, c.high);
    d.low = Math.min(d.low, c.low);
    d.candles.push(c);
  }

  console.log([padR('Date', 12), padL('Open$', 8), padL('Close$', 8), padL('Chg%', 7), padL('Range%', 8)].join(' | '));
  console.log('-'.repeat(55));

  for (const [day, d] of [...dailyBtc.entries()].sort()) {
    const chg = ((d.close - d.open) / d.open * 100);
    const range = ((d.high - d.low) / d.open * 100);
    console.log([
      padR(day, 12),
      padL(d.open.toFixed(0), 8),
      padL(d.close.toFixed(0), 8),
      padL(pct(chg), 7),
      padL(range.toFixed(2) + '%', 8),
    ].join(' | '));
  }

  // ── 7. Regime changes in November vs other months detail ─────────────
  divider('SECTION 6: REGIME ANALYSIS — NOVEMBER vs BEST/WORST MONTHS');

  // Find best and worst months by PnL
  const monthlyPnls = [...byMonth.entries()].map(([m, trades]) => ({
    month: m,
    pnl: trades.reduce((s, t) => s + t.netPnlUsd, 0),
  })).sort((a, b) => a.pnl - b.pnl);

  const worstMonth = monthlyPnls[0];
  const bestMonth = monthlyPnls[monthlyPnls.length - 1];
  const novPnlEntry = monthlyPnls.find(m => m.month === '2025-11');
  const novRank = monthlyPnls.findIndex(m => m.month === '2025-11') + 1;

  console.log(`\n  November rank: #${novRank} of ${monthlyPnls.length} months (1 = worst)`);
  console.log(`  Best month:  ${bestMonth.month} (${usd(bestMonth.pnl)})`);
  console.log(`  Worst month: ${worstMonth.month} (${usd(worstMonth.pnl)})`);
  console.log(`  November:    2025-11 (${usd(novPnlEntry?.pnl ?? 0)})`);

  // ── 8. Detailed SL analysis November ─────────────────────────────────
  divider('SECTION 7: STOP LOSS TRADE ANALYSIS — NOVEMBER');

  const novSL = novTrades.filter(t => t.exitReason.includes('SL') || t.exitReason.includes('STOP'));
  const restSL = restTrades.filter(t => t.exitReason.includes('SL') || t.exitReason.includes('STOP'));
  const novStagnant = novTrades.filter(t => t.exitReason.includes('STAGNANT'));
  const restStagnant = restTrades.filter(t => t.exitReason.includes('STAGNANT'));

  console.log(`\n  SL trades:       Nov ${novSL.length}/${novStats.count} (${(novSL.length / novStats.count * 100).toFixed(1)}%)  vs  Rest ${restSL.length}/${restStats.count} (${(restSL.length / restStats.count * 100).toFixed(1)}%)`);
  console.log(`  SL avg PnL:      Nov ${usd(novSL.length > 0 ? novSL.reduce((s, t) => s + t.netPnlUsd, 0) / novSL.length : 0)}  vs  Rest ${usd(restSL.length > 0 ? restSL.reduce((s, t) => s + t.netPnlUsd, 0) / restSL.length : 0)}`);
  console.log(`  SL total PnL:    Nov ${usd(novSL.reduce((s, t) => s + t.netPnlUsd, 0))}  vs  Rest ${usd(restSL.reduce((s, t) => s + t.netPnlUsd, 0))}`);
  console.log(`  Stagnant trades: Nov ${novStagnant.length}/${novStats.count} (${(novStagnant.length / novStats.count * 100).toFixed(1)}%)  vs  Rest ${restStagnant.length}/${restStats.count} (${(restStagnant.length / restStats.count * 100).toFixed(1)}%)`);
  console.log(`  Stagnant PnL:    Nov ${usd(novStagnant.reduce((s, t) => s + t.netPnlUsd, 0))}  vs  Rest ${usd(restStagnant.reduce((s, t) => s + t.netPnlUsd, 0))}`);

  // Trailing (winning) trades comparison
  const novTrail = novTrades.filter(t => t.exitReason.startsWith('TRAIL'));
  const restTrail = restTrades.filter(t => t.exitReason.startsWith('TRAIL'));
  console.log(`\n  Trail trades:    Nov ${novTrail.length}/${novStats.count} (${(novTrail.length / novStats.count * 100).toFixed(1)}%)  vs  Rest ${restTrail.length}/${restStats.count} (${(restTrail.length / restStats.count * 100).toFixed(1)}%)`);
  console.log(`  Trail avg PnL:   Nov ${usd(novTrail.length > 0 ? novTrail.reduce((s, t) => s + t.netPnlUsd, 0) / novTrail.length : 0)}  vs  Rest ${usd(restTrail.length > 0 ? restTrail.reduce((s, t) => s + t.netPnlUsd, 0) / restTrail.length : 0)}`);
  console.log(`  Trail total PnL: Nov ${usd(novTrail.reduce((s, t) => s + t.netPnlUsd, 0))}  vs  Rest ${usd(restTrail.reduce((s, t) => s + t.netPnlUsd, 0))}`);

  // ── 9. Individual November trades ────────────────────────────────────
  divider('SECTION 8: ALL NOVEMBER TRADES (sorted by PnL)');

  const sortedNovTrades = [...novTrades].sort((a, b) => a.netPnlUsd - b.netPnlUsd);
  console.log('\n' + [
    padR('Symbol', 8), padR('Side', 5), padR('Entry', 17), padR('Exit', 17),
    padL('Hold', 6), padL('PnL$', 9), padL('PnL%', 8), padR('ExitReason', 22),
  ].join(' | '));
  console.log('-'.repeat(115));

  for (const t of sortedNovTrades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    console.log([
      padR(sym, 8),
      padR(t.side, 5),
      padR(t.entryTime.slice(0, 16), 17),
      padR(t.exitTime.slice(0, 16), 17),
      padL(Math.round(t.holdMinutes) + 'm', 6),
      padL(usd(t.netPnlUsd), 9),
      padL(pct(t.netPnlPct), 8),
      padR(t.exitReason, 22),
    ].join(' | '));
  }

  // ── 10. Diagnosis ────────────────────────────────────────────────────
  divider('SECTION 9: DIAGNOSIS — WHAT MADE NOVEMBER BAD?');

  // Compute key diagnostics
  const novBtcStats = btcStats.find(s => s.monthIdx === 10);
  const avgAtrOther = otherMonths.reduce((s, m) => s + m.avgAtrPct, 0) / otherMonths.length;
  const avgAdxOther = otherMonths.reduce((s, m) => s + m.avgAdx, 0) / otherMonths.length;
  const avgFlipsOther = otherMonths.reduce((s, m) => s + m.regimeFlips, 0) / otherMonths.length;

  // Choppy indicator: many regime flips + low ADX = choppy
  const isChoppy = novBtcStats && novBtcStats.regimeFlips > avgFlipsOther * 1.5;
  const isLowTrend = novBtcStats && novBtcStats.avgAdx < avgAdxOther * 0.8;
  const isHighVol = novBtcStats && novBtcStats.avgAtrPct > avgAtrOther * 1.2;
  const isLowVol = novBtcStats && novBtcStats.avgAtrPct < avgAtrOther * 0.8;

  // SL proportion comparison
  const novSLPct = novStats.count > 0 ? novSL.length / novStats.count * 100 : 0;
  const restSLPct = restStats.count > 0 ? restSL.length / restStats.count * 100 : 0;
  const highSLRate = novSLPct > restSLPct * 1.2;

  // Short performance
  const novShortPnlPerTrade = novStats.shortCount > 0 ? novStats.shortPnl / novStats.shortCount : 0;
  const restShortPnlPerTrade = restStats.shortCount > 0 ? restStats.shortPnl / restStats.shortCount : 0;
  const shortsWorse = novShortPnlPerTrade < restShortPnlPerTrade * 0.5;

  // Long performance
  const novLongPnlPerTrade = novStats.longCount > 0 ? novStats.longPnl / novStats.longCount : 0;
  const restLongPnlPerTrade = restStats.longCount > 0 ? restStats.longPnl / restStats.longCount : 0;
  const longsWorse = novLongPnlPerTrade < restLongPnlPerTrade * 0.5;

  // Stagnant proportion
  const novStagnantPct = novStats.count > 0 ? novStagnant.length / novStats.count * 100 : 0;
  const restStagnantPct = restStats.count > 0 ? restStagnant.length / restStats.count * 100 : 0;
  const highStagnant = novStagnantPct > restStagnantPct * 1.3;

  // Trail success
  const novTrailPct = novStats.count > 0 ? novTrail.length / novStats.count * 100 : 0;
  const restTrailPct = restStats.count > 0 ? restTrail.length / restStats.count * 100 : 0;
  const lowTrailRate = novTrailPct < restTrailPct * 0.7;

  console.log('\n  MARKET CONDITIONS:');
  if (novBtcStats) {
    console.log(`    BTC price change: ${pct(novBtcStats.priceChangePct)} (${novBtcStats.priceChangePct > 0 ? 'BULLISH' : 'BEARISH'} month)`);
    console.log(`    BTC range: ${novBtcStats.rangePct.toFixed(1)}%`);
    console.log(`    Volatility (ATR): ${novBtcStats.avgAtrPct.toFixed(3)} ${isHighVol ? '-> HIGH (>120% of avg)' : isLowVol ? '-> LOW (<80% of avg)' : '-> NORMAL'}`);
    console.log(`    Trend strength (ADX): ${novBtcStats.avgAdx.toFixed(0)} ${isLowTrend ? '-> WEAK TREND (<80% of avg)' : '-> NORMAL'}`);
    console.log(`    Regime flips: ${novBtcStats.regimeFlips} ${isChoppy ? '-> CHOPPY (>150% of avg)' : '-> NORMAL'}`);
    console.log(`    Bull candle ratio: ${(novBtcStats.bullRatio * 100).toFixed(0)}%`);
  }

  console.log('\n  TRADE BEHAVIOR:');
  console.log(`    SL rate: ${novSLPct.toFixed(1)}% vs ${restSLPct.toFixed(1)}% rest ${highSLRate ? '-> ELEVATED (>120% of rest)' : '-> NORMAL'}`);
  console.log(`    Stagnant rate: ${novStagnantPct.toFixed(1)}% vs ${restStagnantPct.toFixed(1)}% rest ${highStagnant ? '-> ELEVATED (>130% of rest)' : '-> NORMAL'}`);
  console.log(`    Trail rate: ${novTrailPct.toFixed(1)}% vs ${restTrailPct.toFixed(1)}% rest ${lowTrailRate ? '-> LOW (<70% of rest)' : '-> NORMAL'}`);
  console.log(`    Short PnL/trade: ${usd(novShortPnlPerTrade)} vs ${usd(restShortPnlPerTrade)} rest ${shortsWorse ? '-> SHORTS UNDERPERFORMING' : '-> NORMAL'}`);
  console.log(`    Long PnL/trade: ${usd(novLongPnlPerTrade)} vs ${usd(restLongPnlPerTrade)} rest ${longsWorse ? '-> LONGS UNDERPERFORMING' : '-> NORMAL'}`);

  console.log('\n  PROBABLE CAUSES:');
  const causes: string[] = [];

  if (isChoppy) causes.push('CHOPPY REGIME: Too many BTC regime flips -> signals enter on false breakouts that reverse');
  if (isLowTrend) causes.push('WEAK TREND: Low ADX means entries lack trend conviction -> high SL/stagnant rate');
  if (isHighVol) causes.push('HIGH VOLATILITY REVERSALS: High ATR means wider swings that trigger SL before trend resumes');
  if (isLowVol) causes.push('LOW VOLATILITY: Not enough momentum for trailing stops to capture meaningful profit');
  if (highSLRate) causes.push('HIGH STOP LOSS RATE: Entries are getting stopped out more frequently -> possible choppy whipsaw');
  if (highStagnant) causes.push('HIGH STAGNANT EXITS: Trades entering but going nowhere -> range-bound, no follow-through');
  if (lowTrailRate) causes.push('LOW TRAIL RATE: Fewer trades reaching trailing profit -> moves die before activation threshold');
  if (shortsWorse) causes.push('SHORT PERFORMANCE COLLAPSED: Short trades especially bad -> possible uptrend faking out short signals');
  if (longsWorse) causes.push('LONG PERFORMANCE COLLAPSED: Long trades especially bad -> possible downtrend faking out long signals');

  if (novBtcStats && novBtcStats.priceChangePct > 10 && novStats.shortPnl < -100) {
    causes.push('STRONG BTC RALLY + SHORT LOSSES: BTC rallied hard but shorts kept firing -> regime detection too slow');
  }
  if (novBtcStats && novBtcStats.priceChangePct < -10 && novStats.longPnl < -100) {
    causes.push('STRONG BTC DUMP + LONG LOSSES: BTC dumped but longs kept firing -> regime detection too slow');
  }

  if (causes.length === 0) {
    causes.push('NO CLEAR SINGLE CAUSE: November may have had a combination of moderate negatives across multiple dimensions');
  }

  for (let i = 0; i < causes.length; i++) {
    console.log(`    ${i + 1}. ${causes[i]}`);
  }

  // ── 11. Cross-reference: worst November trades vs BTC intra-day moves
  divider('SECTION 10: WORST 10 NOVEMBER TRADES vs BTC CONTEXT');

  const worst10 = sortedNovTrades.slice(0, 10);
  for (const t of worst10) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    const entryTs = new Date(t.entryTime).getTime();

    // Find BTC ATR/ADX at entry
    const btcIdx = data.btcCandles.findIndex(c => c.timestamp > entryTs) - 1;
    let btcAtr = 'N/A';
    let btcAdx = 'N/A';
    let btcSma200Dist = 'N/A';
    let btcRegime = 'N/A';

    if (btcIdx >= 200) {
      const btcWindow = data.btcCandles.slice(btcIdx - 200, btcIdx + 1);
      const closes = btcWindow.map(c => c.close);
      const sma200 = calcSMA(closes, 200);
      const atr = calcATR(btcWindow.slice(-20), 14);
      const adx = calcADX(btcWindow.slice(-30), 14);
      const btcPrice = btcWindow[btcWindow.length - 1].close;

      btcAtr = atr ? (atr / btcPrice * 100).toFixed(3) + '%' : 'N/A';
      btcAdx = adx > 0 ? adx.toFixed(0) : 'N/A';
      btcRegime = sma200 ? (btcPrice > sma200 ? 'BULL' : 'BEAR') : 'N/A';
      btcSma200Dist = sma200 ? ((btcPrice - sma200) / sma200 * 100).toFixed(1) + '%' : 'N/A';
    }

    console.log(`\n  ${sym} ${t.side.toUpperCase()} | Entry: ${t.entryTime.slice(0, 16)} | Exit: ${t.exitTime.slice(0, 16)} | ${t.exitReason}`);
    console.log(`    PnL: ${usd(t.netPnlUsd)} (${pct(t.netPnlPct)}) | Hold: ${Math.round(t.holdMinutes)}m | Entry price: $${t.entryPrice.toFixed(4)}`);
    console.log(`    BTC at entry: regime=${btcRegime}, ATR=${btcAtr}, ADX=${btcAdx}, SMA200 dist=${btcSma200Dist}`);
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
