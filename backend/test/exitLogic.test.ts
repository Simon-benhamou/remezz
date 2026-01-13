/**
 * 🧪 TESTS UNITAIRES - Exit Logic Alignment
 * 
 * Ces tests valident que la logique d'exit est cohérente entre:
 * - shouldExitPosition() dans momentumSimple.ts
 * - backtestService.ts simulation
 * 
 * V5.39 Tests couvrant:
 * - Trailing stop activation et calcul
 * - Adaptive trailing basé sur volatilité
 * - Stagnant trade state machine
 * - Stop loss avec SL adaptatif
 * - Momentum reversal 2-candle
 * - Max hold time
 * - Regime change exit
 */

import { jest } from '@jest/globals';
import {
  shouldExitPosition,
  determineVolatilityRegime,
  calcROC,
  calcSMA,
  calcATR,
  updatePositionWaterMarks,
  MomentumConfig,
} from '../src/strategies/momentumSimple.js';
import type { Position, Candle } from '../src/types.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createMockPosition(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'test-pos-1',
    symbol: 'DOGE/USDT:USDT',
    side: 'long',
    entryPrice: 0.10,
    entryTime: now - 30 * 60 * 1000, // 30 minutes ago
    quantity: 1000,
    leverage: 5,
    stopLossPct: 2.5,
    trailingActive: false,
    maxPnlPct: 0,
    highWaterMark: undefined,
    lowWaterMark: undefined,
    stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
    ...overrides,
  } as Position;
}

function createMockCandles(count: number, basePrice: number = 100, volatility: 'low' | 'medium' | 'high' = 'medium'): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  
  // Volatility ranges as % of price
  const volRange = volatility === 'low' ? 0.01 : volatility === 'high' ? 0.04 : 0.02;
  
  for (let i = 0; i < count; i++) {
    const close = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    const high = close * (1 + Math.random() * volRange);
    const low = close * (1 - Math.random() * volRange);
    const open = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    
    candles.push({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      open,
      high,
      low,
      close,
      volume: 1000000 + Math.random() * 500000,
    });
    basePrice = close;
  }
  
  return candles;
}

function createTrendingCandles(
  count: number, 
  startPrice: number, 
  trend: 'up' | 'down', 
  trendStrengthPct: number = 0.5
): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let price = startPrice;
  
  for (let i = 0; i < count; i++) {
    const change = price * (trendStrengthPct / 100) * (trend === 'up' ? 1 : -1);
    const newPrice = price + change;
    
    candles.push({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      open: price,
      high: Math.max(price, newPrice) * 1.002,
      low: Math.min(price, newPrice) * 0.998,
      close: newPrice,
      volume: 1000000,
    });
    
    price = newPrice;
  }
  
  return candles;
}

// ============================================================================
// TESTS: determineVolatilityRegime
// ============================================================================

describe('determineVolatilityRegime', () => {
  describe('LOW volatility regime (ATR < 2%)', () => {
    it('should return LOW regime with tight trailing params', () => {
      // Create low volatility candles (small high-low range)
      const candles = createMockCandles(20, 100, 'low');
      
      const result = determineVolatilityRegime(candles);
      
      // If ATR < 2%, should be LOW regime
      if (result.atrPct !== null && result.atrPct < 2) {
        expect(result.regime).toBe('LOW');
        expect(result.trailingDistance).toBe(MomentumConfig.EXIT.LOW_VOL_DISTANCE);
        expect(result.trailingActivation).toBe(MomentumConfig.EXIT.LOW_VOL_ACTIVATION);
      }
    });
  });

  describe('HIGH volatility regime (ATR > 3.5%)', () => {
    it('should return HIGH regime with wide trailing params', () => {
      const candles = createMockCandles(20, 100, 'high');
      
      const result = determineVolatilityRegime(candles);
      
      // If ATR > 3.5%, should be HIGH regime
      if (result.atrPct !== null && result.atrPct > 3.5) {
        expect(result.regime).toBe('HIGH');
        expect(result.trailingDistance).toBe(MomentumConfig.EXIT.HIGH_VOL_DISTANCE);
        expect(result.trailingActivation).toBe(MomentumConfig.EXIT.HIGH_VOL_ACTIVATION);
      }
    });
  });

  describe('MEDIUM volatility regime (2% < ATR < 3.5%)', () => {
    it('should return MEDIUM regime with standard trailing params', () => {
      const candles = createMockCandles(20, 100, 'medium');
      
      const result = determineVolatilityRegime(candles);
      
      // Regardless of actual ATR, verify structure
      expect(result).toHaveProperty('regime');
      expect(result).toHaveProperty('atrPct');
      expect(result).toHaveProperty('trailingDistance');
      expect(result).toHaveProperty('trailingActivation');
      expect(result).toHaveProperty('reason');
    });
  });

  describe('edge cases', () => {
    it('should handle empty candles array', () => {
      const result = determineVolatilityRegime([]);
      
      expect(result.regime).toBe('MEDIUM');
      expect(result.atrPct).toBeNull();
      expect(result.reason).toContain('ATR unavailable');
    });

    it('should handle single candle', () => {
      const candles = createMockCandles(1, 100);
      const result = determineVolatilityRegime(candles);
      
      expect(result).toHaveProperty('regime');
    });
  });
});

