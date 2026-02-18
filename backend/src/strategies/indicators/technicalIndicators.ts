import { MomentumConfig, type Candle } from '../config/momentumConfig.js';
import type { Position } from '../config/momentumConfig.js';

// ============================================================================
// INDICATEURS - V5.41: Exported for shared use across backtest and live
// ============================================================================

export function calcMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  // V5.111: Avoid slice() allocation — sum in-place from the end
  let sum = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) sum += values[i];
  return sum / period;
}

export function calcSMA(values: number[], period: number): number {
  return calcMA(values, period);
}

export function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

// Bollinger Bands - V5.41: Unified function (alias for calcBB)
export function calcBollingerBands(closes: number[], period: number = 20, stdMultiplier: number = 2): { upper: number; middle: number; lower: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: middle + std * stdMultiplier,
    middle,
    lower: middle - std * stdMultiplier,
  };
}

// V5.41: Alias for backwards compatibility with backtest (uses calcBB name)
export function calcBB(closes: number[], period = 20, mult = 2): { upper: number; middle: number; lower: number } {
  return calcBollingerBands(closes, period, mult);
}

export function calcBBPosition(candles: Candle[], period = 20, mult = 2): number {
  const closes = candles.map(c => c.close);
  const bb = calcBB(closes, period, mult);
  const currentPrice = candles[candles.length - 1].close;
  if (bb.upper <= bb.lower) return 0.5;
  // V5.103: Return unclamped position so signal scorer can measure breakout depth
  // Values > 1.0 = above upper band, < 0.0 = below lower band
  return (currentPrice - bb.lower) / (bb.upper - bb.lower);
}

export function calcTrendStrength(closes: number[], period = 50): number {
  if (closes.length < period) return 0;
  const sma = calcSMA(closes, period);
  const currentPrice = closes[closes.length - 1];
  return sma > 0 ? (currentPrice - sma) / sma : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.101: S/R LEVEL DETECTION & PROXIMITY SCORING
// Moved from contextScore.ts — pure functions, no external deps.
// Used by the SR filter inside checkMomentumSignal().
// ═══════════════════════════════════════════════════════════════════════════

export interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
}

/**
 * Detect support/resistance levels from pivot points in candle history.
 *
 * A pivot HIGH is a candle whose high is >= all highs within `pivotLookback`
 * candles on each side.  Pivot LOW is symmetrical on lows.
 *
 * Nearby pivots are clustered (within `clusterPct`%), touches counted,
 * and weak levels (< minTouches) filtered out.
 */
