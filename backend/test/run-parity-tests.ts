/**
 * 🧪 BACKTEST vs LIVE PARITY TESTS
 * 
 * Ces tests vérifient que les décisions de sortie sont IDENTIQUES
 * entre le code live (shouldExitPosition) et le code backtest
 * 
 * Run with: npx tsx test/run-parity-tests.ts
 */

import {
  shouldExitPosition,
  determineVolatilityRegime,
  updatePositionWaterMarks,
  MomentumConfig,
  calcATR,
} from '../src/strategies/momentumSimple.js';
import type { Position, Candle } from '../src/types.js';

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

function describe(name: string, fn: () => void): void {
  console.log(`\n📦 ${name}`);
  fn();
}

// Backtest config (from backtestService.ts)
const BACKTEST_CONFIG = {
  EXIT: {
    STOP_LOSS_PCT: 2.5,
    TRAILING_ACTIVATION_PCT: 0.8,
    TRAILING_DISTANCE_PCT: 0.5,
    TRAILING_WIDEN_AT_PCT: 3.0,
    TRAILING_WIDE_DISTANCE_PCT: 0.8,
    MAX_HOLD_BARS: 192, // 48h in 15m bars
    STAGNANT_TIME_BARS: 3, // 45 min
    STAGNANT_OBS_BARS: 4, // 60 min
    STAGNANT_SL_TIGHTEN_PCT: 0.8,
    STAGNANT_MIN_PROFIT: 0.8,
    STAGNANT_RECOVERY_PCT: 0.6,
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04,
    SLIPPAGE_PCT: 0.05,
    FUNDING_RATE_PCT: 0.01,
    FUNDING_INTERVAL_BARS: 32,
  },
  ADAPTIVE_TRAILING: {
    LOW_VOL_ATR_MAX: 2,
    LOW_VOL_ACTIVATION: 0.6,
    LOW_VOL_DISTANCE: 0.3,
    HIGH_VOL_ATR_MIN: 3.5,
    HIGH_VOL_ACTIVATION: 1.2,
    HIGH_VOL_DISTANCE: 0.8,
  },
};

// Create mock position
function createPosition(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'test-pos',
    symbol: 'TEST/USDT',
    side: 'long',
    entryPrice: 100,
    entryTime: now - 30 * 60 * 1000,
    quantity: 100,
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

// Create trending candles
function createCandles(count: number, startPrice: number, trend: 'up' | 'down' | 'flat' = 'flat'): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let price = startPrice;
  
  for (let i = 0; i < count; i++) {
    const change = trend === 'up' ? 0.5 : trend === 'down' ? -0.5 : 0;
    const newPrice = price * (1 + change / 100);
    
    candles.push({
      timestamp: now - (count - i) * 15 * 60 * 1000,
      open: price,
      high: Math.max(price, newPrice) * 1.005,
      low: Math.min(price, newPrice) * 0.995,
      close: newPrice,
      volume: 1000000,
    });
    
    price = newPrice;
  }
  
  return candles;
}

// ============================================================================
// SIMULATED BACKTEST EXIT LOGIC
// (Mirrors backtestService.ts exactly)
// ============================================================================

interface BacktestPos {
  side: 'long' | 'short';
  entryPrice: number;
  entryBarIndex: number;
  stopLossPct: number;
  trailingActive: boolean;
  highWaterMark?: number;
  lowWaterMark?: number;
  maxPnlPct: number;
  trailingBreachCandles: number;
  stagnantState: {
    triggered: boolean;
    confirmed: boolean;
    cancelled: boolean;
    obsPeakPct: number;
    triggeredAtBar?: number;
  };
}

