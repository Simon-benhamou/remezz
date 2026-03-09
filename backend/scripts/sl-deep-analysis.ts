/**
 * sl-deep-analysis.ts — Deep SL trade behavior analysis (V5.150 research)
 *
 * Phase 1: UNDERSTAND how SL trades behave vs WIN trades
 * - MAE/MFE (Maximum Adverse/Favorable Excursion) per trade
 * - Time-to-MAE: how fast do SL trades crash?
 * - Do SL trades ever go positive first? (MFE > 0 before SL)
 * - Stagnant gap: could stagnant have saved the trade?
 *
 * Phase 2: Entry context comparison (NO look-ahead bias)
 * - ATR at entry, volume ratio, RSI, BTC regime
 * - Time-of-day, symbol clustering
 * - Breakout quality (distance from BB, ROC strength)
 *
 * IMPORTANT: All "features" use ONLY data available at entry time.
 * Post-entry analysis (MAE/MFE) is for UNDERSTANDING only, not for filtering.
 *
 * Run: npx tsx scripts/sl-deep-analysis.ts
 */

import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';
import path from 'node:path';

const SYMBOLS = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const GRID = 15 * 60 * 1000; // 15 min

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadData(start: string, end: string) {
  const startDate = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');
  const extraBarsMs = 3200 * GRID;
  const since = startDate.getTime() - extraBarsMs;
  const endMs = endDate.getTime();

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of SYMBOLS) {
    const fpath = path.join(DATA_DIR, sym + '_USDT_15m.json');
    if (!fs.existsSync(fpath)) continue;
    const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    const candles: BacktestCandle[] = raw
      .filter((c: any) => c.openTime && c.open && c.close)
      .map((c: any) => ({
        timestamp: c.openTime, open: +c.open, high: +c.high,
        low: +c.low, close: +c.close, volume: +(c.volume || 0),
      }))
      .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);
    const sliced = sliceCandlesByTime(candles, since, endMs);
    if (sliced.length >= 300) allData[sym + '/USDT:USDT'] = sliced;
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: Object.keys(allData), leverage: LEVERAGE },
    btcCandles, btcCandlesRegime: btcCandles, allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  return { trades: result.trades, btcCandles, allData };
}

// ============================================================================
// MAE/MFE ANALYSIS (post-entry — for understanding, NOT filtering)
// ============================================================================

interface TradeExcursion {
  symbol: string;
  side: 'long' | 'short';
  exitReason: string;
  exitCategory: 'SL' | 'STAGNANT' | 'WIN' | 'OTHER';
  entryPrice: number;
  exitPrice: number;
  netPnlUsd: number;
  netPnlPct: number;
  holdBars: number;

  // MAE/MFE (percentage from entry)
  mae: number;           // Max Adverse Excursion (always negative or 0)
  mfe: number;           // Max Favorable Excursion (always positive or 0)
  barsToMae: number;     // How many bars to reach worst point
  barsToMfe: number;     // How many bars to reach best point
  mfeBeforeMae: boolean; // Did trade go positive BEFORE hitting MAE?
  maxMfeBeforeMae: number; // Best PnL% reached before MAE point

  // Stagnant analysis
  couldStagnantSave: boolean; // Was MAE reached after 8 bars (120min)?
  pnlAt8Bars: number;        // PnL% at bar 8 (stagnant trigger point)
  pnlAt16Bars: number;       // PnL% at bar 16 (stagnant confirmation)

  // Entry context (NO look-ahead)
  hourUtc: number;
  atrPct: number;        // ATR(14) / close at entry
  volRatio: number;       // signal candle volume / avg 5 prior
  roc10: number;          // ROC 10 at entry
  roc5: number;           // ROC 5 at entry
  bbDistPct: number;      // distance from BB upper (LONG) or lower (SHORT)
  consecSameDir: number;  // consecutive candles in signal direction
  btcChange1h: number;    // BTC 1h change at entry
  btcChange4h: number;    // BTC 4h change at entry
  btcAtrPct: number;      // BTC ATR% at entry
}

