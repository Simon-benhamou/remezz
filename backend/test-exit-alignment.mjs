/**
 * V5.38 Exit Logic Alignment Test
 * 
 * This script tests that shouldExitPosition() in momentumSimple.ts
 * behaves EXACTLY like the backtest exit logic.
 */

import { shouldExitPosition } from './dist/src/strategies/momentumSimple.js';

// Test scenarios
const scenarios = [
  {
    name: "LONG: SL hit on wick (no trailing)",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 30 * 60 * 1000, // 30 min ago
      stopLossPct: 1.3,
      highWaterMark: 101,
      maxPnlPct: 0.5,
      trailingActive: false
    },
    currentPrice: 99.5,  // Close at -0.5%
    opts: { priceLow: 98.5, priceHigh: 100.5 }, // Wick went to -1.5% (below SL)
    expected: { shouldExit: true, reason: 'stoploss' }
  },
  {
    name: "LONG: Trailing active, close breaches stop (first breach)",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 103, // Was at +3%
      maxPnlPct: 3.0,
      trailingActive: true,
      trailingBreachCandles: 0
    },
    currentPrice: 102.2, // Close at +2.2%, below trailing stop (103 * 0.993 = 102.279)
    opts: { priceLow: 102.0, priceHigh: 103.0 },
    expected: { shouldExit: false, trailingBreached: true }
  },
  {
    name: "LONG: Trailing active, 2nd consecutive breach → should signal exit",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 103,
      maxPnlPct: 3.0,
      trailingActive: true,
      trailingBreachCandles: 1  // Already 1 breach
    },
    currentPrice: 102.1, // Close below trailing stop again
    opts: { priceLow: 102.0, priceHigh: 102.5 },
    expected: { shouldExit: false, trailingBreached: true } // Still returns breach, caller does 2-check
  },
  {
    name: "LONG: Trailing active but close recovers → no breach",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 103,
      maxPnlPct: 3.0,
      trailingActive: true,
      trailingBreachCandles: 1
    },
    currentPrice: 102.5, // Close ABOVE trailing stop (102.279)
    opts: { priceLow: 102.2, priceHigh: 103.0 },
    expected: { shouldExit: false, trailingActivated: true } // No trailingBreached = no breach
  },
  {
    name: "LONG: Stagnant confirmed (105min), SL tightened to 0.8%",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 110 * 60 * 1000, // 110 min ago
      stopLossPct: 1.3,
      highWaterMark: 100.3,
      maxPnlPct: 0.3, // Never hit trailing activation
      trailingActive: false,
      stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 }
    },
    currentPrice: 99.5,
    opts: { priceLow: 99.1, priceHigh: 100.2 }, // Wick at -0.9% (below 0.8% tightened SL)
    expected: { shouldExit: true, reason: 'stagnant_trade' }
  },
  {
    name: "LONG: Stagnant triggered but cancelled (recovery during obs)",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 110 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 100.8,
      maxPnlPct: 0.8,
      trailingActive: false,
      stagnantState: { triggered: true, confirmed: false, cancelled: true, obsPeakPct: 0.8 }
    },
    currentPrice: 99.5,
    opts: { priceLow: 98.5, priceHigh: 100.5 }, // Wick below normal SL (1.3%)
    expected: { shouldExit: true, reason: 'stoploss' } // Uses normal SL, not tightened
  },
  {
    name: "LONG: Trailing active + violent crash hits SL on wick",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 102,
      maxPnlPct: 2.0,
      trailingActive: true,
      trailingBreachCandles: 0
    },
    currentPrice: 99.0, // Close at -1%
    opts: { priceLow: 98.0, priceHigh: 101.5 }, // Wick crashed to -2% (below SL!)
    expected: { shouldExit: true, reason: 'stoploss' } // SL checked BEFORE trailing
  },
  {
    name: "SHORT: SL hit on wick",
    position: {
      side: 'short',
      entryPrice: 100,
      entryTime: Date.now() - 30 * 60 * 1000,
      stopLossPct: 1.3,
      lowWaterMark: 99,
      maxPnlPct: 0.5,
      trailingActive: false
    },
    currentPrice: 100.5,
    opts: { priceLow: 99.5, priceHigh: 101.5 }, // Wick went to +1.5% (above SL)
    expected: { shouldExit: true, reason: 'stoploss' }
  },
  {
    name: "SHORT: Trailing active, close breaches stop",
    position: {
      side: 'short',
      entryPrice: 100,
      entryTime: Date.now() - 60 * 60 * 1000,
      stopLossPct: 1.3,
      lowWaterMark: 97, // Was at +3%
      maxPnlPct: 3.0,
      trailingActive: true,
      trailingBreachCandles: 0
    },
    currentPrice: 97.8, // Close at +2.2%, above trailing stop (97 * 1.007 = 97.679)
    opts: { priceLow: 97.0, priceHigh: 98.0 },
    expected: { shouldExit: false, trailingBreached: true }
  },
  {
    name: "LONG: Momentum reversal (2 consecutive ROC5 < -1.5%)",
    position: {
      side: 'long',
      entryPrice: 100,
      entryTime: Date.now() - 120 * 60 * 1000,
      stopLossPct: 1.3,
      highWaterMark: 102,
      maxPnlPct: 2.0,
      trailingActive: false
    },
    currentPrice: 99,
    opts: { priceLow: 98.5, priceHigh: 99.5 },
    candles: [
      { close: 102 }, { close: 101.5 }, { close: 101 }, { close: 100.5 },
      { close: 100 }, { close: 99.3 }, { close: 99 }  // ROC5 = (99-102)/102 = -2.9%
    ],
    expected: { shouldExit: true, reason: 'momentum_reversal' }
  }
];