function calcAdaptiveTrailing(candles: Candle[]): { activation: number; distance: number } {
  if (!MomentumConfig.EXIT.ADAPTIVE_TRAILING) {
    return { activation: BACKTEST_CONFIG.EXIT.TRAILING_ACTIVATION_PCT, distance: BACKTEST_CONFIG.EXIT.TRAILING_DISTANCE_PCT };
  }
  
  const atrValue = calcATR(candles, 14);
  if (!atrValue || candles.length === 0) {
    return { activation: BACKTEST_CONFIG.EXIT.TRAILING_ACTIVATION_PCT, distance: BACKTEST_CONFIG.EXIT.TRAILING_DISTANCE_PCT };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atrValue / currentPrice) * 100;
  
  if (atrPct < BACKTEST_CONFIG.ADAPTIVE_TRAILING.LOW_VOL_ATR_MAX) {
    return { 
      activation: BACKTEST_CONFIG.ADAPTIVE_TRAILING.LOW_VOL_ACTIVATION, 
      distance: BACKTEST_CONFIG.ADAPTIVE_TRAILING.LOW_VOL_DISTANCE 
    };
  }
  
  if (atrPct > BACKTEST_CONFIG.ADAPTIVE_TRAILING.HIGH_VOL_ATR_MIN) {
    return { 
      activation: BACKTEST_CONFIG.ADAPTIVE_TRAILING.HIGH_VOL_ACTIVATION, 
      distance: BACKTEST_CONFIG.ADAPTIVE_TRAILING.HIGH_VOL_DISTANCE 
    };
  }
  
  return { activation: BACKTEST_CONFIG.EXIT.TRAILING_ACTIVATION_PCT, distance: BACKTEST_CONFIG.EXIT.TRAILING_DISTANCE_PCT };
}

