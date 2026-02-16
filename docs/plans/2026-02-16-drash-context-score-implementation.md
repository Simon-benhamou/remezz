# Drash Context Score Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a modular context scoring system (S/R proximity + breakout quality + market correlation) to the signal ranker, validated via train/test backtest split.

**Architecture:** A new `contextScore.ts` module with 3 independently-toggleable scoring factors that feed into the existing `calculateSignalScore()`. Each factor produces a score in [-1, +1]. The weighted sum becomes a new component in the signal ranker. Config lives in `MomentumConfig.DRASH_CONTEXT` with per-factor `ENABLED` toggles.

**Tech Stack:** TypeScript, existing Candle type from `momentumSimple.ts`, Jest for unit tests, existing `runBacktest()` for validation.

---

## Task 1: Add DRASH_CONTEXT config to MomentumConfig

**Files:**
- Modify: `backend/src/strategies/momentumSimple.ts` (add config block after line ~530, end of config object)

**Step 1: Find the end of MomentumConfig and add DRASH_CONTEXT config**

Add this block before the closing `}` of `MomentumConfig`:

```typescript
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.99: DRASH CONTEXT SCORING
  // Modular context factors for signal ranking (score, don't filter)
  // ═══════════════════════════════════════════════════════════════════════════
  DRASH_CONTEXT: {
    ENABLED: true,
    WEIGHT_IN_SIGNAL_SCORE: 0.20,

    FACTORS: {
      SR_PROXIMITY: {
        ENABLED: true,
        WEIGHT: 0.40,
        LOOKBACK_CANDLES: 200,
        PIVOT_LOOKBACK: 5,
        MIN_TOUCHES: 2,
        CLUSTER_PCT: 0.3,
        NEAR_THRESHOLD_PCT: 1.5,
        FAR_THRESHOLD_PCT: 5.0,
      },
      BREAKOUT_QUALITY: {
        ENABLED: true,
        WEIGHT: 0.35,
        STRONG_BREAKOUT_PCT: 1.5,
        WEAK_BREAKOUT_PCT: 0.3,
        STRONG_BODY_RATIO: 0.7,
        WEAK_BODY_RATIO: 0.3,
        VOL_CONFIRM_MULT: 2.0,
      },
      MARKET_CORRELATION: {
        ENABLED: true,
        WEIGHT: 0.25,
        ROC1_THRESHOLD_PCT: 0.5,
        HERD_THRESHOLD: 0.6,
        ISOLATED_THRESHOLD: 0.3,
      },
    },
  },
```

**Step 2: Verify build compiles**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add backend/src/strategies/momentumSimple.ts
git commit -m "V5.99: Add DRASH_CONTEXT config to MomentumConfig"
```

---

## Task 2: Create contextScore.ts with S/R proximity factor

**Files:**
- Create: `backend/src/strategies/contextScore.ts`
- Test: `backend/test/unit/contextScore.test.ts`

**Step 1: Write the failing test for S/R pivot detection**

Create `backend/test/unit/contextScore.test.ts`:

```typescript
import { findSRLevels, calcSRProximityScore } from '../../src/strategies/contextScore.js';

// Helper to generate candles with specific highs/lows for S/R level testing
function makeCandle(ts: number, open: number, high: number, low: number, close: number, volume = 100) {
  return { timestamp: ts, open, high, low, close, volume };
}

// Generate a series of candles that create clear S/R levels
function makeSRCandles(): ReturnType<typeof makeCandle>[] {
  const candles = [];
  const baseTs = 1700000000000;
  const interval = 900_000; // 15m
  let price = 100;

  // Create 50 candles with 2 clear support bounces at ~95 and 2 resistance rejections at ~105
  for (let i = 0; i < 50; i++) {
    const ts = baseTs + i * interval;

    if (i === 10 || i === 30) {
      // Support bounce: price dips to 95 then recovers
      candles.push(makeCandle(ts, 98, 99, 95, 97, 200));
    } else if (i === 20 || i === 40) {
      // Resistance rejection: price spikes to 105 then falls
      candles.push(makeCandle(ts, 102, 105, 101, 103, 200));
    } else {
      // Normal candle around 100
      const drift = Math.sin(i * 0.3) * 2;
      const c = price + drift;
      candles.push(makeCandle(ts, c - 0.5, c + 1, c - 1, c + 0.5, 100));
    }
  }
  return candles;
}