// Run tests
console.log('═══════════════════════════════════════════════════════════════');
console.log('V5.38 EXIT LOGIC ALIGNMENT TESTS');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

let passed = 0;
let failed = 0;

for (const scenario of scenarios) {
  const result = shouldExitPosition(
    scenario.position,
    scenario.currentPrice,
    scenario.candles || undefined,  // 3rd param is candles
    scenario.opts                    // 4th param is opts
  );
  
  // Check expected outcomes
  let testPassed = true;
  const issues = [];
  
  if (scenario.expected.shouldExit !== undefined && result.shouldExit !== scenario.expected.shouldExit) {
    testPassed = false;
    issues.push(`shouldExit: expected ${scenario.expected.shouldExit}, got ${result.shouldExit}`);
  }
  
  if (scenario.expected.reason && result.reason !== scenario.expected.reason) {
    testPassed = false;
    issues.push(`reason: expected ${scenario.expected.reason}, got ${result.reason}`);
  }
  
  if (scenario.expected.trailingBreached !== undefined && result.trailingBreached !== scenario.expected.trailingBreached) {
    testPassed = false;
    issues.push(`trailingBreached: expected ${scenario.expected.trailingBreached}, got ${result.trailingBreached}`);
  }
  
  if (scenario.expected.trailingActivated !== undefined && result.trailingActivated !== scenario.expected.trailingActivated) {
    testPassed = false;
    issues.push(`trailingActivated: expected ${scenario.expected.trailingActivated}, got ${result.trailingActivated}`);
  }
  
  if (testPassed) {
    console.log(`✅ PASS: ${scenario.name}`);
    passed++;
  } else {
    console.log(`❌ FAIL: ${scenario.name}`);
    issues.forEach(i => console.log(`   → ${i}`));
    console.log(`   Full result:`, JSON.stringify(result, null, 2));
    failed++;
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${scenarios.length} tests`);
console.log('═══════════════════════════════════════════════════════════════');

if (failed > 0) {
  process.exit(1);
}