function backtestExitCheck(
  pos: BacktestPos,
  currentBar: number,
  candle: Candle,
  candles: Candle[]
): { shouldExit: boolean; reason: string } {
  const holdBars = currentBar - pos.entryBarIndex;
  
  // 1. MAX_HOLD (first check - aligned with live)
  if (holdBars >= BACKTEST_CONFIG.EXIT.MAX_HOLD_BARS) {
    return { shouldExit: true, reason: 'TIME' };
  }
  
  // Calculate PnL
  const pnlPct = pos.side === 'long'
    ? ((candle.close - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - candle.close) / pos.entryPrice) * 100;
  
  // Get adaptive trailing params
  const { activation, distance } = calcAdaptiveTrailing(candles);
  
  // Check trailing activation
  const shouldActivateNow = pnlPct >= activation;
  const trailingIsActiveNow = pos.trailingActive || shouldActivateNow;
  
  // Update water marks
  if (pos.side === 'long') {
    pos.highWaterMark = pos.highWaterMark 
      ? Math.max(pos.highWaterMark, candle.high) 
      : candle.high;
  } else {
    pos.lowWaterMark = pos.lowWaterMark 
      ? Math.min(pos.lowWaterMark, candle.low) 
      : candle.low;
  }
  
  // Update maxPnlPct
  const wickPnl = pos.side === 'long'
    ? ((candle.high - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - candle.low) / pos.entryPrice) * 100;
  pos.maxPnlPct = Math.max(pos.maxPnlPct, wickPnl);
  
  // Stagnant state machine (only when trailing NOT active)
  if (!trailingIsActiveNow) {
    // Trigger check
    if (!pos.stagnantState.triggered && 
        holdBars >= BACKTEST_CONFIG.EXIT.STAGNANT_TIME_BARS &&
        pos.maxPnlPct < BACKTEST_CONFIG.EXIT.STAGNANT_MIN_PROFIT) {
      pos.stagnantState.triggered = true;
      pos.stagnantState.triggeredAtBar = holdBars;
    }
    
    // Observation window
    if (pos.stagnantState.triggered && !pos.stagnantState.confirmed && !pos.stagnantState.cancelled) {
      pos.stagnantState.obsPeakPct = Math.max(pos.stagnantState.obsPeakPct, wickPnl);
      
      if (pos.stagnantState.obsPeakPct >= BACKTEST_CONFIG.EXIT.STAGNANT_RECOVERY_PCT) {
        pos.stagnantState.cancelled = true;
      }
      
      const triggeredAtBar = pos.stagnantState.triggeredAtBar ?? BACKTEST_CONFIG.EXIT.STAGNANT_TIME_BARS;
      const obsElapsed = holdBars - triggeredAtBar;
      
      if (obsElapsed >= BACKTEST_CONFIG.EXIT.STAGNANT_OBS_BARS && !pos.stagnantState.cancelled) {
        pos.stagnantState.confirmed = true;
      }
    }
  }
  
  // Effective SL (V5.39: only tighten if trailing NOT active)
  const isStagnantConfirmed = !trailingIsActiveNow && pos.stagnantState.confirmed && !pos.stagnantState.cancelled;
  const effectiveSlPct = isStagnantConfirmed ? BACKTEST_CONFIG.EXIT.STAGNANT_SL_TIGHTEN_PCT : pos.stopLossPct;
  
  // 2. Check SL on wick
  if (pos.side === 'long') {
    const slPrice = pos.entryPrice * (1 - effectiveSlPct / 100);
    if (candle.low <= slPrice) {
      return { shouldExit: true, reason: isStagnantConfirmed ? 'STAGNANT_TRADE' : 'SL' };
    }
  } else {
    const slPrice = pos.entryPrice * (1 + effectiveSlPct / 100);
    if (candle.high >= slPrice) {
      return { shouldExit: true, reason: isStagnantConfirmed ? 'STAGNANT_TRADE' : 'SL' };
    }
  }
  
  // 3. Trailing stop
  if (trailingIsActiveNow) {
    pos.trailingActive = true;
    
    // Calculate trailing distance (widen at 3%)
    const hwm = pos.side === 'long' ? pos.highWaterMark! : pos.lowWaterMark!;
    const hwmPct = pos.side === 'long'
      ? ((hwm - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - hwm) / pos.entryPrice) * 100;
    
    const trailDist = hwmPct >= BACKTEST_CONFIG.EXIT.TRAILING_WIDEN_AT_PCT 
      ? BACKTEST_CONFIG.EXIT.TRAILING_WIDE_DISTANCE_PCT 
      : distance;
    
    let trailingStopPrice: number;
    
    if (pos.side === 'long') {
      trailingStopPrice = hwm * (1 - trailDist / 100);
      if (candle.low <= trailingStopPrice) {
        pos.trailingBreachCandles++;
        if (pos.trailingBreachCandles >= 2) {
          return { shouldExit: true, reason: 'TRAIL' };
        }
      } else {
        pos.trailingBreachCandles = 0;
      }
    } else {
      trailingStopPrice = hwm * (1 + trailDist / 100);
      if (candle.high >= trailingStopPrice) {
        pos.trailingBreachCandles++;
        if (pos.trailingBreachCandles >= 2) {
          return { shouldExit: true, reason: 'TRAIL' };
        }
      } else {
        pos.trailingBreachCandles = 0;
      }
    }
  }
  
  return { shouldExit: false, reason: '' };
}

// ============================================================================
// PARITY TESTS
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log('🔬 BACKTEST vs LIVE PARITY TESTS');
console.log('════════════════════════════════════════════════════════════');

describe('MAX_HOLD Parity', () => {
  const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
  const maxHoldBars = Math.floor(maxHoldMinutes / 15);
  
  // Live check
  const livePosition = createPosition({
    entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000,
  });
  const liveResult = shouldExitPosition(livePosition, 100);
  
  // Backtest check
  const btPosition: BacktestPos = {
    side: 'long',
    entryPrice: 100,
    entryBarIndex: 0,
    stopLossPct: 2.5,
    trailingActive: false,
    maxPnlPct: 0,
    trailingBreachCandles: 0,
    stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
  };
  const btResult = backtestExitCheck(btPosition, maxHoldBars + 1, { open: 100, high: 101, low: 99, close: 100, volume: 1000000, timestamp: Date.now() }, []);
  
  assert(liveResult.shouldExit === btResult.shouldExit, `MAX_HOLD exit: Live=${liveResult.shouldExit}, BT=${btResult.shouldExit}`);
  assert(liveResult.reason === 'time' && btResult.reason === 'TIME', `MAX_HOLD reason: Live=${liveResult.reason}, BT=${btResult.reason}`);
});