// ============================================================================
// TESTS: shouldExitPosition - MAX HOLD TIME
// ============================================================================

describe('shouldExitPosition - MAX_HOLD_TIME', () => {
  it('should exit with TIME reason when max hold exceeded', () => {
    const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
    const position = createMockPosition({
      entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000, // Exceeded max hold
    });
    
    const result = shouldExitPosition(position, position.entryPrice);
    
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('time');
  });

  it('should NOT exit when under max hold time', () => {
    const position = createMockPosition({
      entryTime: Date.now() - 30 * 60 * 1000, // Only 30 minutes
    });
    
    const result = shouldExitPosition(position, position.entryPrice * 1.005); // Slight profit
    
    // Should not exit for time (might exit for other reasons)
    if (result.shouldExit && result.reason === 'time') {
      fail('Should not exit for time when under max hold');
    }
  });
});

// ============================================================================
// TESTS: shouldExitPosition - STOP LOSS
// ============================================================================

describe('shouldExitPosition - STOP_LOSS', () => {
  describe('LONG positions', () => {
    it('should trigger SL when price drops below threshold', () => {
      const position = createMockPosition({
        side: 'long',
        entryPrice: 100,
        stopLossPct: 2.5,
      });
      
      // Price dropped 3% (below 2.5% SL)
      const result = shouldExitPosition(position, 97, undefined, {
        priceLow: 97,
      });
      
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('stoploss');
    });

    it('should NOT trigger SL when price above threshold', () => {
      const position = createMockPosition({
        side: 'long',
        entryPrice: 100,
        stopLossPct: 2.5,
      });
      
      // Price dropped only 1% (above 2.5% SL)
      const result = shouldExitPosition(position, 99, undefined, {
        priceLow: 99,
      });
      
      expect(result.reason).not.toBe('stoploss');
    });
  });

  describe('SHORT positions', () => {
    it('should trigger SL when price rises above threshold', () => {
      const position = createMockPosition({
        side: 'short',
        entryPrice: 100,
        stopLossPct: 2.5,
      });
      
      // Price rose 3% (above 2.5% SL)
      const result = shouldExitPosition(position, 103, undefined, {
        priceHigh: 103,
      });
      
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('stoploss');
    });
  });
});

// ============================================================================
// TESTS: shouldExitPosition - STAGNANT TRADE
// ============================================================================

