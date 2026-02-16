import {
  findSRLevels,
  calcSRProximityScore,
  calcBreakoutQualityScore,
  calcMarketCorrelationScore,
  calcContextScore,
  type SRLevel,
} from '../../src/strategies/contextScore.js';
import { MomentumConfig, type Candle } from '../../src/strategies/momentumSimple.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCandle(ts: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { timestamp: ts, open, high, low, close, volume };
}

/**
 * Build candles that bounce between `support` and `resistance` to create
 * clear S/R levels with multiple touches.
 *
 * Pattern: oscillates up/down `cycles` times over `stepsPerHalf` candles per
 * half-cycle, producing pivot highs at `resistance` and pivot lows at `support`.
 */
function makeBounceCandles(
  support: number,
  resistance: number,
  cycles: number,
  stepsPerHalf = 10,
): Candle[] {
  const candles: Candle[] = [];
  let ts = 1_000_000;
  const range = resistance - support;

  for (let c = 0; c < cycles; c++) {
    // Up leg: support → resistance
    for (let i = 0; i < stepsPerHalf; i++) {
      const t = i / (stepsPerHalf - 1);
      const mid = support + range * t;
      const spread = range * 0.02;
      candles.push(makeCandle(ts++, mid - spread, mid + spread, mid - spread, mid));
    }
    // Down leg: resistance → support
    for (let i = 0; i < stepsPerHalf; i++) {
      const t = i / (stepsPerHalf - 1);
      const mid = resistance - range * t;
      const spread = range * 0.02;
      candles.push(makeCandle(ts++, mid + spread, mid + spread, mid - spread, mid));
    }
  }

  return candles;
}

// ── Save / restore config ──────────────────────────────────────────────────

const savedDrashContext = JSON.parse(JSON.stringify(MomentumConfig.DRASH_CONTEXT));

afterEach(() => {
  // Restore config after each test
  Object.assign(MomentumConfig.DRASH_CONTEXT, JSON.parse(JSON.stringify(savedDrashContext)));
});

// ============================================================================
// 1. findSRLevels
// ============================================================================

describe('findSRLevels', () => {
  const defaultOpts = {
    lookbackCandles: 200,
    pivotLookback: 5,
    minTouches: 2,
    clusterPct: 0.3,
  };

  test('detects support and resistance from bounce candles', () => {
    // 4 cycles between 100 and 110 → should produce clear S/R at ~100 and ~110
    const candles = makeBounceCandles(100, 110, 4, 12);
    const levels = findSRLevels(candles, defaultOpts);

    expect(levels.length).toBeGreaterThanOrEqual(1);

    // At least one support level near 100
    const supports = levels.filter(l => l.type === 'support');
    const resistances = levels.filter(l => l.type === 'resistance');

    // We expect some levels detected
    expect(supports.length + resistances.length).toBeGreaterThanOrEqual(1);

    // All levels have at least minTouches
    for (const level of levels) {
      expect(level.touches).toBeGreaterThanOrEqual(defaultOpts.minTouches);
    }
  });

  test('filters weak levels below minTouches', () => {
    // Use a high minTouches threshold
    const candles = makeBounceCandles(100, 110, 2, 12);
    const strictOpts = { ...defaultOpts, minTouches: 20 };
    const levels = findSRLevels(candles, strictOpts);

    // With only 2 cycles, shouldn't have 20 touches at any level
    expect(levels.length).toBe(0);
  });

  test('handles insufficient data gracefully', () => {
    // Only 5 candles, pivotLookback=5 needs 11 minimum
    const candles = Array.from({ length: 5 }, (_, i) =>
      makeCandle(i, 100, 101, 99, 100),
    );
    const levels = findSRLevels(candles, defaultOpts);
    expect(levels).toEqual([]);
  });

  test('handles empty array', () => {
    expect(findSRLevels([], defaultOpts)).toEqual([]);
  });
});

// ============================================================================
// 2. calcSRProximityScore
// ============================================================================

