/**
 * 🧪 Direct Test Runner for Exit Logic
 * Run with: npx tsx test/run-exit-tests.ts
 */

import {
  shouldExitPosition,
  determineVolatilityRegime,
  calcATR,
  updatePositionWaterMarks,
  MomentumConfig,
} from '../src/strategies/momentumSimple.js';
import type { Position, Candle } from '../src/types.js';

// Local helper functions (mirrors internal ones)
function calcROC(closes: number[], period: number = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return (current - past) / past;
}

function calcSMA(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ============================================================================
// TEST HELPERS
// ============================================================================

let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function assert(condition: boolean, message: string): void {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${message}`);
  } else {
    testsFailed++;
    console.log(`  ❌ ${message}`);
  }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
  testsRun++;
  if (Math.abs(actual - expected) <= tolerance) {
    testsPassed++;
    console.log(`  ✅ ${message} (${actual} ≈ ${expected})`);
  } else {
    testsFailed++;
    console.log(`  ❌ ${message} (got ${actual}, expected ${expected})`);
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n📦 ${name}`);
  fn();
}

function it(name: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    testsRun++;
    testsFailed++;
    console.log(`  ❌ ${name}: ${e}`);
  }
}

function createMockPosition(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'test-pos-1',
    symbol: 'DOGE/USDT:USDT',
    side: 'long',
    entryPrice: 0.10,
    entryTime: now - 30 * 60 * 1000,
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

function createMockCandles(count: number, basePrice: number = 100): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  
  for (let i = 0; i < count; i++) {
    const close = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    candles.push({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      open: basePrice,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 1000000,
    });
    basePrice = close;
  }
  
  return candles;
}

// ============================================================================
// TESTS
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log('🧪 EXIT LOGIC ALIGNMENT TESTS');
console.log('════════════════════════════════════════════════════════════');

describe('calcROC (Rate of Change)', () => {
  it('should calculate correct ROC for uptrend', () => {
    const closes = [100, 101, 102, 103, 104, 105];
    const roc5 = calcROC(closes, 5);
    assertClose(roc5, 0.05, 0.001, 'ROC5 uptrend = 5%');
  });

  it('should calculate correct ROC for downtrend', () => {
    const closes = [100, 99, 98, 97, 96, 95];
    const roc5 = calcROC(closes, 5);
    assertClose(roc5, -0.05, 0.001, 'ROC5 downtrend = -5%');
  });

  it('should handle flat prices', () => {
    const closes = [100, 100, 100, 100, 100, 100];
    const roc5 = calcROC(closes, 5);
    assertClose(roc5, 0, 0.001, 'ROC5 flat = 0%');
  });
});

describe('calcSMA (Simple Moving Average)', () => {
  it('should calculate correct SMA', () => {
    const values = [10, 20, 30, 40, 50];
    const sma5 = calcSMA(values, 5);
    assert(sma5 === 30, 'SMA5 of [10,20,30,40,50] = 30');
  });

  it('should use last N values', () => {
    const values = [1, 2, 10, 20, 30, 40, 50];
    const sma5 = calcSMA(values, 5);
    assert(sma5 === 30, 'SMA5 uses last 5 values');
  });
});

describe('determineVolatilityRegime', () => {
  it('should return valid regime object', () => {
    const candles = createMockCandles(20, 100);
    const result = determineVolatilityRegime(candles);
    
    assert(['LOW', 'MEDIUM', 'HIGH'].includes(result.regime), 'Regime is LOW/MEDIUM/HIGH');
    assert(typeof result.trailingDistance === 'number', 'trailingDistance is number');
    assert(typeof result.trailingActivation === 'number', 'trailingActivation is number');
    assert(typeof result.reason === 'string', 'reason is string');
  });

  it('should handle empty candles', () => {
    const result = determineVolatilityRegime([]);
    assert(result.regime === 'MEDIUM', 'Empty candles → MEDIUM regime');
    assert(result.atrPct === null, 'Empty candles → null ATR');
  });
});

describe('shouldExitPosition - MAX_HOLD_TIME', () => {
  it('should exit when max hold exceeded', () => {
    const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
    const position = createMockPosition({
      entryTime: Date.now() - (maxHoldMinutes + 10) * 60 * 1000,
    });
    
    const result = shouldExitPosition(position, position.entryPrice);
    
    assert(result.shouldExit === true, 'Should exit when max hold exceeded');
    assert(result.reason === 'time', 'Exit reason is time');
  });

  it('should NOT exit before max hold', () => {
    const position = createMockPosition({
      entryTime: Date.now() - 30 * 60 * 1000, // 30 min ago
    });
    
    const result = shouldExitPosition(position, position.entryPrice * 1.005);
    
    assert(result.reason !== 'time', 'Should not exit for time before max hold');
  });
});