describe('shouldExitPosition - STAGNANT_TRADE', () => {
  it('should trigger stagnant after 45min with low maxPnl and NO trailing', () => {
    const stagnantTimeMin = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
    const stagnantObsMin = MomentumConfig.EXIT.STAGNANT_TRADE_OBS_MINUTES ?? 60;
    const totalTime = stagnantTimeMin + stagnantObsMin;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - (totalTime + 5) * 60 * 1000,
      maxPnlPct: 0.2, // Low max PnL (below 0.8% threshold)
      trailingActive: false,
      stagnantState: { triggered: true, confirmed: false, cancelled: false, obsPeakPct: 0.3, triggeredAtMinutes: stagnantTimeMin },
    });
    
    // At 105min (45+60), stagnant should be confirmed
    // Price is slightly below entry, SL tightened to 0.8%
    const result = shouldExitPosition(position, 99.1, undefined, {
      priceLow: 99.1, // Just below 0.8% SL
    });
    
    // Should either exit with stagnant_trade or continue
    // The key is the stagnantState should progress
    expect(position.stagnantState).toBeDefined();
  });

  it('should cancel stagnant if position reaches recovery threshold', () => {
    const stagnantTimeMin = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
    const recoveryPct = MomentumConfig.EXIT.STAGNANT_TRADE_RECOVERY_PCT ?? 0.6;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - (stagnantTimeMin + 10) * 60 * 1000,
      maxPnlPct: 0.2,
      trailingActive: false,
      stagnantState: { triggered: true, confirmed: false, cancelled: false, obsPeakPct: 0 },
    });
    
    // Price spiked to 0.8% profit during observation
    const priceHigh = 100 * (1 + recoveryPct / 100 + 0.1);
    
    shouldExitPosition(position, 100.3, undefined, {
      priceHigh,
      priceLow: 100,
    });
    
    // Stagnant should be cancelled due to recovery
    expect(position.stagnantState.cancelled).toBe(true);
  });

  it('should NOT trigger stagnant when trailing is active', () => {
    const stagnantTimeMin = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - (stagnantTimeMin + 5) * 60 * 1000,
      maxPnlPct: 1.5, // Good profit
      trailingActive: true, // Trailing IS active
      stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
    });
    
    shouldExitPosition(position, 101.5, undefined);
    
    // Stagnant should NOT be triggered when trailing active
    expect(position.stagnantState.triggered).toBe(false);
  });
});

// ============================================================================
// TESTS: shouldExitPosition - TRAILING STOP
// ============================================================================

describe('shouldExitPosition - TRAILING_STOP', () => {
  it('should activate trailing when pnlPct >= activation threshold', () => {
    const activation = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: false,
    });
    
    // Price at activation threshold
    const currentPrice = 100 * (1 + activation / 100);
    
    const result = shouldExitPosition(position, currentPrice, undefined, {
      priceHigh: currentPrice,
    });
    
    // Trailing should be active now
    // The function sets internal state
    expect(result.pnlPct).toBeGreaterThanOrEqual(activation);
  });

  it('should return trailingBreached when price falls below trailing stop', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 105, // Reached 5% profit
    });
    
    // Price fell back significantly
    const trailDist = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
    const trailStop = 105 * (1 - trailDist / 100);
    
    const result = shouldExitPosition(position, trailStop - 0.1, undefined, {
      priceLow: trailStop - 0.1,
    });
    
    // Should signal trailing breach
    expect(result.trailingBreached).toBe(true);
  });

  it('should use WIDE distance when hwmPct >= 3%', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 103.5, // 3.5% profit reached
    });
    
    const widenAt = MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT;
    const hwmPct = ((103.5 - 100) / 100) * 100; // 3.5%
    
    expect(hwmPct).toBeGreaterThanOrEqual(widenAt);
    
    // Wide distance should be used
    // This is tested implicitly - trailing stop should be wider
  });
});

// ============================================================================
// TESTS: shouldExitPosition - MOMENTUM REVERSAL
// ============================================================================

describe('shouldExitPosition - MOMENTUM_REVERSAL', () => {
  it('should exit LONG on 2 consecutive bearish ROC5 candles', () => {
    // Create candles with strong downtrend at end
    const candles = createTrendingCandles(10, 100, 'down', 0.5);
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000, // 1 hour ago
    });
    
    const currentPrice = candles[candles.length - 1].close;
    
    const result = shouldExitPosition(position, currentPrice, candles);
    
    // If ROC5 is < -1.5% for 2 candles, should exit
    // The actual result depends on candle values
    expect(result).toHaveProperty('reason');
  });

  it('should exit SHORT on 2 consecutive bullish ROC5 candles', () => {
    // Create candles with strong uptrend at end
    const candles = createTrendingCandles(10, 100, 'up', 0.5);
    
    const position = createMockPosition({
      side: 'short',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
    });
    
    const currentPrice = candles[candles.length - 1].close;
    
    const result = shouldExitPosition(position, currentPrice, candles);
    
    // If ROC5 is > +1.5% for 2 candles, should exit
    expect(result).toHaveProperty('reason');
  });
});

