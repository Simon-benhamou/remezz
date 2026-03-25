import { describe, it, expect } from '@jest/globals';
import type { IStrategy, EntryContext, ExitContext, Candle, Position } from '../../src/strategies/types.js';
import { FUNDING_CONFIG } from '../../src/strategies/fundingRate/config.js';

// ============================================================================
// Helpers
// ============================================================================

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

function makeCandles(n: number, basePrice: number, volume = 500): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: Date.now() - (n - i) * FIFTEEN_MIN_MS,
    open: basePrice,
    high: basePrice * 1.001,
    low: basePrice * 0.999,
    close: basePrice,
    volume,
  }));
}

/**
 * Build candles with strong upward momentum over the last MOMENTUM_LOOKBACK candles.
 * This should trigger a SHORT signal (funding proxy = positive).
 */
function makePositiveMomentumCandles(n: number): { candles: Candle[]; currentPrice: number } {
  const basePrice = 50_000;
  const candles: Candle[] = [];
  const lookback = FUNDING_CONFIG.MOMENTUM_LOOKBACK;

  // Flat candles before lookback window
  for (let i = 0; i < n - lookback - 1; i++) {
    candles.push({
      timestamp: Date.now() - (n - i) * FIFTEEN_MIN_MS,
      open: basePrice,
      high: basePrice * 1.001,
      low: basePrice * 0.999,
      close: basePrice,
      volume: 500,
    });
  }

  // Rising candles in the lookback window: 3% rise over 32 candles
  const totalRise = basePrice * 0.03; // 3% > threshold of 2%
  for (let i = 0; i <= lookback; i++) {
    const price = basePrice + (totalRise * i) / lookback;
    candles.push({
      timestamp: Date.now() - (lookback - i + 1) * FIFTEEN_MIN_MS,
      open: price - totalRise / lookback / 2,
      high: price + 50,
      low: price - 50,
      close: price,
      volume: 500,
    });
  }

  return { candles, currentPrice: basePrice + totalRise };
}

/**
 * Build candles with strong downward momentum.
 * This should trigger a LONG signal.
 */