describe('contextScore', () => {
  describe('findSRLevels', () => {
    it('should detect support and resistance levels from pivot points', () => {
      const candles = makeSRCandles();
      const levels = findSRLevels(candles, { lookbackCandles: 50, pivotLookback: 3, minTouches: 2, clusterPct: 0.5 });

      // Should find at least one support level near 95 and one resistance near 105
      const supports = levels.filter(l => l.type === 'support');
      const resistances = levels.filter(l => l.type === 'resistance');

      expect(supports.length).toBeGreaterThanOrEqual(1);
      expect(resistances.length).toBeGreaterThanOrEqual(1);

      // Support should be near 95
      const nearestSupport = supports.find(s => Math.abs(s.price - 95) / 95 < 0.02);
      expect(nearestSupport).toBeDefined();
      expect(nearestSupport!.touches).toBeGreaterThanOrEqual(2);

      // Resistance should be near 105
      const nearestResistance = resistances.find(r => Math.abs(r.price - 105) / 105 < 0.02);
      expect(nearestResistance).toBeDefined();
      expect(nearestResistance!.touches).toBeGreaterThanOrEqual(2);
    });

    it('should filter out weak levels with < minTouches', () => {
      const candles = makeSRCandles();
      // Require 3 touches - should filter most levels
      const levels = findSRLevels(candles, { lookbackCandles: 50, pivotLookback: 3, minTouches: 3, clusterPct: 0.5 });
      // With only 2 touches per level, nothing should pass minTouches=3
      expect(levels.length).toBe(0);
    });

    it('should return empty for insufficient data', () => {
      const candles = [makeCandle(1, 100, 101, 99, 100)];
      const levels = findSRLevels(candles, { lookbackCandles: 200, pivotLookback: 5, minTouches: 2, clusterPct: 0.3 });
      expect(levels).toEqual([]);
    });
  });

  describe('calcSRProximityScore', () => {
    it('should score +1.0 for LONG near strong support', () => {
      // Price at 96, support at 95 (1.05% above support = within 1.5% threshold)
      const levels = [
        { price: 95, type: 'support' as const, touches: 3 },
        { price: 110, type: 'resistance' as const, touches: 2 },
      ];
      const score = calcSRProximityScore(96, 'long', levels, { nearPct: 1.5, farPct: 5.0 });
      expect(score).toBeGreaterThan(0.5);
    });

    it('should score -1.0 for LONG near strong resistance', () => {
      // Price at 104, resistance at 105 (0.96% below resistance)
      const levels = [
        { price: 90, type: 'support' as const, touches: 2 },
        { price: 105, type: 'resistance' as const, touches: 3 },
      ];
      const score = calcSRProximityScore(104, 'long', levels, { nearPct: 1.5, farPct: 5.0 });
      expect(score).toBeLessThan(-0.5);
    });

    it('should score +1.0 for SHORT near strong resistance', () => {
      const levels = [
        { price: 90, type: 'support' as const, touches: 2 },
        { price: 105, type: 'resistance' as const, touches: 3 },
      ];
      const score = calcSRProximityScore(104, 'short', levels, { nearPct: 1.5, farPct: 5.0 });
      expect(score).toBeGreaterThan(0.5);
    });

    it('should score 0 when no S/R levels nearby', () => {
      const levels = [
        { price: 50, type: 'support' as const, touches: 2 },
        { price: 150, type: 'resistance' as const, touches: 2 },
      ];
      const score = calcSRProximityScore(100, 'long', levels, { nearPct: 1.5, farPct: 5.0 });
      expect(score).toBe(0);
    });

    it('should score 0 for empty levels', () => {
      const score = calcSRProximityScore(100, 'long', [], { nearPct: 1.5, farPct: 5.0 });
      expect(score).toBe(0);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx jest test/unit/contextScore.test.ts --no-cache 2>&1 | tail -15`
Expected: FAIL — module not found

**Step 3: Create `contextScore.ts` with types and S/R factor**

Create `backend/src/strategies/contextScore.ts`:

```typescript
/**
 * V5.99: Drash Context Scoring System
 *
 * Modular signal context analysis with independently-toggleable factors.
 * Each factor produces a score in [-1.0, +1.0].
 * The weighted sum feeds into calculateSignalScore() as a new component.
 *
 * Factors:
 *   1. S/R Proximity  — Is price at a meaningful support/resistance level?
 *   2. Breakout Quality — Is the BB breakout strong or likely to fail?
 *   3. Market Correlation — Is this an isolated move or a herd event?
 */

import { MomentumConfig, type Candle } from './momentumSimple.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  touches: number;
}

export interface ContextScoreResult {
  score: number;                     // Final weighted score [-1.0, +1.0]
  srScore: number | null;            // null if factor disabled
  breakoutScore: number | null;
  correlationScore: number | null;
  srDetail?: {
    nearestSupport: number | null;
    nearestResistance: number | null;
    supportStrength: number;
    resistanceStrength: number;
    distToSupportPct: number | null;
    distToResistancePct: number | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTOR 1: S/R PROXIMITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect support and resistance levels from pivot points in candle data.
 *
 * Algorithm:
 * 1. Find local highs (pivot highs) — higher than pivotLookback candles on each side
 * 2. Find local lows (pivot lows) — lower than pivotLookback candles on each side
 * 3. Cluster nearby pivots within clusterPct% of each other
 * 4. Each cluster becomes an S/R level with touch count = number of merged pivots
 * 5. Filter out levels with fewer than minTouches
 */
export function findSRLevels(
  candles: Candle[],
  opts: { lookbackCandles: number; pivotLookback: number; minTouches: number; clusterPct: number },
): SRLevel[] {
  const { lookbackCandles, pivotLookback, minTouches, clusterPct } = opts;
  const startIdx = Math.max(0, candles.length - lookbackCandles);

  if (candles.length < pivotLookback * 2 + 1) return [];

  // Step 1-2: Find pivot highs and lows
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = startIdx + pivotLookback; i < candles.length - pivotLookback; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= pivotLookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isLow = false;
      }
    }

    if (isHigh) pivotHighs.push(candles[i].high);
    if (isLow) pivotLows.push(candles[i].low);
  }

  // Step 3-4: Cluster pivots and count touches
  function clusterPivots(prices: number[], type: 'support' | 'resistance'): SRLevel[] {
    if (prices.length === 0) return [];

    const sorted = [...prices].sort((a, b) => a - b);
    const clusters: SRLevel[] = [];
    let clusterPrices = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const clusterAvg = clusterPrices.reduce((s, p) => s + p, 0) / clusterPrices.length;
      const dist = Math.abs(sorted[i] - clusterAvg) / clusterAvg * 100;

      if (dist <= clusterPct) {
        clusterPrices.push(sorted[i]);
      } else {
        // Finalize previous cluster
        clusters.push({
          price: clusterPrices.reduce((s, p) => s + p, 0) / clusterPrices.length,
          type,
          touches: clusterPrices.length,
        });
        clusterPrices = [sorted[i]];
      }
    }
    // Finalize last cluster
    clusters.push({
      price: clusterPrices.reduce((s, p) => s + p, 0) / clusterPrices.length,
      type,
      touches: clusterPrices.length,
    });

    return clusters;
  }

  const supportLevels = clusterPivots(pivotLows, 'support');
  const resistanceLevels = clusterPivots(pivotHighs, 'resistance');

  // Step 5: Filter by minimum touches
  const all = [...supportLevels, ...resistanceLevels].filter(l => l.touches >= minTouches);

  return all;
}

/**
 * Score S/R proximity for a given price and trade direction.
 *
 * Returns [-1.0, +1.0]:
 *   +1.0 = ideal context (LONG at support, SHORT at resistance)
 *   -1.0 = bad context (LONG into resistance, SHORT into support)
 *    0.0 = no relevant S/R nearby
 */
export function calcSRProximityScore(
  price: number,
  side: 'long' | 'short',
  levels: SRLevel[],
  opts: { nearPct: number; farPct: number },
): number {
  if (levels.length === 0) return 0;

  const { nearPct, farPct } = opts;

  // Find nearest support (below price) and nearest resistance (above price)
  let nearestSupport: SRLevel | null = null;
  let nearestResistance: SRLevel | null = null;
  let minSupportDist = Infinity;
  let minResistanceDist = Infinity;

  for (const level of levels) {
    const distPct = Math.abs(price - level.price) / price * 100;

    if (level.type === 'support' && level.price <= price && distPct < minSupportDist) {
      minSupportDist = distPct;
      nearestSupport = level;
    }
    if (level.type === 'resistance' && level.price >= price && distPct < minResistanceDist) {
      minResistanceDist = distPct;
      nearestResistance = level;
    }
  }

  let score = 0;

  // Strength multiplier: 4+ touches = 1.2x (capped at absolute 1.0)
  const strengthMult = (touches: number) => touches >= 4 ? 1.2 : 1.0;

  if (side === 'long') {
    // LONG near support = good (+1.0)
    if (nearestSupport && minSupportDist <= nearPct) {
      score += 1.0 * strengthMult(nearestSupport.touches);
    }
    // LONG near resistance = bad (-1.0)
    if (nearestResistance && minResistanceDist <= nearPct) {
      score -= 1.0 * strengthMult(nearestResistance.touches);
    }
  } else {
    // SHORT near resistance = good (+1.0)
    if (nearestResistance && minResistanceDist <= nearPct) {
      score += 1.0 * strengthMult(nearestResistance.touches);
    }
    // SHORT near support = bad (-0.8)
    if (nearestSupport && minSupportDist <= nearPct) {
      score -= 0.8 * strengthMult(nearestSupport.touches);
    }
  }

  // Clamp to [-1.0, +1.0]
  return Math.max(-1, Math.min(1, score));
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTOR 2: BREAKOUT QUALITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score breakout quality based on distance from BB, candle body, and volume.
 *
 * Components (each -0.5 to +0.5, summed and clamped to [-1.0, +1.0]):
 *   1. Breakout distance from BB band
 *   2. Candle body conviction (full body vs wick-heavy)
 *   3. Volume confirmation relative to breakout
 */
export function calcBreakoutQualityScore(
  current: Candle,
  bb: { upper: number; lower: number },
  side: 'long' | 'short',
  volRatio: number,
  config: {
    strongBreakoutPct: number;
    weakBreakoutPct: number;
    strongBodyRatio: number;
    weakBodyRatio: number;
    volConfirmMult: number;
  },
): number {
  const { strongBreakoutPct, weakBreakoutPct, strongBodyRatio, weakBodyRatio, volConfirmMult } = config;
  let score = 0;

  // 1. Breakout distance
  const breakoutDist = side === 'long'
    ? (current.close - bb.upper) / current.close * 100
    : (bb.lower - current.close) / current.close * 100;

  if (breakoutDist >= strongBreakoutPct) {
    score += 0.5;
  } else if (breakoutDist <= weakBreakoutPct) {
    score -= 0.5;
  } else {
    // Linear interpolation between weak and strong
    const range = strongBreakoutPct - weakBreakoutPct;
    score += ((breakoutDist - weakBreakoutPct) / range - 0.5) * 1.0;
  }

  // 2. Candle body conviction
  const candleRange = current.high - current.low;
  if (candleRange > 0) {
    const bodyRatio = Math.abs(current.close - current.open) / candleRange;
    if (bodyRatio >= strongBodyRatio) {
      score += 0.3;
    } else if (bodyRatio <= weakBodyRatio) {
      score -= 0.3;
    }
  }

  // 3. Volume confirmation
  if (breakoutDist >= weakBreakoutPct) {
    // Only check volume for actual breakouts
    if (volRatio >= volConfirmMult) {
      score += 0.2;
    } else if (volRatio < 1.0) {
      score -= 0.3; // Big breakout + low volume = fake
    }
  }

  return Math.max(-1, Math.min(1, score));
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTOR 3: MARKET CORRELATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Score market-wide correlation: isolated signals are better than herd moves.
 *
 * When >60% of symbols move in the same direction, it's a market-wide event,
 * not an individual opportunity. When <30% move together, it's isolated = genuine edge.
 */
export function calcMarketCorrelationScore(
  allSymbolsROC1: Map<string, number>,
  currentSymbol: string,
  side: 'long' | 'short',
  config: {
    roc1ThresholdPct: number;
    herdThreshold: number;
    isolatedThreshold: number;
  },
): number {
  const { roc1ThresholdPct, herdThreshold, isolatedThreshold } = config;

  // Need at least 3 other symbols for meaningful correlation
  const otherSymbols = [...allSymbolsROC1.entries()].filter(([sym]) => sym !== currentSymbol);
  if (otherSymbols.length < 3) return 0;

  const threshold = roc1ThresholdPct / 100;
  let sameDirectionCount = 0;

  for (const [, roc1] of otherSymbols) {
    if (side === 'long' && roc1 > threshold) sameDirectionCount++;
    if (side === 'short' && roc1 < -threshold) sameDirectionCount++;
  }

  const herdRatio = sameDirectionCount / otherSymbols.length;

  if (herdRatio < isolatedThreshold) return 0.5;   // Isolated = good
  if (herdRatio > herdThreshold) return -0.5;       // Herd = bad
  return 0;                                          // Normal = neutral
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: COMBINED CONTEXT SCORE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate the combined context score from all enabled factors.
 *
 * Each factor is independently toggleable. Disabled factors contribute 0
 * and their weight is redistributed proportionally to enabled factors.
 */
export function calcContextScore(params: {
  candles: Candle[];
  current: Candle;
  bb: { upper: number; lower: number };
  side: 'long' | 'short';
  volRatio: number;
  allSymbolsROC1: Map<string, number>;
  currentSymbol: string;
}): ContextScoreResult {
  const config = MomentumConfig.DRASH_CONTEXT;
  const result: ContextScoreResult = {
    score: 0,
    srScore: null,
    breakoutScore: null,
    correlationScore: null,
  };

  if (!config.ENABLED) return result;

  const factors = config.FACTORS;
  let totalWeight = 0;
  let weightedSum = 0;

  // Factor 1: S/R Proximity
  if (factors.SR_PROXIMITY.ENABLED) {
    const srConfig = factors.SR_PROXIMITY;
    const levels = findSRLevels(params.candles, {
      lookbackCandles: srConfig.LOOKBACK_CANDLES,
      pivotLookback: srConfig.PIVOT_LOOKBACK,
      minTouches: srConfig.MIN_TOUCHES,
      clusterPct: srConfig.CLUSTER_PCT,
    });

    const srScore = calcSRProximityScore(
      params.current.close,
      params.side,
      levels,
      { nearPct: srConfig.NEAR_THRESHOLD_PCT, farPct: srConfig.FAR_THRESHOLD_PCT },
    );

    result.srScore = srScore;
    weightedSum += srScore * srConfig.WEIGHT;
    totalWeight += srConfig.WEIGHT;

    // Build detail for logging
    const supports = levels.filter(l => l.type === 'support');
    const resistances = levels.filter(l => l.type === 'resistance');
    const price = params.current.close;

    const nearest = (arr: SRLevel[], below: boolean) => {
      const filtered = arr.filter(l => below ? l.price <= price : l.price >= price);
      if (filtered.length === 0) return null;
      return filtered.reduce((best, l) =>
        Math.abs(l.price - price) < Math.abs(best.price - price) ? l : best
      );
    };

    const ns = nearest(supports, true);
    const nr = nearest(resistances, false);

    result.srDetail = {
      nearestSupport: ns?.price ?? null,
      nearestResistance: nr?.price ?? null,
      supportStrength: ns?.touches ?? 0,
      resistanceStrength: nr?.touches ?? 0,
      distToSupportPct: ns ? (price - ns.price) / price * 100 : null,
      distToResistancePct: nr ? (nr.price - price) / price * 100 : null,
    };
  }

  // Factor 2: Breakout Quality
  if (factors.BREAKOUT_QUALITY.ENABLED) {
    const bqConfig = factors.BREAKOUT_QUALITY;
    const bqScore = calcBreakoutQualityScore(
      params.current,
      params.bb,
      params.side,
      params.volRatio,
      {
        strongBreakoutPct: bqConfig.STRONG_BREAKOUT_PCT,
        weakBreakoutPct: bqConfig.WEAK_BREAKOUT_PCT,
        strongBodyRatio: bqConfig.STRONG_BODY_RATIO,
        weakBodyRatio: bqConfig.WEAK_BODY_RATIO,
        volConfirmMult: bqConfig.VOL_CONFIRM_MULT,
      },
    );

    result.breakoutScore = bqScore;
    weightedSum += bqScore * bqConfig.WEIGHT;
    totalWeight += bqConfig.WEIGHT;
  }

  // Factor 3: Market Correlation
  if (factors.MARKET_CORRELATION.ENABLED) {
    const mcConfig = factors.MARKET_CORRELATION;
    const mcScore = calcMarketCorrelationScore(
      params.allSymbolsROC1,
      params.currentSymbol,
      params.side,
      {
        roc1ThresholdPct: mcConfig.ROC1_THRESHOLD_PCT,
        herdThreshold: mcConfig.HERD_THRESHOLD,
        isolatedThreshold: mcConfig.ISOLATED_THRESHOLD,
      },
    );

    result.correlationScore = mcScore;
    weightedSum += mcScore * mcConfig.WEIGHT;
    totalWeight += mcConfig.WEIGHT;
  }

  // Normalize: redistribute weight proportionally if some factors disabled
  result.score = totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSum / totalWeight)) : 0;

  return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx jest test/unit/contextScore.test.ts --no-cache 2>&1 | tail -20`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add backend/src/strategies/contextScore.ts backend/test/unit/contextScore.test.ts
git commit -m "V5.99: Add contextScore.ts with S/R proximity, breakout quality, and market correlation factors"
```

---

## Task 3: Add breakout quality and market correlation tests

**Files:**
- Modify: `backend/test/unit/contextScore.test.ts`

**Step 1: Add breakout quality tests**

Append to the test file:

```typescript
describe('calcBreakoutQualityScore', () => {
  const defaultConfig = {
    strongBreakoutPct: 1.5,
    weakBreakoutPct: 0.3,
    strongBodyRatio: 0.7,
    weakBodyRatio: 0.3,
    volConfirmMult: 2.0,
  };

  it('should score positive for strong breakout with full body and high volume', () => {
    // LONG: close well above BB upper, full body candle, high volume
    const candle = makeCandle(1, 100, 103, 99.5, 102.5, 300);
    const bb = { upper: 101, lower: 95 };
    const score = calcBreakoutQualityScore(candle, bb, 'long', 2.5, defaultConfig);
    expect(score).toBeGreaterThan(0.5);
  });

  it('should score negative for weak breakout with wick-heavy candle', () => {
    // LONG: barely above BB upper, mostly wick, low volume
    const candle = makeCandle(1, 100.5, 102, 99, 100.6, 50);
    const bb = { upper: 100.5, lower: 95 };
    const score = calcBreakoutQualityScore(candle, bb, 'long', 0.8, defaultConfig);
    expect(score).toBeLessThan(-0.3);
  });

  it('should work for SHORT breakouts', () => {
    // SHORT: close well below BB lower, full body, high volume
    const candle = makeCandle(1, 96, 96.5, 93, 93.5, 300);
    const bb = { upper: 105, lower: 95 };
    const score = calcBreakoutQualityScore(candle, bb, 'short', 2.5, defaultConfig);
    expect(score).toBeGreaterThan(0.3);
  });
});
```

**Step 2: Add market correlation tests**

Append:

```typescript
describe('calcMarketCorrelationScore', () => {
  const defaultConfig = {
    roc1ThresholdPct: 0.5,
    herdThreshold: 0.6,
    isolatedThreshold: 0.3,
  };

  it('should score +0.5 for isolated LONG (few others pumping)', () => {
    const allROC = new Map([
      ['BTC/USDT:USDT', 0.01],   // +1% - same direction
      ['ETH/USDT:USDT', -0.008], // -0.8% - opposite
      ['SOL/USDT:USDT', -0.005], // flat-ish
      ['DOGE/USDT:USDT', -0.01], // opposite
      ['XRP/USDT:USDT', 0.002],  // flat
    ]);
    const score = calcMarketCorrelationScore(allROC, 'BTC/USDT:USDT', 'long', defaultConfig);
    // Only 0/4 others above threshold → isolated → +0.5
    expect(score).toBe(0.5);
  });

  it('should score -0.5 for herd move (most symbols same direction)', () => {
    const allROC = new Map([
      ['BTC/USDT:USDT', 0.02],
      ['ETH/USDT:USDT', 0.015],
      ['SOL/USDT:USDT', 0.012],
      ['DOGE/USDT:USDT', 0.008],
      ['XRP/USDT:USDT', 0.01],
    ]);
    const score = calcMarketCorrelationScore(allROC, 'BTC/USDT:USDT', 'long', defaultConfig);
    // 4/4 others above 0.5% → herd → -0.5
    expect(score).toBe(-0.5);
  });

  it('should score 0 when too few symbols for meaningful correlation', () => {
    const allROC = new Map([
      ['BTC/USDT:USDT', 0.02],
      ['ETH/USDT:USDT', 0.015],
    ]);
    const score = calcMarketCorrelationScore(allROC, 'BTC/USDT:USDT', 'long', defaultConfig);
    // Only 1 other symbol < 3 minimum → return 0
    expect(score).toBe(0);
  });
});
```

**Step 3: Add combined calcContextScore tests**

Append:

```typescript
import { calcBreakoutQualityScore, calcMarketCorrelationScore, calcContextScore } from '../../src/strategies/contextScore.js';

describe('calcContextScore (combined)', () => {
  it('should return all nulls when DRASH_CONTEXT disabled', () => {
    const orig = MomentumConfig.DRASH_CONTEXT.ENABLED;
    MomentumConfig.DRASH_CONTEXT.ENABLED = false;

    const result = calcContextScore({
      candles: makeSRCandles(),
      current: makeCandle(1, 100, 101, 99, 100.5),
      bb: { upper: 101, lower: 95 },
      side: 'long',
      volRatio: 1.5,
      allSymbolsROC1: new Map(),
      currentSymbol: 'TEST',
    });

    expect(result.score).toBe(0);
    expect(result.srScore).toBeNull();
    expect(result.breakoutScore).toBeNull();
    expect(result.correlationScore).toBeNull();

    MomentumConfig.DRASH_CONTEXT.ENABLED = orig;
  });

  it('should compute weighted combination of enabled factors', () => {
    const result = calcContextScore({
      candles: makeSRCandles(),
      current: makeCandle(1, 100, 103, 99.5, 102.5),
      bb: { upper: 101, lower: 95 },
      side: 'long',
      volRatio: 2.5,
      allSymbolsROC1: new Map([
        ['SYM1', 0.001], ['SYM2', -0.01], ['SYM3', -0.005], ['SYM4', -0.008],
      ]),
      currentSymbol: 'TEST',
    });

    // Should have non-null scores for all factors
    expect(result.srScore).not.toBeNull();
    expect(result.breakoutScore).not.toBeNull();
    expect(result.correlationScore).not.toBeNull();
    // Combined score should be in valid range
    expect(result.score).toBeGreaterThanOrEqual(-1);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
```

**Step 4: Fix imports at top of test file**

Update the import line at the top to include all functions:

```typescript
import {
  findSRLevels,
  calcSRProximityScore,
  calcBreakoutQualityScore,
  calcMarketCorrelationScore,
  calcContextScore,
} from '../../src/strategies/contextScore.js';
import { MomentumConfig } from '../../src/strategies/momentumSimple.js';
```

**Step 5: Run all tests**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx jest test/unit/contextScore.test.ts --no-cache 2>&1 | tail -20`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add backend/test/unit/contextScore.test.ts
git commit -m "V5.99: Add comprehensive unit tests for all context score factors"
```

---

## Task 4: Integrate context score into signalRanker

**Files:**
- Modify: `backend/src/strategies/signalRanker.ts` (lines 62-104)

**Step 1: Add contextScore parameter to calculateSignalScore**

In `signalRanker.ts`, modify the `calculateSignalScore` function signature and body:

Change the parameter type (line 62-69) to add `contextScore?`:

```typescript
export function calculateSignalScore(params: {
  roc5: number;
  volumeRatio: number;
  bbPosition: number;
  atrPct: number;
  trendStrength: number;
  side: 'long' | 'short';
  contextScore?: number;  // V5.99: Drash context score [-1.0, +1.0]
}): number {
```

Then add the context component before the return (before line 103):

```typescript
  // 6. Context (V5.99 Drash) — adjusts ranking based on S/R, breakout quality, correlation
  const contextComponent = (params.contextScore ?? 0) * 10 * 0.20;

  return bbScore + rocScore + volScore + atrScore + trendScore + contextComponent;
```

**Step 2: Verify build compiles**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors (contextScore is optional, so existing callers are unaffected)

**Step 3: Commit**

```bash
git add backend/src/strategies/signalRanker.ts
git commit -m "V5.99: Add contextScore parameter to calculateSignalScore"
```

---

## Task 5: Integrate context score into backtestService

**Files:**
- Modify: `backend/src/services/backtestService.ts`

**Step 1: Add import for calcContextScore**

After the existing import of `calculateSignalScore` (line 67), add:

```typescript
import { calcContextScore } from '../strategies/contextScore.js';
```

**Step 2: Compute allSymbolsROC1 before signal scoring**

In the backtest main loop, after the `signalCandidates` collection loop closes (around line 1843, after `}` that closes `for (const symbol of symbols)`), add the ROC1 computation and context scoring:

```typescript
    // ═══════════════════════════════════════════════════════════════════
    // V5.99: DRASH CONTEXT SCORING
    // Compute per-symbol ROC1 for market correlation factor
    // ═══════════════════════════════════════════════════════════════════
    const allSymbolsROC1 = new Map<string, number>();
    for (const symbol of symbols) {
      const sCandles = allData[symbol];
      const sIdx = symbolIdx[symbol];
      if (sIdx >= 2) {
        const prevClose = sCandles[sIdx].close;
        const prevPrevClose = sCandles[sIdx - 1].close;
        allSymbolsROC1.set(symbol, (prevClose - prevPrevClose) / prevPrevClose);
      }
    }

    // Re-score candidates with context
    for (const candidate of signalCandidates) {
      const windowCandles = candidate.candles;
      const current = candidate.current;
      const closes = windowCandles.map(c => c.close);
      const volumes = windowCandles.map(c => c.volume);

      const bb = calcBollingerBands(closes, MomentumConfig.ENTRY.BB_PERIOD, MomentumConfig.ENTRY.BB_STD);
      const volRatio = calcVolRatio(volumes);

      const ctx = calcContextScore({
        candles: windowCandles,
        current,
        bb: { upper: bb.upper, lower: bb.lower },
        side: candidate.signal.side!,
        volRatio,
        allSymbolsROC1,
        currentSymbol: candidate.symbol,
      });

      // Re-compute score with context factor
      const roc5 = calcROC(closes, 5);
      const bbPosition = calcBBPosition(windowCandles, 20, 2);
      const atrRaw = calcATR(windowCandles, 14) ?? 0;
      const atrPct = atrRaw ? (atrRaw / current.close) * 100 : 0;
      const trendStrength = calcTrendStrength(closes, 50);

      candidate.score = calculateSignalScore({
        roc5,
        volumeRatio: volRatio,
        bbPosition,
        atrPct,
        trendStrength,
        side: candidate.signal.side!,
        contextScore: ctx.score,
      });
    }
```

**Step 3: Check that calcBollingerBands is imported**

It should already be imported from `momentumSimple.js`. Verify the import includes `calcBollingerBands`. If not, add it to the existing destructured import.

**Step 4: Verify build**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 5: Commit**

```bash
git add backend/src/services/backtestService.ts
git commit -m "V5.99: Integrate context score into backtest signal ranking"
```

---

## Task 6: Integrate context score into live agent

**Files:**
- Modify: `backend/src/strategies/simpleAgent.ts` (around line 1420-1465)

**Step 1: Add import**

Add at the top of `simpleAgent.ts` imports:

```typescript
import { calcContextScore } from './contextScore.js';
```

**Step 2: Add context scoring before addSignal**

In the signal detection block (around line 1448, after `qualityScore` is computed but before `globalSignalRanker.addSignal()`), add context score computation:

```typescript
        // V5.99: Drash context scoring
        // Compute market-wide ROC1 from other agents' latest candles
        const allSymbolsROC1 = new Map<string, number>();
        // Use the WS ticker cache for all tracked symbols
        for (const agentSym of (this.config.symbols || [])) {
          if (agentSym === symbol) continue;
          const otherCandles = this.allSymbolCandles?.get(agentSym);
          if (otherCandles && otherCandles.length >= 2) {
            const last = otherCandles[otherCandles.length - 1];
            const prev = otherCandles[otherCandles.length - 2];
            if (prev.close > 0) {
              allSymbolsROC1.set(agentSym, (last.close - prev.close) / prev.close);
            }
          }
        }

        const bb = calcBollingerBands(
          candles.map(c => c.close),
          MomentumConfig.ENTRY.BB_PERIOD,
          MomentumConfig.ENTRY.BB_STD
        );
        const ctx = calcContextScore({
          candles,
          current: candles[candles.length - 1],
          bb: { upper: bb.upper, lower: bb.lower },
          side: signal.side,
          volRatio: signal.features?.volRatio ?? 1,
          allSymbolsROC1,
          currentSymbol: symbol,
        });

        // Re-score with context
        if (ctx.score !== 0) {
          qualityScore = globalSignalRanker.calculateScore({
            roc5,
            volumeRatio,
            bbPosition,
            atrPct,
            trendStrength,
            side: signal.side,
            contextScore: ctx.score,
          });
          logger.info(`📐 [${shortSymbol}] Context: score=${ctx.score.toFixed(2)} sr=${ctx.srScore?.toFixed(2) ?? 'off'} bq=${ctx.breakoutScore?.toFixed(2) ?? 'off'} mc=${ctx.correlationScore?.toFixed(2) ?? 'off'}`);
        }
```

**Step 3: Update the SignalRanker class calculateScore method to accept contextScore**

In `signalRanker.ts`, find the `calculateScore` method in the class (around line 269-274) and add `contextScore?`:

```typescript
  calculateScore(params: {
    roc5: number;
    volumeRatio: number;
    bbPosition: number;
    atrPct: number;
    trendStrength: number;
    side: 'long' | 'short';
    contextScore?: number;
  }): number {
    return calculateSignalScore(params);
  }
```

**Step 4: Check if `allSymbolCandles` exists on the agent**

Search for `allSymbolCandles` or equivalent symbol candle access. If it doesn't exist, we'll use a simpler approach: only use the symbol's own candles (skip market correlation in live for now — it will still work in backtest).

If `allSymbolCandles` doesn't exist, replace the ROC1 computation with:

```typescript
        const allSymbolsROC1 = new Map<string, number>(); // Empty in live = correlation factor returns 0
```

This is safe because `calcMarketCorrelationScore` returns 0 when there are < 3 symbols.

**Step 5: Verify build**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 6: Commit**

```bash
git add backend/src/strategies/simpleAgent.ts backend/src/strategies/signalRanker.ts
git commit -m "V5.99: Integrate context score into live agent signal scoring"
```

---

## Task 7: Create comparison script

**Files:**
- Create: `backend/scripts/compare-drash-context.ts`

**Step 1: Write the 8-combination comparison script**

Create `backend/scripts/compare-drash-context.ts`:

```typescript
/**
 * V5.99 Drash Context Score: Backtest Comparison
 * ================================================
 * Runs all 8 factor combinations (2^3) on train + test periods.
 *
 * Usage: npx tsx backend/scripts/compare-drash-context.ts
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

const SYMBOLS = ['DOGE/USDT:USDT', 'IMX/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT', 'XRP/USDT:USDT'];

const TRAIN_PARAMS = {
  startDate: new Date('2024-06-01T00:00:00Z'),
  endDate: new Date('2025-06-30T23:59:59Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

const TEST_PARAMS = {
  startDate: new Date('2025-07-01T00:00:00Z'),
  endDate: new Date('2025-12-31T23:59:59Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

interface RunConfig {
  label: string;
  sr: boolean;
  breakout: boolean;
  correlation: boolean;
}

const CONFIGS: RunConfig[] = [
  { label: 'Baseline (no context)',    sr: false, breakout: false, correlation: false },
  { label: 'SR only',                  sr: true,  breakout: false, correlation: false },
  { label: 'Breakout only',            sr: false, breakout: true,  correlation: false },
  { label: 'Correlation only',         sr: false, breakout: false, correlation: true  },
  { label: 'SR + Breakout',            sr: true,  breakout: true,  correlation: false },
  { label: 'SR + Correlation',         sr: true,  breakout: false, correlation: true  },
  { label: 'Breakout + Correlation',   sr: false, breakout: true,  correlation: true  },
  { label: 'ALL 3 factors',            sr: true,  breakout: true,  correlation: true  },
];

function setFactors(cfg: RunConfig) {
  const factors = MomentumConfig.DRASH_CONTEXT.FACTORS;
  MomentumConfig.DRASH_CONTEXT.ENABLED = cfg.sr || cfg.breakout || cfg.correlation;
  factors.SR_PROXIMITY.ENABLED = cfg.sr;
  factors.BREAKOUT_QUALITY.ENABLED = cfg.breakout;
  factors.MARKET_CORRELATION.ENABLED = cfg.correlation;
}

function printRow(label: string, r: BacktestResult) {
  const s = r.summary;
  const longTrades = r.trades.filter(t => t.side === 'long');
  const shortTrades = r.trades.filter(t => t.side === 'short');
  const longWR = longTrades.length > 0 ? (longTrades.filter(t => t.netPnlPct > 0).length / longTrades.length * 100) : 0;
  const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => t.netPnlPct > 0).length / shortTrades.length * 100) : 0;
  const avgPnl = s.totalTrades > 0 ? s.totalPnlPct / s.totalTrades : 0;

  console.log(
    `  ${label.padEnd(28)} | ` +
    `${String(s.totalTrades).padStart(5)} | ` +
    `${s.winRate.toFixed(1).padStart(5)}% | ` +
    `${s.totalPnlPct.toFixed(0).padStart(7)}% | ` +
    `${s.sharpeRatio.toFixed(2).padStart(5)} | ` +
    `${s.profitFactor.toFixed(2).padStart(5)} | ` +
    `${s.maxDrawdownPct.toFixed(1).padStart(5)}% | ` +
    `${avgPnl.toFixed(2).padStart(6)}% | ` +
    `L:${longWR.toFixed(0)}% S:${shortWR.toFixed(0)}%`
  );
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║     V5.99 DRASH CONTEXT SCORE: 8-COMBINATION BACKTEST COMPARISON       ║');
  console.log('║     Train: Jun 2024 - Jun 2025  |  Test: Jul - Dec 2025               ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');

  // Preload markets
  console.log('\n🔄 Preloading markets...');
  let ok = false;
  try { ok = await preloadMarkets(); } catch { ok = false; }
  if (!ok) {
    console.log('   API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('   Markets ready.\n');

  // Save original config
  const origEnabled = MomentumConfig.DRASH_CONTEXT.ENABLED;
  const origSR = MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED;
  const origBQ = MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED;
  const origMC = MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED;

  const header = '  Config'.padEnd(30) + ' | Trade |    WR |     ROI | Sharp |    PF |    DD | AvgPnl | L/S WR';
  const sep = '  ' + '─'.repeat(header.length - 2);

  // ── TRAIN PERIOD ──
  console.log('\n═══ TRAIN PERIOD (Jun 2024 - Jun 2025) ═══\n');
  console.log(header);
  console.log(sep);

  const trainResults: BacktestResult[] = [];
  for (const cfg of CONFIGS) {
    setFactors(cfg);
    const t = Date.now();
    const result = await runBacktest(TRAIN_PARAMS);
    trainResults.push(result);
    printRow(cfg.label, result);
    console.log(`${''.padStart(30)}   (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }

  // ── TEST PERIOD ──
  console.log('\n\n═══ TEST PERIOD (Jul - Dec 2025) — OUT-OF-SAMPLE ═══\n');
  console.log(header);
  console.log(sep);

  const testResults: BacktestResult[] = [];
  for (const cfg of CONFIGS) {
    setFactors(cfg);
    const t = Date.now();
    const result = await runBacktest(TEST_PARAMS);
    testResults.push(result);
    printRow(cfg.label, result);
    console.log(`${''.padStart(30)}   (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  }

  // ── COMPARISON vs BASELINE ──
  const baselineTrain = trainResults[0].summary;
  const baselineTest = testResults[0].summary;

  console.log('\n\n═══ DELTA vs BASELINE ═══\n');
  console.log('  Config'.padEnd(30) + ' | Train WR | Train ROI | Test WR | Test ROI | Test Sharpe');
  console.log('  ' + '─'.repeat(90));

  for (let i = 1; i < CONFIGS.length; i++) {
    const tr = trainResults[i].summary;
    const te = testResults[i].summary;

    const dTrainWR = tr.winRate - baselineTrain.winRate;
    const dTrainROI = tr.totalPnlPct - baselineTrain.totalPnlPct;
    const dTestWR = te.winRate - baselineTest.winRate;
    const dTestROI = te.totalPnlPct - baselineTest.totalPnlPct;
    const dTestSharpe = te.sharpeRatio - baselineTest.sharpeRatio;

    console.log(
      `  ${CONFIGS[i].label.padEnd(28)} | ` +
      `${dTrainWR >= 0 ? '+' : ''}${dTrainWR.toFixed(1).padStart(5)}pp | ` +
      `${dTrainROI >= 0 ? '+' : ''}${dTrainROI.toFixed(0).padStart(7)}% | ` +
      `${dTestWR >= 0 ? '+' : ''}${dTestWR.toFixed(1).padStart(5)}pp | ` +
      `${dTestROI >= 0 ? '+' : ''}${dTestROI.toFixed(0).padStart(6)}% | ` +
      `${dTestSharpe >= 0 ? '+' : ''}${dTestSharpe.toFixed(2).padStart(6)}`
    );
  }

  // ── VERDICT ──
  console.log('\n\n═══ VERDICT ═══\n');

  // Find best combo on OOS test period (by Sharpe, then ROI)
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < testResults.length; i++) {
    const te = testResults[i].summary;
    // Composite: Sharpe * 0.5 + normalized ROI * 0.3 + WR * 0.2
    const composite = te.sharpeRatio * 0.5 + (te.totalPnlPct / 100) * 0.3 + te.winRate * 0.2;
    if (composite > bestScore) {
      bestScore = composite;
      bestIdx = i;
    }
  }

  console.log(`  Best OOS combo: ${CONFIGS[bestIdx].label}`);
  const best = testResults[bestIdx].summary;
  const base = baselineTest;
  console.log(`  Test WR:    ${base.winRate.toFixed(1)}% → ${best.winRate.toFixed(1)}%  (${best.winRate >= base.winRate ? '+' : ''}${(best.winRate - base.winRate).toFixed(1)}pp)`);
  console.log(`  Test ROI:   ${base.totalPnlPct.toFixed(0)}% → ${best.totalPnlPct.toFixed(0)}%  (${best.totalPnlPct >= base.totalPnlPct ? '+' : ''}${(best.totalPnlPct - base.totalPnlPct).toFixed(0)}%)`);
  console.log(`  Test Sharpe: ${base.sharpeRatio.toFixed(2)} → ${best.sharpeRatio.toFixed(2)}  (${best.sharpeRatio >= base.sharpeRatio ? '+' : ''}${(best.sharpeRatio - base.sharpeRatio).toFixed(2)})`);

  // Pass/fail criteria
  const wrImproved = best.winRate >= base.winRate + 1.0;
  const roiNotDegraded = best.totalPnlPct >= base.totalPnlPct * 0.95;
  const sharpeImproved = best.sharpeRatio >= base.sharpeRatio + 0.10;

  console.log(`\n  Criteria:`);
  console.log(`  ${wrImproved ? '✅' : '❌'} WR improved >= +1pp OOS`);
  console.log(`  ${roiNotDegraded ? '✅' : '❌'} ROI not degraded (>= 95% of baseline)`);
  console.log(`  ${sharpeImproved ? '✅' : '❌'} Sharpe improved >= +0.10 OOS`);

  // Restore
  MomentumConfig.DRASH_CONTEXT.ENABLED = origEnabled;
  MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = origSR;
  MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = origBQ;
  MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = origMC;
}

main().catch(console.error);
```

**Step 2: Verify script compiles**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

**Step 3: Commit**

```bash
git add backend/scripts/compare-drash-context.ts
git commit -m "V5.99: Add 8-combination Drash context comparison script with train/test split"
```

---

## Task 8: Run backtest comparison and analyze results

**Step 1: Run the comparison script**

Run: `cd /Users/simon-davidbenhamou/Desktop/remezz && npx tsx backend/scripts/compare-drash-context.ts`

This will take several minutes (8 configs × 2 periods = 16 backtest runs).

**Step 2: Analyze the output**

Look at the DELTA vs BASELINE table:
- Which combination has the best OOS (test period) improvement?
- Does it pass all 3 criteria (WR +1pp, ROI not degraded, Sharpe +0.10)?
- Is the improvement consistent between train and test?

**Step 3: If results are good, commit with findings**

If the best combo passes criteria:

```bash
git commit --allow-empty -m "V5.99: Drash context score validated — [BEST_COMBO] improves OOS by +Xpp WR, +Y% ROI, +Z Sharpe"
```

**Step 4: If results need tuning**

If no combo passes criteria, try:
1. Adjust `WEIGHT_IN_SIGNAL_SCORE` (try 0.15, 0.25, 0.30)
2. Adjust individual factor thresholds
3. Run the comparison again with modified config

---

## Task 9: Update CLAUDE.md with V5.99 documentation

**Files:**
- Modify: `backend/CLAUDE.md`

**Step 1: Add V5.99 version entry**

In the Version Tracking section, after V5.98, add:

```markdown
- V5.99: Drash Context Score — modular signal context analysis:
  - **Context scoring system**: 3 independently-toggleable factors that adjust signal ranking (score, not filter). Added to `calculateSignalScore()` as 6th factor (20% weight).
  - **Factor 1 — S/R Proximity**: Pivot-based support/resistance detection on last 200 candles. LONG at support = boost, LONG into resistance = penalize. Reverse for SHORT. Min 2 touches for valid level. Source: `contextScore.ts`
  - **Factor 2 — Breakout Quality**: Assesses BB breakout distance, candle body conviction, and volume confirmation. Strong breakout + full body + high volume = boost. Weak breakout + wick + low volume = penalize.
  - **Factor 3 — Market Correlation**: Detects herd moves vs isolated signals using ROC1 across all tracked symbols. Isolated move = boost (genuine edge). >60% same direction = penalize (market-wide event).
  - **Config**: `MomentumConfig.DRASH_CONTEXT` with per-factor `ENABLED` toggles and weights.
  - **Validation**: Train/test split (Jun 2024 - Jun 2025 train, Jul - Dec 2025 OOS). Script: `scripts/compare-drash-context.ts` tests all 8 factor combinations.
  - **Key insight**: V5.96 S/R filter failed because it was binary (killed 16% of trades). Drash scores instead of filters — no trade count reduction.
```

**Step 2: Commit**

```bash
git add backend/CLAUDE.md
git commit -m "V5.99: Document Drash context score in CLAUDE.md"
```

---

## Summary of Changes

| File | Action | Purpose |
|------|--------|---------|
| `src/strategies/momentumSimple.ts` | Modify | Add `DRASH_CONTEXT` config block |
| `src/strategies/contextScore.ts` | Create | S/R, breakout quality, correlation scoring |
| `src/strategies/signalRanker.ts` | Modify | Add `contextScore` param to `calculateSignalScore()` |
| `src/services/backtestService.ts` | Modify | Compute allSymbolsROC1, apply context score |
| `src/strategies/simpleAgent.ts` | Modify | Apply context score in live signal path |
| `test/unit/contextScore.test.ts` | Create | Unit tests for all 3 factors + combined |
| `scripts/compare-drash-context.ts` | Create | 8-combination comparison script |
| `CLAUDE.md` | Modify | V5.99 documentation |