export function findSRLevels(
  candles: Candle[],
  opts: { lookbackCandles: number; pivotLookback: number; minTouches: number; clusterPct: number },
): SRLevel[] {
  const { lookbackCandles, pivotLookback, minTouches, clusterPct } = opts;

  // Use only the most recent `lookbackCandles` candles
  const slice = candles.length > lookbackCandles
    ? candles.slice(candles.length - lookbackCandles)
    : candles;

  if (slice.length < pivotLookback * 2 + 1) return [];

  // --- Find pivot points ---
  const pivots: { price: number; type: 'support' | 'resistance' }[] = [];

  for (let i = pivotLookback; i < slice.length - pivotLookback; i++) {
    const c = slice[i];

    // Pivot HIGH
    let isHigh = true;
    for (let j = 1; j <= pivotLookback; j++) {
      if (slice[i - j].high > c.high || slice[i + j].high > c.high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) pivots.push({ price: c.high, type: 'resistance' });

    // Pivot LOW
    let isLow = true;
    for (let j = 1; j <= pivotLookback; j++) {
      if (slice[i - j].low < c.low || slice[i + j].low < c.low) {
        isLow = false;
        break;
      }
    }
    if (isLow) pivots.push({ price: c.low, type: 'support' });
  }

  if (pivots.length === 0) return [];

  // --- Cluster nearby pivots ---
  pivots.sort((a, b) => a.price - b.price);

  const clusters: { prices: number[]; type: 'support' | 'resistance' }[] = [];

  for (const pivot of pivots) {
    let merged = false;
    for (const cluster of clusters) {
      const avgPrice = cluster.prices.reduce((s, p) => s + p, 0) / cluster.prices.length;
      const distance = Math.abs(pivot.price - avgPrice) / avgPrice * 100;
      if (distance <= clusterPct) {
        cluster.prices.push(pivot.price);
        merged = true;
        break;
      }
    }
    if (!merged) {
      clusters.push({ prices: [pivot.price], type: pivot.type });
    }
  }

  // --- Build levels, filter by minTouches ---
  const levels: SRLevel[] = [];
  for (const cluster of clusters) {
    if (cluster.prices.length < minTouches) continue;
    const avgPrice = cluster.prices.reduce((s, p) => s + p, 0) / cluster.prices.length;
    levels.push({
      price: avgPrice,
      type: cluster.type,
      touches: cluster.prices.length,
    });
  }

  return levels;
}

/**
 * Score how favourable the current price is relative to nearby S/R levels.
 *
 * - LONG near support   → +1.0  (bouncing off support)
 * - LONG near resistance → -1.0  (running into ceiling)
 * - SHORT near resistance → +1.0  (bouncing off resistance)
 * - SHORT near support   → -0.8  (running into floor, slightly less penalised)
 * - No nearby S/R         →  0.0
 *
 * Strength bonus: levels with 4+ touches get a 1.2x multiplier (capped at |1.0|).
 */
export function calcSRProximityScore(
  price: number,
  side: 'long' | 'short',
  levels: SRLevel[],
  opts: { nearThresholdPct: number; farThresholdPct: number },
): number {
  if (levels.length === 0) return 0;

  const { nearThresholdPct, farThresholdPct } = opts;

  let bestScore = 0;

  for (const level of levels) {
    const distPct = Math.abs(price - level.price) / price * 100;

    // Skip levels that are too far away
    if (distPct > farThresholdPct) continue;

    // Proximity factor: 1.0 at distPct=0, linearly to 0.0 at farThresholdPct
    const proximity = 1 - distPct / farThresholdPct;

    let rawScore = 0;

    if (side === 'long') {
      if (level.type === 'support' && price >= level.price * (1 - nearThresholdPct / 100)) {
        rawScore = proximity;
      } else if (level.type === 'resistance' && price <= level.price * (1 + nearThresholdPct / 100)) {
        rawScore = -proximity;
      }
    } else {
      if (level.type === 'resistance' && price <= level.price * (1 + nearThresholdPct / 100)) {
        rawScore = proximity;
      } else if (level.type === 'support' && price >= level.price * (1 - nearThresholdPct / 100)) {
        rawScore = -0.8 * proximity;
      }
    }

    // Strength bonus for 4+ touches
    if (level.touches >= 4) {
      rawScore *= 1.2;
    }

    // Keep the strongest absolute score
    if (Math.abs(rawScore) > Math.abs(bestScore)) {
      bestScore = rawScore;
    }
  }

  // Clamp to [-1, +1]
  return Math.max(-1, Math.min(1, bestScore));
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET REGIME DETECTION (Cash Mode)
// ═══════════════════════════════════════════════════════════════════════════

export type MarketRegime = 'TRENDING_BULL' | 'TRENDING_BEAR' | 'CHOPPY' | 'LOW_VOL';

/**
 * Calculate ADX (Average Directional Index) for trend strength.
 * ADX < 20 = no trend, ADX > 25 = trending.
 */
export function calcADX(candles: Candle[], period = 14): number {
  if (candles.length < period * 2 + 1) return 0;

  const slice = candles.slice(-(period * 2 + 1));
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trArr: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high;
    const low = slice[i].low;
    const prevHigh = slice[i - 1].high;
    const prevLow = slice[i - 1].low;
    const prevClose = slice[i - 1].close;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Smoothed averages (Wilder's smoothing)
  const smooth = (arr: number[], p: number): number[] => {
    const result: number[] = [];
    let sum = arr.slice(0, p).reduce((s, v) => s + v, 0);
    result.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      result.push(sum);
    }
    return result;
  };

  const smoothPlusDM = smooth(plusDM, period);
  const smoothMinusDM = smooth(minusDM, period);
  const smoothTR = smooth(trArr, period);

  if (smoothTR.length === 0) return 0;

  const dxValues: number[] = [];
  for (let i = 0; i < smoothPlusDM.length; i++) {
    const tr = smoothTR[i];
    if (tr === 0) { dxValues.push(0); continue; }
    const plusDI = (smoothPlusDM[i] / tr) * 100;
    const minusDI = (smoothMinusDM[i] / tr) * 100;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxValues.length < period) return dxValues[dxValues.length - 1] || 0;

  // ADX = smoothed DX
  let adx = dxValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

/**
 * Detect current market regime from BTC candle data.
 */
export function detectMarketRegime(
  btcCandles: Candle[],
  btcCandles1h: Candle[],
): MarketRegime {
  const cfg = MomentumConfig.CASH_MODE;

  // ADX on 1h candles for trend strength
  const adx = btcCandles1h.length > 30 ? calcADX(btcCandles1h) : calcADX(btcCandles);

  // ATR declining check (volatility drying up)
  const atrCurrent = calcATR(btcCandles, 14);
  let atrDeclining = false;
  if (atrCurrent !== null && btcCandles.length > cfg.ATR_DECLINING_LOOKBACK + 14) {
    const olderCandles = btcCandles.slice(0, -cfg.ATR_DECLINING_LOOKBACK);
    const atrOlder = calcATR(olderCandles, 14);
    if (atrOlder !== null && atrOlder > 0) {
      atrDeclining = atrCurrent / atrOlder < cfg.ATR_DECLINING_RATIO;
    }
  }

  // SMA200 slope (flat = ranging)
  const closes1h = btcCandles1h.filter(c => c.isFinal !== false).map(c => c.close);
  let sma200SlopeFlat = false;
  // Try 1h closes first; fall back to 15m if insufficient data for SMA200 slope
  let slopeCloses: number[] | null;
  if (closes1h.length >= 205) {
    slopeCloses = closes1h;
  } else if (btcCandles.length >= 205) {
    slopeCloses = btcCandles.filter(c => c.isFinal !== false).map(c => c.close);
  } else {
    slopeCloses = null;
  }
  if (slopeCloses && slopeCloses.length >= 205) {
    const sma200Now = calcSMA(slopeCloses.slice(-200), 200);
    const sma200Prev = calcSMA(slopeCloses.slice(-205, -5), 200);
    if (sma200Prev > 0) {
      const slopePct = Math.abs((sma200Now - sma200Prev) / sma200Prev);
      sma200SlopeFlat = slopePct < cfg.SMA200_SLOPE_FLAT_PCT / 100;
    }
  }

  // Classify regime
  if (adx < cfg.ADX_NO_TREND_THRESHOLD && atrDeclining) {
    return 'LOW_VOL';
  }

  if (adx < cfg.ADX_NO_TREND_THRESHOLD && sma200SlopeFlat) {
    return 'CHOPPY';
  }

  // V5.113: Tolerance band around SMA200 to prevent whipsaw
  const tolerancePct = (MomentumConfig.ENTRY as any).BTC_REGIME_TOLERANCE_PCT ?? 0;

  // Determine bull/bear from SMA200 direction
  if (closes1h.length >= 200) {
    const sma200 = calcSMA(closes1h.slice(-200), 200);
    const currentPrice = closes1h[closes1h.length - 1];
    return classifyRegimeWithTolerance(currentPrice, sma200, tolerancePct, closes1h);
  }

  // Default: use 15m data
  const closes15m = btcCandles.map(c => c.close);
  if (closes15m.length >= 200) {
    const sma200 = calcSMA(closes15m.slice(-200), 200);
    return classifyRegimeWithTolerance(closes15m[closes15m.length - 1], sma200, tolerancePct, closes15m);
  }

  return 'TRENDING_BULL'; // Default to bullish if insufficient data
}

/**
 * V5.113: Classify regime with tolerance band around SMA200.
 * When price is within ±tolerance% of SMA200, use SMA slope to determine direction
 * (stateless hysteresis — rising SMA = BULL, falling SMA = BEAR).
 */
function classifyRegimeWithTolerance(
  currentPrice: number,
  sma200: number,
  tolerancePct: number,
  closes: number[],
): MarketRegime {
  if (tolerancePct <= 0 || sma200 <= 0) {
    return currentPrice > sma200 ? 'TRENDING_BULL' : 'TRENDING_BEAR';
  }
  const tolerance = sma200 * (tolerancePct / 100);
  if (currentPrice > sma200 + tolerance) return 'TRENDING_BULL';
  if (currentPrice < sma200 - tolerance) return 'TRENDING_BEAR';
  // In dead zone: use SMA200 slope to determine direction
  if (closes.length >= 201) {
    const sma200Prev = calcSMA(closes.slice(-201, -1), 200);
    return sma200 >= sma200Prev ? 'TRENDING_BULL' : 'TRENDING_BEAR';
  }
  return 'TRENDING_BULL';
}

/**
 * Should we skip entry based on the current regime?
 * In CHOPPY or LOW_VOL regimes, skip all entries (go to cash).
 */
export function shouldSkipEntryForRegime(
  regime: MarketRegime,
  _side: 'long' | 'short',
): boolean {
  if (!MomentumConfig.CASH_MODE.ENABLED) return false;
  return regime === 'CHOPPY' || regime === 'LOW_VOL';
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.41: SHARED COOLDOWN LOGIC - Single source of truth
// Used by both backtest and live agent after position exit
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get cooldown bars based on exit reason
 * - Profitable exits (TRAILING) = short cooldown (momentum continues)
 * - Loss exits (STOP_LOSS) = longer cooldown (bad signal)
 * - Regime/Momentum change = medium/long cooldown (wait for confirmation)
 *
 * @param exitReason - The exit reason string (case insensitive)
 * @param defaultCooldown - Default cooldown in bars (default 8 = 2h)
 * @returns Number of 15m bars to wait before next entry
 */
export function getCooldownBars(exitReason: string, defaultCooldown: number = 8): number {
  const reason = exitReason.toLowerCase();

  if (reason.includes('trailing') || reason.includes('trail') || reason === 'take_profit' || reason === 'tp') {
    return 2; // 30 minutes - profitable exit, quick re-entry allowed
  } else if (reason.includes('stop') || reason.includes('sl') || reason === 'stoploss') {
    return 10; // 2h30 - stop loss, extended wait
  } else if (reason.includes('stagnant')) {
    return 8; // 2h - stagnant trade (tightened SL hit)
  } else if (reason.includes('momentum')) {
    return 8; // 2h - momentum reversal
  } else if (reason.includes('regime')) {
    return 12; // 3h - regime change, wait for confirmation
  } else if (reason.includes('time') || reason === 'max_hold') {
    return 4; // 1h - max hold time reached
  }

  return defaultCooldown;
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.32: BB SQUEEZE DETECTION - Identify volatility compression
// When bandwidth is contracting, a big move is coming (works 70%+ of the time)
// ═══════════════════════════════════════════════════════════════════════════

export interface BBSqueezeResult {
  isSqueeze: boolean;        // Is there a squeeze? (bandwidth contracting)
  currentBW: number;         // Current bandwidth %
  avgBW: number;             // Average bandwidth over lookback period
  squeezeRatio: number;      // currentBW / avgBW (< 1 = squeezing)
}

/**
 * Detect BB Squeeze - volatility compression before explosive moves
 * @param closes - Array of closing prices
 * @param period - BB period (default 20)
 * @param lookback - How many candles to compare (default 10)
 * @param threshold - Squeeze threshold (default 0.7 = 70%)
 */
export function detectBBSqueeze(
  closes: number[],
  period: number = 20,
  lookback: number = 10,
  threshold: number = 0.7
): BBSqueezeResult {
  if (closes.length < period + lookback) {
    return { isSqueeze: false, currentBW: 0, avgBW: 0, squeezeRatio: 1 };
  }

  // Calculate current bandwidth
  const currentBB = calcBollingerBands(closes, period);
  const currentBW = (currentBB.upper - currentBB.lower) / currentBB.middle;

  // Calculate average bandwidth over lookback period
  const bandwidths: number[] = [];
  for (let i = lookback; i >= 1; i--) {
    const pastCloses = closes.slice(0, -i);
    if (pastCloses.length >= period) {
      const pastBB = calcBollingerBands(pastCloses, period);
      const pastBW = (pastBB.upper - pastBB.lower) / pastBB.middle;
      bandwidths.push(pastBW);
    }
  }

  if (bandwidths.length === 0) {
    return { isSqueeze: false, currentBW, avgBW: currentBW, squeezeRatio: 1 };
  }

  const avgBW = bandwidths.reduce((a, b) => a + b, 0) / bandwidths.length;
  const squeezeRatio = avgBW > 0 ? currentBW / avgBW : 1;

  return {
    isSqueeze: squeezeRatio < threshold,
    currentBW,
    avgBW,
    squeezeRatio,
  };
}

/**
 * Detect Volume Accumulation - rising volume pattern before spike
 * @param volumes - Array of volume values
 * @param lookback - How many candles to check (default 3)
 * @param minTrend - Minimum trend multiplier (default 1.05 = 5% increase)
 * @param minRatio - Minimum absolute volume ratio vs avg (default 0.8)
 */
export function detectVolumeAccumulation(
  volumes: number[],
  lookback: number = 3,
  minTrend: number = 1.05,
  minRatio: number = 0.8
): { isAccumulating: boolean; trendScore: number; avgRatio: number } {
  if (volumes.length < lookback + 10) {
    return { isAccumulating: false, trendScore: 0, avgRatio: 0 };
  }

  // Get recent volumes
  const recentVols = volumes.slice(-lookback);

  // Calculate average volume (excluding recent)
  const avgSlice = volumes.slice(-20, -lookback);
  const avgVol = avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length;

  // Check if each candle has more volume than the previous
  let trendCount = 0;
  for (let i = 1; i < recentVols.length; i++) {
    if (recentVols[i] >= recentVols[i - 1] * minTrend) {
      trendCount++;
    }
  }
  const trendScore = trendCount / (lookback - 1);

  // Check absolute volume level
  const recentAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const avgRatio = avgVol > 0 ? recentAvg / avgVol : 0;

  return {
    isAccumulating: trendScore >= 0.5 && avgRatio >= minRatio,
    trendScore,
    avgRatio,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.36: PATTERN FILTER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V5.36 PATTERN 1: Multi-Timeframe Confluence Filter
 * Checks if BTC higher timeframe (1h) trend aligns with signal direction
 *
 * @param btcCandles1h - BTC 1h candles (at least 11 candles needed)
 * @param side - Trade direction (LONG or SHORT)
 * @returns true if MTF aligned, false if divergent
 */
export function checkMTFAlignment(
  btcCandles1h: any[],
  side: 'LONG' | 'SHORT'
): boolean {
  const config = MomentumConfig.MULTI_TIMEFRAME_FILTER;

  if (!config.ENABLED) {
    return true; // Pass-through if disabled
  }

  if (!btcCandles1h || btcCandles1h.length < config.LOOKBACK_CANDLES + 1) {
    // Not enough data - fail safe: allow trade (log warning in production)
    return true;
  }

  // Calculate BTC 1h ROC
  const closes = btcCandles1h.map((c: any) => c.close);
  const btcRoc1h = calcROC(closes, config.LOOKBACK_CANDLES);

  // Check alignment
  if (side === 'LONG') {
    // LONG requires BTC 1h trend to be bullish (ROC > threshold)
    return btcRoc1h > config.MIN_BTC_ROC_LONG;
  } else if (side === 'SHORT') {
    // SHORT requires BTC 1h trend to be bearish (ROC < threshold)
    return btcRoc1h < config.MAX_BTC_ROC_SHORT;
  }

  return false;
}

/**
 * V5.36 PATTERN 2: BTC Volatility Filter
 * Checks if BTC has sufficient volatility for trending moves
 * Low volatility = choppy/ranging = stagnant trades
 *
 * @param btcCandles - BTC candles (15m timeframe)
 * @returns true if volatility sufficient, false if too low
 */
export function checkBTCVolatility(btcCandles: any[]): boolean {
  const config = MomentumConfig.BTC_VOLATILITY_FILTER;

  if (!config.ENABLED) {
    return true; // Pass-through if disabled
  }

  if (!btcCandles || btcCandles.length < config.ATR_PERIOD + 1) {
    // Not enough data - fail safe: allow trade
    return true;
  }

  // Calculate BTC ATR (returns absolute value in $)
  const btcATR = calcATR(btcCandles, config.ATR_PERIOD);

  // Handle null case (fail safe: allow trade)
  if (btcATR === null || btcATR === undefined) {
    return true;
  }

  // V5.39 FIX: Convert ATR to percentage for comparison with MIN_ATR_PCT
  // calcATR returns absolute value (e.g., $450 for BTC)
  // MIN_ATR_PCT is in % (e.g., 1.5%)
  // Without this fix, the filter ALWAYS passed because $450 >> 1.5!
  const btcPrice = btcCandles[btcCandles.length - 1].close;
  const btcATRPct = btcPrice > 0 ? (btcATR / btcPrice) * 100 : 0;

  // Check if volatility meets minimum threshold
  return btcATRPct >= config.MIN_ATR_PCT;
}

// Rate of Change (ROC) - V5.41: Exported for shared use
export function calcROC(closes: number[], period: number = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0;
}

// Count consecutive up candles - V5.41: Exported for shared use
export function countConsecUp(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// Count consecutive down candles (for SHORT) - V5.41: Exported for shared use
export function countConsecDown(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ============================================================================
// V5.78: CANDLE PATTERN QUALITY HELPER FUNCTIONS
// ============================================================================

/**
 * Green Ratio: proportion of bullish candles in the last N candles.
 * Used to detect overbought candle patterns before LONG entries.
 */
export function calcGreenRatio(candles: Candle[], lookback: number): number {
  const window = candles.slice(-lookback);
  if (window.length === 0) return 0.5;
  return window.filter(c => c.close > c.open).length / window.length;
}

/**
 * Alternation rate: count direction changes in the last 5 candles.
 * 0 = fully trending (all same direction), 4 = maximum chop (alternating every candle).
 */
export function calcAlternation5(candles: Candle[]): number {
  const tail = candles.slice(-5);
  if (tail.length < 2) return 0;
  const dirs = tail.map(c => c.close > c.open);
  let alt = 0;
  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] !== dirs[i - 1]) alt++;
  }
  return alt;
}

/**
 * Count how many of the last N candles touched or breached a BB band.
 * A "touch" = high >= upper * (1 - threshold) OR low <= lower * (1 + threshold).
 */
export function calcBBTouchCount(
  candles: Candle[],
  lookback: number,
  bbPeriod: number,
  threshold: number
): number {
  const n = candles.length;
  if (n < bbPeriod + lookback) return 0;
  let touches = 0;
  for (let i = n - lookback; i < n; i++) {
    const slice = candles.slice(Math.max(0, i - bbPeriod + 1), i + 1).map(c => c.close);
    if (slice.length < bbPeriod) continue;
    const bb = calcBB(slice, bbPeriod);
    if (candles[i].high >= bb.upper * (1 - threshold) || candles[i].low <= bb.lower * (1 + threshold)) {
      touches++;
    }
  }
  return touches;
}

/**
 * ROC Acceleration: difference between recent ROC and previous ROC.
 * Positive = momentum accelerating upward, negative = accelerating downward.
 */
export function calcRocAcceleration(closes: number[], fastPeriod: number): number {
  const n = closes.length;
  if (n < fastPeriod * 2 + 1) return 0;
  const rocNow = ((closes[n - 1] - closes[n - 1 - fastPeriod]) / closes[n - 1 - fastPeriod]) * 100;
  const rocPrev = ((closes[n - 1 - fastPeriod] - closes[n - 1 - fastPeriod * 2]) / closes[n - 1 - fastPeriod * 2]) * 100;
  return rocNow - rocPrev;
}

// ═══════════════════════════════════════════════════════════════════════════
// ATR (Average True Range)
// ═══════════════════════════════════════════════════════════════════════════

export function calcATR(candles: { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].high;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    atrSum += tr;
  }

  return atrSum / period;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOLATILITY REGIME & ADAPTIVE TRAILING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V5.14: Determine volatility regime and adaptive trailing parameters
 *
 * Returns trailing configuration adapted to current market volatility:
 * - LOW volatility (ATR < 2%): Tight trailing (0.3%), early activation (0.6%)
 * - MEDIUM volatility (2% < ATR < 3.5%): Standard trailing (0.5%), normal activation (0.8%)
 * - HIGH volatility (ATR > 3.5%): Wide trailing (0.8%), late activation (1.2%)
 */
export function determineVolatilityRegime(
  candles: { high: number; low: number; close: number }[]
): {
  regime: 'LOW' | 'MEDIUM' | 'HIGH';
  atrPct: number | null;
  trailingDistance: number;
  trailingActivation: number;
  reason: string;
} {
  const config = MomentumConfig.EXIT;

  // If adaptive trailing disabled, use defaults
  if (!config.ADAPTIVE_TRAILING) {
    return {
      regime: 'MEDIUM',
      atrPct: null,
      trailingDistance: config.TRAILING_DISTANCE_PCT,
      trailingActivation: config.TRAILING_ACTIVATION_PCT,
      reason: 'Adaptive trailing disabled - using defaults'
    };
  }

  // Calculate ATR
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) {
    return {
      regime: 'MEDIUM',
      atrPct: null,
      trailingDistance: config.TRAILING_DISTANCE_PCT,
      trailingActivation: config.TRAILING_ACTIVATION_PCT,
      reason: 'ATR unavailable - using defaults'
    };
  }

  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;

  // LOW VOLATILITY: ATR < 2%
  // Market is calm, tight trailing is safe
  if (atrPct < config.LOW_VOL_ATR_MAX) {
    return {
      regime: 'LOW',
      atrPct,
      trailingDistance: config.LOW_VOL_DISTANCE,
      trailingActivation: config.LOW_VOL_ACTIVATION,
      reason: `Low volatility (ATR ${atrPct.toFixed(2)}%) - tight trailing safe`
    };
  }

  // HIGH VOLATILITY: ATR > 3.5%
  // Market is wild, wide trailing needed to avoid noise exits
  if (atrPct > config.HIGH_VOL_ATR_MIN) {
    return {
      regime: 'HIGH',
      atrPct,
      trailingDistance: config.HIGH_VOL_DISTANCE,
      trailingActivation: config.HIGH_VOL_ACTIVATION,
      reason: `High volatility (ATR ${atrPct.toFixed(2)}%) - wide trailing to avoid noise`
    };
  }

  // MEDIUM VOLATILITY: 2% < ATR < 3.5%
  // Normal market conditions, standard trailing
  return {
    regime: 'MEDIUM',
    atrPct,
    trailingDistance: config.TRAILING_DISTANCE_PCT,
    trailingActivation: config.TRAILING_ACTIVATION_PCT,
    reason: `Medium volatility (ATR ${atrPct.toFixed(2)}%) - standard trailing`
  };
}

/**
 * V5.14: Calculate 3-layer protection prices with progressive profit lock
 *
 * Returns the 3 protection levels for a position:
 * - Emergency Stop: Wide stop loss on exchange (catastrophe protection)
 * - Trailing Stop: Intelligent app-side trailing (main exit logic)
 * - Profit Lock Stop: Progressive stop that moves up to lock profits
 */
/**
 * Update position water marks for trailing stop tracking
 * Call this every tick to track high/low
 */
export function updatePositionWaterMarks(
  position: Position,
  currentPrice: number,
  priceHigh?: number,
  priceLow?: number,
): Position {
  // Calculate current PnL %
  const currentPnlPct = position.side === 'long'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

  // Track max PnL reached (for exit analysis)
  const newMaxPnlPct = position.maxPnlPct !== undefined
    ? Math.max(position.maxPnlPct, currentPnlPct)
    : currentPnlPct;

  if (position.side === 'long') {
    const effectiveHigh = priceHigh ?? currentPrice;
    const newHigh = position.highWaterMark
      ? Math.max(position.highWaterMark, effectiveHigh)
      : effectiveHigh;
    return { ...position, highWaterMark: newHigh, maxPnlPct: newMaxPnlPct };
  } else {
    const effectiveLow = priceLow ?? currentPrice;
    const newLow = position.lowWaterMark
      ? Math.min(position.lowWaterMark, effectiveLow)
      : effectiveLow;
    return { ...position, lowWaterMark: newLow, maxPnlPct: newMaxPnlPct };
  }
}