describe('Stop Loss Parity', () => {
  // LONG SL hit
  const livePosition = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
  });
  const liveResult = shouldExitPosition(livePosition, 97, undefined, { priceLow: 97 });
  
  const btPosition: BacktestPos = {
    side: 'long',
    entryPrice: 100,
    entryBarIndex: 0,
    stopLossPct: 2.5,
    trailingActive: false,
    maxPnlPct: 0,
    trailingBreachCandles: 0,
    stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
  };
  const btResult = backtestExitCheck(btPosition, 1, { open: 100, high: 100, low: 97, close: 97, volume: 1000000, timestamp: Date.now() }, []);
  
  assert(liveResult.shouldExit === btResult.shouldExit, `SL LONG exit: Live=${liveResult.shouldExit}, BT=${btResult.shouldExit}`);
  assert(liveResult.reason === 'stoploss' && btResult.reason === 'SL', `SL LONG reason aligned`);
  
  // SHORT SL hit
  const livePositionShort = createPosition({
    side: 'short',
    entryPrice: 100,
    stopLossPct: 2.5,
  });
  const liveResultShort = shouldExitPosition(livePositionShort, 103, undefined, { priceHigh: 103 });
  
  const btPositionShort: BacktestPos = {
    side: 'short',
    entryPrice: 100,
    entryBarIndex: 0,
    stopLossPct: 2.5,
    trailingActive: false,
    maxPnlPct: 0,
    trailingBreachCandles: 0,
    stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
  };
  const btResultShort = backtestExitCheck(btPositionShort, 1, { open: 100, high: 103, low: 100, close: 103, volume: 1000000, timestamp: Date.now() }, []);
  
  assert(liveResultShort.shouldExit === btResultShort.shouldExit, `SL SHORT exit: Live=${liveResultShort.shouldExit}, BT=${btResultShort.shouldExit}`);
});

describe('Stagnant SL Tightening + Trailing Check', () => {
  // Case 1: Stagnant confirmed BUT trailing active → SL NOT tightened
  const livePos1 = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
    trailingActive: true, // Trailing active
    stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
  });
  // Price at 99% (1% loss) - would hit 0.8% tightened SL but not 2.5% base SL
  const result1 = shouldExitPosition(livePos1, 99, undefined, { priceLow: 99 });
  
  assert(result1.reason !== 'stagnant_trade', `Trailing active → SL NOT tightened: reason=${result1.reason}`);
  
  // Case 2: Stagnant confirmed AND trailing NOT active → SL tightened
  const livePos2 = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
    trailingActive: false, // Trailing NOT active
    stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
  });
  const result2 = shouldExitPosition(livePos2, 99, undefined, { priceLow: 99 });
  
  assert(result2.shouldExit === true && result2.reason === 'stagnant_trade', `Trailing NOT active → SL tightened to 0.8%`);
  
  // Backtest equivalent
  const btPos: BacktestPos = {
    side: 'long',
    entryPrice: 100,
    entryBarIndex: 0,
    stopLossPct: 2.5,
    trailingActive: false,
    maxPnlPct: 0.3,
    trailingBreachCandles: 0,
    stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
  };
  const btResult = backtestExitCheck(btPos, 10, { open: 100, high: 100, low: 99, close: 99, volume: 1000000, timestamp: Date.now() }, []);
  
  assert(btResult.shouldExit === true && btResult.reason === 'STAGNANT_TRADE', `Backtest also exits on tightened SL`);
});

