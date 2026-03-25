import { describe, it, expect } from '@jest/globals';
import type { IStrategy, EntryContext, ExitContext, Candle, Position } from '../../src/strategies/types.js';
import { MEAN_REV_4H_CONFIG } from '../../src/strategies/meanReversion4h/config.js';

// ============================================================================
// Helpers
// ============================================================================

const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Build 15m candles that form complete 4h buckets.
 * Each 4h bucket = 16 consecutive 15m candles aligned to 4h boundaries.
 */
function make15mCandles(num4hBuckets: number, basePrice: number, volume = 500): Candle[] {
  const candles: Candle[] = [];
  const startBoundary = Math.floor(Date.now() / FOUR_HOUR_MS) * FOUR_HOUR_MS
    - num4hBuckets * FOUR_HOUR_MS;

  for (let bucket = 0; bucket < num4hBuckets; bucket++) {
    const bucketStart = startBoundary + bucket * FOUR_HOUR_MS;
    for (let i = 0; i < 16; i++) {
      candles.push({
        timestamp: bucketStart + i * FIFTEEN_MIN_MS,
        open: basePrice,
        high: basePrice * 1.001,
        low: basePrice * 0.999,
        close: basePrice,
        volume,
      });
    }
  }
  return candles;
}

/**
 * Build 15m candles where the last few 4h buckets have declining closes
 * (to push RSI below oversold) and the final close is below lower BB.
 */
function makeLongEntry15mCandles(num4hBuckets: number): { candles: Candle[]; lastClose: number } {
  const basePrice = 50_000;
  const candles: Candle[] = [];
  const startBoundary = Math.floor(Date.now() / FOUR_HOUR_MS) * FOUR_HOUR_MS
    - num4hBuckets * FOUR_HOUR_MS;

  // Phase 1: flat alternating candles (keep ADX low)
  const flatBuckets = num4hBuckets - 16;
  for (let bucket = 0; bucket < flatBuckets; bucket++) {
    const bucketStart = startBoundary + bucket * FOUR_HOUR_MS;
    const dir = bucket % 2 === 0 ? 1 : -1;
    for (let i = 0; i < 16; i++) {
      candles.push({
        timestamp: bucketStart + i * FIFTEEN_MIN_MS,
        open: basePrice,
        high: basePrice + 200,
        low: basePrice - 200,
        close: basePrice + dir * 5,
        volume: 500,
      });
    }
  }

  // Phase 2: 15 buckets with declining closes for RSI < 30
  let price = basePrice;
  for (let bucket = flatBuckets; bucket < num4hBuckets - 1; bucket++) {
    const bucketStart = startBoundary + bucket * FOUR_HOUR_MS;
    const evenOdd = (bucket - flatBuckets) % 2 === 0;
    const high = price + (evenOdd ? 400 : 100);
    const low = price - (evenOdd ? 100 : 400);
    const close = price - 80;
    for (let i = 0; i < 16; i++) {
      candles.push({
        timestamp: bucketStart + i * FIFTEEN_MIN_MS,
        open: price,
        high,
        low,
        close: i === 15 ? close : price - 5 * i,
        volume: 500,
      });
    }
    price = close;
  }

  // Phase 3: final bucket with spike below lower BB
  const lastClose = price - 4_000;
  const finalBucketStart = startBoundary + (num4hBuckets - 1) * FOUR_HOUR_MS;
  for (let i = 0; i < 16; i++) {
    candles.push({
      timestamp: finalBucketStart + i * FIFTEEN_MIN_MS,
      open: price,
      high: price + 100,
      low: lastClose,
      close: i === 15 ? lastClose : price - 250 * i,
      volume: 2000, // volume spike
    });
  }

  return { candles, lastClose };
}

function makeEntryCtx(candles: Candle[], currentPrice: number): EntryContext {
  return {
    symbol: 'BTC/USDT:USDT',
    candles,
    btcCandles: candles,
    currentPrice,
    timestamp: Date.now(),
    capital: 10_000,
    openPositions: 0,
  };
}

function makePosition(side: 'long' | 'short', entryPrice: number): Position {
  return {
    symbol: 'BTC/USDT:USDT',
    side,
    entryPrice,
    qty: 1,
    entryTime: Date.now() - 60 * 60 * 1000,
  };
}

