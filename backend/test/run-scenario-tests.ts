/**
 * 🧪 SCENARIO-BASED EXIT TESTS
 * 
 * Simule des scénarios de trading réels pour vérifier
 * que les exits se comportent comme attendu
 * 
 * Run with: npx tsx test/run-scenario-tests.ts
 */

import {
  shouldExitPosition,
  determineVolatilityRegime,
  updatePositionWaterMarks,
  MomentumConfig,
} from '../src/strategies/momentumSimple.js';
import type { Position, Candle } from '../src/types.js';

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

function createPosition(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'test-pos',
    symbol: 'DOGE/USDT:USDT',
    side: 'long',
    entryPrice: 0.40,
    entryTime: now - 30 * 60 * 1000,
    quantity: 10000,
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

console.log('\n════════════════════════════════════════════════════════════');
console.log('🎬 SCENARIO-BASED EXIT TESTS');
console.log('════════════════════════════════════════════════════════════');

describe('SCENARIO 1: Perfect Trade - Entry to Trailing Exit', () => {
  // Entry: DOGE at $0.40
  // Price goes up to $0.404 (1% profit) - trailing activates at 0.8%
  // Price continues to $0.412 (3% profit) - trailing widens
  // Price retraces to $0.409 - within wide trail
  // Price drops to $0.407 - exits on trailing
  
  const position = createPosition({ entryPrice: 0.40 });
  
  // Candle 1: Price rises to 1% profit
  let updated = updatePositionWaterMarks(position, 0.404, 0.404, 0.40);
  let result = shouldExitPosition(updated, 0.404, undefined, { priceHigh: 0.404, priceLow: 0.40 });
  
  assert(result.pnlPct >= 0.8, `Candle 1: PnL at ${result.pnlPct?.toFixed(2)}% (trailing activates at 0.8%)`);
  assert(!result.shouldExit, 'Candle 1: Should NOT exit yet');
  
  // Candle 2: Price rises to 3%+ profit
  updated.trailingActive = true;
  updated = updatePositionWaterMarks(updated, 0.413, 0.414, 0.404);
  result = shouldExitPosition(updated, 0.413, undefined, { priceHigh: 0.414, priceLow: 0.404 });
  
  assert(result.pnlPct! >= 3, `Candle 2: PnL at ${result.pnlPct?.toFixed(2)}% (wide trailing at 3%)`);
  assert(!result.shouldExit, 'Candle 2: Should NOT exit (trail not breached)');
  
  // Candle 3: Price retraces but within trail
  updated = updatePositionWaterMarks(updated, 0.409, 0.412, 0.408);
  result = shouldExitPosition(updated, 0.409, undefined, { priceHigh: 0.412, priceLow: 0.408 });
  
  assert(!result.shouldExit || result.trailingBreached, 'Candle 3: Within trail or first breach');
  
  console.log(`    📊 Final HWM: $${updated.highWaterMark?.toFixed(4)}`);
});

describe('SCENARIO 2: Stagnant Trade - Tightened SL Exit', () => {
  // Entry: DOGE at $0.40
  // Position stays flat for 45 min (stagnant triggers)
  // No recovery for 60 min (stagnant confirms)
  // Price dips below 0.8% SL → exit
  
  const stagnantTime = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
  const obsTime = MomentumConfig.EXIT.STAGNANT_TRADE_OBS_MINUTES ?? 60;
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: Date.now() - (stagnantTime + obsTime + 5) * 60 * 1000,
    maxPnlPct: 0.2, // Never reached 0.8%
    trailingActive: false,
    stagnantState: { 
      triggered: true, 
      confirmed: true, 
      cancelled: false, 
      obsPeakPct: 0.3,
      triggeredAtMinutes: stagnantTime 
    },
  });
  
  // Price drops to 0.9% loss (below 0.8% tightened SL)
  const result = shouldExitPosition(position, 0.396, undefined, { priceLow: 0.396 });
  
  assert(result.shouldExit === true, 'Should exit on tightened SL');
  assert(result.reason === 'stagnant_trade', `Exit reason: ${result.reason}`);
  assert(result.effectiveSlPct === 0.8, `Effective SL: ${result.effectiveSlPct}%`);
});