function calcATR(candles: BacktestCandle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-period - 1);
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return 0;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function calcBB(candles: BacktestCandle[], period: number, std: number) {
  const closes = candles.slice(-period).map(c => c.close);
  if (closes.length < period) return { upper: 0, lower: 0, mid: 0 };
  const mid = closes.reduce((a, b) => a + b, 0) / period;
  const variance = closes.reduce((a, b) => a + (b - mid) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mid + std * stdDev, lower: mid - std * stdDev, mid };
}

function analyzeTradeExcursion(
  trade: any,
  symCandles: BacktestCandle[],
  btcCandles: BacktestCandle[],
  symTsMap: Map<number, number>,
  btcTsMap: Map<number, number>,
): TradeExcursion | null {
  const entryTs = new Date(trade.entryTime).getTime();
  const exitTs = new Date(trade.exitTime).getTime();
  // V5.150 FIX: entryTime = candle CLOSE. Subtract 15min for signal candle OPEN.
  const signalGridTs = Math.floor((entryTs - GRID) / GRID) * GRID;

  let symIdx = symTsMap.get(signalGridTs);
  if (symIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of symTsMap) {
      if (Math.abs(ts - signalGridTs) < bestDist) { bestDist = Math.abs(ts - signalGridTs); best = idx; }
    }
    symIdx = best;
  }
  if (symIdx < 20) return null;

  const isLong = trade.side === 'long';
  const entryPrice = trade.entryPrice;
  const exitPrice = trade.exitPrice;

  // Categorize exit reason
  const reason = trade.exitReason || '';
  let exitCategory: 'SL' | 'STAGNANT' | 'WIN' | 'OTHER';
  if (reason.includes('SL') || reason.includes('STOP_LOSS') || reason.includes('stoploss')) exitCategory = 'SL';
  else if (reason.includes('stagnant') || reason.includes('STAGNANT')) exitCategory = 'STAGNANT';
  else if (trade.netPnlUsd > 0) exitCategory = 'WIN';
  else exitCategory = 'OTHER';

  // ── Post-entry MAE/MFE analysis ──
  // Walk through candles from entry to exit
  const holdBars = Math.round((exitTs - entryTs) / GRID);
  const entryIdx = symIdx + 1; // Entry happens at the CLOSE of signal candle = OPEN of next
  const maxBars = Math.min(holdBars + 2, symCandles.length - entryIdx);

  let mae = 0, mfe = 0, barsToMae = 0, barsToMfe = 0;
  let maeReached = false;
  let mfeBeforeMae = false, maxMfeBeforeMae = 0;
  let pnlAt8Bars = 0, pnlAt16Bars = 0;

  for (let b = 0; b < maxBars && (entryIdx + b) < symCandles.length; b++) {
    const c = symCandles[entryIdx + b];
    // Check both high and low (wick-level analysis)
    const pnlHigh = isLong
      ? (c.high - entryPrice) / entryPrice * 100
      : (entryPrice - c.low) / entryPrice * 100;
    const pnlLow = isLong
      ? (c.low - entryPrice) / entryPrice * 100
      : (entryPrice - c.high) / entryPrice * 100;
    const pnlClose = isLong
      ? (c.close - entryPrice) / entryPrice * 100
      : (entryPrice - c.close) / entryPrice * 100;

    if (pnlLow < mae) { mae = pnlLow; barsToMae = b + 1; maeReached = true; }
    if (pnlHigh > mfe) {
      if (!maeReached || pnlHigh > maxMfeBeforeMae) {
        if (!maeReached) maxMfeBeforeMae = pnlHigh;
      }
      mfe = pnlHigh; barsToMfe = b + 1;
    }

    if (b < barsToMae && pnlHigh > 0) mfeBeforeMae = true;

    if (b === 7) pnlAt8Bars = pnlClose;  // bar 8 = 120 min = stagnant trigger
    if (b === 15) pnlAt16Bars = pnlClose; // bar 16 = 240 min = stagnant confirmed
  }

  // Could stagnant have saved this SL trade?
  // Stagnant needs 120 min (8 bars) to trigger. If MAE (SL hit) is before bar 8, stagnant can't help.
  const couldStagnantSave = barsToMae > 8;

  // ── Entry context (NO look-ahead — only pre-entry data) ──
  const signalCandle = symCandles[symIdx];
  const pre20 = symCandles.slice(Math.max(0, symIdx - 20), symIdx + 1);
  const pre5 = symCandles.slice(Math.max(0, symIdx - 5), symIdx);

  // ATR
  const atr = calcATR(pre20, 14);
  const atrPct = signalCandle.close > 0 ? (atr / signalCandle.close) * 100 : 0;

  // Volume ratio
  const avgVol5 = pre5.length > 0 ? pre5.reduce((s, c) => s + c.volume, 0) / pre5.length : 1;
  const volRatio = avgVol5 > 0 ? signalCandle.volume / avgVol5 : 0;

  // ROC
  const roc10 = symIdx >= 10 ? (signalCandle.close - symCandles[symIdx - 10].close) / symCandles[symIdx - 10].close : 0;
  const roc5 = symIdx >= 5 ? (signalCandle.close - symCandles[symIdx - 5].close) / symCandles[symIdx - 5].close : 0;

  // BB distance
  const bb = calcBB(pre20, 20, 2);
  const bbDistPct = isLong
    ? (bb.upper > 0 ? (signalCandle.close - bb.upper) / bb.upper * 100 : 0)
    : (bb.lower > 0 ? (bb.lower - signalCandle.close) / bb.lower * 100 : 0);

  // Consecutive same direction
  let consecSameDir = 0;
  for (let i = symIdx; i >= Math.max(0, symIdx - 10); i--) {
    const cc = symCandles[i];
    if ((isLong && cc.close > cc.open) || (!isLong && cc.close < cc.open)) consecSameDir++;
    else break;
  }

  // BTC context
  let btcIdx = btcTsMap.get(signalGridTs);
  if (btcIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of btcTsMap) {
      if (Math.abs(ts - signalGridTs) < bestDist) { bestDist = Math.abs(ts - signalGridTs); best = idx; }
    }
    btcIdx = best;
  }
  const btcChange1h = btcIdx >= 4 ? (btcCandles[btcIdx].close - btcCandles[btcIdx - 4].close) / btcCandles[btcIdx - 4].close * 100 : 0;
  const btcChange4h = btcIdx >= 16 ? (btcCandles[btcIdx].close - btcCandles[btcIdx - 16].close) / btcCandles[btcIdx - 16].close * 100 : 0;
  const btcPre20 = btcCandles.slice(Math.max(0, btcIdx - 20), btcIdx + 1);
  const btcAtr = calcATR(btcPre20, 14);
  const btcAtrPct = btcIdx >= 0 && btcCandles[btcIdx].close > 0 ? (btcAtr / btcCandles[btcIdx].close) * 100 : 0;

  const hourUtc = new Date(entryTs).getUTCHours();
  const netPnlPct = entryPrice > 0 ? (isLong
    ? (exitPrice - entryPrice) / entryPrice * 100
    : (entryPrice - exitPrice) / entryPrice * 100) : 0;

  return {
    symbol: trade.symbol,
    side: trade.side,
    exitReason: reason,
    exitCategory,
    entryPrice,
    exitPrice,
    netPnlUsd: trade.netPnlUsd,
    netPnlPct,
    holdBars,
    mae, mfe, barsToMae, barsToMfe,
    mfeBeforeMae, maxMfeBeforeMae,
    couldStagnantSave, pnlAt8Bars, pnlAt16Bars,
    hourUtc, atrPct, volRatio, roc10, roc5,
    bbDistPct, consecSameDir, btcChange1h, btcChange4h, btcAtrPct,
  };
}