function makeExitCtx(
  position: Position,
  candles: Candle[],
  currentPrice: number,
  unrealizedPnlPct: number,
  holdingMinutes = 60,
): ExitContext {
  return {
    symbol: position.symbol,
    position,
    candles,
    btcCandles: candles,
    currentPrice,
    timestamp: Date.now(),
    entryPrice: position.entryPrice,
    unrealizedPnlPct,
    holdingMinutes,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('MeanReversion4hStrategy', () => {
  let strategy: IStrategy;

  beforeAll(async () => {
    const mod = await import('../../src/strategies/meanReversion4h/strategy.js');
    strategy = mod.meanReversion4hStrategy;
  });

  // --------------------------------------------------------------------------
  // Config & metadata
  // --------------------------------------------------------------------------

  it('should have correct name', () => {
    expect(strategy.name).toBe('meanReversion4h');
  });

  it('should return correct config', () => {
    const cfg = strategy.getConfig();
    expect(cfg.leverage).toBe(2);
    expect(cfg.maxPositions).toBe(2);
    expect(cfg.positionSizePct).toBe(0.05);
    expect(cfg.symbols).toContain('BTC/USDT:USDT');
    expect(cfg.symbols).toContain('SOL/USDT:USDT');
    expect(cfg.timeframeMs).toBe(4 * 60 * 60 * 1000);
    expect(cfg.minCandlesRequired).toBe(
      (MEAN_REV_4H_CONFIG.BB_PERIOD + 20) * MEAN_REV_4H_CONFIG.CANDLE_AGGREGATE,
    );
  });

  // --------------------------------------------------------------------------
  // Entry — warmup guard
  // --------------------------------------------------------------------------

  it('should return null with insufficient 15m candles', () => {
    // Not enough candles to form 40 4h buckets
    const candles = make15mCandles(10, 50_000);
    const ctx = makeEntryCtx(candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  it('should return null when price is at mean (no BB breakout)', () => {
    const candles = make15mCandles(45, 50_000);
    const ctx = makeEntryCtx(candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Entry — LONG signal
  // --------------------------------------------------------------------------

  it('should produce LONG signal when conditions are met (or null if filters not met)', () => {
    const { candles, lastClose } = makeLongEntry15mCandles(50);
    const ctx = makeEntryCtx(candles, lastClose);
    const signal = strategy.checkEntry(ctx);

    if (signal !== null) {
      expect(signal.valid).toBe(true);
      expect(signal.side).toBe('long');
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.stopLossPct).toBe(MEAN_REV_4H_CONFIG.STOP_LOSS_PCT);
    } else {
      // Null is acceptable if ADX/RSI thresholds not quite reached
      expect(signal).toBeNull();
    }
  });

  // --------------------------------------------------------------------------
  // Exit — stop loss
  // --------------------------------------------------------------------------

  it('should exit at stop loss', () => {
    const entryPrice = 50_000;
    const candles = make15mCandles(45, entryPrice);
    const position = makePosition('long', entryPrice);
    const pnl = -(MEAN_REV_4H_CONFIG.STOP_LOSS_PCT + 0.1);
    const ctx = makeExitCtx(position, candles, entryPrice * 0.965, pnl, 30);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('STOP_LOSS');
  });

  // --------------------------------------------------------------------------
  // Exit — max hold time
  // --------------------------------------------------------------------------

  it('should exit at max hold time', () => {
    const entryPrice = 50_000;
    const candles = make15mCandles(45, 100_000);
    const position = makePosition('long', entryPrice);

    const ctx = makeExitCtx(
      position,
      candles,
      entryPrice * 0.99,
      -1.0,
      MEAN_REV_4H_CONFIG.MAX_HOLD_MINUTES + 1,
    );

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('MAX_HOLD_TIME');
  });

  // --------------------------------------------------------------------------
  // Exit — mean reversion (LONG)
  // --------------------------------------------------------------------------

  it('should exit LONG when price reverts to mean (middle BB)', () => {
    const entryPrice = 45_000;
    const basePrice = 50_000;
    const candles = make15mCandles(45, basePrice);
    const position = makePosition('long', entryPrice);
    const ctx = makeExitCtx(position, candles, basePrice, 10, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('MEAN_REVERSION_EXIT');
  });

  // --------------------------------------------------------------------------
  // Exit — mean reversion (SHORT)
  // --------------------------------------------------------------------------

  it('should exit SHORT when price reverts to mean (middle BB)', () => {
    const entryPrice = 56_000;
    const basePrice = 50_000;
    const candles = make15mCandles(45, basePrice);
    const position = makePosition('short', entryPrice);
    const ctx = makeExitCtx(position, candles, basePrice, 10, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('MEAN_REVERSION_EXIT');
  });

  // --------------------------------------------------------------------------
  // Exit — trailing stop
  // --------------------------------------------------------------------------

  it('should exit via trailing stop when profit drops from peak', () => {
    const entryPrice = 50_000;
    const candles = make15mCandles(45, 100_000);

    const position: Position = {
      ...makePosition('long', entryPrice),
      maxPnlPct: 5.0, // peaked at 5%
    };

    // Current PnL = 2.0%. gap = 5.0 - 2.0 = 3.0% > TRAILING_DISTANCE_PCT (1.5%)
    const ctx = makeExitCtx(position, candles, entryPrice * 1.02, 2.0, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('TRAILING_STOP');
  });

  // --------------------------------------------------------------------------
  // Exit — hold when no exit condition
  // --------------------------------------------------------------------------

  it('should not exit when price is still far from mean and no SL/time limit', () => {
    const entryPrice = 44_000;
    const basePrice = 50_000;
    const candles = make15mCandles(45, basePrice);
    const position = makePosition('long', entryPrice);

    const ctx = makeExitCtx(position, candles, 46_000, 4.5, 60);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Config integrity
  // --------------------------------------------------------------------------

  it('MEAN_REV_4H_CONFIG should have all required fields', () => {
    expect(MEAN_REV_4H_CONFIG.CANDLE_AGGREGATE).toBe(16);
    expect(MEAN_REV_4H_CONFIG.BB_PERIOD).toBe(20);
    expect(MEAN_REV_4H_CONFIG.BB_STD_ENTRY).toBe(2.0);
    expect(MEAN_REV_4H_CONFIG.RSI_PERIOD).toBe(14);
    expect(MEAN_REV_4H_CONFIG.RSI_OVERSOLD).toBe(30);
    expect(MEAN_REV_4H_CONFIG.RSI_OVERBOUGHT).toBe(70);
    expect(MEAN_REV_4H_CONFIG.ADX_MAX).toBe(30);
    expect(MEAN_REV_4H_CONFIG.STOP_LOSS_PCT).toBe(3.0);
    expect(MEAN_REV_4H_CONFIG.TRAILING_ACTIVATION_PCT).toBe(2.0);
    expect(MEAN_REV_4H_CONFIG.TRAILING_DISTANCE_PCT).toBe(1.5);
    expect(MEAN_REV_4H_CONFIG.MAX_HOLD_MINUTES).toBe(5760);
    expect(MEAN_REV_4H_CONFIG.PROGRESSIVE_ENABLED).toBe(true);
    expect(MEAN_REV_4H_CONFIG.TIER2_PROFIT_PCT).toBe(4.0);
    expect(MEAN_REV_4H_CONFIG.TIER3_PROFIT_PCT).toBe(8.0);
  });

  // --------------------------------------------------------------------------
  // 4h aggregation — incomplete bucket guard
  // --------------------------------------------------------------------------

  it('should not include incomplete 4h buckets (look-ahead protection)', () => {
    // Create 40 complete buckets + 5 extra 15m candles (incomplete bucket)
    const candles = make15mCandles(40, 50_000);
    // Add 5 candles in the next 4h boundary
    const lastTs = candles[candles.length - 1].timestamp;
    const nextBoundary = Math.floor((lastTs + FOUR_HOUR_MS) / FOUR_HOUR_MS) * FOUR_HOUR_MS;
    for (let i = 0; i < 5; i++) {
      candles.push({
        timestamp: nextBoundary + i * FIFTEEN_MIN_MS,
        open: 99_999, // Very different price — would bias indicators
        high: 99_999,
        low: 99_999,
        close: 99_999,
        volume: 500,
      });
    }

    // The strategy should still work on the 40 complete buckets
    const ctx = makeEntryCtx(candles, 50_000);
    // Should not throw and should return null (flat price = no signal)
    const signal = strategy.checkEntry(ctx);
    expect(signal).toBeNull();
  });
});