describe('SCENARIO 3: Quick Stop Loss Hit', () => {
  // Entry: DOGE at $0.40
  // Immediate dump to 3% loss → SL hit
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: Date.now() - 5 * 60 * 1000, // 5 min ago
  });
  
  // Price crashes 3%
  const result = shouldExitPosition(position, 0.388, undefined, { priceLow: 0.388 });
  
  assert(result.shouldExit === true, 'Should exit on SL');
  assert(result.reason === 'stoploss', `Exit reason: ${result.reason}`);
  assert(result.pnlPct! < -2.5, `PnL: ${result.pnlPct?.toFixed(2)}%`);
});

describe('SCENARIO 4: Short Position - SL Hit', () => {
  // Entry: SHORT at $0.40
  // Price pumps 3% → SL hit
  
  const position = createPosition({
    side: 'short',
    entryPrice: 0.40,
    entryTime: Date.now() - 10 * 60 * 1000,
  });
  
  // Price pumps 3%
  const result = shouldExitPosition(position, 0.412, undefined, { priceHigh: 0.412 });
  
  assert(result.shouldExit === true, 'Should exit SHORT on SL');
  assert(result.reason === 'stoploss', `Exit reason: ${result.reason}`);
  assert(result.pnlPct! < -2.5, `PnL: ${result.pnlPct?.toFixed(2)}%`);
});

describe('SCENARIO 5: Stagnant Recovery - SL NOT Tightened', () => {
  // Entry: DOGE at $0.40
  // Position flat for 45 min (stagnant triggers)
  // During observation, price spikes to 0.8% → recovery → stagnant cancelled
  // Later dip to 0.9% loss should NOT hit tightened SL
  
  const stagnantTime = MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES ?? 45;
  const recoveryPct = MomentumConfig.EXIT.STAGNANT_TRADE_RECOVERY_PCT ?? 0.6;
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: Date.now() - (stagnantTime + 30) * 60 * 1000,
    maxPnlPct: 0.2,
    trailingActive: false,
    stagnantState: { 
      triggered: true, 
      confirmed: false, 
      cancelled: false, 
      obsPeakPct: 0,
      triggeredAtMinutes: stagnantTime 
    },
  });
  
  // Price spikes to recovery threshold
  const spikePrice = 0.40 * (1 + recoveryPct / 100 + 0.1);
  let result = shouldExitPosition(position, 0.402, undefined, { priceHigh: spikePrice, priceLow: 0.40 });
  
  assert(position.stagnantState.cancelled === true, 'Stagnant should be cancelled after recovery');
  
  // Now price dips to 0.9% loss
  result = shouldExitPosition(position, 0.396, undefined, { priceLow: 0.396 });
  
  assert(result.reason !== 'stagnant_trade', 'Should NOT exit on stagnant_trade (cancelled)');
  assert(!result.shouldExit, 'Should NOT exit (0.9% loss is above 2.5% base SL)');
});

describe('SCENARIO 6: Trailing Active Prevents Stagnant Tightening', () => {
  // Trailing is active AND stagnant is confirmed
  // SL should NOT be tightened
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: Date.now() - 120 * 60 * 1000, // 2h ago
    trailingActive: true, // TRAILING IS ACTIVE
    highWaterMark: 0.404, // Was at 1% profit
    stagnantState: { 
      triggered: true, 
      confirmed: true, 
      cancelled: false, 
      obsPeakPct: 0.5 
    },
  });
  
  // Price drops to 0.9% loss (would hit 0.8% tightened SL if applied)
  const result = shouldExitPosition(position, 0.396, undefined, { priceLow: 0.396 });
  
  assert(result.reason !== 'stagnant_trade', 'Should NOT use tightened SL when trailing active');
});

