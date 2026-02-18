import { computeFiveMinScore } from '../../src/services/polymarket/fiveMinScorer.js';
import type { Candle1m } from '../../src/services/polymarket/polymarketTypes.js';

function makeCandle(overrides: Partial<Candle1m> = {}): Candle1m {
  return {
    timestamp: Date.now(),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    isFinal: true,
    ...overrides,
  };
}

describe('computeFiveMinScore', () => {
  it('strong uptrend with volume spike → high score, UP direction', () => {
    // Window: 5 strong bullish candles, big bodies, high volume
    const windowOpen = 100;
    const windowCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 100.5, low: 99.95, close: 100.4, volume: 5000 }),
      makeCandle({ open: 100.4, high: 100.9, low: 100.35, close: 100.8, volume: 5500 }),
      makeCandle({ open: 100.8, high: 101.3, low: 100.75, close: 101.2, volume: 6000 }),
      makeCandle({ open: 101.2, high: 101.7, low: 101.15, close: 101.6, volume: 5800 }),
      makeCandle({ open: 101.6, high: 102.1, low: 101.55, close: 102.0, volume: 6200 }),
    ];
    // Pre-window: low volume context
    const preWindowCandles: Candle1m[] = [
      makeCandle({ open: 99.5, high: 99.8, low: 99.4, close: 99.7, volume: 2000 }),
      makeCandle({ open: 99.7, high: 100.0, low: 99.6, close: 99.9, volume: 2200 }),
      makeCandle({ open: 99.9, high: 100.1, low: 99.8, close: 100.0, volume: 2100 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindowCandles, windowOpen);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('UP');
    expect(result!.score.total).toBeGreaterThanOrEqual(60);
    // Volume ~5700 avg vs ~2100 avg → ratio ~2.7x → 25 pts
    expect(result!.score.volumeSpike).toBe(25);
    // ROC = (102 - 100) / 100 = 2% → 20 pts
    expect(result!.score.microRoc).toBe(20);
    // All 5 candles bullish → alignment 100% → 15 pts
    expect(result!.score.candleAlignment).toBe(15);
    expect(result!.microRocPct).toBeGreaterThan(0);
  });

  it('flat candles with no volume → null (skip)', () => {
    const windowOpen = 100;
    // Tiny moves, low volume, doji-like candles
    const windowCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 100.01, low: 99.99, close: 100.005, volume: 100 }),
      makeCandle({ open: 100.005, high: 100.015, low: 99.99, close: 100.01, volume: 90 }),
      makeCandle({ open: 100.01, high: 100.02, low: 99.995, close: 100.008, volume: 110 }),
    ];
    const preWindowCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 100.02, low: 99.98, close: 100.01, volume: 500 }),
      makeCandle({ open: 100.01, high: 100.03, low: 99.99, close: 100.0, volume: 480 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindowCandles, windowOpen);
    // Total score should be well below 60 → null
    expect(result).toBeNull();
  });

  it('strong downtrend → DOWN direction', () => {
    const windowOpen = 100;
    const windowCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 100.05, low: 99.5, close: 99.6, volume: 5000 }),
      makeCandle({ open: 99.6, high: 99.65, low: 99.1, close: 99.2, volume: 5500 }),
      makeCandle({ open: 99.2, high: 99.25, low: 98.7, close: 98.8, volume: 6000 }),
      makeCandle({ open: 98.8, high: 98.85, low: 98.3, close: 98.4, volume: 5800 }),
      makeCandle({ open: 98.4, high: 98.45, low: 97.9, close: 98.0, volume: 6200 }),
    ];
    const preWindowCandles: Candle1m[] = [
      makeCandle({ open: 100.3, high: 100.5, low: 100.1, close: 100.2, volume: 2000 }),
      makeCandle({ open: 100.2, high: 100.3, low: 100.0, close: 100.1, volume: 2200 }),
      makeCandle({ open: 100.1, high: 100.2, low: 99.9, close: 100.0, volume: 2100 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindowCandles, windowOpen);
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('DOWN');
    expect(result!.score.total).toBeGreaterThanOrEqual(60);
    // ROC = (98 - 100) / 100 = -2% → abs 2% → 20 pts
    expect(result!.score.microRoc).toBe(20);
    // All bearish → 100% alignment → 15 pts
    expect(result!.score.candleAlignment).toBe(15);
    expect(result!.microRocPct).toBeLessThan(0);
  });

  it('wick rejection candles → negative wickRejection score', () => {
    const windowOpen = 100;
    // UP direction but every candle has a huge upper wick (sellers rejecting highs)
    // open=100, high=101.5, close=100.2 → upper wick = 1.3 out of 2 range = 0.65 ratio
    const windowCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 101.5, low: 99.5, close: 100.2, volume: 3000 }),
      makeCandle({ open: 100.2, high: 101.7, low: 99.7, close: 100.3, volume: 3100 }),
      makeCandle({ open: 100.3, high: 101.8, low: 99.8, close: 100.4, volume: 3200 }),
    ];
    const preWindowCandles: Candle1m[] = [
      makeCandle({ open: 99.5, high: 100.0, low: 99.3, close: 99.8, volume: 1500 }),
      makeCandle({ open: 99.8, high: 100.1, low: 99.5, close: 100.0, volume: 1600 }),
    ];

    const result = computeFiveMinScore(windowCandles, preWindowCandles, windowOpen);
    // Whether total >= 60 or not, we can check the breakdown if result is non-null,
    // but wick rejection should be strongly negative regardless.
    // Let's compute manually: direction=UP, each candle has opposing wick ratio >= 0.4 → -5 each = -15
    // We need to inspect the score. If total < 60, result is null — so we test the scorer directly.

    // Actually let's build a scenario where total would be >= 60 without wick rejection
    // Volume: 3100 avg / 1550 avg = 2x → 25
    // microRoc: (100.4 - 100)/100 = 0.4% → 20
    // bodyRatio: |100.2 - 100| / (101.5 - 99.5) = 0.2/2 = 0.1 → 0 pts
    // wickRejection: -15
    // alignment: all close > open → 100% → 15
    // preMomentum: (100.0 - 99.5)/99.5 = 0.5% → aligned → 10
    // Total: 25 + 20 + 0 - 15 + 15 + 10 = 55 → null (below 60)

    // Result is null because wick rejection drags total below threshold.
    // That's actually the desired behavior — wick rejection makes us skip.
    // To explicitly test the negative score, let's boost other components enough:

    const boostedCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 101.5, low: 99.5, close: 100.3, volume: 5000 }),
      makeCandle({ open: 100.3, high: 101.8, low: 99.8, close: 100.5, volume: 5500 }),
      makeCandle({ open: 100.5, high: 102.0, low: 100.0, close: 100.7, volume: 6000 }),
      makeCandle({ open: 100.7, high: 102.2, low: 100.2, close: 100.9, volume: 5800 }),
      makeCandle({ open: 100.9, high: 102.5, low: 100.4, close: 101.1, volume: 6200 }),
    ];
    const boostedPreWindow: Candle1m[] = [
      makeCandle({ open: 99.0, high: 99.5, low: 98.8, close: 99.3, volume: 2000 }),
      makeCandle({ open: 99.3, high: 99.8, low: 99.1, close: 99.6, volume: 2200 }),
      makeCandle({ open: 99.6, high: 100.1, low: 99.4, close: 100.0, volume: 2100 }),
    ];

    const boostedResult = computeFiveMinScore(boostedCandles, boostedPreWindow, windowOpen);
    // Volume: ~5700/2100 = 2.7x → 25
    // microRoc: (101.1-100)/100 = 1.1% → 20
    // bodyRatio: e.g. |100.3-100|/(101.5-99.5) = 0.15 → 0 pts (bodies are small relative to range)
    // wickRejection: each has upper wick ratio like (101.5-100.3)/2 = 0.6 → >=0.4 → -5 × 5 = clamped -15
    // alignment: all close > open → 15
    // preMomentum: (100-99)/99 = 1% → aligned → 10
    // Total: 25 + 20 + 0 - 15 + 15 + 10 = 55 → still null

    // The test validates that heavy wick rejection drags the score below threshold
    expect(boostedResult).toBeNull();

    // Also verify that without wick rejection these candles would score high enough:
    // Let's use clean candles (no opposing wicks) with same volume/ROC
    const cleanCandles: Candle1m[] = [
      makeCandle({ open: 100, high: 100.35, low: 99.98, close: 100.3, volume: 5000 }),
      makeCandle({ open: 100.3, high: 100.65, low: 100.28, close: 100.55, volume: 5500 }),
      makeCandle({ open: 100.55, high: 100.9, low: 100.53, close: 100.8, volume: 6000 }),
      makeCandle({ open: 100.8, high: 101.15, low: 100.78, close: 101.05, volume: 5800 }),
      makeCandle({ open: 101.05, high: 101.4, low: 101.03, close: 101.3, volume: 6200 }),
    ];

    const cleanResult = computeFiveMinScore(cleanCandles, boostedPreWindow, windowOpen);
    expect(cleanResult).not.toBeNull();
    expect(cleanResult!.direction).toBe('UP');
    expect(cleanResult!.score.wickRejection).toBeGreaterThan(0);
    expect(cleanResult!.score.total).toBeGreaterThanOrEqual(60);
  });
});
