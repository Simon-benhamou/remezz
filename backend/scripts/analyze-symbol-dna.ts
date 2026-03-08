/**
 * analyze-symbol-dna.ts — Quantify the "DNA" of winning symbols and find new candidates
 *
 * Computes 6 statistical metrics for each of our 9 winning symbols using local data,
 * then scans Binance for new symbols whose DNA matches the winning profile.
 *
 * Usage:
 *   npx tsx scripts/analyze-symbol-dna.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import * as ccxt from 'ccxt';

// ============================================================================
// TYPES
// ============================================================================
interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DNAMetrics {
  atrPct: number;        // Median ATR(14) as % of close
  mrRate: number;        // % of BB breakouts reverting within 5 candles
  volCV: number;         // Coefficient of variation of volume (rolling 50)
  btcCorr: number;       // Median 30-day rolling Pearson correlation with BTC
  dailyVolUsd: number;   // Median daily volume in USD
  independence: number;  // % of breakouts NOT coinciding with other symbols
}

// ============================================================================
// CONFIG
// ============================================================================
const DATA_DIR = path.resolve(import.meta.dirname ?? __dirname, '../data');

const WINNING_SYMBOLS = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];

const ALREADY_TESTED = new Set([
  // Winners
  'AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP',
  // Already tested
  'BTC', 'ETH', 'SOL', 'SUI', 'ARB', 'UNI', 'NEAR', 'APT', 'DOGE', 'SEI',
  'SONIC', 'BCH', 'LTC', 'FTM', 'OP', 'LINK', 'TIA', 'ATOM', 'INJ', 'JUP', 'BNB',
]);

// ATR period
const ATR_PERIOD = 14;
// Bollinger Bands parameters
const BB_PERIOD = 20;
const BB_STD = 2;
// Volume CV rolling window
const VOL_CV_WINDOW = 50;
// BTC correlation rolling window (30 days of 15m candles)
const BTC_CORR_WINDOW = 2880; // 30 * 24 * 4
// Breakout coincidence window (in candles)
const BREAKOUT_COINCIDENCE = 2;
// How many candles a breakout must revert within
const MR_REVERT_WINDOW = 5;
// Rate limit between Binance API calls (ms)
const RATE_LIMIT_MS = 200;
// Max candidates to fetch from Binance
const MAX_CANDIDATES = 50;

// ============================================================================
// HELPERS: Formatting
// ============================================================================
function padR(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s;
}

// ============================================================================
// HELPERS: Statistics
// ============================================================================
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

// ============================================================================
// HELPERS: Load local candle data
// ============================================================================
function loadLocalCandles(symbol: string): Candle[] {
  const filePath = path.join(DATA_DIR, `${symbol}_USDT_15m.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Data file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Candle[];
}

// ============================================================================
// METRIC 1: ATR% (14-period) — median across all candles
// ============================================================================
function computeAtrPct(candles: Candle[]): number {
  if (candles.length < ATR_PERIOD + 1) return 0;

  const atrPcts: number[] = [];
  let atr = 0;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );

    if (i <= ATR_PERIOD) {
      // Seed: simple average of first ATR_PERIOD true ranges
      atr += tr / ATR_PERIOD;
      if (i === ATR_PERIOD) {
        atrPcts.push((atr / c.close) * 100);
      }
    } else {
      // Wilder smoothing
      atr = (atr * (ATR_PERIOD - 1) + tr) / ATR_PERIOD;
      atrPcts.push((atr / c.close) * 100);
    }
  }

  return median(atrPcts);
}

// ============================================================================
// METRIC 2: Mean-Reversion Rate — % of BB breakouts reverting within 5 candles
// ============================================================================
function computeMeanReversionRate(candles: Candle[]): number {
  if (candles.length < BB_PERIOD) return 0;

  // Precompute BB bands for all valid candles
  let totalBreakouts = 0;
  let revertedWithin5 = 0;

  for (let i = BB_PERIOD - 1; i < candles.length; i++) {
    // Compute SMA and stddev over the last BB_PERIOD closes
    const window = candles.slice(i - BB_PERIOD + 1, i + 1).map(c => c.close);
    const sma = mean(window);
    const sd = std(window);
    const upper = sma + BB_STD * sd;
    const lower = sma - BB_STD * sd;

    const close = candles[i].close;

    // Check for breakout
    if (close > upper || close < lower) {
      totalBreakouts++;

      // Check if it reverts within MR_REVERT_WINDOW candles
      let reverted = false;
      const limit = Math.min(i + MR_REVERT_WINDOW, candles.length - 1);
      for (let j = i + 1; j <= limit; j++) {
        // Recompute bands at position j
        const wj = candles.slice(j - BB_PERIOD + 1, j + 1).map(c => c.close);
        const smaJ = mean(wj);
        const sdJ = std(wj);
        const upperJ = smaJ + BB_STD * sdJ;
        const lowerJ = smaJ - BB_STD * sdJ;
        if (candles[j].close <= upperJ && candles[j].close >= lowerJ) {
          reverted = true;
          break;
        }
      }
      if (reverted) revertedWithin5++;
    }
  }

  return totalBreakouts === 0 ? 0 : (revertedWithin5 / totalBreakouts) * 100;
}

// ============================================================================
// METRIC 3: Volume Spikiness (CV) — rolling 50-candle windows
// ============================================================================
function computeVolCV(candles: Candle[]): number {
  if (candles.length < VOL_CV_WINDOW) return 0;

  const cvValues: number[] = [];
  for (let i = VOL_CV_WINDOW - 1; i < candles.length; i++) {
    const window = candles.slice(i - VOL_CV_WINDOW + 1, i + 1).map(c => c.volume);
    const m = mean(window);
    if (m === 0) continue;
    const s = std(window);
    cvValues.push(s / m);
  }

  return median(cvValues);
}

// ============================================================================
// METRIC 4: BTC Correlation (30-day rolling Pearson on 15m returns)
// ============================================================================
function computeBtcCorrelation(candles: Candle[], btcCandles: Candle[]): number {
  // Align candles by openTime
  const btcMap = new Map<number, number>();
  for (let i = 1; i < btcCandles.length; i++) {
    const ret = (btcCandles[i].close - btcCandles[i - 1].close) / btcCandles[i - 1].close;
    btcMap.set(btcCandles[i].openTime, ret);
  }

  // Build aligned return arrays
  const symbolReturns: { time: number; ret: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const ret = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
    const btcRet = btcMap.get(candles[i].openTime);
    if (btcRet !== undefined) {
      symbolReturns.push({ time: candles[i].openTime, ret });
    }
  }

  if (symbolReturns.length < BTC_CORR_WINDOW) {
    // Not enough data for even one window — compute on all available
    const symRets = symbolReturns.map(r => r.ret);
    const btcRets = symbolReturns.map(r => btcMap.get(r.time)!);
    return pearson(symRets, btcRets);
  }

  // Rolling correlation
  const correlations: number[] = [];
  for (let i = BTC_CORR_WINDOW - 1; i < symbolReturns.length; i++) {
    const window = symbolReturns.slice(i - BTC_CORR_WINDOW + 1, i + 1);
    const symRets = window.map(r => r.ret);
    const btcRets = window.map(r => btcMap.get(r.time)!);
    correlations.push(pearson(symRets, btcRets));
  }

  return median(correlations);
}

// ============================================================================
// METRIC 5: Market Cap Proxy — median daily volume in USD
// ============================================================================
function computeDailyVolUsd(candles: Candle[]): number {
  // Group candles by day, sum close*volume per day
  const dailyVols = new Map<string, number>();
  for (const c of candles) {
    const day = new Date(c.openTime).toISOString().substring(0, 10);
    dailyVols.set(day, (dailyVols.get(day) ?? 0) + c.close * c.volume);
  }
  return median([...dailyVols.values()]);
}

// ============================================================================
// METRIC 6: Signal Timing Independence
// ============================================================================
function computeBreakoutTimestamps(candles: Candle[]): Set<number> {
  const breakouts = new Set<number>();
  if (candles.length < BB_PERIOD) return breakouts;

  for (let i = BB_PERIOD - 1; i < candles.length; i++) {
    const window = candles.slice(i - BB_PERIOD + 1, i + 1).map(c => c.close);
    const sma = mean(window);
    const sd = std(window);
    const upper = sma + BB_STD * sd;
    const lower = sma - BB_STD * sd;
    if (candles[i].close > upper || candles[i].close < lower) {
      breakouts.add(candles[i].openTime);
    }
  }
  return breakouts;
}

function computeIndependence(
  symbolBreakouts: Set<number>,
  allOtherBreakouts: Set<number>[],
  candleIntervalMs: number = 15 * 60 * 1000,
): number {
  if (symbolBreakouts.size === 0) return 100;

  const coincidenceWindowMs = BREAKOUT_COINCIDENCE * candleIntervalMs;
  let independent = 0;

  for (const ts of symbolBreakouts) {
    let coincident = false;
    for (const otherSet of allOtherBreakouts) {
      // Check if any other symbol has a breakout within +-coincidenceWindowMs
      for (let offset = -coincidenceWindowMs; offset <= coincidenceWindowMs; offset += candleIntervalMs) {
        if (otherSet.has(ts + offset)) {
          coincident = true;
          break;
        }
      }
      if (coincident) break;
    }
    if (!coincident) independent++;
  }

  return (independent / symbolBreakouts.size) * 100;
}

// ============================================================================
// COMPUTE ALL DNA METRICS FOR A SET OF CANDLES
// ============================================================================
function computeDNA(
  candles: Candle[],
  btcCandles: Candle[],
  otherBreakouts?: Set<number>[],
): DNAMetrics {
  const atrPct = computeAtrPct(candles);
  const mrRate = computeMeanReversionRate(candles);
  const volCV = computeVolCV(candles);
  const btcCorr = computeBtcCorrelation(candles, btcCandles);
  const dailyVolUsd = computeDailyVolUsd(candles);

  let independence = 0;
  if (otherBreakouts) {
    const myBreakouts = computeBreakoutTimestamps(candles);
    independence = computeIndependence(myBreakouts, otherBreakouts);
  }

  return { atrPct, mrRate, volCV, btcCorr, dailyVolUsd, independence };
}

// ============================================================================
// FORMAT HELPERS
// ============================================================================
function fmtPct(v: number, decimals = 2): string {
  return v.toFixed(decimals) + '%';
}
function fmtNum(v: number, decimals = 2): string {
  return v.toFixed(decimals);
}
function fmtVol(v: number): string {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + v.toFixed(0);
}

function printDnaTable(rows: { symbol: string; dna: DNAMetrics }[]): void {
  const header = `${padR('Symbol', 10)}| ${padL('ATR%', 8)} | ${padL('MR Rate', 8)} | ${padL('Vol CV', 8)} | ${padL('BTC Corr', 9)} | ${padL('Daily Vol', 14)} | ${padL('Independence', 13)}`;
  const sep = '-'.repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const { symbol, dna } of rows) {
    console.log(
      `${padR(symbol, 10)}| ${padL(fmtPct(dna.atrPct), 8)} | ${padL(fmtPct(dna.mrRate, 1), 8)} | ${padL(fmtNum(dna.volCV), 8)} | ${padL(fmtNum(dna.btcCorr, 3), 9)} | ${padL(fmtVol(dna.dailyVolUsd), 14)} | ${padL(fmtPct(dna.independence, 1), 13)}`
    );
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  PHASE 1: DNA Profile of 9 Winning Symbols');
  console.log('═'.repeat(60) + '\n');

  // Load BTC candles (needed for correlation)
  console.log('Loading BTC reference data...');
  const btcCandles = loadLocalCandles('BTC');
  console.log(`  BTC: ${btcCandles.length} candles loaded\n`);

  // Load all winning symbols and compute breakout timestamps first (needed for independence)
  const symbolData: Map<string, Candle[]> = new Map();
  const symbolBreakouts: Map<string, Set<number>> = new Map();

  for (const sym of WINNING_SYMBOLS) {
    try {
      const candles = loadLocalCandles(sym);
      symbolData.set(sym, candles);
      symbolBreakouts.set(sym, computeBreakoutTimestamps(candles));
      console.log(`  ${sym}: ${candles.length} candles loaded, ${symbolBreakouts.get(sym)!.size} breakouts`);
    } catch (err: any) {
      console.error(`  ${sym}: FAILED — ${err.message}`);
    }
  }

  console.log('');

  // Compute DNA for each winning symbol
  const winnerDNAs: { symbol: string; dna: DNAMetrics }[] = [];

  for (const sym of WINNING_SYMBOLS) {
    const candles = symbolData.get(sym);
    if (!candles) continue;

    // Other symbols' breakouts (excluding this one)
    const otherBreakouts = [...symbolBreakouts.entries()]
      .filter(([s]) => s !== sym)
      .map(([, b]) => b);

    console.log(`Computing DNA for ${sym}...`);
    const dna = computeDNA(candles, btcCandles, otherBreakouts);
    winnerDNAs.push({ symbol: sym, dna });
  }

  console.log('');
  printDnaTable(winnerDNAs);

  // ── TARGET DNA RANGES ──
  console.log('\n' + '═'.repeat(60));
  console.log('  TARGET DNA RANGES (min — max of 9 winners)');
  console.log('═'.repeat(60) + '\n');

  const metrics = winnerDNAs.map(w => w.dna);
  const ranges = {
    atrPct:      { min: Math.min(...metrics.map(m => m.atrPct)),      max: Math.max(...metrics.map(m => m.atrPct)),      mean: mean(metrics.map(m => m.atrPct)) },
    mrRate:      { min: Math.min(...metrics.map(m => m.mrRate)),      max: Math.max(...metrics.map(m => m.mrRate)),      mean: mean(metrics.map(m => m.mrRate)) },
    volCV:       { min: Math.min(...metrics.map(m => m.volCV)),       max: Math.max(...metrics.map(m => m.volCV)),       mean: mean(metrics.map(m => m.volCV)) },
    btcCorr:     { min: Math.min(...metrics.map(m => m.btcCorr)),     max: Math.max(...metrics.map(m => m.btcCorr)),     mean: mean(metrics.map(m => m.btcCorr)) },
    dailyVolUsd: { min: Math.min(...metrics.map(m => m.dailyVolUsd)), max: Math.max(...metrics.map(m => m.dailyVolUsd)), mean: mean(metrics.map(m => m.dailyVolUsd)) },
    independence:{ min: Math.min(...metrics.map(m => m.independence)), max: Math.max(...metrics.map(m => m.independence)), mean: mean(metrics.map(m => m.independence)) },
  };

  console.log(`  ATR%:           ${fmtPct(ranges.atrPct.min)} — ${fmtPct(ranges.atrPct.max)}  (mean: ${fmtPct(ranges.atrPct.mean)})`);
  console.log(`  MR Rate:        ${fmtPct(ranges.mrRate.min, 1)} — ${fmtPct(ranges.mrRate.max, 1)}  (mean: ${fmtPct(ranges.mrRate.mean, 1)})`);
  console.log(`  Vol CV:         ${fmtNum(ranges.volCV.min)} — ${fmtNum(ranges.volCV.max)}  (mean: ${fmtNum(ranges.volCV.mean)})`);
  console.log(`  BTC Corr:       ${fmtNum(ranges.btcCorr.min, 3)} — ${fmtNum(ranges.btcCorr.max, 3)}  (mean: ${fmtNum(ranges.btcCorr.mean, 3)})`);
  console.log(`  Daily Vol:      ${fmtVol(ranges.dailyVolUsd.min)} — ${fmtVol(ranges.dailyVolUsd.max)}  (mean: ${fmtVol(ranges.dailyVolUsd.mean)})`);
  console.log(`  Independence:   ${fmtPct(ranges.independence.min, 1)} — ${fmtPct(ranges.independence.max, 1)}  (mean: ${fmtPct(ranges.independence.mean, 1)})`);

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Scan Binance for candidates
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(60));
  console.log('  PHASE 2: Scanning Binance for DNA Matches');
  console.log('═'.repeat(60) + '\n');

  const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

  // 1. Load all markets
  console.log('Loading Binance USDM markets...');
  await exchange.loadMarkets();

  // 2. Get all tickers to sort by 24h volume
  console.log('Fetching 24h tickers...');
  const tickers = await exchange.fetchTickers();

  // 3. Filter USDT perpetuals, exclude already tested, sort by volume
  const candidates: { symbol: string; base: string; quoteVolume: number }[] = [];

  for (const [mktSymbol, ticker] of Object.entries(tickers)) {
    const market = exchange.markets[mktSymbol];
    if (!market) continue;
    if (!market.swap || !market.linear) continue; // USDT perpetual only
    if (market.quote !== 'USDT') continue;
    if (!market.active) continue;

    const base = market.base;
    if (ALREADY_TESTED.has(base)) continue;

    const vol24h = ticker.quoteVolume ?? 0;
    candidates.push({ symbol: mktSymbol, base, quoteVolume: vol24h });
  }

  // Sort by 24h quote volume descending, take top N
  candidates.sort((a, b) => b.quoteVolume - a.quoteVolume);
  const topCandidates = candidates.slice(0, MAX_CANDIDATES);

  console.log(`Found ${candidates.length} untested symbols, scanning top ${topCandidates.length} by volume...\n`);

  // 4. Fetch 30 days of 15m candles for each candidate and compute DNA
  const candidateDNAs: { symbol: string; base: string; dna: DNAMetrics; score: number }[] = [];
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const since = Date.now() - thirtyDaysMs;
  const candleLimit = 1500; // Binance max per request

  // We need BTC candles for the same period — fetch from Binance too
  console.log('Fetching BTC 15m candles from Binance (last 30 days)...');
  const btcCandlesRemote: Candle[] = [];
  {
    let fetchSince = since;
    for (let batch = 0; batch < 4; batch++) {
      // 30 days = ~2880 candles, need 2 batches of 1500
      const ohlcv = await exchange.fetchOHLCV('BTC/USDT:USDT', '15m', fetchSince, candleLimit);
      if (ohlcv.length === 0) break;
      for (const bar of ohlcv) {
        btcCandlesRemote.push({
          openTime: bar[0]!,
          open: bar[1]!,
          high: bar[2]!,
          low: bar[3]!,
          close: bar[4]!,
          volume: bar[5]!,
        });
      }
      fetchSince = ohlcv[ohlcv.length - 1][0]! + 15 * 60 * 1000;
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      if (ohlcv.length < candleLimit) break;
    }
  }
  console.log(`  BTC remote: ${btcCandlesRemote.length} candles fetched\n`);

  for (let idx = 0; idx < topCandidates.length; idx++) {
    const { symbol: mktSym, base } = topCandidates[idx];
    process.stdout.write(`  [${idx + 1}/${topCandidates.length}] ${padR(base, 10)}`);

    try {
      // Fetch candles in batches (need ~2880 for 30 days)
      const candles: Candle[] = [];
      let fetchSince = since;
      for (let batch = 0; batch < 4; batch++) {
        const ohlcv = await exchange.fetchOHLCV(mktSym, '15m', fetchSince, candleLimit);
        if (ohlcv.length === 0) break;
        for (const bar of ohlcv) {
          candles.push({
            openTime: bar[0]!,
            open: bar[1]!,
            high: bar[2]!,
            low: bar[3]!,
            close: bar[4]!,
            volume: bar[5]!,
          });
        }
        fetchSince = ohlcv[ohlcv.length - 1][0]! + 15 * 60 * 1000;
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
        if (ohlcv.length < candleLimit) break;
      }

      if (candles.length < 500) {
        console.log(`— skipped (only ${candles.length} candles)`);
        continue;
      }

      // Compute DNA (no independence metric for candidates — only among themselves)
      const dna = computeDNA(candles, btcCandlesRemote);

      // Score: count how many metrics fall within the winning range
      let score = 0;
      if (dna.atrPct >= ranges.atrPct.min && dna.atrPct <= ranges.atrPct.max) score++;
      if (dna.mrRate >= ranges.mrRate.min && dna.mrRate <= ranges.mrRate.max) score++;
      if (dna.volCV >= ranges.volCV.min && dna.volCV <= ranges.volCV.max) score++;
      if (dna.btcCorr >= ranges.btcCorr.min && dna.btcCorr <= ranges.btcCorr.max) score++;
      if (dna.dailyVolUsd >= ranges.dailyVolUsd.min && dna.dailyVolUsd <= ranges.dailyVolUsd.max) score++;
      // Independence not scored for candidates (no peer group to compare)

      candidateDNAs.push({ symbol: mktSym, base, dna, score });
      console.log(`— ${candles.length} candles, score ${score}/5`);

    } catch (err: any) {
      console.log(`— ERROR: ${err.message?.substring(0, 60)}`);
    }

    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  // 5. Sort by score (then by closeness to mean for tiebreak)
  candidateDNAs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak: sum of normalized distances to range means (lower = better)
    const distA = Math.abs(a.dna.atrPct - ranges.atrPct.mean) / (ranges.atrPct.max - ranges.atrPct.min || 1)
                + Math.abs(a.dna.mrRate - ranges.mrRate.mean) / (ranges.mrRate.max - ranges.mrRate.min || 1)
                + Math.abs(a.dna.volCV - ranges.volCV.mean) / (ranges.volCV.max - ranges.volCV.min || 1)
                + Math.abs(a.dna.btcCorr - ranges.btcCorr.mean) / (ranges.btcCorr.max - ranges.btcCorr.min || 1);
    const distB = Math.abs(b.dna.atrPct - ranges.atrPct.mean) / (ranges.atrPct.max - ranges.atrPct.min || 1)
                + Math.abs(b.dna.mrRate - ranges.mrRate.mean) / (ranges.mrRate.max - ranges.mrRate.min || 1)
                + Math.abs(b.dna.volCV - ranges.volCV.mean) / (ranges.volCV.max - ranges.volCV.min || 1)
                + Math.abs(b.dna.btcCorr - ranges.btcCorr.mean) / (ranges.btcCorr.max - ranges.btcCorr.min || 1);
    return distA - distB;
  });

  // 6. Print top 10
  console.log('\n' + '═'.repeat(60));
  console.log('  TOP 10 DNA MATCHES');
  console.log('═'.repeat(60) + '\n');

  const top10 = candidateDNAs.slice(0, 10);

  const hdr = `${padR('Rank', 5)} ${padR('Symbol', 10)}| ${padL('Score', 6)} | ${padL('ATR%', 8)} | ${padL('MR Rate', 8)} | ${padL('Vol CV', 8)} | ${padL('BTC Corr', 9)} | ${padL('Daily Vol', 14)}`;
  const hdrSep = '-'.repeat(hdr.length);
  console.log(hdr);
  console.log(hdrSep);

  for (let i = 0; i < top10.length; i++) {
    const { base, dna, score } = top10[i];

    // Mark metrics that are in range with a check
    const inRange = (val: number, r: { min: number; max: number }) => val >= r.min && val <= r.max;
    const mark = (val: string, ok: boolean) => ok ? val : val;

    console.log(
      `${padR(`#${i + 1}`, 5)} ${padR(base, 10)}| ${padL(`${score}/5`, 6)} | ${padL(fmtPct(dna.atrPct), 8)} | ${padL(fmtPct(dna.mrRate, 1), 8)} | ${padL(fmtNum(dna.volCV), 8)} | ${padL(fmtNum(dna.btcCorr, 3), 9)} | ${padL(fmtVol(dna.dailyVolUsd), 14)}`
    );
  }

  // Print which metrics are in/out of range for top candidates
  console.log('\n  Legend: range match details for top candidates\n');
  for (let i = 0; i < Math.min(5, top10.length); i++) {
    const { base, dna } = top10[i];
    const checks = [
      `ATR%:${dna.atrPct >= ranges.atrPct.min && dna.atrPct <= ranges.atrPct.max ? 'OK' : 'OUT'}`,
      `MR:${dna.mrRate >= ranges.mrRate.min && dna.mrRate <= ranges.mrRate.max ? 'OK' : 'OUT'}`,
      `CV:${dna.volCV >= ranges.volCV.min && dna.volCV <= ranges.volCV.max ? 'OK' : 'OUT'}`,
      `BTC:${dna.btcCorr >= ranges.btcCorr.min && dna.btcCorr <= ranges.btcCorr.max ? 'OK' : 'OUT'}`,
      `Vol:${dna.dailyVolUsd >= ranges.dailyVolUsd.min && dna.dailyVolUsd <= ranges.dailyVolUsd.max ? 'OK' : 'OUT'}`,
    ];
    console.log(`  ${padR(base, 10)} ${checks.join('  ')}`);
  }

  console.log('\nDone.');
}

// ============================================================================
// RUN
// ============================================================================
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
