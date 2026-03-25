/**
 * sweep-dna-filter.ts — Test dynamic DNA filter on 2024 (bull) and 2025 (range)
 *
 * For each trade, computes rolling 30-day DNA metrics at entry time:
 * - ATR% (volatility level)
 * - BTC Correlation (how closely symbol follows BTC)
 * - Volume CV (coefficient of variation — volume consistency)
 *
 * Filters trades where DNA is outside the "winning" profile range.
 * Compares impact on 2024 vs 2025.
 *
 * Run: npx tsx scripts/sweep-dna-filter.ts
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

// ============================================================================
// DNA METRIC COMPUTATION (rolling window)
// ============================================================================

const ROLLING_DAYS = 30;
const CANDLES_PER_DAY = 96; // 15m candles per day
const ROLLING_CANDLES = ROLLING_DAYS * CANDLES_PER_DAY; // 2880

interface DnaSnapshot {
  atrPct: number;      // ATR(14) as % of price
  btcCorr: number;     // Pearson correlation with BTC closes
  volumeCV: number;    // Coefficient of variation of daily volumes
}

function calcATR(candles: BacktestCandle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close)
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcPearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function computeDna(
  symCandles: BacktestCandle[],
  btcCandles: BacktestCandle[],
  symIdx: number,
  btcTs2Idx: Map<number, number>,
): DnaSnapshot | null {
  if (symIdx < ROLLING_CANDLES + 14) return null;

  const window = symCandles.slice(symIdx - ROLLING_CANDLES, symIdx + 1);
  if (window.length < ROLLING_CANDLES) return null;

  // 1. ATR% — ATR(14) / last close * 100
  const atr = calcATR(window.slice(-15), 14);
  const lastClose = window[window.length - 1].close;
  const atrPct = lastClose > 0 ? (atr / lastClose) * 100 : 0;

  // 2. BTC Correlation — daily returns correlation over 30 days
  // Sample daily closes (every 96 candles)
  const symDailyReturns: number[] = [];
  const btcDailyReturns: number[] = [];

  for (let d = 1; d < ROLLING_DAYS; d++) {
    const todayIdx = symIdx - (ROLLING_DAYS - d - 1) * CANDLES_PER_DAY;
    const yesterdayIdx = todayIdx - CANDLES_PER_DAY;
    if (todayIdx < 0 || yesterdayIdx < 0 || todayIdx >= symCandles.length) continue;

    const symToday = symCandles[todayIdx].close;
    const symYesterday = symCandles[yesterdayIdx].close;
    if (symYesterday <= 0) continue;
    symDailyReturns.push((symToday - symYesterday) / symYesterday);

    // Find matching BTC candles
    const symTs = symCandles[todayIdx].timestamp;
    const symTsYesterday = symCandles[yesterdayIdx].timestamp;
    const btcTodayIdx = btcTs2Idx.get(Math.floor(symTs / (15 * 60 * 1000)) * (15 * 60 * 1000));
    const btcYesterdayIdx = btcTs2Idx.get(Math.floor(symTsYesterday / (15 * 60 * 1000)) * (15 * 60 * 1000));

    if (btcTodayIdx !== undefined && btcYesterdayIdx !== undefined) {
      const btcToday = btcCandles[btcTodayIdx].close;
      const btcYesterday = btcCandles[btcYesterdayIdx].close;
      if (btcYesterday > 0) {
        btcDailyReturns.push((btcToday - btcYesterday) / btcYesterday);
      } else {
        symDailyReturns.pop(); // Remove unmatched
      }
    } else {
      symDailyReturns.pop(); // Remove unmatched
    }
  }

  const btcCorr = calcPearsonCorrelation(symDailyReturns, btcDailyReturns);

  // 3. Volume CV — std/mean of daily volumes over 30 days
  const dailyVolumes: number[] = [];
  for (let d = 0; d < ROLLING_DAYS; d++) {
    const dayStart = symIdx - (ROLLING_DAYS - d) * CANDLES_PER_DAY;
    let dayVol = 0;
    for (let c = 0; c < CANDLES_PER_DAY && dayStart + c < symCandles.length; c++) {
      if (dayStart + c >= 0) dayVol += symCandles[dayStart + c].volume;
    }
    if (dayVol > 0) dailyVolumes.push(dayVol);
  }

  let volumeCV = 0;
  if (dailyVolumes.length > 5) {
    const mean = dailyVolumes.reduce((a, b) => a + b, 0) / dailyVolumes.length;
    const variance = dailyVolumes.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyVolumes.length;
    volumeCV = mean > 0 ? Math.sqrt(variance) / mean : 0;
  }

  return { atrPct, btcCorr, volumeCV };
}

// ============================================================================
// RUN BACKTEST
// ============================================================================

async function runBT(start: string, end: string) {
  const startDate = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');
  const extraBarsMs = 3200 * 15 * 60 * 1000;
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
  return { trades: result.trades, summary: result.summary, btcCandles, allData };
}

// ============================================================================
// DNA FILTER CONFIGS
// ============================================================================

interface DnaFilterConfig {
  name: string;
  atrPctMin: number;    // 0 = disabled
  atrPctMax: number;    // 0 = disabled
  btcCorrMax: number;   // 0 = disabled — block when correlation too high
  btcCorrMin: number;   // 0 = disabled — block when correlation too low
  volumeCVMax: number;  // 0 = disabled
}

function filterTradesByDna(
  trades: any[],
  btcCandles: BacktestCandle[],
  allData: Record<string, BacktestCandle[]>,
  config: DnaFilterConfig,
) {
  // Build BTC timestamp → index map
  const btcTs2Idx = new Map<number, number>();
  for (let i = 0; i < btcCandles.length; i++) {
    btcTs2Idx.set(btcCandles[i].timestamp, i);
  }

  // Build per-symbol timestamp → index maps
  const symTs2Idx = new Map<string, Map<number, number>>();
  for (const [sym, candles] of Object.entries(allData)) {
    const m = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      m.set(candles[i].timestamp, i);
    }
    symTs2Idx.set(sym, m);
  }

  const kept: any[] = [];
  const filtered: any[] = [];
  let dnaComputed = 0;

  for (const t of trades) {
    const sym = t.symbol;
    const symCandles = allData[sym];
    const symIdxMap = symTs2Idx.get(sym);
    if (!symCandles || !symIdxMap) { kept.push(t); continue; }

    const entryTs = new Date(t.entryTime).getTime();
    const flooredTs = Math.floor(entryTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    let symIdx = symIdxMap.get(flooredTs);
    if (symIdx === undefined) {
      // Find nearest
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < symCandles.length; i++) {
        const dist = Math.abs(symCandles[i].timestamp - entryTs);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      symIdx = best;
    }

    const dna = computeDna(symCandles, btcCandles, symIdx, btcTs2Idx);
    if (!dna) { kept.push(t); continue; }
    dnaComputed++;

    let block = false;

    if (config.atrPctMin > 0 && dna.atrPct < config.atrPctMin) block = true;
    if (config.atrPctMax > 0 && dna.atrPct > config.atrPctMax) block = true;
    if (config.btcCorrMax > 0 && dna.btcCorr > config.btcCorrMax) block = true;
    if (config.btcCorrMin > 0 && dna.btcCorr < config.btcCorrMin) block = true;
    if (config.volumeCVMax > 0 && dna.volumeCV > config.volumeCVMax) block = true;

    if (block) {
      filtered.push(t);
    } else {
      kept.push(t);
    }
  }

  return { kept, filtered, dnaComputed };
}

function calcStats(trades: any[], initialCapital: number) {
  if (trades.length === 0) return { trades: 0, wr: 0, pnl: 0, dd: 0 };

  const wins = trades.filter(t => t.netPnlUsd > 0).length;
  const pnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);

  let peak = initialCapital;
  let equity = initialCapital;
  let maxDd = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());
  for (const t of sorted) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  return { trades: trades.length, wr: (wins / trades.length) * 100, pnl, dd: maxDd };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  DNA FILTER SWEEP — 2024 vs 2025');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Running 2024 backtest...');
  const bt2024 = await runBT('2024-01-01', '2024-12-31');
  console.log(`  2024: ${bt2024.summary.totalTrades} trades, $${bt2024.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  console.log('Running 2025 backtest...');
  const bt2025 = await runBT('2025-01-01', '2025-12-31');
  console.log(`  2025: ${bt2025.summary.totalTrades} trades, $${bt2025.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  // DNA winning profile ranges (from analyze-symbol-dna.ts)
  // ATR%: 0.52-0.94%
  // BTC Correlation: 0.659-0.757
  // Volume CV: 0.63-0.72

  const configs: DnaFilterConfig[] = [
    { name: 'BASELINE', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 0 },

    // Single: BTC Correlation cap (block when too correlated — bull regime indicator)
    { name: 'BTC corr < 0.80', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0.80, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'BTC corr < 0.85', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0.85, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'BTC corr < 0.90', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0.90, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'BTC corr < 0.75', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0.75, btcCorrMin: 0, volumeCVMax: 0 },

    // Single: ATR% range
    { name: 'ATR 0.3-1.2%', atrPctMin: 0.3, atrPctMax: 1.2, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'ATR 0.4-1.0%', atrPctMin: 0.4, atrPctMax: 1.0, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'ATR 0.5-0.95%', atrPctMin: 0.5, atrPctMax: 0.95, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 0 },

    // Single: Volume CV cap
    { name: 'VolCV < 0.80', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 0.80 },
    { name: 'VolCV < 1.00', atrPctMin: 0, atrPctMax: 0, btcCorrMax: 0, btcCorrMin: 0, volumeCVMax: 1.00 },

    // Combined: BTC corr + ATR
    { name: 'Corr<0.85 + ATR 0.3-1.2', atrPctMin: 0.3, atrPctMax: 1.2, btcCorrMax: 0.85, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'Corr<0.80 + ATR 0.4-1.0', atrPctMin: 0.4, atrPctMax: 1.0, btcCorrMax: 0.80, btcCorrMin: 0, volumeCVMax: 0 },
    { name: 'Corr<0.85 + ATR 0.4-1.0', atrPctMin: 0.4, atrPctMax: 1.0, btcCorrMax: 0.85, btcCorrMin: 0, volumeCVMax: 0 },

    // Full DNA: all 3
    { name: 'FULL DNA loose', atrPctMin: 0.3, atrPctMax: 1.2, btcCorrMax: 0.85, btcCorrMin: 0, volumeCVMax: 1.00 },
    { name: 'FULL DNA tight', atrPctMin: 0.5, atrPctMax: 0.95, btcCorrMax: 0.80, btcCorrMin: 0, volumeCVMax: 0.80 },
    { name: 'FULL DNA medium', atrPctMin: 0.4, atrPctMax: 1.0, btcCorrMax: 0.85, btcCorrMin: 0, volumeCVMax: 0.90 },
  ];

  console.log('════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════════════════════════\n');

  const header = 'Config'.padEnd(28) + '| 2024 Tr | 2024 PnL  | 2024 DD  | 2025 Tr | 2025 PnL  | 2025 DD  | COMBINED';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const config of configs) {
    let s2024, s2025;

    if (config.atrPctMin === 0 && config.atrPctMax === 0 && config.btcCorrMax === 0 && config.volumeCVMax === 0) {
      s2024 = calcStats(bt2024.trades, INITIAL_CAPITAL);
      s2025 = calcStats(bt2025.trades, INITIAL_CAPITAL);
    } else {
      const f2024 = filterTradesByDna(bt2024.trades, bt2024.btcCandles, bt2024.allData, config);
      const f2025 = filterTradesByDna(bt2025.trades, bt2025.btcCandles, bt2025.allData, config);
      s2024 = calcStats(f2024.kept, INITIAL_CAPITAL);
      s2025 = calcStats(f2025.kept, INITIAL_CAPITAL);
    }

    const combined = s2024.pnl + s2025.pnl;
    const line = config.name.padEnd(28) + '| '
      + String(s2024.trades).padStart(4) + '    | '
      + ('$' + s2024.pnl.toFixed(0)).padStart(8) + '  | '
      + (s2024.dd.toFixed(1) + '%').padStart(6) + '  | '
      + String(s2025.trades).padStart(4) + '    | '
      + ('$' + s2025.pnl.toFixed(0)).padStart(8) + '  | '
      + (s2025.dd.toFixed(1) + '%').padStart(6) + '  | '
      + ('$' + combined.toFixed(0)).padStart(8);
    console.log(line);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