// ============================================================================
// STATISTICAL HELPERS
// ============================================================================

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1));
}

function cohenD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0;
  const pooledStd = Math.sqrt(((a.length - 1) * std(a) ** 2 + (b.length - 1) * std(b) ** 2) / (a.length + b.length - 2));
  return pooledStd > 0 ? (mean(a) - mean(b)) / pooledStd : 0;
}

// ============================================================================
// REPORT
// ============================================================================

function printSection(title: string) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(70)}`);
}

function printDistribution(label: string, values: number[], unit: string = '') {
  if (values.length === 0) { console.log(`  ${label}: no data`); return; }
  console.log(`  ${label} (n=${values.length}): mean=${mean(values).toFixed(2)}${unit}, med=${percentile(values, 50).toFixed(2)}${unit}, P10=${percentile(values, 10).toFixed(2)}${unit}, P90=${percentile(values, 90).toFixed(2)}${unit}`);
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     SL DEEP ANALYSIS — Understanding Trade Behavior                ║');
  console.log('║     Phase 1: MAE/MFE + Stagnant Gap + Entry Context                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  // Run backtests
  console.log('Loading 2025 backtest...');
  const data2025 = await loadData('2025-01-01', '2025-12-31');
  console.log(`  ${data2025.trades.length} trades loaded\n`);

  console.log('Loading 2024 backtest...');
  const data2024 = await loadData('2024-01-01', '2024-12-31');
  console.log(`  ${data2024.trades.length} trades loaded\n`);

  // Build timestamp maps
  function buildTsMap(candles: BacktestCandle[]) {
    const m = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) m.set(Math.floor(candles[i].timestamp / GRID) * GRID, i);
    return m;
  }

  // Process both years
  for (const { label, data } of [
    { label: '2025', data: data2025 },
    { label: '2024', data: data2024 },
  ]) {
    const btcMap = buildTsMap(data.btcCandles);
    const symMaps = new Map<string, Map<number, number>>();
    for (const [sym, c] of Object.entries(data.allData)) symMaps.set(sym, buildTsMap(c));

    // Analyze all trades
    const excursions: TradeExcursion[] = [];
    for (const trade of data.trades) {
      const symCandles = data.allData[trade.symbol];
      const symMap = symMaps.get(trade.symbol);
      if (!symCandles || !symMap) continue;
      const ex = analyzeTradeExcursion(trade, symCandles, data.btcCandles, symMap, btcMap);
      if (ex) excursions.push(ex);
    }

    const sl = excursions.filter(e => e.exitCategory === 'SL');
    const win = excursions.filter(e => e.exitCategory === 'WIN');
    const stag = excursions.filter(e => e.exitCategory === 'STAGNANT');
    const other = excursions.filter(e => e.exitCategory === 'OTHER');

    console.log(`\n\n${'█'.repeat(70)}`);
    console.log(`  ${label} — ${excursions.length} trades analyzed`);
    console.log(`  SL: ${sl.length} | WIN: ${win.length} | STAGNANT: ${stag.length} | OTHER: ${other.length}`);
    console.log(`${'█'.repeat(70)}`);

    // ── SECTION 1: MAE/MFE ──
    printSection('1. MAE/MFE — How far do trades go before exit?');

    console.log('\n  ┌─── SL Trades ───');
    printDistribution('MAE (max drawdown %)', sl.map(e => e.mae), '%');
    printDistribution('MFE (max runup %)', sl.map(e => e.mfe), '%');
    printDistribution('Bars to MAE', sl.map(e => e.barsToMae));
    printDistribution('Bars to MFE', sl.map(e => e.barsToMfe));
    printDistribution('Hold bars total', sl.map(e => e.holdBars));

    console.log('\n  ┌─── WIN Trades ───');
    printDistribution('MAE (max drawdown %)', win.map(e => e.mae), '%');
    printDistribution('MFE (max runup %)', win.map(e => e.mfe), '%');
    printDistribution('Bars to MAE', win.map(e => e.barsToMae));
    printDistribution('Bars to MFE', win.map(e => e.barsToMfe));
    printDistribution('Hold bars total', win.map(e => e.holdBars));

    console.log('\n  ┌─── STAGNANT Trades ───');
    printDistribution('MAE (max drawdown %)', stag.map(e => e.mae), '%');
    printDistribution('MFE (max runup %)', stag.map(e => e.mfe), '%');
    printDistribution('Bars to MAE', stag.map(e => e.barsToMae));
    printDistribution('Hold bars total', stag.map(e => e.holdBars));

    // ── SECTION 2: SL Speed ──
    printSection('2. SL Speed — How fast do SL trades crash?');

    const slFast = sl.filter(e => e.barsToMae <= 2);
    const slMed = sl.filter(e => e.barsToMae > 2 && e.barsToMae <= 8);
    const slSlow = sl.filter(e => e.barsToMae > 8);
    console.log(`  SL within 2 bars (30min):  ${slFast.length} (${(slFast.length / sl.length * 100).toFixed(0)}%) — avg PnL: $${mean(slFast.map(e => e.netPnlUsd)).toFixed(0)}`);
    console.log(`  SL within 3-8 bars (2h):   ${slMed.length} (${(slMed.length / sl.length * 100).toFixed(0)}%) — avg PnL: $${mean(slMed.map(e => e.netPnlUsd)).toFixed(0)}`);
    console.log(`  SL after 8+ bars (>2h):    ${slSlow.length} (${(slSlow.length / sl.length * 100).toFixed(0)}%) — avg PnL: $${mean(slSlow.map(e => e.netPnlUsd)).toFixed(0)}`);

    // ── SECTION 3: Did SL trades go positive first? ──
    printSection('3. SL Trades — Did they go positive first?');

    const slWentPositive = sl.filter(e => e.mfe > 0.1);
    const slNeverPositive = sl.filter(e => e.mfe <= 0.1);
    console.log(`  Went positive (MFE > 0.1%): ${slWentPositive.length} (${(slWentPositive.length / sl.length * 100).toFixed(0)}%)`);
    printDistribution('    Their MFE before crash', slWentPositive.map(e => e.mfe), '%');
    console.log(`  Never went positive:        ${slNeverPositive.length} (${(slNeverPositive.length / sl.length * 100).toFixed(0)}%)`);
    printDistribution('    Their MAE', slNeverPositive.map(e => e.mae), '%');

    // ── SECTION 4: Stagnant Gap ──
    printSection('4. Stagnant Gap — Could stagnant have saved SL trades?');

    const stagnantCouldSave = sl.filter(e => e.couldStagnantSave);
    const stagnantTooSlow = sl.filter(e => !e.couldStagnantSave);
    console.log(`  MAE after 8 bars (stagnant could trigger): ${stagnantCouldSave.length} (${(stagnantCouldSave.length / sl.length * 100).toFixed(0)}%)`);
    console.log(`  MAE within 8 bars (too fast for stagnant): ${stagnantTooSlow.length} (${(stagnantTooSlow.length / sl.length * 100).toFixed(0)}%)`);
    console.log(`\n  PnL at bar 8 for SL trades (what stagnant would see):`);
    printDistribution('PnL% at bar 8', sl.map(e => e.pnlAt8Bars), '%');
    printDistribution('PnL% at bar 16', sl.map(e => e.pnlAt16Bars), '%');

    // ── SECTION 5: Entry Context Comparison ──
    printSection('5. Entry Context — SL vs WIN (NO look-ahead)');

    const features = [
      { name: 'ATR %', slVals: sl.map(e => e.atrPct), winVals: win.map(e => e.atrPct) },
      { name: 'Volume Ratio', slVals: sl.map(e => e.volRatio), winVals: win.map(e => e.volRatio) },
      { name: 'ROC 10', slVals: sl.map(e => e.roc10 * 100), winVals: win.map(e => e.roc10 * 100) },
      { name: 'ROC 5', slVals: sl.map(e => e.roc5 * 100), winVals: win.map(e => e.roc5 * 100) },
      { name: 'BB Distance %', slVals: sl.map(e => e.bbDistPct), winVals: win.map(e => e.bbDistPct) },
      { name: 'Consec Same Dir', slVals: sl.map(e => e.consecSameDir), winVals: win.map(e => e.consecSameDir) },
      { name: 'BTC Change 1h %', slVals: sl.map(e => e.btcChange1h), winVals: win.map(e => e.btcChange1h) },
      { name: 'BTC Change 4h %', slVals: sl.map(e => e.btcChange4h), winVals: win.map(e => e.btcChange4h) },
      { name: 'BTC ATR %', slVals: sl.map(e => e.btcAtrPct), winVals: win.map(e => e.btcAtrPct) },
    ];

    console.log('\n  ' + 'Feature'.padEnd(20) + '| SL mean  | WIN mean | Cohen d | Separation');
    console.log('  ' + '-'.repeat(75));
    for (const f of features) {
      const d = cohenD(f.slVals, f.winVals);
      const sep = Math.abs(d) >= 0.8 ? '★★★ LARGE' : Math.abs(d) >= 0.5 ? '★★ MEDIUM' : Math.abs(d) >= 0.3 ? '★ SMALL' : '  minimal';
      console.log(
        '  ' + f.name.padEnd(20) + '| ' +
        mean(f.slVals).toFixed(3).padStart(8) + ' | ' +
        mean(f.winVals).toFixed(3).padStart(8) + ' | ' +
        d.toFixed(3).padStart(7) + ' | ' + sep
      );
    }

    // ── SECTION 6: Time-of-Day ──
    printSection('6. Time-of-Day — SL vs WIN distribution');

    const hourBuckets = [
      { label: '00-04 UTC', hours: [0, 1, 2, 3] },
      { label: '04-08 UTC', hours: [4, 5, 6, 7] },
      { label: '08-12 UTC', hours: [8, 9, 10, 11] },
      { label: '12-16 UTC', hours: [12, 13, 14, 15] },
      { label: '16-20 UTC', hours: [16, 17, 18, 19] },
      { label: '20-24 UTC', hours: [20, 21, 22, 23] },
    ];

    console.log('\n  ' + 'Time'.padEnd(12) + '| SL   | WIN  | SL%   | WIN%  | SL rate');
    console.log('  ' + '-'.repeat(60));
    for (const bucket of hourBuckets) {
      const slH = sl.filter(e => bucket.hours.includes(e.hourUtc));
      const winH = win.filter(e => bucket.hours.includes(e.hourUtc));
      const total = slH.length + winH.length;
      const slRate = total > 0 ? (slH.length / total * 100).toFixed(1) : '0.0';
      console.log(
        '  ' + bucket.label.padEnd(12) + '| ' +
        String(slH.length).padStart(4) + ' | ' +
        String(winH.length).padStart(4) + ' | ' +
        (sl.length > 0 ? (slH.length / sl.length * 100).toFixed(1) : '0.0').padStart(5) + '% | ' +
        (win.length > 0 ? (winH.length / win.length * 100).toFixed(1) : '0.0').padStart(5) + '% | ' +
        slRate.padStart(5) + '%'
      );
    }

    // ── SECTION 7: Symbol Clustering ──
    printSection('7. Symbol Clustering — SL rate per symbol');

    const symbolSet = [...new Set(excursions.map(e => e.symbol))].sort();
    console.log('\n  ' + 'Symbol'.padEnd(20) + '| SL   | WIN  | STAG | Total | SL rate | SL PnL');
    console.log('  ' + '-'.repeat(75));
    for (const sym of symbolSet) {
      const symAll = excursions.filter(e => e.symbol === sym);
      const symSl = symAll.filter(e => e.exitCategory === 'SL');
      const symWin = symAll.filter(e => e.exitCategory === 'WIN');
      const symStag = symAll.filter(e => e.exitCategory === 'STAGNANT');
      const slRate = symAll.length > 0 ? (symSl.length / symAll.length * 100).toFixed(1) : '0.0';
      const slPnl = symSl.reduce((s, e) => s + e.netPnlUsd, 0);
      console.log(
        '  ' + sym.padEnd(20) + '| ' +
        String(symSl.length).padStart(4) + ' | ' +
        String(symWin.length).padStart(4) + ' | ' +
        String(symStag.length).padStart(4) + ' | ' +
        String(symAll.length).padStart(5) + ' | ' +
        slRate.padStart(5) + '% | ' +
        ('$' + slPnl.toFixed(0)).padStart(8)
      );
    }

    // ── SECTION 8: LONG vs SHORT SL ──
    printSection('8. LONG vs SHORT — SL behavior');

    const slLong = sl.filter(e => e.side === 'long');
    const slShort = sl.filter(e => e.side === 'short');
    console.log(`\n  LONG SL: ${slLong.length} trades, avg PnL $${mean(slLong.map(e => e.netPnlUsd)).toFixed(0)}`);
    printDistribution('    MAE', slLong.map(e => e.mae), '%');
    printDistribution('    Bars to MAE', slLong.map(e => e.barsToMae));
    console.log(`  SHORT SL: ${slShort.length} trades, avg PnL $${mean(slShort.map(e => e.netPnlUsd)).toFixed(0)}`);
    printDistribution('    MAE', slShort.map(e => e.mae), '%');
    printDistribution('    Bars to MAE', slShort.map(e => e.barsToMae));

    // ── SECTION 9: SL by Volatility Regime ──
    printSection('9. SL by Volatility Regime at Entry');

    const slLowVol = sl.filter(e => e.atrPct < 2);
    const slMedVol = sl.filter(e => e.atrPct >= 2 && e.atrPct < 3.5);
    const slHighVol = sl.filter(e => e.atrPct >= 3.5);
    const winLowVol = win.filter(e => e.atrPct < 2);
    const winMedVol = win.filter(e => e.atrPct >= 2 && e.atrPct < 3.5);
    const winHighVol = win.filter(e => e.atrPct >= 3.5);

    console.log('\n  ' + 'Vol Regime'.padEnd(14) + '| SL   | WIN  | SL rate | SL avg MAE | WIN avg MFE');
    console.log('  ' + '-'.repeat(70));
    for (const { label, slG, winG } of [
      { label: 'LOW (<2%)', slG: slLowVol, winG: winLowVol },
      { label: 'MED (2-3.5%)', slG: slMedVol, winG: winMedVol },
      { label: 'HIGH (>3.5%)', slG: slHighVol, winG: winHighVol },
    ]) {
      const total = slG.length + winG.length;
      const slRate = total > 0 ? (slG.length / total * 100).toFixed(1) : '0.0';
      console.log(
        '  ' + label.padEnd(14) + '| ' +
        String(slG.length).padStart(4) + ' | ' +
        String(winG.length).padStart(4) + ' | ' +
        slRate.padStart(5) + '% | ' +
        (mean(slG.map(e => e.mae)).toFixed(2) + '%').padStart(10) + ' | ' +
        (mean(winG.map(e => e.mfe)).toFixed(2) + '%').padStart(10)
      );
    }

    // ── SECTION 10: Key Findings ──
    printSection('10. KEY FINDINGS SUMMARY');

    const slMedianBarsToMae = percentile(sl.map(e => e.barsToMae), 50);
    const slPctFast = sl.length > 0 ? (slFast.length / sl.length * 100).toFixed(0) : '0';
    const slPctWentPositive = sl.length > 0 ? (slWentPositive.length / sl.length * 100).toFixed(0) : '0';
    const slPctCouldStagnantSave = sl.length > 0 ? (stagnantCouldSave.length / sl.length * 100).toFixed(0) : '0';

    console.log(`\n  1. SL crash speed: ${slPctFast}% of SL trades hit within 2 bars (30min)`);
    console.log(`     Median bars to MAE: ${slMedianBarsToMae.toFixed(0)}`);
    console.log(`  2. ${slPctWentPositive}% of SL trades went positive first (MFE > 0.1%) — entry was right, exit was bad`);
    console.log(`  3. Stagnant could save: ${slPctCouldStagnantSave}% of SL trades (MAE after bar 8)`);
    console.log(`  4. Total SL cost: $${sl.reduce((s, e) => s + e.netPnlUsd, 0).toFixed(0)}`);

    // Best entry-time predictor
    const bestFeature = features.reduce((best, f) => Math.abs(cohenD(f.slVals, f.winVals)) > Math.abs(best.d) ? { name: f.name, d: cohenD(f.slVals, f.winVals) } : best, { name: '', d: 0 });
    console.log(`  5. Best entry-time predictor: ${bestFeature.name} (Cohen's d = ${bestFeature.d.toFixed(3)})`);
  }

  console.log('\n\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