function makeNegativeMomentumCandles(n: number): { candles: Candle[]; currentPrice: number } {
  const basePrice = 50_000;
  const candles: Candle[] = [];
  const lookback = FUNDING_CONFIG.MOMENTUM_LOOKBACK;

  for (let i = 0; i < n - lookback - 1; i++) {
    candles.push({
      timestamp: Date.now() - (n - i) * FIFTEEN_MIN_MS,
      open: basePrice,
      high: basePrice * 1.001,
      low: basePrice * 0.999,
      close: basePrice,
      volume: 500,
    });
  }

  const totalDrop = basePrice * 0.03;
  for (let i = 0; i <= lookback; i++) {
    const price = basePrice - (totalDrop * i) / lookback;
    candles.push({
      timestamp: Date.now() - (lookback - i + 1) * FIFTEEN_MIN_MS,
      open: price + totalDrop / lookback / 2,
      high: price + 50,
      low: price - 50,
      close: price,
      volume: 500,
    });
  }

  return { candles, currentPrice: basePrice - totalDrop };
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

describe('FundingRateStrategy', () => {
  let strategy: IStrategy;

  beforeAll(async () => {
    const mod = await import('../../src/strategies/fundingRate/strategy.js');
    strategy = mod.fundingRateStrategy;
  });

  // --------------------------------------------------------------------------
  // Config & metadata
  // --------------------------------------------------------------------------

  it('should have correct name', () => {
    expect(strategy.name).toBe('fundingRate');
  });

  it('should return correct config', () => {
    const cfg = strategy.getConfig();
    expect(cfg.leverage).toBe(1);
    expect(cfg.maxPositions).toBe(4);
    expect(cfg.positionSizePct).toBe(0.05);
    expect(cfg.symbols).toHaveLength(4);
    expect(cfg.minCandlesRequired).toBe(FUNDING_CONFIG.MOMENTUM_LOOKBACK + 10);
  });

  // --------------------------------------------------------------------------
  // Entry — warmup guard
  // --------------------------------------------------------------------------

  it('should return null with insufficient candles', () => {
    const candles = makeCandles(10, 50_000);
    const ctx = makeEntryCtx(candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  it('should return null when momentum is flat (no signal)', () => {
    const candles = makeCandles(50, 50_000);
    const ctx = makeEntryCtx(candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Entry — SHORT on positive momentum
  // --------------------------------------------------------------------------

  it('should SHORT when momentum is strongly positive', () => {
    const { candles, currentPrice } = makePositiveMomentumCandles(50);
    const ctx = makeEntryCtx(candles, currentPrice);
    const signal = strategy.checkEntry(ctx);

    expect(signal).not.toBeNull();
    expect(signal!.valid).toBe(true);
    expect(signal!.side).toBe('short');
    expect(signal!.confidence).toBeGreaterThanOrEqual(0.3);
    expect(signal!.confidence).toBeLessThanOrEqual(0.5);
    expect(signal!.stopLossPct).toBe(FUNDING_CONFIG.STOP_LOSS_PCT);
  });

  // --------------------------------------------------------------------------
  // Entry — LONG on negative momentum
  // --------------------------------------------------------------------------

  it('should LONG when momentum is strongly negative', () => {
    const { candles, currentPrice } = makeNegativeMomentumCandles(50);
    const ctx = makeEntryCtx(candles, currentPrice);
    const signal = strategy.checkEntry(ctx);

    expect(signal).not.toBeNull();
    expect(signal!.valid).toBe(true);
    expect(signal!.side).toBe('long');
    expect(signal!.confidence).toBeGreaterThanOrEqual(0.3);
  });

  // --------------------------------------------------------------------------
  // Exit — stop loss
  // --------------------------------------------------------------------------

  it('should exit at stop loss', () => {
    const candles = makeCandles(50, 50_000);
    const position = makePosition('short', 50_000);
    const pnl = -(FUNDING_CONFIG.STOP_LOSS_PCT + 0.1);
    const ctx = makeExitCtx(position, candles, 51_100, pnl, 30);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('STOP_LOSS');
  });

  // --------------------------------------------------------------------------
  // Exit — funding period complete (8h)
  // --------------------------------------------------------------------------

  it('should exit after HOLD_HOURS funding period', () => {
    const candles = makeCandles(50, 50_000);
    const position = makePosition('short', 50_000);
    const holdMinutes = FUNDING_CONFIG.HOLD_HOURS * 60 + 1;
    const ctx = makeExitCtx(position, candles, 50_000, 0.1, holdMinutes);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('FUNDING_PERIOD_COMPLETE');
  });

  // --------------------------------------------------------------------------
  // Exit — max hold time
  // --------------------------------------------------------------------------

  it('should exit at max hold time', () => {
    const candles = makeCandles(50, 50_000);
    const position = makePosition('short', 50_000);
    const holdMinutes = FUNDING_CONFIG.MAX_HOLD_HOURS * 60 + 1;
    const ctx = makeExitCtx(position, candles, 50_000, 0.1, holdMinutes);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    // Could be FUNDING_PERIOD_COMPLETE or MAX_HOLD_TIME (both triggered)
    expect(exit.reason).toMatch(/FUNDING_PERIOD_COMPLETE|MAX_HOLD_TIME/);
  });

  // --------------------------------------------------------------------------
  // Exit — momentum reversal
  // --------------------------------------------------------------------------

  it('should exit SHORT when momentum reverses to negative', () => {
    // Build candles where momentum is now negative (reversed from entry)
    const { candles } = makeNegativeMomentumCandles(50);
    const position = makePosition('short', 50_000);
    const ctx = makeExitCtx(position, candles, 49_000, 2.0, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('MOMENTUM_REVERSAL');
  });

  // --------------------------------------------------------------------------
  // Exit — hold when no condition met
  // --------------------------------------------------------------------------

  it('should not exit when holding with positive momentum and short time', () => {
    const { candles } = makePositiveMomentumCandles(50);
    const position = makePosition('short', 50_000);
    // Short hold, positive momentum still, no SL
    const ctx = makeExitCtx(position, candles, 49_500, 1.0, 60);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Config integrity
  // --------------------------------------------------------------------------

  it('FUNDING_CONFIG should have all required fields', () => {
    expect(FUNDING_CONFIG.MOMENTUM_LOOKBACK).toBe(32);
    expect(FUNDING_CONFIG.MOMENTUM_THRESHOLD_PCT).toBe(2.0);
    expect(FUNDING_CONFIG.HOLD_HOURS).toBe(8);
    expect(FUNDING_CONFIG.MAX_HOLD_HOURS).toBe(24);
    expect(FUNDING_CONFIG.STOP_LOSS_PCT).toBe(2.0);
    expect(FUNDING_CONFIG.SHORT_ONLY).toBe(false);
  });
});