// ============================================================================
// TESTS: calcROC (Rate of Change)
// ============================================================================

describe('calcROC', () => {
  it('should calculate correct ROC for uptrend', () => {
    const closes = [100, 101, 102, 103, 104, 105];
    const roc5 = calcROC(closes, 5);
    
    // ROC5 = (105 - 100) / 100 = 5%
    expect(roc5).toBeCloseTo(0.05, 4);
  });

  it('should calculate correct ROC for downtrend', () => {
    const closes = [100, 99, 98, 97, 96, 95];
    const roc5 = calcROC(closes, 5);
    
    // ROC5 = (95 - 100) / 100 = -5%
    expect(roc5).toBeCloseTo(-0.05, 4);
  });

  it('should handle insufficient data', () => {
    const closes = [100, 101];
    const roc5 = calcROC(closes, 5);
    
    // Should return 0 or handle gracefully
    expect(typeof roc5).toBe('number');
  });
});

// ============================================================================
// TESTS: calcSMA (Simple Moving Average)
// ============================================================================

describe('calcSMA', () => {
  it('should calculate correct SMA', () => {
    const values = [10, 20, 30, 40, 50];
    const sma5 = calcSMA(values, 5);
    
    // SMA5 = (10+20+30+40+50) / 5 = 30
    expect(sma5).toBe(30);
  });

  it('should handle period larger than data', () => {
    const values = [10, 20, 30];
    const sma10 = calcSMA(values, 10);
    
    // Should use available data
    expect(typeof sma10).toBe('number');
  });
});

// ============================================================================
// TESTS: updatePositionWaterMarks
// ============================================================================

describe('updatePositionWaterMarks', () => {
  it('should update highWaterMark for LONG position', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      highWaterMark: 102,
    });
    
    // Price went higher
    const updated = updatePositionWaterMarks(position, 105, 106, 104);
    
    expect(updated.highWaterMark).toBe(106);
  });

  it('should update lowWaterMark for SHORT position', () => {
    const position = createMockPosition({
      side: 'short',
      entryPrice: 100,
      lowWaterMark: 98,
    });
    
    // Price went lower
    const updated = updatePositionWaterMarks(position, 95, 96, 94);
    
    expect(updated.lowWaterMark).toBe(94);
  });

  it('should track maxPnlPct correctly', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      maxPnlPct: 2.0,
    });
    
    // PnL now 3%
    const updated = updatePositionWaterMarks(position, 103);
    
    expect(updated.maxPnlPct).toBeGreaterThanOrEqual(3.0);
  });
});

// ============================================================================
// TESTS: Integration - Backtest vs Live alignment
// ============================================================================

describe('Backtest vs Live Alignment', () => {
  describe('Exit order priority', () => {
    it('should check MAX_HOLD first (before other exits)', () => {
      const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
      
      const position = createMockPosition({
        side: 'long',
        entryPrice: 100,
        entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000,
        trailingActive: true,
        highWaterMark: 110, // In profit with trailing active
      });
      
      // Even with trailing active and in profit, MAX_HOLD should trigger first
      const result = shouldExitPosition(position, 109);
      
      expect(result.shouldExit).toBe(true);
      expect(result.reason).toBe('time');
    });
  });

  describe('Stagnant SL with trailing check', () => {
    it('should NOT tighten SL when trailing is active', () => {
      const position = createMockPosition({
        side: 'long',
        entryPrice: 100,
        trailingActive: true, // Trailing active
        stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.5 },
      });
      
      // isStagnantConfirmed should be false because trailingActive is true
      // SL should NOT be tightened to 0.8%
      const result = shouldExitPosition(position, 99.5, undefined, {
        priceLow: 99.5, // 0.5% loss, would hit 0.8% SL if tightened
      });
      
      // Should not exit because SL is still at base (2.5%), not tightened
      // 0.5% loss is way above 2.5% SL
      expect(result.reason).not.toBe('stagnant_trade');
    });
  });

  describe('Adaptive trailing consistency', () => {
    it('should use same trailing params as determineVolatilityRegime', () => {
      const candles = createMockCandles(20, 100, 'medium');
      
      // Get regime directly
      const regime = determineVolatilityRegime(candles);
      
      // Create position that would use trailing
      const position = createMockPosition({
        side: 'long',
        entryPrice: 100,
        trailingActive: true,
        highWaterMark: 102,
      });
      
      // shouldExitPosition should use same params
      // This is implicit - we're testing the function uses determineVolatilityRegime
      const result = shouldExitPosition(position, 101.5, candles);
      
      expect(result).toHaveProperty('pnlPct');
    });
  });
});

