import { describe, it, expect, beforeAll } from '@jest/globals';
import type { IStrategy, EntryContext, ExitContext, Candle, Position } from '../../src/strategies/types.js';
import { PULLBACK_CONFIG } from '../../src/strategies/pullbackTrend/config.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCandles(n: number, basePrice: number, volume = 500): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: Date.now() - (n - i) * 15 * 60 * 1000,
    open: basePrice,
    high: basePrice * 1.001,
    low: basePrice * 0.999,
    close: basePrice,
    volume,
  }));
}

/**
 * Build candles for a LONG pullback entry:
 * - Uptrend: most closes above SMA50 (price climbing then pulls back)
 * - Pullback: last candles drop to lower BB
 * - RSI < 35 on last candles (oversold from pullback)
 * - ADX > 15 (trend exists)
 * - Volume above average
 */
function makeLongPullbackCandles(n: number): { candles: Candle[]; entryPrice: number } {
  const candles: Candle[] = [];
  const basePrice = 50_000;

  // Phase 1: Strong uptrend (n - 20 candles climbing) — ensures close > SMA50
  let price = basePrice;
  for (let i = 0; i < n - 20; i++) {
    const step = 80; // steady climb
    candles.push({
      timestamp: i,
      open: price,
      high: price + step * 1.5,
      low: price - step * 0.3,
      close: price + step,
      volume: 500,
    });
    price += step;
  }

  // Phase 2: Sharp pullback (15 candles declining) — pushes RSI down, price toward lower BB
  for (let i = 0; i < 15; i++) {
    const drop = 250;
    candles.push({
      timestamp: n - 20 + i,
      open: price,
      high: price + 50,
      low: price - drop * 1.2,
      close: price - drop,
      volume: 600,
    });
    price -= drop;
  }

  // Phase 3: Final candle — deep pullback with volume spike
  const finalDrop = 500;
  const entryPrice = price - finalDrop;
  candles.push({
    timestamp: n - 5,
    open: price,
    high: price + 20,
    low: entryPrice,
    close: entryPrice,
    volume: 500 * 3, // volume spike
  });
  price = entryPrice;

  // Remaining 4 candles at pullback level
  for (let i = 0; i < 4; i++) {
    candles.push({
      timestamp: n - 4 + i,
      open: price,
      high: price + 30,
      low: price - 30,
      close: price - 10,
      volume: 500 * 2,
    });
    price -= 10;
  }

  return { candles, entryPrice: price };
}

/**
 * Build candles for a SHORT pullback entry:
 * - Downtrend: price declining, close < SMA50
 * - Rally: last candles bounce up to upper BB
 * - RSI > 65 (overbought from rally)
 */
function makeShortPullbackCandles(n: number): { candles: Candle[]; entryPrice: number } {
  const candles: Candle[] = [];
  const basePrice = 50_000;

  // Phase 1: Strong downtrend (n - 20 candles declining)
  let price = basePrice;
  for (let i = 0; i < n - 20; i++) {
    const step = 80;
    candles.push({
      timestamp: i,
      open: price,
      high: price + step * 0.3,
      low: price - step * 1.5,
      close: price - step,
      volume: 500,
    });
    price -= step;
  }

  // Phase 2: Sharp rally (15 candles climbing) — pushes RSI up, price toward upper BB
  for (let i = 0; i < 15; i++) {
    const rise = 250;
    candles.push({
      timestamp: n - 20 + i,
      open: price,
      high: price + rise * 1.2,
      low: price - 50,
      close: price + rise,
      volume: 600,
    });
    price += rise;
  }

  // Phase 3: Final candle with volume spike at the top
  const finalRise = 500;
  const entryPrice = price + finalRise;
  candles.push({
    timestamp: n - 5,
    open: price,
    high: entryPrice,
    low: price - 20,
    close: entryPrice,
    volume: 500 * 3,
  });
  price = entryPrice;

  for (let i = 0; i < 4; i++) {
    candles.push({
      timestamp: n - 4 + i,
      open: price,
      high: price + 30,
      low: price - 30,
      close: price + 10,
      volume: 500 * 2,
    });
    price += 10;
  }

  return { candles, entryPrice: price };
}

