/**
 * V5.99: DRASH CONTEXT SCORING
 *
 * Modular context factors for signal ranking.
 * Each factor returns a score in [-1, +1]:
 *   +1 = strongly favourable context
 *   -1 = strongly unfavourable context
 *    0 = neutral / insufficient data
 *
 * Factors are combined via weighted average and exposed as a single
 * ContextScoreResult to the signal ranker.
 */

import { MomentumConfig, type Candle } from './momentumSimple.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
}

export interface ContextScoreResult {
  srProximity: number | null;
  breakoutQuality: number | null;
  marketCorrelation: number | null;
  combined: number;
}

// Shorthand config aliases
type SRConfig = typeof MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY;
type BreakoutConfig = typeof MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY;
type CorrConfig = typeof MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION;

// ── 1. S/R Level Detection ─────────────────────────────────────────────────

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
  // Sort by price for clustering
  pivots.sort((a, b) => a.price - b.price);

  const clusters: { prices: number[]; type: 'support' | 'resistance' }[] = [];

  for (const pivot of pivots) {
    let merged = false;
    for (const cluster of clusters) {
      const avgPrice = cluster.prices.reduce((s, p) => s + p, 0) / cluster.prices.length;
      const distance = Math.abs(pivot.price - avgPrice) / avgPrice * 100;
      if (distance <= clusterPct) {
        cluster.prices.push(pivot.price);
        // If mixed types, keep the majority; on tie, use the latest added
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

// ── 2. S/R Proximity Score ─────────────────────────────────────────────────

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
        // LONG near support = positive
        rawScore = proximity;
      } else if (level.type === 'resistance' && price <= level.price * (1 + nearThresholdPct / 100)) {
        // LONG near resistance = negative
        rawScore = -proximity;
      }
    } else {
      // SHORT
      if (level.type === 'resistance' && price <= level.price * (1 + nearThresholdPct / 100)) {
        // SHORT near resistance = positive
        rawScore = proximity;
      } else if (level.type === 'support' && price >= level.price * (1 - nearThresholdPct / 100)) {
        // SHORT near support = negative
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

// ── 3. Breakout Quality Score ──────────────────────────────────────────────

/**
 * Score how strong the current breakout is.
 *
 * Components:
 *  - Distance from BB band: strong breakout (+0.5) vs weak (-0.5), linear interp
 *  - Candle body ratio: full body (+0.3) vs wick-heavy (-0.3)
 *  - Volume confirmation: big breakout + high vol (+0.2), big breakout + low vol (-0.3)
 *
 * @param current  The current candle
 * @param bb       Bollinger Band info: { upper, lower } for the relevant band
 * @param side     'long' | 'short'
 * @param volRatio Volume ratio (current / average)
 * @param config   Breakout quality config
 */
export function calcBreakoutQualityScore(
  current: Candle,
  bb: { upper: number; lower: number },
  side: 'long' | 'short',
  volRatio: number,
  config: BreakoutConfig,
): number {
  const { STRONG_BREAKOUT_PCT, WEAK_BREAKOUT_PCT, STRONG_BODY_RATIO, WEAK_BODY_RATIO, VOL_CONFIRM_MULT } = config;

  // --- Breakout distance component ---
  const band = side === 'long' ? bb.upper : bb.lower;
  const distPct = side === 'long'
    ? (current.close - band) / band * 100
    : (band - current.close) / band * 100;

  // Linear interp: WEAK_BREAKOUT_PCT → -0.5, STRONG_BREAKOUT_PCT → +0.5
  let distScore: number;
  if (distPct >= STRONG_BREAKOUT_PCT) {
    distScore = 0.5;
  } else if (distPct <= WEAK_BREAKOUT_PCT) {
    distScore = -0.5;
  } else {
    const t = (distPct - WEAK_BREAKOUT_PCT) / (STRONG_BREAKOUT_PCT - WEAK_BREAKOUT_PCT);
    distScore = -0.5 + t * 1.0;  // -0.5 to +0.5
  }

  // --- Body ratio component ---
  const range = current.high - current.low;
  const bodyRatio = range > 0 ? Math.abs(current.close - current.open) / range : 0;

  let bodyScore: number;
  if (bodyRatio >= STRONG_BODY_RATIO) {
    bodyScore = 0.3;
  } else if (bodyRatio <= WEAK_BODY_RATIO) {
    bodyScore = -0.3;
  } else {
    const t = (bodyRatio - WEAK_BODY_RATIO) / (STRONG_BODY_RATIO - WEAK_BODY_RATIO);
    bodyScore = -0.3 + t * 0.6;  // -0.3 to +0.3
  }

  // --- Volume confirmation component ---
  let volScore = 0;
  const isStrongBreakout = distPct >= STRONG_BREAKOUT_PCT;
  if (isStrongBreakout) {
    volScore = volRatio >= VOL_CONFIRM_MULT ? 0.2 : -0.3;
  }

  // Combine and clamp
  const raw = distScore + bodyScore + volScore;
  return Math.max(-1, Math.min(1, raw));
}

// ── 4. Market Correlation Score ────────────────────────────────────────────

/**
 * Score whether the current signal is isolated (contrarian) or herding.
 *
 * @param allSymbolsROC1  Map of symbol → ROC1 % for all monitored symbols
 * @param currentSymbol   The symbol being scored
 * @param side            'long' | 'short'
 * @param config          Correlation config
 */
export function calcMarketCorrelationScore(
  allSymbolsROC1: Map<string, number>,
  currentSymbol: string,
  side: 'long' | 'short',
  config: CorrConfig,
): number {
  const { ROC1_THRESHOLD_PCT, HERD_THRESHOLD, ISOLATED_THRESHOLD } = config;

  // Count other symbols moving in the same direction
  const otherSymbols = [...allSymbolsROC1.entries()].filter(([sym]) => sym !== currentSymbol);

  if (otherSymbols.length < 3) return 0;

  const sameDirectionCount = otherSymbols.filter(([, roc1]) => {
    if (side === 'long') return roc1 > ROC1_THRESHOLD_PCT;
    return roc1 < -ROC1_THRESHOLD_PCT;
  }).length;

  const herdRatio = sameDirectionCount / otherSymbols.length;

  if (herdRatio < ISOLATED_THRESHOLD) {
    // Isolated move — contrarian signal is favourable
    return 0.5;
  }
  if (herdRatio > HERD_THRESHOLD) {
    // Herd move — crowded trade, unfavourable
    return -0.5;
  }

  return 0;
}

// ── 5. Combined Context Score ──────────────────────────────────────────────

export interface CalcContextScoreParams {
  candles: Candle[];
  currentPrice: number;
  side: 'long' | 'short';
  currentCandle: Candle;
  bb: { upper: number; lower: number };
  volRatio: number;
  allSymbolsROC1: Map<string, number>;
  currentSymbol: string;
}

/**
 * Compute the combined context score from all enabled factors.
 *
 * Returns individual factor scores (null if disabled) and a weighted combined score.
 * All zeros if DRASH_CONTEXT.ENABLED is false.
 */
export function calcContextScore(params: CalcContextScoreParams): ContextScoreResult {
  const cfg = MomentumConfig.DRASH_CONTEXT;

  const result: ContextScoreResult = {
    srProximity: null,
    breakoutQuality: null,
    marketCorrelation: null,
    combined: 0,
  };

  if (!cfg.ENABLED) return result;

  const factors = cfg.FACTORS;
  let weightSum = 0;
  let scoreSum = 0;

  // --- S/R Proximity ---
  if (factors.SR_PROXIMITY.ENABLED) {
    const srCfg = factors.SR_PROXIMITY;
    const levels = findSRLevels(params.candles, {
      lookbackCandles: srCfg.LOOKBACK_CANDLES,
      pivotLookback: srCfg.PIVOT_LOOKBACK,
      minTouches: srCfg.MIN_TOUCHES,
      clusterPct: srCfg.CLUSTER_PCT,
    });
    const score = calcSRProximityScore(params.currentPrice, params.side, levels, {
      nearThresholdPct: srCfg.NEAR_THRESHOLD_PCT,
      farThresholdPct: srCfg.FAR_THRESHOLD_PCT,
    });
    result.srProximity = score;
    scoreSum += score * srCfg.WEIGHT;
    weightSum += srCfg.WEIGHT;
  }

  // --- Breakout Quality ---
  if (factors.BREAKOUT_QUALITY.ENABLED) {
    const bqCfg = factors.BREAKOUT_QUALITY;
    const score = calcBreakoutQualityScore(
      params.currentCandle,
      params.bb,
      params.side,
      params.volRatio,
      bqCfg,
    );
    result.breakoutQuality = score;
    scoreSum += score * bqCfg.WEIGHT;
    weightSum += bqCfg.WEIGHT;
  }

  // --- Market Correlation ---
  if (factors.MARKET_CORRELATION.ENABLED) {
    const mcCfg = factors.MARKET_CORRELATION;
    const score = calcMarketCorrelationScore(
      params.allSymbolsROC1,
      params.currentSymbol,
      params.side,
      mcCfg,
    );
    result.marketCorrelation = score;
    scoreSum += score * mcCfg.WEIGHT;
    weightSum += mcCfg.WEIGHT;
  }

  // Normalize by enabled weight
  result.combined = weightSum > 0 ? scoreSum / weightSum : 0;

  return result;
}