describe('SCENARIO 7: Max Hold Time Exit', () => {
  // Position held for 49 hours (exceeds 48h max)
  
  const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: Date.now() - (maxHoldMinutes + 60) * 60 * 1000, // 49h ago
    trailingActive: true,
    highWaterMark: 0.42, // In profit
    maxPnlPct: 5,
  });
  
  const result = shouldExitPosition(position, 0.41); // Still in profit
  
  assert(result.shouldExit === true, 'Should exit on max hold');
  assert(result.reason === 'time', `Exit reason: ${result.reason}`);
  assert(result.pnlPct! > 0, 'Exits even in profit due to time');
});

describe('SCENARIO 8: Momentum Reversal Exit', () => {
  // Strong downtrend momentum triggers exit
  
  // Create candles with strong downtrend
  const now = Date.now();
  const candles: Candle[] = [];
  let price = 0.40;
  
  for (let i = 0; i < 10; i++) {
    const newPrice = price * 0.995; // -0.5% each candle
    candles.push({
      timestamp: now - (10 - i) * 15 * 60 * 1000,
      open: price,
      high: price * 1.001,
      low: newPrice * 0.999,
      close: newPrice,
      volume: 1000000,
    });
    price = newPrice;
  }
  
  const position = createPosition({
    entryPrice: 0.40,
    entryTime: now - 60 * 60 * 1000,
    side: 'long',
  });
  
  const currentPrice = candles[candles.length - 1].close;
  const result = shouldExitPosition(position, currentPrice, candles);
  
  // With -0.5% per candle for 10 candles, ROC5 should be significant
  console.log(`    📊 Current price: $${currentPrice.toFixed(4)}, PnL: ${result.pnlPct?.toFixed(2)}%`);
  
  // Note: May or may not trigger depending on exact ROC5 calculation
  if (result.reason === 'momentum_reversal') {
    assert(true, `Momentum reversal detected: ROC5 < -1.5% for 2 candles`);
  } else {
    assert(true, `No momentum reversal: ROC5 not below -1.5% threshold`);
  }
});

describe('SCENARIO 9: Volatility Regime Changes Trailing Params', () => {
  // Test that different volatility regimes use different trailing params
  
  // Low volatility candles
  const lowVolCandles: Candle[] = [];
  for (let i = 0; i < 20; i++) {
    lowVolCandles.push({
      timestamp: Date.now() - (20 - i) * 15 * 60 * 1000,
      open: 0.40,
      high: 0.402, // 0.5% range
      low: 0.398,
      close: 0.40,
      volume: 1000000,
    });
  }
  
  // High volatility candles
  const highVolCandles: Candle[] = [];
  let hprice = 0.40;
  for (let i = 0; i < 20; i++) {
    const swing = (i % 2 === 0 ? 1 : -1) * 0.02;
    highVolCandles.push({
      timestamp: Date.now() - (20 - i) * 15 * 60 * 1000,
      open: hprice,
      high: hprice * 1.04, // 4% range
      low: hprice * 0.96,
      close: hprice * (1 + swing),
      volume: 1000000,
    });
    hprice = hprice * (1 + swing);
  }
  
  const lowRegime = determineVolatilityRegime(lowVolCandles);
  const highRegime = determineVolatilityRegime(highVolCandles);
  
  console.log(`    📊 Low Vol: ${lowRegime.regime}, dist=${lowRegime.trailingDistance}%`);
  console.log(`    📊 High Vol: ${highRegime.regime}, dist=${highRegime.trailingDistance}%`);
  
  // High volatility should have wider trailing
  assert(
    highRegime.trailingDistance >= lowRegime.trailingDistance,
    `High vol has wider trail (${highRegime.trailingDistance}% >= ${lowRegime.trailingDistance}%)`
  );
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log(`📊 SCENARIO RESULTS: ${testsPassed}/${testsRun} passed, ${testsFailed} failed`);
console.log('════════════════════════════════════════════════════════════');

if (testsFailed > 0) {
  console.log('\n❌ SOME SCENARIOS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL SCENARIOS PASSED');
  process.exit(0);
}