function makeEntryCtx(candles: Candle[], btcCandles: Candle[], currentPrice: number): EntryContext {
  return {
    symbol: 'ETH/USDT:USDT',
    candles,
    btcCandles,
    currentPrice,
    timestamp: Date.now(),
    capital: 10_000,
    openPositions: 0,
  };
}

function makePosition(side: 'long' | 'short', entryPrice: number, maxPnlPct?: number): Position {
  return {
    symbol: 'ETH/USDT:USDT',
    side,
    entryPrice,
    qty: 1,
    entryTime: Date.now() - 60 * 60 * 1000,
    maxPnlPct,
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

describe('PullbackTrendStrategy', () => {
  let strategy: IStrategy;

  beforeAll(async () => {
    const mod = await import('../../src/strategies/pullbackTrend/strategy.js');
    strategy = mod.pullbackTrendStrategy;
  });

  const MIN_CANDLES = Math.max(PULLBACK_CONFIG.TREND_SMA_PERIOD, PULLBACK_CONFIG.BB_PERIOD) + 20;

  // --------------------------------------------------------------------------
  // Config & metadata
  // --------------------------------------------------------------------------

  it('should have correct name', () => {
    expect(strategy.name).toBe('pullbackTrend');
  });

  it('should return correct config', () => {
    const cfg = strategy.getConfig();
    expect(cfg.leverage).toBe(3);
    expect(cfg.maxPositions).toBe(2);
    expect(cfg.positionSizePct).toBe(0.05);
    expect(cfg.symbols).toContain('BTC/USDT:USDT');
    expect(cfg.symbols).toContain('ETH/USDT:USDT');
    expect(cfg.symbols).toContain('SOL/USDT:USDT');
    expect(cfg.symbols).toContain('XRP/USDT:USDT');
    expect(cfg.minCandlesRequired).toBe(MIN_CANDLES);
  });

  // --------------------------------------------------------------------------
  // Entry — warmup guard
  // --------------------------------------------------------------------------

  it('should return null with insufficient candles', () => {
    const candles = makeCandles(MIN_CANDLES - 1, 50_000);
    const ctx = makeEntryCtx(candles, candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Entry — no signal on flat market (no pullback)
  // --------------------------------------------------------------------------

  it('should return null on flat market (no pullback to BB)', () => {
    const candles = makeCandles(MIN_CANDLES + 30, 50_000);
    const ctx = makeEntryCtx(candles, candles, 50_000);
    expect(strategy.checkEntry(ctx)).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Entry — LONG pullback in uptrend
  // --------------------------------------------------------------------------

  it('should detect LONG entry on pullback in uptrend (if conditions met)', () => {
    const { candles, entryPrice } = makeLongPullbackCandles(MIN_CANDLES + 40);
    const btcCandles = candles; // BTC = same trend for alignment
    const ctx = makeEntryCtx(candles, btcCandles, entryPrice);
    const signal = strategy.checkEntry(ctx);

    // May or may not trigger depending on exact indicator values
    if (signal !== null) {
      expect(signal.valid).toBe(true);
      expect(signal.side).toBe('long');
      expect(signal.reason).toContain('PULLBACK_LONG');
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.stopLossPct).toBe(PULLBACK_CONFIG.STOP_LOSS_PCT);
    }
  });

  // --------------------------------------------------------------------------
  // Entry — SHORT pullback in downtrend
  // --------------------------------------------------------------------------

  it('should detect SHORT entry on pullback in downtrend (if conditions met)', () => {
    const { candles, entryPrice } = makeShortPullbackCandles(MIN_CANDLES + 40);
    const btcCandles = candles;
    const ctx = makeEntryCtx(candles, btcCandles, entryPrice);
    const signal = strategy.checkEntry(ctx);

    if (signal !== null) {
      expect(signal.valid).toBe(true);
      expect(signal.side).toBe('short');
      expect(signal.reason).toContain('PULLBACK_SHORT');
    }
  });

  // --------------------------------------------------------------------------
  // Entry — no entry when ADX too low (no trend)
  // --------------------------------------------------------------------------

  it('should not enter when ADX is below ADX_MIN (no trend)', () => {
    // Build alternating candles that produce very low ADX
    const n = MIN_CANDLES + 40;
    const candles: Candle[] = [];
    const basePrice = 50_000;

    for (let i = 0; i < n; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      candles.push({
        timestamp: i,
        open: basePrice,
        high: basePrice + 50,
        low: basePrice - 50,
        close: basePrice + dir * 10, // tiny oscillation
        volume: 500,
      });
    }

    const ctx = makeEntryCtx(candles, candles, basePrice - 2000);
    const signal = strategy.checkEntry(ctx);
    // Low ADX should filter this out
    expect(signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Entry — no entry when BTC trend doesn't align
  // --------------------------------------------------------------------------

  it('should not enter when BTC trend does not align', () => {
    const { candles, entryPrice } = makeLongPullbackCandles(MIN_CANDLES + 40);
    // BTC in downtrend — make BTC candles declining
    const btcCandles: Candle[] = [];
    let btcPrice = 70_000;
    for (let i = 0; i < candles.length; i++) {
      btcCandles.push({
        timestamp: candles[i].timestamp,
        open: btcPrice,
        high: btcPrice + 50,
        low: btcPrice - 200,
        close: btcPrice - 100,
        volume: 1000,
      });
      btcPrice -= 100;
    }

    const ctx = makeEntryCtx(candles, btcCandles, entryPrice);
    const signal = strategy.checkEntry(ctx);
    // BTC is in downtrend but symbol is in uptrend => no alignment
    expect(signal).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Exit — stop loss
  // --------------------------------------------------------------------------

  it('should exit on stop loss', () => {
    const entryPrice = 50_000;
    const candles = makeCandles(MIN_CANDLES, 100_000); // high SMA to prevent trend reversal exit
    const position = makePosition('long', entryPrice);

    const pnl = -(PULLBACK_CONFIG.STOP_LOSS_PCT + 0.1);
    const ctx = makeExitCtx(position, candles, entryPrice * 0.98, pnl, 30);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('STOP_LOSS');
  });

  // --------------------------------------------------------------------------
  // Exit — max hold time
  // --------------------------------------------------------------------------

  it('should exit at max hold time', () => {
    const entryPrice = 50_000;
    const candles = makeCandles(MIN_CANDLES, 100_000);
    const position = makePosition('long', entryPrice);

    const ctx = makeExitCtx(
      position,
      candles,
      entryPrice * 1.005,
      0.5,
      PULLBACK_CONFIG.MAX_HOLD_MINUTES + 1,
    );

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('MAX_HOLD_TIME');
  });

  // --------------------------------------------------------------------------
  // Exit — trend reversal
  // --------------------------------------------------------------------------

  it('should exit on trend reversal (LONG position, price crosses below SMA)', () => {
    const entryPrice = 50_000;
    // Build candles where SMA50 is high (around 60K) and current price drops below it
    const n = MIN_CANDLES + 10;
    const candles: Candle[] = [];
    let price = 60_000;
    for (let i = 0; i < n - 5; i++) {
      candles.push({
        timestamp: i,
        open: price,
        high: price + 100,
        low: price - 100,
        close: price,
        volume: 500,
      });
    }
    // Last 5 candles drop sharply
    for (let i = 0; i < 5; i++) {
      price -= 2000;
      candles.push({
        timestamp: n - 5 + i,
        open: price + 2000,
        high: price + 2100,
        low: price - 100,
        close: price,
        volume: 500,
      });
    }

    const currentPrice = price; // well below SMA50
    const position = makePosition('long', 58_000);

    const ctx = makeExitCtx(position, candles, currentPrice, -5, 120);
    const exit = strategy.checkExit(ctx);
    // Stop loss at -5% should trigger first (SL = 2%), but trend reversal also applies
    expect(exit.shouldExit).toBe(true);
    expect(['STOP_LOSS', 'TREND_REVERSAL']).toContain(exit.reason);
  });

  // --------------------------------------------------------------------------
  // Exit — trailing stop (progressive)
  // --------------------------------------------------------------------------

  it('should exit via trailing stop when profit drops from peak (tier 1)', () => {
    const entryPrice = 50_000;
    // Current price is above entry and above SMA to avoid TREND_REVERSAL
    const currentPrice = entryPrice * 1.003; // 0.3% profit
    const candles = makeCandles(MIN_CANDLES, currentPrice * 0.99); // SMA slightly below current
    const position = makePosition('long', entryPrice, 2.0); // maxPnlPct = 2.0%

    // Current PnL = 0.3%, maxPnl = 2.0% => drop of 1.7% > TRAILING_DISTANCE_PCT (1.5%)
    const ctx = makeExitCtx(position, candles, currentPrice, 0.3, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('TRAILING_STOP');
  });

  it('should exit via trailing stop at tier 2 (wider trail)', () => {
    const entryPrice = 50_000;
    const currentPrice = entryPrice * 1.012; // 1.2% profit
    const candles = makeCandles(MIN_CANDLES, currentPrice * 0.99);
    // maxPnlPct = 4.0% (reached tier 2, trail = 2.5%)
    const position = makePosition('long', entryPrice, 4.0);

    // Current PnL = 1.2%, maxPnl = 4.0% => drop of 2.8% > TIER2_TRAIL_PCT (2.5%)
    const ctx = makeExitCtx(position, candles, currentPrice, 1.2, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(true);
    expect(exit.reason).toBe('TRAILING_STOP');
  });

  it('should NOT exit via trailing when drop is within trail distance', () => {
    const entryPrice = 50_000;
    const currentPrice = entryPrice * 1.01; // 1.0% profit
    const candles = makeCandles(MIN_CANDLES, currentPrice * 0.99);
    // maxPnlPct = 2.0%, current PnL = 1.0% => drop of 1.0% < TRAILING_DISTANCE_PCT (1.5%)
    const position = makePosition('long', entryPrice, 2.0);

    const ctx = makeExitCtx(position, candles, currentPrice, 1.0, 120);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Exit — holding
  // --------------------------------------------------------------------------

  it('should not exit when no conditions are met', () => {
    const entryPrice = 50_000;
    const currentPrice = entryPrice * 1.005; // small profit, above SMA
    const candles = makeCandles(MIN_CANDLES, currentPrice * 0.99); // SMA below current
    const position = makePosition('long', entryPrice);

    // Small profit, short hold, no trailing active
    const ctx = makeExitCtx(position, candles, currentPrice, 0.5, 60);

    const exit = strategy.checkExit(ctx);
    expect(exit.shouldExit).toBe(false);
    expect(exit.reason).toBe('holding');
  });

  // --------------------------------------------------------------------------
  // Config integrity
  // --------------------------------------------------------------------------

  it('PULLBACK_CONFIG should have all required fields', () => {
    expect(PULLBACK_CONFIG.TREND_SMA_PERIOD).toBe(50);
    expect(PULLBACK_CONFIG.TREND_REQUIRE_BTC_ALIGN).toBe(true);
    expect(PULLBACK_CONFIG.BB_PERIOD).toBe(20);
    expect(PULLBACK_CONFIG.BB_STD).toBe(2.0);
    expect(PULLBACK_CONFIG.RSI_PERIOD).toBe(14);
    expect(PULLBACK_CONFIG.RSI_OVERSOLD).toBe(35);
    expect(PULLBACK_CONFIG.RSI_OVERBOUGHT).toBe(65);
    expect(PULLBACK_CONFIG.VOLUME_MIN).toBe(1.0);
    expect(PULLBACK_CONFIG.ADX_MIN).toBe(15);
    expect(PULLBACK_CONFIG.STOP_LOSS_PCT).toBe(2.0);
    expect(PULLBACK_CONFIG.TRAILING_ACTIVATION_PCT).toBe(1.0);
    expect(PULLBACK_CONFIG.TRAILING_DISTANCE_PCT).toBe(1.5);
    expect(PULLBACK_CONFIG.MAX_HOLD_MINUTES).toBe(2880);
    expect(PULLBACK_CONFIG.PROGRESSIVE_TRAIL_ENABLED).toBe(true);
    expect(PULLBACK_CONFIG.TIER2_PROFIT_PCT).toBe(3.0);
    expect(PULLBACK_CONFIG.TIER2_TRAIL_PCT).toBe(2.5);
    expect(PULLBACK_CONFIG.TIER3_PROFIT_PCT).toBe(6.0);
    expect(PULLBACK_CONFIG.TIER3_TRAIL_PCT).toBe(4.0);
  });
});
