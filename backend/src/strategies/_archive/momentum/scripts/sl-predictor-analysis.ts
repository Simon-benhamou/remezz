/**
 * sl-predictor-analysis.ts — Data-driven SL prediction
 *
 * Novel approach: extract 20+ features at entry time for every trade,
 * then statistically compare SL trades vs WINNING trades.
 * Find the features with the biggest separation → candidate filters.
 *
 * Run: npx tsx scripts/sl-predictor-analysis.ts
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
// FEATURE EXTRACTION — novel features not typically used
// ============================================================================

interface TradeFeatures {
  // Signal candle microstructure
  bodyRatio: number;           // |close-open| / (high-low) — clean breakout vs messy
  upperWickRatio: number;      // upper wick / candle range — rejection signal
  lowerWickRatio: number;      // lower wick / candle range
  bodyVsAtr: number;           // candle body size / ATR(14) — relative strength

  // Pre-breakout context (5 candles before signal)
  rangeCompression5: number;   // (max_high - min_low) of last 5 / ATR — squeeze indicator
  volumeTrend5: number;        // volume slope over last 5 candles (>0 = increasing)
  closeSlopeAngle: number;     // linear regression slope of last 5 closes (momentum quality)

  // Breakout quality
  bbDistancePct: number;       // distance from BB at entry (how far past BB)
  rocAccel: number;            // ROC(5) - ROC(10) — is momentum accelerating?
  volSurge: number;            // signal candle volume / avg(5 prior candles)

  // BTC micro-context
  btcCandleBody: number;       // BTC signal candle body direction (+/-)
  btcRoc2: number;             // BTC last 2 candle ROC — very short-term momentum
  btcVolSurge: number;         // BTC signal volume / avg(5 prior)

  // Pattern quality
  priorFalseBreakouts: number; // BB touches in last 20 candles that didn't sustain
  rangePosition: number;       // where in 20-candle range (0=low, 1=high)
  consecSameDir: number;       // consecutive candles in signal direction (overextension)

  // Time clustering
  hourOfDay: number;           // UTC hour

  // Outcome
  exitReason: string;
  pnl: number;
  isSL: boolean;
}

function extractFeatures(
  trade: any,
  symCandles: BacktestCandle[],
  btcCandles: BacktestCandle[],
  symTsMap: Map<number, number>,
  btcTsMap: Map<number, number>,
): TradeFeatures | null {
  const entryTs = new Date(trade.entryTime).getTime();
  const grid = 15 * 60 * 1000;
  // V5.150 FIX: trade.entryTime = candle CLOSE (candle.timestamp + 15min).
  // Subtract 15min to recover the signal candle's OPEN timestamp for feature extraction.
  const gridTs = Math.floor((entryTs - grid) / grid) * grid;

  let symIdx = symTsMap.get(gridTs);
  if (symIdx === undefined) {
    // Find nearest
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of symTsMap) {
      const dist = Math.abs(ts - entryTs);
      if (dist < bestDist) { bestDist = dist; best = idx; }
    }
    symIdx = best;
  }
  if (symIdx < 20) return null;

  const c = symCandles[symIdx]; // signal candle
  const range = c.high - c.low;
  if (range <= 0) return null;

  // Signal candle microstructure
  const body = Math.abs(c.close - c.open);
  const bodyRatio = body / range;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWickRatio = upperWick / range;
  const lowerWickRatio = lowerWick / range;

  // ATR(14)
  let atr = 0;
  if (symIdx >= 15) {
    let sum = 0;
    for (let i = symIdx - 14; i <= symIdx; i++) {
      const prev = symCandles[i - 1];
      const cur = symCandles[i];
      sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    }
    atr = sum / 14;
  }
  const bodyVsAtr = atr > 0 ? body / atr : 0;

  // Pre-breakout context (5 candles before)
  const pre5 = symCandles.slice(symIdx - 5, symIdx);
  const pre5Highs = pre5.map(x => x.high);
  const pre5Lows = pre5.map(x => x.low);
  const rangeCompression5 = atr > 0 ? (Math.max(...pre5Highs) - Math.min(...pre5Lows)) / atr : 0;

  // Volume trend
  const pre5Vols = pre5.map(x => x.volume);
  const avgPre5Vol = pre5Vols.reduce((a, b) => a + b, 0) / 5;
  let volumeTrend5 = 0;
  if (pre5Vols.length === 5 && pre5Vols[0] > 0) {
    // Simple: (last - first) / avg
    volumeTrend5 = (pre5Vols[4] - pre5Vols[0]) / (avgPre5Vol || 1);
  }

  // Close slope (linear regression over 5 candles)
  const pre5Closes = pre5.map(x => x.close);
  let closeSlopeAngle = 0;
  if (pre5Closes.length === 5) {
    const xMean = 2; // 0,1,2,3,4 → mean=2
    const yMean = pre5Closes.reduce((a, b) => a + b, 0) / 5;
    let num = 0, den = 0;
    for (let i = 0; i < 5; i++) {
      num += (i - xMean) * (pre5Closes[i] - yMean);
      den += (i - xMean) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    closeSlopeAngle = yMean > 0 ? (slope / yMean) * 100 : 0; // as % per candle
  }

  // BB distance
  const closes20 = symCandles.slice(symIdx - 19, symIdx + 1).map(x => x.close);
  const ma20 = closes20.reduce((a, b) => a + b, 0) / 20;
  const std20 = Math.sqrt(closes20.reduce((s, v) => s + (v - ma20) ** 2, 0) / 20);
  const bbUpper = ma20 + 2 * std20;
  const bbLower = ma20 - 2 * std20;
  const bbDistancePct = bbUpper > 0 ? ((c.close - bbUpper) / bbUpper) * 100 : 0;

  // ROC acceleration
  const closes10 = symCandles.slice(symIdx - 9, symIdx + 1).map(x => x.close);
  const closes5 = symCandles.slice(symIdx - 4, symIdx + 1).map(x => x.close);
  const roc10 = closes10.length >= 10 && closes10[0] > 0 ? (closes10[9] - closes10[0]) / closes10[0] * 100 : 0;
  const roc5 = closes5.length >= 5 && closes5[0] > 0 ? (closes5[4] - closes5[0]) / closes5[0] * 100 : 0;
  const rocAccel = roc5 - roc10;

  // Volume surge
  const volSurge = avgPre5Vol > 0 ? c.volume / avgPre5Vol : 0;

  // BTC micro-context
  const btcGridTs = gridTs;
  let btcIdx = btcTsMap.get(btcGridTs);
  if (btcIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of btcTsMap) {
      const dist = Math.abs(ts - entryTs);
      if (dist < bestDist) { bestDist = dist; best = idx; }
    }
    btcIdx = best;
  }

  let btcCandleBody = 0, btcRoc2 = 0, btcVolSurge = 0;
  if (btcIdx >= 5) {
    const bc = btcCandles[btcIdx];
    btcCandleBody = bc.close > bc.open ? 1 : -1;
    const bc2ago = btcCandles[btcIdx - 2];
    btcRoc2 = bc2ago.close > 0 ? ((bc.close - bc2ago.close) / bc2ago.close) * 100 : 0;
    const btcPre5 = btcCandles.slice(btcIdx - 5, btcIdx);
    const btcAvgVol = btcPre5.reduce((s, x) => s + x.volume, 0) / 5;
    btcVolSurge = btcAvgVol > 0 ? bc.volume / btcAvgVol : 0;
  }

  // Prior false breakouts (BB touches in last 20 that reverted)
  let priorFalseBreakouts = 0;
  for (let i = symIdx - 20; i < symIdx; i++) {
    if (i < 0) continue;
    const sc = symCandles[i];
    if (sc.high > bbUpper && sc.close < bbUpper) priorFalseBreakouts++; // touched but closed below
    if (sc.low < bbLower && sc.close > bbLower) priorFalseBreakouts++;
  }

  // Range position
  const range20High = Math.max(...symCandles.slice(symIdx - 19, symIdx + 1).map(x => x.high));
  const range20Low = Math.min(...symCandles.slice(symIdx - 19, symIdx + 1).map(x => x.low));
  const rangePosition = range20High > range20Low ? (c.close - range20Low) / (range20High - range20Low) : 0.5;

  // Consecutive same direction
  let consecSameDir = 0;
  const isLong = trade.side === 'long';
  for (let i = symIdx; i >= Math.max(0, symIdx - 10); i--) {
    const cc = symCandles[i];
    if ((isLong && cc.close > cc.open) || (!isLong && cc.close < cc.open)) {
      consecSameDir++;
    } else break;
  }

  const hourOfDay = new Date(entryTs).getUTCHours();

  return {
    bodyRatio,
    upperWickRatio,
    lowerWickRatio,
    bodyVsAtr,
    rangeCompression5,
    volumeTrend5,
    closeSlopeAngle,
    bbDistancePct,
    rocAccel,
    volSurge,
    btcCandleBody,
    btcRoc2,
    btcVolSurge,
    priorFalseBreakouts,
    rangePosition,
    consecSameDir,
    hourOfDay,
    exitReason: trade.exitReason || 'UNKNOWN',
    pnl: trade.netPnlUsd,
    isSL: (trade.exitReason || '').includes('SL'),
  };
}

// ============================================================================
// BACKTEST + ANALYSIS
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
  return { trades: result.trades, btcCandles, allData };
}

function analyzeFeatureSeparation(features: TradeFeatures[], label: string) {
  const slTrades = features.filter(f => f.isSL);
  const winTrades = features.filter(f => !f.isSL && f.pnl > 0);
  const stagnantTrades = features.filter(f => f.exitReason === 'STAGNANT_TRADE');

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}: ${features.length} trades | ${slTrades.length} SL | ${winTrades.length} WIN | ${stagnantTrades.length} STAGNANT`);
  console.log(`${'═'.repeat(70)}\n`);

  const featureKeys: (keyof TradeFeatures)[] = [
    'bodyRatio', 'upperWickRatio', 'lowerWickRatio', 'bodyVsAtr',
    'rangeCompression5', 'volumeTrend5', 'closeSlopeAngle',
    'bbDistancePct', 'rocAccel', 'volSurge',
    'btcCandleBody', 'btcRoc2', 'btcVolSurge',
    'priorFalseBreakouts', 'rangePosition', 'consecSameDir', 'hourOfDay',
  ];

  const median = (arr: number[]) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const mean = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

  type FeatureResult = { feature: string; slMean: number; winMean: number; separation: number; slMedian: number; winMedian: number };
  const results: FeatureResult[] = [];

  for (const key of featureKeys) {
    const slVals = slTrades.map(f => f[key] as number).filter(v => typeof v === 'number' && isFinite(v));
    const winVals = winTrades.map(f => f[key] as number).filter(v => typeof v === 'number' && isFinite(v));

    if (slVals.length < 5 || winVals.length < 5) continue;

    const slMean = mean(slVals);
    const winMean = mean(winVals);
    const pooledStd = Math.sqrt(
      (slVals.reduce((s, v) => s + (v - slMean) ** 2, 0) + winVals.reduce((s, v) => s + (v - winMean) ** 2, 0))
      / (slVals.length + winVals.length - 2)
    );
    // Cohen's d: effect size (|mean_diff| / pooled_std)
    const separation = pooledStd > 0 ? Math.abs(slMean - winMean) / pooledStd : 0;

    results.push({
      feature: key,
      slMean, winMean,
      separation,
      slMedian: median(slVals),
      winMedian: median(winVals),
    });
  }

  // Sort by separation (Cohen's d)
  results.sort((a, b) => b.separation - a.separation);

  console.log('Feature'.padEnd(22) + '| SL mean   | WIN mean  | Cohen d | SL med   | WIN med  | Direction');
  console.log('-'.repeat(105));

  for (const r of results) {
    const dir = r.slMean > r.winMean ? 'SL higher ↑' : 'SL lower ↓';
    const star = r.separation >= 0.3 ? ' ***' : r.separation >= 0.2 ? ' **' : r.separation >= 0.1 ? ' *' : '';
    console.log(
      r.feature.padEnd(22) + '| ' +
      r.slMean.toFixed(3).padStart(9) + ' | ' +
      r.winMean.toFixed(3).padStart(9) + ' | ' +
      r.separation.toFixed(3).padStart(6) + star.padEnd(5) + '| ' +
      r.slMedian.toFixed(3).padStart(8) + ' | ' +
      r.winMedian.toFixed(3).padStart(8) + ' | ' +
      dir
    );
  }

  // Top 3 features: show distributions
  console.log('\n--- Top 3 discriminating features (distribution) ---\n');
  for (const r of results.slice(0, 3)) {
    const slVals = slTrades.map(f => f[r.feature as keyof TradeFeatures] as number).filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);
    const winVals = winTrades.map(f => f[r.feature as keyof TradeFeatures] as number).filter(v => typeof v === 'number' && isFinite(v)).sort((a, b) => a - b);

    const p10 = (arr: number[]) => arr[Math.floor(arr.length * 0.1)];
    const p25 = (arr: number[]) => arr[Math.floor(arr.length * 0.25)];
    const p75 = (arr: number[]) => arr[Math.floor(arr.length * 0.75)];
    const p90 = (arr: number[]) => arr[Math.floor(arr.length * 0.9)];

    console.log(`${r.feature} (Cohen's d = ${r.separation.toFixed(3)}):`);
    console.log(`  SL:  P10=${p10(slVals)?.toFixed(3)} P25=${p25(slVals)?.toFixed(3)} MED=${r.slMedian.toFixed(3)} P75=${p75(slVals)?.toFixed(3)} P90=${p90(slVals)?.toFixed(3)}`);
    console.log(`  WIN: P10=${p10(winVals)?.toFixed(3)} P25=${p25(winVals)?.toFixed(3)} MED=${r.winMedian.toFixed(3)} P75=${p75(winVals)?.toFixed(3)} P90=${p90(winVals)?.toFixed(3)}`);
    console.log();
  }
}

async function main() {
  console.log('Running 2025 backtest...');
  const bt2025 = await runBT('2025-01-01', '2025-12-31');

  // Build timestamp maps
  const btcTsMap = new Map<number, number>();
  const grid = 15 * 60 * 1000;
  for (let i = 0; i < bt2025.btcCandles.length; i++) {
    btcTsMap.set(Math.floor(bt2025.btcCandles[i].timestamp / grid) * grid, i);
  }

  const symTsMaps = new Map<string, Map<number, number>>();
  for (const [sym, candles] of Object.entries(bt2025.allData)) {
    const m = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      m.set(Math.floor(candles[i].timestamp / grid) * grid, i);
    }
    symTsMaps.set(sym, m);
  }

  // Extract features for all trades
  const allFeatures: TradeFeatures[] = [];
  for (const trade of bt2025.trades) {
    const sym = trade.symbol;
    const symCandles = bt2025.allData[sym];
    const symTsMap = symTsMaps.get(sym);
    if (!symCandles || !symTsMap) continue;

    const f = extractFeatures(trade, symCandles, bt2025.btcCandles, symTsMap, btcTsMap);
    if (f) allFeatures.push(f);
  }

  analyzeFeatureSeparation(allFeatures, '2025 ALL TRADES');

  // Also analyze LONG vs SHORT separately
  const longFeatures = allFeatures.filter(f => !f.isSL || f.exitReason.includes('LONG') || f.pnl > 0);
  // Actually let's just show the combined analysis — it's more useful

  console.log('\nRunning 2024 backtest...');
  const bt2024 = await runBT('2024-01-01', '2024-12-31');

  const btcTsMap2024 = new Map<number, number>();
  for (let i = 0; i < bt2024.btcCandles.length; i++) {
    btcTsMap2024.set(Math.floor(bt2024.btcCandles[i].timestamp / grid) * grid, i);
  }
  const symTsMaps2024 = new Map<string, Map<number, number>>();
  for (const [sym, candles] of Object.entries(bt2024.allData)) {
    const m = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      m.set(Math.floor(candles[i].timestamp / grid) * grid, i);
    }
    symTsMaps2024.set(sym, m);
  }

  const allFeatures2024: TradeFeatures[] = [];
  for (const trade of bt2024.trades) {
    const sym = trade.symbol;
    const symCandles = bt2024.allData[sym];
    const symTsMap = symTsMaps2024.get(sym);
    if (!symCandles || !symTsMap) continue;
    const f = extractFeatures(trade, symCandles, bt2024.btcCandles, symTsMap, btcTsMap2024);
    if (f) allFeatures2024.push(f);
  }

  analyzeFeatureSeparation(allFeatures2024, '2024 ALL TRADES');

  console.log('\n═══ CROSS-YEAR VALIDATION ═══');
  console.log('Features that separate SL from WIN in BOTH years are robust candidates.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