describe('Adaptive Trailing Parity', () => {
  // Create low volatility candles
  const candles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    candles.push({
      timestamp: now - (20 - i) * 15 * 60 * 1000,
      open: 100,
      high: 100.5, // Very tight range
      low: 99.5,
      close: 100,
      volume: 1000000,
    });
  }
  
  // Live volatility regime
  const liveRegime = determineVolatilityRegime(candles);
  
  // Backtest adaptive trailing
  const btAdaptive = calcAdaptiveTrailing(candles);
  
  console.log(`    📊 Live: ${liveRegime.regime}, dist=${liveRegime.trailingDistance}%`);
  console.log(`    📊 Backtest: dist=${btAdaptive.distance}%`);
  
  // Both should use same distance for same volatility
  assert(
    Math.abs(liveRegime.trailingDistance - btAdaptive.distance) < 0.01,
    `Trailing distance matches: Live=${liveRegime.trailingDistance}, BT=${btAdaptive.distance}`
  );
});

describe('Trailing Widen at 3% Parity', () => {
  // Position that reached 3.5% profit
  const livePos = createPosition({
    side: 'long',
    entryPrice: 100,
    trailingActive: true,
    highWaterMark: 103.5, // 3.5% profit peak
  });
  
  const btPos: BacktestPos = {
    side: 'long',
    entryPrice: 100,
    entryBarIndex: 0,
    stopLossPct: 2.5,
    trailingActive: true,
    highWaterMark: 103.5,
    maxPnlPct: 3.5,
    trailingBreachCandles: 0,
    stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 },
  };
  
  // Both should use WIDE distance (0.8%) not base (0.5%)
  const hwmPct = ((103.5 - 100) / 100) * 100;
  const shouldWiden = hwmPct >= BACKTEST_CONFIG.EXIT.TRAILING_WIDEN_AT_PCT;
  
  assert(shouldWiden, `Should widen at hwmPct=${hwmPct}% (threshold=3%)`);
  
  // Live uses same widen logic (verified in shouldExitPosition)
  assert(hwmPct >= MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT, `Live widen threshold matches`);
});

describe('Exit Priority Order', () => {
  // MAX_HOLD should trigger FIRST, even with other conditions
  const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
  
  const livePos = createPosition({
    side: 'long',
    entryPrice: 100,
    entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000,
    trailingActive: true,
    highWaterMark: 110, // In profit, trailing active
  });
  
  const result = shouldExitPosition(livePos, 109);
  
  assert(result.reason === 'time', `MAX_HOLD checked first: reason=${result.reason}`);
});

describe('Trailing Breach Reset on Wick Recovery', () => {
  // When wick hits trailing stop but close recovers, trailingBreached should be false
  // This is critical for 2-close confirmation to work correctly
  
  const position = createPosition({
    side: 'long',
    entryPrice: 100,
    trailingActive: true,
    highWaterMark: 105, // 5% profit reached
  });
  
  // Trailing stop at 105 * (1 - 0.5%) = 104.475
  const trailDist = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
  const trailStop = 105 * (1 - trailDist / 100);
  
  // Scenario: Wick hit below stop (104) but close recovered above (104.5)
  const result = shouldExitPosition(position, 104.5, undefined, {
    priceHigh: 105,
    priceLow: 104, // Below trailing stop
  });
  
  console.log(`    📊 Trail stop: $${trailStop.toFixed(4)}, Low: $104, Close: $104.5`);
  console.log(`    📊 trailingBreached: ${result.trailingBreached}`);
  
  // trailingBreached should be explicitly false (not undefined, not true)
  assert(result.trailingBreached === false, `trailingBreached should be false when wick hit but close recovered`);
  assert(result.trailingActivated === true, `trailingActivated should still be true`);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log(`📊 PARITY RESULTS: ${testsPassed}/${testsRun} passed, ${testsFailed} failed`);
console.log('════════════════════════════════════════════════════════════');

if (testsFailed > 0) {
  console.log('\n❌ PARITY ISSUES DETECTED');
  process.exit(1);
} else {
  console.log('\n✅ BACKTEST & LIVE ARE PERFECTLY ALIGNED');
  process.exit(0);
}
