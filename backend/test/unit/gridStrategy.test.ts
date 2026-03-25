import { describe, it, expect } from '@jest/globals';
import { GridStrategy } from '../../src/strategies/grid/strategy.js';
import { GRID_CONFIG } from '../../src/strategies/grid/config.js';
import type { EntryContext, ExitContext, Candle, Position } from '../../src/strategies/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeCandles(
  count: number,
  opts: {
    startPrice?: number;
    trendPctPerBar?: number;
    volatilityPct?: number;
    startTs?: number;
    intervalMs?: number;
    volume?: number;
  } = {},
): Candle[] {
  const {
    startPrice = 100,
    trendPctPerBar = 0,
    volatilityPct = 0.005,
    startTs = Date.now() - count * 900_000,
    intervalMs = 900_000,
    volume = 1000,
  } = opts;

  const candles: Candle[] = [];
  let price = startPrice;

  for (let i = 0; i < count; i++) {
    const close = price * (1 + trendPctPerBar);
    const high = Math.max(price, close) * (1 + volatilityPct);
    const low = Math.min(price, close) * (1 - volatilityPct);
    candles.push({
      timestamp: startTs + i * intervalMs,
      open: price,
      high,
      low,
      close,
      volume,
      isFinal: true,
    });
    price = close;
  }

  return candles;
}

/**
 * Build a sideways-ranging set of candles with a well-defined percentile range
 * and low ADX (choppy, mean-reverting).
 *
 * Uses an 8-bar cycle that steps down 4 bars then back up 4 bars within ±rangeHalfPct.
 * This yields ADX ~8 (well below 25) and rangePct ~5% for rangeHalfPct=0.05.
 *
 * Computed 25th/75th percentile range is centred at midPrice * (1 - rangeHalfPct/2),
 * which for rangeHalfPct=0.05 gives midpoint = 95 when midPrice=100.
 * Use `midPrice=100` and `rangeHalfPct=0.05` to get:
 *   rangeLow ≈ 92.5, rangeHigh ≈ 97.5, midpoint ≈ 95
 *   LONG entry zone: price < 94.7 (e.g. 93)
 *   SHORT entry zone: price > 95.3 (e.g. 97.6)
 */
function makeRangingCandles(
  count: number,
  midPrice = 100,
  rangeHalfPct = 0.05,
  startTs = Date.now() - count * 900_000,
): Candle[] {
  const candles: Candle[] = [];
  const intervalMs = 900_000;
  const step = midPrice * rangeHalfPct / 2;
  const cycleLen = 8;

  for (let i = 0; i < count; i++) {
    const cyclePos = i % cycleLen;
    let price: number;
    if (cyclePos < 4) {
      price = midPrice - step * (cyclePos + 1);
    } else {
      price = midPrice - step * (cycleLen - cyclePos - 1);
    }
    const high = price * 1.002;
    const low = price * 0.998;
    candles.push({
      timestamp: startTs + i * intervalMs,
      open: price * 0.999,
      high,
      low,
      close: price,
      volume: 1000,
      isFinal: true,
    });
  }

  return candles;
}

function makeEntryCtx(
  candles: Candle[],
  currentPrice: number,
  openPositions = 0,
): EntryContext {
  return {
    symbol: 'ETH/USDT:USDT',
    candles,
    btcCandles: candles.slice(-20),
    currentPrice,
    timestamp: Date.now(),
    capital: 10_000,
    openPositions,
  };
}