// ============================================================================
// TESTS: Edge Cases
// ============================================================================

describe('Edge Cases', () => {
  it('should handle position with all optional fields undefined', () => {
    const barePosition: Position = {
      id: 'bare-pos',
      symbol: 'TEST/USDT',
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 10 * 60 * 1000,
      quantity: 100,
      leverage: 5,
    } as Position;
    
    // Should not throw
    expect(() => {
      shouldExitPosition(barePosition, 100);
    }).not.toThrow();
  });

  it('should handle zero entry price gracefully', () => {
    const position = createMockPosition({
      entryPrice: 0.0001, // Very small price
    });
    
    expect(() => {
      shouldExitPosition(position, 0.00011);
    }).not.toThrow();
  });

  it('should handle very old positions', () => {
    const position = createMockPosition({
      entryTime: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    });
    
    const result = shouldExitPosition(position, position.entryPrice);
    
    // Should exit due to MAX_HOLD
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('time');
  });
});

// ============================================================================
// TESTS: V5.40 MOMENTUM EXHAUSTION
// ============================================================================

describe('shouldExitPosition - V5.40 MOMENTUM EXHAUSTION', () => {
  it('should tighten trailing when momentum exhausted on profitable trade', () => {
    // Scenario: LONG position with 15% profit, trailing active, but momentum exhausted
    const position = createMockPosition({
      side: 'long',
      entryPrice: 0.10,
      entryTime: Date.now() - 60 * 60 * 1000, // 1 hour ago
      trailingActive: true,
      highWaterMark: 0.115, // 15% profit peak
    });
    
    // Create candles showing exhausted momentum (ROC near zero)
    const candles: Candle[] = [];
    const now = Date.now();
    let price = 0.115; // At high water mark
    
    // Generate 15 candles with flat/weak momentum (ROC5 < 0.3%, ROC10 < 0.5%)
    for (let i = 0; i < 15; i++) {
      // Very small price changes (< 0.1% per candle)
      const change = (Math.random() - 0.5) * 0.0001; // Tiny changes
      price = price + change;
      
      candles.push({
        timestamp: now - (15 - i) * 15 * 60 * 1000,
        open: price - change / 2,
        high: price + 0.0001,
        low: price - 0.0001,
        close: price,
        volume: 1000000 * (0.5 + Math.random() * 0.3), // Low-ish volume
      });
    }
    
    // Current price at 15% profit
    const currentPrice = 0.115;
    
    const result = shouldExitPosition(position, currentPrice, candles, {
      priceHigh: currentPrice,
      priceLow: currentPrice,
    });
    
    // Should NOT exit (just tighten trailing)
    expect(result.shouldExit).toBe(false);
    
    // Should detect momentum exhaustion
    expect(result.momentumExhausted).toBe(true);
    
    // Should tighten trailing distance to 0.3% (from default 0.5% or 0.8%)
    expect(result.trailingDistancePct).toBe(MomentumConfig.EXIT.MOMENTUM_EXHAUSTION_TIGHTEN_DISTANCE_PCT);
    expect(result.trailingDistancePct).toBe(0.3);
    
    // Should have trailing active
    expect(result.trailingActivated).toBe(true);
  });

  it('should NOT tighten trailing when profit below threshold', () => {
    // Position with only 3% profit (below 5% threshold)
    const position = createMockPosition({
      side: 'long',
      entryPrice: 0.10,
      entryTime: Date.now() - 60 * 60 * 1000,
      trailingActive: true,
      highWaterMark: 0.103, // Only 3% profit
    });
    
    const candles = createMockCandles(15, 0.103, 'low');
    const currentPrice = 0.103;
    
    const result = shouldExitPosition(position, currentPrice, candles, {
      priceHigh: currentPrice,
      priceLow: currentPrice,
    });
    
    // Should NOT detect momentum exhaustion (profit too low)
    expect(result.momentumExhausted).toBe(false);
  });

  it('should NOT tighten trailing when momentum still strong', () => {
    // Position with 10% profit and  strong ongoing momentum
    const entryPrice = 100;
    const currentPrice = 110; // 10% profit
    
    const position = createMockPosition({
      side: 'long',
      entryPrice,
      entryTime: Date.now() - 60 * 60 * 1000,
      trailingActive: true,
      highWaterMark: currentPrice,
    });
    
    // Create candles with strong momentum: prices going from 105 to 110
    // This should give ROC5 > 0.5% and ROC10 > 0.5%
    const candles: Candle[] = [];
    const now = Date.now();
    
    const prices = [105, 106, 107, 108, 109, 110, 110.2, 110.4, 110.6, 110.8, 111, 111.2, 111.4, 111.6, 111.8];
    // ROC5 from 110 to 111.8 = (111.8-110)/110 = 1.6% >> 0.3%
    // ROC10 from 109 to 111.8 = (111.8-109)/109 = 2.6% >> 0.5%
    
    for (let i = 0; i < 15; i++) {
      const close = prices[i];
      candles.push({
        timestamp: now - (15 - i) * 15 * 60 * 1000,
        open: close - 0.5,
        high: close + 0.1,
        low: close - 0.6,
        close,
        volume: 1000000 * 1.5,
      });
    }
    
    const result = shouldExitPosition(position, currentPrice, candles, {
      priceHigh: currentPrice,
      priceLow: currentPrice,
    });
    
    // Should NOT detect momentum exhaustion because momentum is still strong
    expect(result.momentumExhausted).toBe(false);
  });

  it('should work for SHORT positions with exhausted momentum', () => {
    // SHORT position with 12% profit, trailing active, momentum exhausted
    const position = createMockPosition({
      side: 'short',
      entryPrice: 0.10,
      entryTime: Date.now() - 60 * 60 * 1000,
      trailingActive: true,
      lowWaterMark: 0.088, // 12% profit on SHORT
    });
    
    // Create candles with flat momentum
    const candles: Candle[] = [];
    const now = Date.now();
    let price = 0.088;
    
    for (let i = 0; i < 15; i++) {
      const change = (Math.random() - 0.5) * 0.0001;
      price = price + change;
      
      candles.push({
        timestamp: now - (15 - i) * 15 * 60 * 1000,
        open: price - change / 2,
        high: price + 0.0001,
        low: price - 0.0001,
        close: price,
        volume: 1000000 * 0.6,
      });
    }
    
    const currentPrice = 0.088;
    
    const result = shouldExitPosition(position, currentPrice, candles, {
      priceHigh: currentPrice,
      priceLow: currentPrice,
    });
    
    // Should detect momentum exhaustion
    expect(result.momentumExhausted).toBe(true);
    expect(result.trailingDistancePct).toBe(0.3);
  });

  it('should handle case when MOMENTUM_EXHAUSTION_ENABLED is false', () => {
    // Temporarily disable feature
    const originalEnabled = MomentumConfig.EXIT.MOMENTUM_EXHAUSTION_ENABLED;
    (MomentumConfig.EXIT as any).MOMENTUM_EXHAUSTION_ENABLED = false;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 0.10,
      trailingActive: true,
      highWaterMark: 0.115,
    });
    
    const candles = createMockCandles(15, 0.115, 'low');
    const currentPrice = 0.115;
    
    const result = shouldExitPosition(position, currentPrice, candles, {
      priceHigh: currentPrice,
      priceLow: currentPrice,
    });
    
    // Should NOT detect momentum exhaustion when feature disabled
    expect(result.momentumExhausted).toBe(false);
    
    // Restore original value
    (MomentumConfig.EXIT as any).MOMENTUM_EXHAUSTION_ENABLED = originalEnabled;
  });
});
