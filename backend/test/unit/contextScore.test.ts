import {
  findSRLevels,
  calcSRProximityScore,
  type SRLevel,
} from '../../src/strategies/momentumSimple.js';
import { type Candle } from '../../src/strategies/momentumSimple.js';

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
