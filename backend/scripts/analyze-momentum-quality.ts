/**
 * Momentum Quality Score (MQS) Analysis
 *
 * Computes a composite quality score for each backtest trade based on 6 indicators
 * measured AT ENTRY TIME, then analyzes correlation with trade outcomes.
 *
 * Features:
 * 1. RSI Divergence (bearish div on LONG = fake, bullish div on SHORT = fake)
 * 2. ADX Absolute Level (trend strength, never tested as minimum filter)
 * 3. Volume Acceleration (is volume INCREASING candle-over-candle?)
 * 4. Candle Body Strength (body_ratio = conviction)
 * 5. Wick Rejection (wicks against the move = selling/buying pressure)
 * 6. ROC Acceleration (ROC of ROC — momentum accelerating or decelerating?)
 *
 * MQS = 0.20*rsi_div + 0.20*adx + 0.15*vol_accel + 0.15*body + 0.15*wick + 0.15*roc_accel
 *
 * Usage: cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsx scripts/analyze-momentum-quality.ts
 */
import { runBacktestComputation, type BacktestTrade } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  calcADX, calcROC,
} from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// CONFIG
// ============================================================================
const SYMBOLS = MomentumConfig.SYMBOLS;
const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
  postProcess1m: false,
};

// ============================================================================
// DATA LOADING (standard pattern)
// ============================================================================
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 200 * CANDLE_15M_MS;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandlesRegime = btcCandles;

  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`No data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const CANDLE_REGIME_INTERVAL_MS = configTfMin * 60 * 1000;

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS };
}

// ============================================================================
// INDICATOR FUNCTIONS
// ============================================================================

/** RSI(14) with standard Wilder smoothing */
function calcRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================================
// FEATURE SCORING FUNCTIONS
// ============================================================================

/**
 * 1. RSI Divergence Score
 * Looks for bearish divergence on LONG (price HH, RSI LH) and
 * bullish divergence on SHORT (price LL, RSI HL).
 * Returns 1 if no divergence (good), 0 if divergence detected (fake signal).
 */
function scoreRSIDivergence(
  candles: BacktestCandle[],
  entryIdx: number,
  side: 'long' | 'short',
): number {
  // We need a "previous swing" to compare against.
  // Use a simple approach: scan back 10-30 candles for a local extremum.
  // For LONG: find previous high in last 20-60 candles
  // For SHORT: find previous low in last 20-60 candles

  const lookback = 30; // candles to look back for previous swing
  const minGap = 5;    // minimum gap between current and previous swing

  if (entryIdx < lookback + 15) return 1; // not enough data, assume no divergence

  const window = candles.slice(Math.max(0, entryIdx - lookback - 14), entryIdx + 1);
  if (window.length < lookback) return 1;

  const closes = window.map(c => c.close);
  const highs = window.map(c => c.high);
  const lows = window.map(c => c.low);
  const n = closes.length;

  // Current RSI
  const currentRSI = calcRSI(closes, 14);

  if (side === 'long') {
    // Look for previous high that's lower than current high
    const currentHigh = highs[n - 1];
    let prevHighIdx = -1;
    let prevHighVal = -Infinity;

    // Find the highest point in the lookback range (excluding last minGap candles)
    for (let i = n - minGap - 1; i >= Math.max(0, n - lookback); i--) {
      if (highs[i] > prevHighVal) {
        prevHighVal = highs[i];
        prevHighIdx = i;
      }
    }

    if (prevHighIdx < 0) return 1;

    // Bearish divergence: price makes Higher High but RSI makes Lower High
    if (currentHigh > prevHighVal) {
      // Price HH - check if RSI made LH
      const prevCloses = closes.slice(0, prevHighIdx + 1);
      const prevRSI = calcRSI(prevCloses, 14);
      if (currentRSI < prevRSI - 3) { // 3-point RSI buffer to avoid noise
        return 0; // bearish divergence detected = FAKE
      }
    }
  } else {
    // SHORT: look for previous low that's higher than current low
    const currentLow = lows[n - 1];
    let prevLowIdx = -1;
    let prevLowVal = Infinity;

    for (let i = n - minGap - 1; i >= Math.max(0, n - lookback); i--) {
      if (lows[i] < prevLowVal) {
        prevLowVal = lows[i];
        prevLowIdx = i;
      }
    }

    if (prevLowIdx < 0) return 1;

    // Bullish divergence: price makes Lower Low but RSI makes Higher Low
    if (currentLow < prevLowVal) {
      const prevCloses = closes.slice(0, prevLowIdx + 1);
      const prevRSI = calcRSI(prevCloses, 14);
      if (currentRSI > prevRSI + 3) {
        return 0; // bullish divergence detected = FAKE
      }
    }
  }

  return 1; // no divergence
}

/**
 * 2. ADX Absolute Level Score
 * ADX < 15 = 0, 15-20 = 0.3, 20-25 = 0.6, 25-30 = 0.8, > 30 = 1.0
 */
function scoreADX(candles: BacktestCandle[]): number {
  const adx = calcADX(candles as any[], 14);
  if (adx < 15) return 0;
  if (adx < 20) return 0.3;
  if (adx < 25) return 0.6;
  if (adx < 30) return 0.8;
  return 1.0;
}

/**
 * 3. Volume Acceleration Score
 * Compare current candle volume to previous candle volume.
 * > 1.2 = 1.0, 0.8-1.2 = 0.5, < 0.8 = 0.0
 */
function scoreVolumeAcceleration(candles: BacktestCandle[], entryIdx: number): number {
  if (entryIdx < 1) return 0.5;
  const currentVol = candles[entryIdx].volume;
  const prevVol = candles[entryIdx - 1].volume;
  if (prevVol <= 0) return 0.5;
  const volAccel = currentVol / prevVol;
  if (volAccel > 1.2) return 1.0;
  if (volAccel >= 0.8) return 0.5;
  return 0;
}

/**
 * 4. Candle Body Strength Score
 * body_ratio = abs(close - open) / (high - low), capped at 1.0
 */
function scoreBodyStrength(candle: BacktestCandle): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0;
  const body = Math.abs(candle.close - candle.open);
  return Math.min(body / range, 1.0);
}

/**
 * 5. Wick Rejection Score
 * For LONG: upper_wick_ratio = (high - close) / (high - low). Less wick = better.
 * For SHORT: lower_wick_ratio = (close - low) / (high - low). Less wick = better.
 * Score = 1 - wick_ratio
 */
function scoreWickRejection(candle: BacktestCandle, side: 'long' | 'short'): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0.5;

  if (side === 'long') {
    // For LONG: upper wick = selling pressure at highs = bad
    const upperWick = (candle.high - Math.max(candle.close, candle.open)) / range;
    return Math.max(0, Math.min(1, 1 - upperWick));
  } else {
    // For SHORT: lower wick = buying pressure at lows = bad
    const lowerWick = (Math.min(candle.close, candle.open) - candle.low) / range;
    return Math.max(0, Math.min(1, 1 - lowerWick));
  }
}

/**
 * 6. ROC Acceleration Score
 * Compare ROC(1) of current candle to ROC(1) of previous candle.
 * For LONG: accelerating up = 1.0, flat = 0.5, decelerating = 0.0
 * For SHORT: accelerating down = 1.0, flat = 0.5, decelerating = 0.0
 */
function scoreROCAcceleration(candles: BacktestCandle[], entryIdx: number, side: 'long' | 'short'): number {
  if (entryIdx < 2) return 0.5;
  const c0 = candles[entryIdx];
  const c1 = candles[entryIdx - 1];
  const c2 = candles[entryIdx - 2];

  if (c1.close <= 0 || c2.close <= 0) return 0.5;

  const roc1_current = (c0.close - c1.close) / c1.close;
  const roc1_prev = (c1.close - c2.close) / c2.close;
  const rocDelta = roc1_current - roc1_prev;

  if (side === 'long') {
    // For LONG: positive delta = accelerating upward = good
    if (rocDelta > 0.001) return 1.0;  // accelerating
    if (rocDelta > -0.001) return 0.5; // flat
    return 0;                           // decelerating
  } else {
    // For SHORT: negative delta = accelerating downward = good
    if (rocDelta < -0.001) return 1.0;
    if (rocDelta < 0.001) return 0.5;
    return 0;
  }
}

// ============================================================================
// COMPOSITE SCORE
// ============================================================================
interface MQSResult {
  trade: BacktestTrade;
  side: 'long' | 'short';
  symbol: string;
  outcome: 'win' | 'loss';
  exitReason: string;
  // Individual scores
  rsiDivScore: number;
  adxScore: number;
  volAccelScore: number;
  bodyScore: number;
  wickScore: number;
  rocAccelScore: number;
  // Composite
  mqs: number;
  // Raw values for debugging
  rawADX: number;
  rawRSI: number;
  rawVolAccel: number;
  rawBodyRatio: number;
  rawWickRatio: number;
  rawROCDelta: number;
}

function computeMQS(
  trade: BacktestTrade,
  symbolCandles: BacktestCandle[],
): MQSResult | null {
  const entryTs = new Date(trade.entryTime).getTime();

  // Find the candle at or just before entry time
  let entryIdx = -1;
  for (let i = 0; i < symbolCandles.length; i++) {
    if (symbolCandles[i].timestamp >= entryTs) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx < 0 || entryIdx < 50) return null; // need warmup

  const side = trade.side as 'long' | 'short';
  const window = symbolCandles.slice(Math.max(0, entryIdx - 200), entryIdx + 1);
  if (window.length < 30) return null;

  const entryCandle = symbolCandles[entryIdx];
  const closes = window.map(c => c.close);

  // 1. RSI Divergence
  const rsiDivScore = scoreRSIDivergence(symbolCandles, entryIdx, side);

  // 2. ADX Level
  const adxScore = scoreADX(window as any[]);
  const rawADX = calcADX(window as any[], 14);

  // 3. Volume Acceleration
  const volAccelScore = scoreVolumeAcceleration(symbolCandles, entryIdx);
  const prevVol = entryIdx > 0 ? symbolCandles[entryIdx - 1].volume : 1;
  const rawVolAccel = prevVol > 0 ? entryCandle.volume / prevVol : 1;

  // 4. Body Strength
  const bodyScore = scoreBodyStrength(entryCandle);
  const range = entryCandle.high - entryCandle.low;
  const rawBodyRatio = range > 0 ? Math.abs(entryCandle.close - entryCandle.open) / range : 0;

  // 5. Wick Rejection
  const wickScore = scoreWickRejection(entryCandle, side);
  let rawWickRatio: number;
  if (range > 0) {
    if (side === 'long') {
      rawWickRatio = (entryCandle.high - Math.max(entryCandle.close, entryCandle.open)) / range;
    } else {
      rawWickRatio = (Math.min(entryCandle.close, entryCandle.open) - entryCandle.low) / range;
    }
  } else {
    rawWickRatio = 0;
  }

  // 6. ROC Acceleration
  const rocAccelScore = scoreROCAcceleration(symbolCandles, entryIdx, side);
  let rawROCDelta = 0;
  if (entryIdx >= 2) {
    const c0 = symbolCandles[entryIdx];
    const c1 = symbolCandles[entryIdx - 1];
    const c2 = symbolCandles[entryIdx - 2];
    if (c1.close > 0 && c2.close > 0) {
      const roc1_curr = (c0.close - c1.close) / c1.close;
      const roc1_prev = (c1.close - c2.close) / c2.close;
      rawROCDelta = roc1_curr - roc1_prev;
    }
  }

  // Raw RSI
  const rawRSI = calcRSI(closes, 14);

  // Composite: MQS = 0.20*rsi_div + 0.20*adx + 0.15*vol_accel + 0.15*body + 0.15*wick + 0.15*roc_accel
  const mqs = 0.20 * rsiDivScore
    + 0.20 * adxScore
    + 0.15 * volAccelScore
    + 0.15 * bodyScore
    + 0.15 * wickScore
    + 0.15 * rocAccelScore;

  const isWin = trade.netPnlUsd > 0;

  return {
    trade,
    side,
    symbol: trade.symbol.replace('/USDT:USDT', ''),
    outcome: isWin ? 'win' : 'loss',
    exitReason: trade.exitReason,
    rsiDivScore,
    adxScore,
    volAccelScore,
    bodyScore,
    wickScore,
    rocAccelScore,
    mqs,
    rawADX,
    rawRSI,
    rawVolAccel,
    rawBodyRatio,
    rawWickRatio,
    rawROCDelta,
  };
}

// ============================================================================
// STATISTICS HELPERS
// ============================================================================
function stats(values: number[]) {
  if (values.length === 0) return { mean: 0, median: 0, std: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, median, std: Math.sqrt(variance), n: values.length };
}

function cohenD(a: number[], b: number[]): number {
  const sa = stats(a);
  const sb = stats(b);
  if (sa.n === 0 || sb.n === 0) return 0;
  const pooledStd = Math.sqrt((sa.std ** 2 + sb.std ** 2) / 2);
  return pooledStd > 0 ? (sa.mean - sb.mean) / pooledStd : 0;
}

function pad(s: string | number, len: number): string {
  return String(s).padStart(len);
}

function padL(s: string | number, len: number): string {
  return String(s).padEnd(len);
}

function pct(n: number, d: number): string {
  return d > 0 ? (n / d * 100).toFixed(1) + '%' : 'N/A';
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('='.repeat(90));
  console.log('  MOMENTUM QUALITY SCORE (MQS) ANALYSIS');
  console.log('  V5.141 Backtest | Jan-Dec 2025 | 9 symbols | $2K | 5x leverage');
  console.log('='.repeat(90));

  // Step 1: Load data and run backtest
  console.log('\n[1/5] Loading candle data...');
  const data = await loadData();

  console.log('[2/5] Running V5.141 backtest...');
  const result = await runBacktestComputation({ params: PARAMS, ...data });
  console.log(`  Trades: ${result.trades.length}, WR: ${result.summary.winRate.toFixed(1)}%, PnL: $${result.summary.totalPnlUsd.toFixed(0)}`);

  // Step 2: Compute MQS for each trade
  console.log('\n[3/5] Computing Momentum Quality Scores...');
  const allMQS: MQSResult[] = [];
  let skipped = 0;
  for (const trade of result.trades) {
    const symbolCandles = data.allData[trade.symbol];
    if (!symbolCandles) { skipped++; continue; }
    const mqsResult = computeMQS(trade, symbolCandles);
    if (mqsResult) {
      allMQS.push(mqsResult);
    } else {
      skipped++;
    }
  }
  console.log(`  Computed: ${allMQS.length} trades, Skipped: ${skipped}`);

  const wins = allMQS.filter(m => m.outcome === 'win');
  const losses = allMQS.filter(m => m.outcome === 'loss');

  // ════════════════════════════════════════════════════════════════════════
  // STEP 3: MQS DISTRIBUTION
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  STEP 3: MQS DISTRIBUTION');
  console.log(`${'='.repeat(90)}`);

  const winMQS = stats(wins.map(m => m.mqs));
  const lossMQS = stats(losses.map(m => m.mqs));
  const mqsCohenD = cohenD(wins.map(m => m.mqs), losses.map(m => m.mqs));

  console.log(`  Winners  (n=${winMQS.n}):  mean=${winMQS.mean.toFixed(3)}, median=${winMQS.median.toFixed(3)}, std=${winMQS.std.toFixed(3)}`);
  console.log(`  Losers   (n=${lossMQS.n}):  mean=${lossMQS.mean.toFixed(3)}, median=${lossMQS.median.toFixed(3)}, std=${lossMQS.std.toFixed(3)}`);
  console.log(`  Cohen's d (MQS): ${mqsCohenD.toFixed(3)} ${Math.abs(mqsCohenD) > 0.8 ? '***' : Math.abs(mqsCohenD) > 0.5 ? '**' : Math.abs(mqsCohenD) > 0.2 ? '*' : '(negligible)'}`);

  // ════════════════════════════════════════════════════════════════════════
  // STEP 4: BUCKET ANALYSIS — MQS vs Outcomes
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  STEP 4: MQS BUCKET ANALYSIS — All Trades');
  console.log(`${'='.repeat(90)}`);

  interface BucketStats {
    label: string;
    trades: MQSResult[];
    count: number;
    wins: number;
    losses: number;
    wr: number;
    avgPnlUsd: number;
    totalPnlUsd: number;
    slCount: number;
    slRate: number;
  }

  function bucketize(items: MQSResult[], bucketRanges: [number, number, string][]): BucketStats[] {
    return bucketRanges.map(([lo, hi, label]) => {
      const bucket = items.filter(m => m.mqs >= lo && m.mqs < hi);
      const w = bucket.filter(m => m.outcome === 'win').length;
      const l = bucket.filter(m => m.outcome === 'loss').length;
      const slCount = bucket.filter(m => m.exitReason === 'SL').length;
      const totalPnl = bucket.reduce((s, m) => s + m.trade.netPnlUsd, 0);
      return {
        label,
        trades: bucket,
        count: bucket.length,
        wins: w,
        losses: l,
        wr: bucket.length > 0 ? w / bucket.length * 100 : 0,
        avgPnlUsd: bucket.length > 0 ? totalPnl / bucket.length : 0,
        totalPnlUsd: totalPnl,
        slCount,
        slRate: bucket.length > 0 ? slCount / bucket.length * 100 : 0,
      };
    });
  }

  const mqsBuckets: [number, number, string][] = [
    [0, 0.3, '0.00 - 0.30'],
    [0.3, 0.5, '0.30 - 0.50'],
    [0.5, 0.7, '0.50 - 0.70'],
    [0.7, 1.01, '0.70 - 1.00'],
  ];

  function printBucketTable(items: MQSResult[], title: string) {
    const buckets = bucketize(items, mqsBuckets);
    console.log(`\n  ${title}`);
    console.log(`  ${padL('MQS Bucket', 14)} ${pad('#', 6)} ${pad('Wins', 6)} ${pad('Loss', 6)} ${pad('WR%', 7)} ${pad('Avg$', 9)} ${pad('Total$', 10)} ${pad('SL#', 5)} ${pad('SL%', 7)}`);
    console.log(`  ${'-'.repeat(80)}`);
    for (const b of buckets) {
      console.log(
        `  ${padL(b.label, 14)} ${pad(b.count, 6)} ${pad(b.wins, 6)} ${pad(b.losses, 6)} ` +
        `${pad(b.wr.toFixed(1), 6)}% ${pad(b.avgPnlUsd.toFixed(1), 9)} ${pad(b.totalPnlUsd.toFixed(0), 10)} ` +
        `${pad(b.slCount, 5)} ${pad(b.slRate.toFixed(1), 6)}%`
      );
    }
    // Totals
    const total = items.length;
    const totalWins = items.filter(m => m.outcome === 'win').length;
    const totalLosses = items.filter(m => m.outcome === 'loss').length;
    const totalPnl = items.reduce((s, m) => s + m.trade.netPnlUsd, 0);
    const totalSL = items.filter(m => m.exitReason === 'SL').length;
    console.log(`  ${'-'.repeat(80)}`);
    console.log(
      `  ${padL('TOTAL', 14)} ${pad(total, 6)} ${pad(totalWins, 6)} ${pad(totalLosses, 6)} ` +
      `${pad((totalWins / total * 100).toFixed(1), 6)}% ${pad((totalPnl / total).toFixed(1), 9)} ${pad(totalPnl.toFixed(0), 10)} ` +
      `${pad(totalSL, 5)} ${pad((totalSL / total * 100).toFixed(1), 6)}%`
    );
  }

  // All trades
  printBucketTable(allMQS, 'ALL TRADES');

  // Split by LONG vs SHORT
  const longs = allMQS.filter(m => m.side === 'long');
  const shorts = allMQS.filter(m => m.side === 'short');
  printBucketTable(longs, 'LONG TRADES ONLY');
  printBucketTable(shorts, 'SHORT TRADES ONLY');

  // ════════════════════════════════════════════════════════════════════════
  // STEP 4b: INDIVIDUAL FEATURE Cohen's d (Winners vs Losers)
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  STEP 4b: INDIVIDUAL FEATURE EFFECT SIZES (Cohen d: * > 0.2, ** > 0.5, *** > 0.8)');
  console.log(`${'='.repeat(90)}`);

  const featureGetters: { name: string; getter: (m: MQSResult) => number }[] = [
    { name: 'RSI Divergence', getter: m => m.rsiDivScore },
    { name: 'ADX Level', getter: m => m.adxScore },
    { name: 'Vol Acceleration', getter: m => m.volAccelScore },
    { name: 'Body Strength', getter: m => m.bodyScore },
    { name: 'Wick Rejection', getter: m => m.wickScore },
    { name: 'ROC Acceleration', getter: m => m.rocAccelScore },
    { name: 'MQS (composite)', getter: m => m.mqs },
    // Raw values for reference
    { name: 'Raw ADX', getter: m => m.rawADX },
    { name: 'Raw RSI', getter: m => m.rawRSI },
    { name: 'Raw Vol Accel', getter: m => m.rawVolAccel },
    { name: 'Raw Body Ratio', getter: m => m.rawBodyRatio },
    { name: 'Raw Wick Ratio', getter: m => m.rawWickRatio },
    { name: 'Raw ROC Delta', getter: m => m.rawROCDelta },
  ];

  console.log(`\n  ${padL('Feature', 18)} ${pad('Win Mean', 10)} ${pad('Loss Mean', 10)} ${pad('d', 7)} Sig`);
  console.log(`  ${'-'.repeat(55)}`);

  for (const { name, getter } of featureGetters) {
    const winVals = wins.map(getter);
    const lossVals = losses.map(getter);
    const wSt = stats(winVals);
    const lSt = stats(lossVals);
    const d = cohenD(winVals, lossVals);
    const sig = Math.abs(d) > 0.8 ? '***' : Math.abs(d) > 0.5 ? '**' : Math.abs(d) > 0.2 ? '*' : '';
    console.log(
      `  ${padL(name, 18)} ${pad(wSt.mean.toFixed(3), 10)} ${pad(lSt.mean.toFixed(3), 10)} ${pad(d.toFixed(3), 7)} ${sig}`
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 5: INDIVIDUAL FEATURE MEDIAN-SPLIT ANALYSIS
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  STEP 5: INDIVIDUAL FEATURE ANALYSIS — Median Split (LOW vs HIGH half)');
  console.log(`${'='.repeat(90)}`);

  const featureScoreGetters: { name: string; getter: (m: MQSResult) => number }[] = [
    { name: 'RSI Divergence', getter: m => m.rsiDivScore },
    { name: 'ADX Level', getter: m => m.adxScore },
    { name: 'Vol Acceleration', getter: m => m.volAccelScore },
    { name: 'Body Strength', getter: m => m.bodyScore },
    { name: 'Wick Rejection', getter: m => m.wickScore },
    { name: 'ROC Acceleration', getter: m => m.rocAccelScore },
  ];

  for (const { name, getter } of featureScoreGetters) {
    const values = allMQS.map(getter);
    const sorted = [...values].sort((a, b) => a - b);
    const medianVal = sorted[Math.floor(sorted.length / 2)];

    const low = allMQS.filter(m => getter(m) <= medianVal);
    const high = allMQS.filter(m => getter(m) > medianVal);

    // Handle case where median split is degenerate (e.g., binary feature — most values are the same)
    if (high.length < 10 || low.length < 10) {
      // Try splitting on exact values
      const uniqueVals = [...new Set(values)].sort((a, b) => a - b);
      if (uniqueVals.length <= 3) {
        // Binary or ternary — show each value
        console.log(`\n  ${name} (discrete values: ${uniqueVals.map(v => v.toFixed(2)).join(', ')}):`);
        console.log(`  ${'Value'.padEnd(10)} ${'#'.padStart(6)} ${'Wins'.padStart(6)} ${'Loss'.padStart(6)} ${'WR%'.padStart(7)} ${'AvgPnl$'.padStart(10)} ${'TotalPnl$'.padStart(12)} ${'SL%'.padStart(7)}`);
        console.log(`  ${'-'.repeat(70)}`);
        for (const v of uniqueVals) {
          const group = allMQS.filter(m => Math.abs(getter(m) - v) < 0.001);
          const gWins = group.filter(m => m.outcome === 'win').length;
          const gLosses = group.filter(m => m.outcome === 'loss').length;
          const gPnl = group.reduce((s, m) => s + m.trade.netPnlUsd, 0);
          const gSL = group.filter(m => m.exitReason === 'SL').length;
          const gWR = group.length > 0 ? gWins / group.length * 100 : 0;
          console.log(
            `  ${v.toFixed(2).padEnd(10)} ${pad(group.length, 6)} ${pad(gWins, 6)} ${pad(gLosses, 6)} ` +
            `${pad(gWR.toFixed(1), 6)}% ${pad((gPnl / Math.max(group.length, 1)).toFixed(1), 10)} ` +
            `${pad(gPnl.toFixed(0), 12)} ${pad((gSL / Math.max(group.length, 1) * 100).toFixed(1), 6)}%`
          );
        }
        continue;
      }
    }

    const lowWins = low.filter(m => m.outcome === 'win').length;
    const highWins = high.filter(m => m.outcome === 'win').length;
    const lowPnl = low.reduce((s, m) => s + m.trade.netPnlUsd, 0);
    const highPnl = high.reduce((s, m) => s + m.trade.netPnlUsd, 0);
    const lowSL = low.filter(m => m.exitReason === 'SL').length;
    const highSL = high.filter(m => m.exitReason === 'SL').length;

    console.log(`\n  ${name} (median split at ${medianVal.toFixed(3)}):`);
    console.log(`  ${'Half'.padEnd(10)} ${'#'.padStart(6)} ${'Wins'.padStart(6)} ${'Loss'.padStart(6)} ${'WR%'.padStart(7)} ${'AvgPnl$'.padStart(10)} ${'TotalPnl$'.padStart(12)} ${'SL%'.padStart(7)}`);
    console.log(`  ${'-'.repeat(65)}`);
    console.log(
      `  ${'LOW'.padEnd(10)} ${pad(low.length, 6)} ${pad(lowWins, 6)} ${pad(low.length - lowWins, 6)} ` +
      `${pad((lowWins / Math.max(low.length, 1) * 100).toFixed(1), 6)}% ` +
      `${pad((lowPnl / Math.max(low.length, 1)).toFixed(1), 10)} ${pad(lowPnl.toFixed(0), 12)} ` +
      `${pad((lowSL / Math.max(low.length, 1) * 100).toFixed(1), 6)}%`
    );
    console.log(
      `  ${'HIGH'.padEnd(10)} ${pad(high.length, 6)} ${pad(highWins, 6)} ${pad(high.length - highWins, 6)} ` +
      `${pad((highWins / Math.max(high.length, 1) * 100).toFixed(1), 6)}% ` +
      `${pad((highPnl / Math.max(high.length, 1)).toFixed(1), 10)} ${pad(highPnl.toFixed(0), 12)} ` +
      `${pad((highSL / Math.max(high.length, 1) * 100).toFixed(1), 6)}%`
    );
    console.log(
      `  DELTA:   WR ${((highWins / Math.max(high.length, 1) - lowWins / Math.max(low.length, 1)) * 100).toFixed(1)}pp, ` +
      `PnL $${(highPnl - lowPnl).toFixed(0)}, ` +
      `SL ${((highSL / Math.max(high.length, 1) - lowSL / Math.max(low.length, 1)) * 100).toFixed(1)}pp`
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // STEP 5b: FEATURE SPLIT BY SIDE (LONG vs SHORT)
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  STEP 5b: INDIVIDUAL FEATURES — Cohen d by SIDE');
  console.log(`${'='.repeat(90)}`);

  for (const sideLabel of ['LONG', 'SHORT'] as const) {
    const sideTrades = allMQS.filter(m => m.side === sideLabel.toLowerCase());
    const sideWins = sideTrades.filter(m => m.outcome === 'win');
    const sideLosses = sideTrades.filter(m => m.outcome === 'loss');

    console.log(`\n  --- ${sideLabel} (n=${sideTrades.length}, W=${sideWins.length}, L=${sideLosses.length}) ---`);
    console.log(`  ${padL('Feature', 18)} ${pad('Win Mean', 10)} ${pad('Loss Mean', 10)} ${pad('d', 7)} Sig`);
    console.log(`  ${'-'.repeat(55)}`);

    for (const { name, getter } of featureGetters) {
      const wVals = sideWins.map(getter);
      const lVals = sideLosses.map(getter);
      const wS = stats(wVals);
      const lS = stats(lVals);
      const d = cohenD(wVals, lVals);
      const sig = Math.abs(d) > 0.8 ? '***' : Math.abs(d) > 0.5 ? '**' : Math.abs(d) > 0.2 ? '*' : '';
      console.log(
        `  ${padL(name, 18)} ${pad(wS.mean.toFixed(3), 10)} ${pad(lS.mean.toFixed(3), 10)} ${pad(d.toFixed(3), 7)} ${sig}`
      );
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // SUMMARY: TOP-10 and BOTTOM-10 MQS trades
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  TOP-10 MQS TRADES (highest quality entries)');
  console.log(`${'='.repeat(90)}`);

  const sorted = [...allMQS].sort((a, b) => b.mqs - a.mqs);
  console.log(`  ${padL('MQS', 6)} ${padL('Symbol', 8)} ${padL('Side', 6)} ${padL('Outcome', 8)} ${padL('Exit', 20)} ${pad('PnL$', 9)} ${pad('RSI', 5)} ${pad('ADX', 5)} ${pad('Vol', 5)} ${pad('Body', 5)} ${pad('Wick', 5)} ${pad('ROC', 5)}`);
  console.log(`  ${'-'.repeat(95)}`);
  for (const m of sorted.slice(0, 10)) {
    console.log(
      `  ${m.mqs.toFixed(3).padEnd(6)} ${padL(m.symbol, 8)} ${padL(m.side.toUpperCase(), 6)} ${padL(m.outcome.toUpperCase(), 8)} ` +
      `${padL(m.exitReason, 20)} ${pad(m.trade.netPnlUsd.toFixed(1), 9)} ` +
      `${pad(m.rsiDivScore.toFixed(1), 5)} ${pad(m.adxScore.toFixed(1), 5)} ${pad(m.volAccelScore.toFixed(1), 5)} ` +
      `${pad(m.bodyScore.toFixed(2), 5)} ${pad(m.wickScore.toFixed(2), 5)} ${pad(m.rocAccelScore.toFixed(1), 5)}`
    );
  }

  console.log(`\n  BOTTOM-10 MQS TRADES (lowest quality entries)`);
  console.log(`  ${padL('MQS', 6)} ${padL('Symbol', 8)} ${padL('Side', 6)} ${padL('Outcome', 8)} ${padL('Exit', 20)} ${pad('PnL$', 9)} ${pad('RSI', 5)} ${pad('ADX', 5)} ${pad('Vol', 5)} ${pad('Body', 5)} ${pad('Wick', 5)} ${pad('ROC', 5)}`);
  console.log(`  ${'-'.repeat(95)}`);
  for (const m of sorted.slice(-10)) {
    console.log(
      `  ${m.mqs.toFixed(3).padEnd(6)} ${padL(m.symbol, 8)} ${padL(m.side.toUpperCase(), 6)} ${padL(m.outcome.toUpperCase(), 8)} ` +
      `${padL(m.exitReason, 20)} ${pad(m.trade.netPnlUsd.toFixed(1), 9)} ` +
      `${pad(m.rsiDivScore.toFixed(1), 5)} ${pad(m.adxScore.toFixed(1), 5)} ${pad(m.volAccelScore.toFixed(1), 5)} ` +
      `${pad(m.bodyScore.toFixed(2), 5)} ${pad(m.wickScore.toFixed(2), 5)} ${pad(m.rocAccelScore.toFixed(1), 5)}`
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // FINAL VERDICT
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  VERDICT: MQS FILTER SIMULATION');
  console.log(`${'='.repeat(90)}`);

  // Simulate filtering out low-MQS trades
  const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
  console.log(`\n  ${padL('MQS >=', 8)} ${pad('#', 6)} ${pad('WR%', 7)} ${pad('AvgPnl$', 9)} ${pad('TotalPnl$', 11)} ${pad('SL%', 7)} ${pad('Removed', 8)} ${pad('RemWR%', 7)}`);
  console.log(`  ${'-'.repeat(75)}`);

  for (const thresh of thresholds) {
    const kept = allMQS.filter(m => m.mqs >= thresh);
    const removed = allMQS.filter(m => m.mqs < thresh);
    const kWins = kept.filter(m => m.outcome === 'win').length;
    const kPnl = kept.reduce((s, m) => s + m.trade.netPnlUsd, 0);
    const kSL = kept.filter(m => m.exitReason === 'SL').length;
    const rWins = removed.filter(m => m.outcome === 'win').length;
    console.log(
      `  ${padL('>= ' + thresh.toFixed(2), 8)} ${pad(kept.length, 6)} ` +
      `${pad((kWins / Math.max(kept.length, 1) * 100).toFixed(1), 6)}% ` +
      `${pad((kPnl / Math.max(kept.length, 1)).toFixed(1), 9)} ${pad(kPnl.toFixed(0), 11)} ` +
      `${pad((kSL / Math.max(kept.length, 1) * 100).toFixed(1), 6)}% ` +
      `${pad(removed.length, 8)} ${pad((rWins / Math.max(removed.length, 1) * 100).toFixed(1), 6)}%`
    );
  }

  console.log(`\n  Baseline (no filter): ${allMQS.length} trades, ${pct(wins.length, allMQS.length)} WR, $${allMQS.reduce((s, m) => s + m.trade.netPnlUsd, 0).toFixed(0)} total PnL`);

  // ════════════════════════════════════════════════════════════════════════
  // EXIT REASON BREAKDOWN by MQS bucket
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(90)}`);
  console.log('  EXIT REASON BREAKDOWN BY MQS BUCKET');
  console.log(`${'='.repeat(90)}`);

  for (const [lo, hi, label] of mqsBuckets) {
    const bucket = allMQS.filter(m => m.mqs >= lo && m.mqs < hi);
    if (bucket.length === 0) continue;

    const byExit: Record<string, { count: number; wins: number; pnl: number }> = {};
    for (const m of bucket) {
      const r = m.exitReason;
      if (!byExit[r]) byExit[r] = { count: 0, wins: 0, pnl: 0 };
      byExit[r].count++;
      if (m.outcome === 'win') byExit[r].wins++;
      byExit[r].pnl += m.trade.netPnlUsd;
    }

    console.log(`\n  MQS ${label} (n=${bucket.length}):`);
    console.log(`  ${padL('Exit Reason', 24)} ${pad('#', 5)} ${pad('WR%', 7)} ${pad('PnL$', 10)}`);
    console.log(`  ${'-'.repeat(50)}`);
    for (const [reason, d] of Object.entries(byExit).sort((a, b) => b[1].count - a[1].count)) {
      console.log(
        `  ${padL(reason, 24)} ${pad(d.count, 5)} ${pad((d.wins / d.count * 100).toFixed(1), 6)}% ${pad(d.pnl.toFixed(0), 10)}`
      );
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