describe('shouldExitPosition - STOP_LOSS', () => {
  it('should trigger SL for LONG when price drops', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      stopLossPct: 2.5,
    });
    
    // Price dropped 3%
    const result = shouldExitPosition(position, 97, undefined, { priceLow: 97 });
    
    assert(result.shouldExit === true, 'Should exit on SL breach');
    assert(result.reason === 'stoploss', 'Exit reason is stoploss');
  });

  it('should trigger SL for SHORT when price rises', () => {
    const position = createMockPosition({
      side: 'short',
      entryPrice: 100,
      stopLossPct: 2.5,
    });
    
    // Price rose 3%
    const result = shouldExitPosition(position, 103, undefined, { priceHigh: 103 });
    
    assert(result.shouldExit === true, 'Should exit on SL breach (SHORT)');
    assert(result.reason === 'stoploss', 'Exit reason is stoploss');
  });

  it('should NOT trigger SL when price within threshold', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      stopLossPct: 2.5,
    });
    
    // Price dropped only 1%
    const result = shouldExitPosition(position, 99, undefined, { priceLow: 99 });
    
    assert(result.reason !== 'stoploss', 'Should not exit when above SL');
  });
});

describe('shouldExitPosition - TRAILING_STOP', () => {
  it('should return trailingBreached when trailing stop hit', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 105,
    });
    
    // Price fell below trailing stop
    const trailDist = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
    const trailStop = 105 * (1 - trailDist / 100);
    
    const result = shouldExitPosition(position, trailStop - 1, undefined, {
      priceLow: trailStop - 1,
    });
    
    assert(result.trailingBreached === true, 'trailingBreached should be true');
  });
});

describe('shouldExitPosition - STAGNANT_TRADE', () => {
  it('should NOT process stagnant when trailing is active', () => {
    const stagnantTimeMin = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - (stagnantTimeMin + 5) * 60 * 1000,
      maxPnlPct: 0.3,
      trailingActive: true, // TRAILING IS ACTIVE
      stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
    });
    
    shouldExitPosition(position, 100.5);
    
    assert(position.stagnantState.triggered === false, 'Stagnant should NOT trigger when trailing active');
  });

  it('should tighten SL when stagnant confirmed AND trailing NOT active', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      stopLossPct: 2.5,
      trailingActive: false, // Trailing NOT active
      stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
    });
    
    // Price dropped 1% (below 0.8% tightened SL, but above 2.5% base SL)
    const result = shouldExitPosition(position, 99, undefined, { priceLow: 99 });
    
    assert(result.shouldExit === true, 'Should exit on tightened SL');
    assert(result.reason === 'stagnant_trade', 'Exit reason is stagnant_trade');
  });

  it('should NOT tighten SL when stagnant confirmed BUT trailing IS active', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      stopLossPct: 2.5,
      trailingActive: true, // Trailing IS active
      stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
    });
    
    // Price dropped 1% (would hit 0.8% tightened SL if applied)
    const result = shouldExitPosition(position, 99, undefined, { priceLow: 99 });
    
    assert(result.reason !== 'stagnant_trade', 'Should NOT exit on stagnant_trade when trailing active');
  });
});

describe('shouldExitPosition - Adaptive Trailing', () => {
  it('should use volatility regime for trailing params', () => {
    const candles = createMockCandles(20, 100);
    const regime = determineVolatilityRegime(candles);
    
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 102,
    });
    
    // Just verify it doesn't crash with candles
    const result = shouldExitPosition(position, 101, candles);
    
    assert(typeof result.pnlPct === 'number', 'Should return valid pnlPct');
    console.log(`    📊 Volatility Regime: ${regime.regime}, TrailDist: ${regime.trailingDistance}%`);
  });
});

describe('updatePositionWaterMarks', () => {
  it('should update highWaterMark for LONG', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      highWaterMark: 102,
    });
    
    const updated = updatePositionWaterMarks(position, 105, 106, 104);
    
    assert(updated.highWaterMark === 106, 'highWaterMark updated to 106');
  });

  it('should update lowWaterMark for SHORT', () => {
    const position = createMockPosition({
      side: 'short',
      entryPrice: 100,
      lowWaterMark: 98,
    });
    
    const updated = updatePositionWaterMarks(position, 95, 96, 94);
    
    assert(updated.lowWaterMark === 94, 'lowWaterMark updated to 94');
  });

  it('should track maxPnlPct', () => {
    const position = createMockPosition({
      side: 'long',
      entryPrice: 100,
      maxPnlPct: 2.0,
    });
    
    const updated = updatePositionWaterMarks(position, 103);
    
    assert(updated.maxPnlPct! >= 3.0, 'maxPnlPct updated to 3%+');
  });
});

describe('Edge Cases', () => {
  it('should handle position with minimal fields', () => {
    const barePosition = {
      id: 'bare-pos',
      symbol: 'TEST/USDT',
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 10 * 60 * 1000,
      quantity: 100,
      leverage: 5,
    } as Position;
    
    let threw = false;
    try {
      shouldExitPosition(barePosition, 100);
    } catch (e) {
      threw = true;
    }
    
    assert(!threw, 'Should not throw with minimal position');
  });

  it('should exit very old positions (30 days)', () => {
    const position = createMockPosition({
      entryTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    
    const result = shouldExitPosition(position, position.entryPrice);
    
    assert(result.shouldExit === true, 'Should exit old position');
    assert(result.reason === 'time', 'Exit reason is time');
  });
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log(`📊 RESULTS: ${testsPassed}/${testsRun} passed, ${testsFailed} failed`);
console.log('════════════════════════════════════════════════════════════');

if (testsFailed > 0) {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
  process.exit(0);
}