describe('calcSRProximityScore', () => {
  const defaultOpts = { nearThresholdPct: 1.5, farThresholdPct: 5.0 };

  const supportAt100: SRLevel = { price: 100, type: 'support', touches: 3 };
  const resistanceAt110: SRLevel = { price: 110, type: 'resistance', touches: 3 };
  const strongResistance: SRLevel = { price: 110, type: 'resistance', touches: 5 };

  test('LONG near support returns positive score', () => {
    // Price at 100.5, support at 100 → very close
    const score = calcSRProximityScore(100.5, 'long', [supportAt100], defaultOpts);
    expect(score).toBeGreaterThan(0);
  });

  test('LONG near resistance returns negative score', () => {
    // Price at 109.5, resistance at 110 → very close
    const score = calcSRProximityScore(109.5, 'long', [resistanceAt110], defaultOpts);
    expect(score).toBeLessThan(0);
  });

  test('SHORT near resistance returns positive score', () => {
    // Price at 109.5, resistance at 110 → very close
    const score = calcSRProximityScore(109.5, 'short', [resistanceAt110], defaultOpts);
    expect(score).toBeGreaterThan(0);
  });

  test('SHORT near support returns negative score', () => {
    // Price at 100.5, support at 100 → very close
    const score = calcSRProximityScore(100.5, 'short', [supportAt100], defaultOpts);
    expect(score).toBeLessThan(0);
  });

  test('returns 0 for no nearby S/R levels', () => {
    // Price at 105, levels at 100 and 110 — both far (5%) at the boundary
    // Use a very tight threshold to ensure they are "far"
    const tightOpts = { nearThresholdPct: 0.5, farThresholdPct: 1.0 };
    const score = calcSRProximityScore(105, 'long', [supportAt100, resistanceAt110], tightOpts);
    expect(score).toBe(0);
  });

  test('returns 0 for empty levels', () => {
    const score = calcSRProximityScore(100, 'long', [], defaultOpts);
    expect(score).toBe(0);
  });

  test('strength bonus for 4+ touches capped at 1.0', () => {
    // Close to resistance with 5 touches → 1.2x multiplier but capped at 1.0
    const score = calcSRProximityScore(109.9, 'short', [strongResistance], defaultOpts);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1.0);
  });
});

// ============================================================================
// 3. calcBreakoutQualityScore
// ============================================================================

describe('calcBreakoutQualityScore', () => {
  const config = MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY;
  const bb = { upper: 100, lower: 90 };

  test('strong breakout with full body and high volume returns positive', () => {
    // Price closes 2% above upper BB, body ratio > 0.7, volRatio = 3x
    const candle = makeCandle(1, 101, 102.5, 100.5, 102, 300);
    const score = calcBreakoutQualityScore(candle, bb, 'long', 3.0, config);
    expect(score).toBeGreaterThan(0);
  });

  test('weak breakout with wicky candle returns negative', () => {
    // Price barely above BB (0.1%), long wicks (body ratio < 0.3), low volume
    const candle = makeCandle(1, 100.05, 101.5, 99.5, 100.1, 50);
    const score = calcBreakoutQualityScore(candle, bb, 'long', 0.5, config);
    expect(score).toBeLessThan(0);
  });

  test('SHORT strong breakout below lower BB returns positive', () => {
    // Price closes 2% below lower BB, full body
    const candle = makeCandle(1, 89, 89.5, 88, 88.2, 300);
    const score = calcBreakoutQualityScore(candle, bb, 'short', 3.0, config);
    expect(score).toBeGreaterThan(0);
  });

  test('result is clamped to [-1, +1]', () => {
    // Extreme values
    const candle = makeCandle(1, 110, 115, 109.5, 115, 1000);
    const score = calcBreakoutQualityScore(candle, bb, 'long', 10.0, config);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(-1.0);
  });
});

// ============================================================================
// 4. calcMarketCorrelationScore
// ============================================================================