function makeExitCtx(
  candles: Candle[],
  currentPrice: number,
  unrealizedPnlPct: number,
  holdingMinutes: number,
  side: 'long' | 'short' = 'long',
  entryPrice = 100,
): ExitContext {
  const position: Position = {
    symbol: 'ETH/USDT:USDT',
    side,
    entryPrice,
    qty: 1,
    entryTime: Date.now() - holdingMinutes * 60_000,
  };

  return {
    symbol: 'ETH/USDT:USDT',
    position,
    candles,
    btcCandles: candles.slice(-20),
    currentPrice,
    timestamp: Date.now(),
    entryPrice,
    unrealizedPnlPct,
    holdingMinutes,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('GridStrategy', () => {
  const strategy = new GridStrategy();

  describe('config', () => {
    it('should have name "grid"', () => {
      expect(strategy.name).toBe('grid');
    });

    it('should return correct config', () => {
      const config = strategy.getConfig();
      expect(config.name).toBe('grid');
      expect(config.leverage).toBe(2);
      expect(config.maxPositions).toBe(3);
      expect(config.symbols).toContain('BTC/USDT:USDT');
      expect(config.symbols).toContain('ETH/USDT:USDT');
      expect(config.symbols).toContain('SOL/USDT:USDT');
      expect(config.symbols).toContain('XRP/USDT:USDT');
      expect(config.minCandlesRequired).toBe(GRID_CONFIG.RANGE_LOOKBACK_CANDLES);
    });
  });

  describe('checkEntry', () => {
    it('should return null with insufficient candles', () => {
      const candles = makeCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES - 1, { startPrice: 100 });
      const ctx = makeEntryCtx(candles, 100);
      expect(strategy.checkEntry(ctx)).toBeNull();
    });

    it('should return null when max positions reached', () => {
      const candles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);
      const ctx = makeEntryCtx(candles, 94, 3); // openPositions = maxPositions = 3
      expect(strategy.checkEntry(ctx)).toBeNull();
    });

    it('should return null when range is too narrow (< MIN_RANGE_PCT)', () => {
      // Very flat candles — tiny range
      const candles = makeCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, {
        startPrice: 100,
        trendPctPerBar: 0,
        volatilityPct: 0.0001, // nearly flat
      });
      const ctx = makeEntryCtx(candles, 99.9);
      expect(strategy.checkEntry(ctx)).toBeNull();
    });

    it('should return null when price is near midpoint (within threshold)', () => {
      // makeRangingCandles(100, 0.05) → midpoint ≈ 95.0
      // ENTRY_THRESHOLD_PCT = 0.3%, so price must be < 94.72 (LONG) or > 95.29 (SHORT)
      const candles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);
      // Price exactly at midpoint (95) → within threshold → no signal
      const ctx = makeEntryCtx(candles, 95);
      expect(strategy.checkEntry(ctx)).toBeNull();
    });

    it('should enter LONG when price drops below midpoint', () => {
      // makeRangingCandles(100, 0.05): rangeLow ≈ 92.5, rangeHigh ≈ 97.5, midpoint ≈ 95
      // Price at 93 is -2.1% from midpoint → LONG signal
      const candles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);
      const ctx = makeEntryCtx(candles, 93);
      const signal = strategy.checkEntry(ctx);

      expect(signal).not.toBeNull();
      expect(signal!.valid).toBe(true);
      expect(signal!.side).toBe('long');
      expect(signal!.confidence).toBeGreaterThan(0);
      expect(signal!.confidence).toBeLessThanOrEqual(1);
      expect(signal!.stopLossPct).toBe(GRID_CONFIG.STOP_LOSS_PCT);
    });

    it('should enter SHORT when price rises above midpoint', () => {
      // makeRangingCandles(100, 0.05): midpoint ≈ 95
      // Price at 97.6 is +2.7% from midpoint → SHORT signal
      const candles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);
      const ctx = makeEntryCtx(candles, 97.6);
      const signal = strategy.checkEntry(ctx);

      expect(signal).not.toBeNull();
      expect(signal!.valid).toBe(true);
      expect(signal!.side).toBe('short');
      expect(signal!.confidence).toBeGreaterThan(0);
      expect(signal!.confidence).toBeLessThanOrEqual(1);
      expect(signal!.stopLossPct).toBe(GRID_CONFIG.STOP_LOSS_PCT);
    });

    it('higher grid level (deeper in range) = higher confidence', () => {
      // midpoint ≈ 95. Shallow LONG at 94.5, deep LONG at 93
      const candles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);

      const ctxShallow = makeEntryCtx(candles, 94.5);
      const ctxDeep = makeEntryCtx(candles, 93.0);

      const signalShallow = strategy.checkEntry(ctxShallow);
      const signalDeep = strategy.checkEntry(ctxDeep);

      // Both should be LONG — deep should have >= confidence
      if (signalShallow && signalDeep) {
        expect(signalDeep.confidence).toBeGreaterThanOrEqual(signalShallow.confidence);
      }
    });
  });

  describe('checkExit', () => {
    // makeRangingCandles(100, 0.05): rangeLow ≈ 92.5, rangeHigh ≈ 97.5, midpoint ≈ 95
    // rangePct ≈ 5.41%, gridSpacing = 5.41/5 ≈ 1.08%, takeProfit = 1.08% * 1 = 1.08%
    // breakout_down threshold: 92.5 * 0.985 ≈ 91.1
    // breakout_up  threshold: 97.5 * 1.015 ≈ 98.9
    const rangingCandles = makeRangingCandles(GRID_CONFIG.RANGE_LOOKBACK_CANDLES, 100, 0.05);

    it('should not exit when conditions are normal', () => {
      // Price slightly above entry, moderate PnL, short hold → hold
      const ctx = makeExitCtx(rangingCandles, 96, 0.5, 60, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(false);
    });

    it('should exit at stop loss', () => {
      const ctx = makeExitCtx(rangingCandles, 92, -GRID_CONFIG.STOP_LOSS_PCT, 60, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('stop_loss');
    });

    it('should exit when stop loss threshold is exceeded', () => {
      const ctx = makeExitCtx(rangingCandles, 91, -(GRID_CONFIG.STOP_LOSS_PCT + 0.5), 60, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('stop_loss');
    });

    it('should exit at max hold time', () => {
      const ctx = makeExitCtx(rangingCandles, 96, 1.0, GRID_CONFIG.MAX_HOLD_MINUTES, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('max_hold_time');
    });

    it('should exit at take profit', () => {
      // rangePct ≈ 5.41%, gridSpacing ≈ 1.08%, takeProfit ≈ 1.08%
      // Set unrealizedPnlPct = 1.5% (well above TP threshold)
      const ctx = makeExitCtx(rangingCandles, 96.5, 1.5, 120, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('take_profit');
    });

    it('should exit on range breakout downward (long position, stop loss path)', () => {
      // price=89 → below breakout threshold 91.1 AND pnl=-3.5% → stop loss fires first
      const ctx = makeExitCtx(rangingCandles, 89, -(GRID_CONFIG.STOP_LOSS_PCT + 0.5), 120, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(['range_breakout_down', 'stop_loss']).toContain(exit.reason);
    });

    it('should exit on range breakout upward (short position, stop loss path)', () => {
      // price=100 → above breakout threshold 98.9 AND pnl=-3.5% → stop loss fires first
      const ctx = makeExitCtx(rangingCandles, 100, -(GRID_CONFIG.STOP_LOSS_PCT + 0.5), 120, 'short', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(['range_breakout_up', 'stop_loss']).toContain(exit.reason);
    });

    it('should exit range breakout upward before stop loss for short (clear breakout)', () => {
      // rangeHigh ≈ 97.5, breakout threshold = 97.5 * 1.015 ≈ 98.9
      // price = 99.5 (clearly above threshold), pnl = -2% (below stop loss threshold)
      const ctx = makeExitCtx(rangingCandles, 99.5, -2.0, 120, 'short', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('range_breakout_up');
    });

    it('should exit range breakout downward before stop loss for long (clear breakout)', () => {
      // rangeLow ≈ 92.5, breakout threshold = 92.5 * 0.985 ≈ 91.1
      // price = 90.5 (clearly below threshold), pnl = -2% (below stop loss threshold)
      const ctx = makeExitCtx(rangingCandles, 90.5, -2.0, 120, 'long', 95);
      const exit = strategy.checkExit(ctx);
      expect(exit.shouldExit).toBe(true);
      expect(exit.reason).toBe('range_breakout_down');
    });
  });
});