describe('calcMarketCorrelationScore', () => {
  const config = MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION;

  test('isolated move returns +0.5', () => {
    // Current symbol going up, most others flat or down
    const roc1Map = new Map<string, number>([
      ['BTC', -0.2],
      ['ETH', -0.1],
      ['SOL', 0.0],
      ['XRP', -0.3],
      ['DOGE', 0.1],
    ]);
    const score = calcMarketCorrelationScore(roc1Map, 'SUI', 'long', config);
    // SUI not in map, 5 others. Only DOGE has roc1 < 0.5% threshold → 0/5 = 0% herd
    expect(score).toBe(0.5);
  });

  test('herd move returns -0.5', () => {
    // Everyone going up strongly
    const roc1Map = new Map<string, number>([
      ['BTC', 1.5],
      ['ETH', 2.0],
      ['SOL', 1.8],
      ['XRP', 1.2],
      ['DOGE', 0.9],
      ['SUI', 1.0],
    ]);
    const score = calcMarketCorrelationScore(roc1Map, 'SUI', 'long', config);
    // 5 others, all > 0.5% → herdRatio = 5/5 = 1.0 > 0.6
    expect(score).toBe(-0.5);
  });

  test('returns 0 for too few other symbols', () => {
    const roc1Map = new Map<string, number>([
      ['BTC', 1.5],
      ['ETH', 2.0],
      ['SUI', 1.0],
    ]);
    // Only 2 others (BTC, ETH) → < 3
    const score = calcMarketCorrelationScore(roc1Map, 'SUI', 'long', config);
    expect(score).toBe(0);
  });

  test('normal correlation returns 0', () => {
    // Mixed — some going same direction, some not
    const roc1Map = new Map<string, number>([
      ['BTC', 1.0],
      ['ETH', -0.2],
      ['SOL', 0.8],
      ['XRP', -0.5],
      ['DOGE', 0.3],
    ]);
    // LONG for SUI. Others: BTC>0.5(yes), ETH(no), SOL>0.5(yes), XRP(no), DOGE(no) → 2/5=0.4
    const score = calcMarketCorrelationScore(roc1Map, 'SUI', 'long', config);
    expect(score).toBe(0); // 0.4 is between 0.3 and 0.6
  });
});

// ============================================================================
// 5. calcContextScore (combined)
// ============================================================================

describe('calcContextScore', () => {
  const defaultParams = {
    candles: makeBounceCandles(95, 105, 4, 12),
    currentPrice: 100,
    side: 'long' as const,
    currentCandle: makeCandle(999, 99, 101, 98.5, 100.5),
    bb: { upper: 99, lower: 91 },
    volRatio: 1.5,
    allSymbolsROC1: new Map<string, number>([
      ['BTC', 0.3],
      ['ETH', -0.1],
      ['SOL', 0.2],
      ['XRP', -0.4],
      ['DOGE', 0.1],
    ]),
    currentSymbol: 'SUI',
  };

  test('returns all nulls and combined=0 when disabled', () => {
    MomentumConfig.DRASH_CONTEXT.ENABLED = false;
    const result = calcContextScore(defaultParams);
    expect(result.srProximity).toBeNull();
    expect(result.breakoutQuality).toBeNull();
    expect(result.marketCorrelation).toBeNull();
    expect(result.combined).toBe(0);
  });

  test('computes weighted combination when enabled', () => {
    MomentumConfig.DRASH_CONTEXT.ENABLED = true;
    const result = calcContextScore(defaultParams);

    // All factors should be non-null
    expect(result.srProximity).not.toBeNull();
    expect(result.breakoutQuality).not.toBeNull();
    expect(result.marketCorrelation).not.toBeNull();

    // Combined should be a finite number in [-1, +1]
    expect(typeof result.combined).toBe('number');
    expect(Number.isFinite(result.combined)).toBe(true);
    expect(result.combined).toBeGreaterThanOrEqual(-1);
    expect(result.combined).toBeLessThanOrEqual(1);
  });

  test('disabling individual factors returns null for that factor', () => {
    MomentumConfig.DRASH_CONTEXT.ENABLED = true;
    MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = false;

    const result = calcContextScore(defaultParams);

    expect(result.srProximity).toBeNull();
    expect(result.breakoutQuality).not.toBeNull();
    expect(result.marketCorrelation).not.toBeNull();
    // Combined still computed from remaining factors
    expect(typeof result.combined).toBe('number');
  });

  test('combined is weighted average of enabled factors', () => {
    MomentumConfig.DRASH_CONTEXT.ENABLED = true;
    // Disable all except market correlation for easy verification
    MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = false;
    MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = false;
    MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = true;

    const result = calcContextScore(defaultParams);

    // Only market correlation enabled → combined = marketCorrelation score
    expect(result.combined).toBe(result.marketCorrelation);
  });
});
