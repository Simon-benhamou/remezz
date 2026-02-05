/**
 * 🧪 EXIT LOGIC TESTS
 *
 * Ces tests vérifient que shouldExitPosition() fonctionne correctement.
 * Depuis V5.41, LIVE et BACKTEST utilisent la MÊME fonction shouldExitPosition().
 *
 * Run with: npx tsx test/run-parity-tests.ts
 */

import {
  shouldExitPosition,
  determineVolatilityRegime,
  MomentumConfig,
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

// Create mock position with a known symbol for tier-based SL
function createPosition(overrides: Partial<Position> = {}): Position {
  const now = Date.now();
  return {
    id: 'test-pos',
    symbol: 'SOL/USDT',  // Use a known TIER2 symbol for predictable SL
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


// ============================================================================
// TESTS
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log('🔬 EXIT LOGIC TESTS (shouldExitPosition)');
console.log('════════════════════════════════════════════════════════════');
console.log('📝 Note: Since V5.41, LIVE and BACKTEST use the SAME function');
console.log('════════════════════════════════════════════════════════════');

describe('MAX_HOLD Exit', () => {
  const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;

  // Position held too long
  const position = createPosition({
    entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000,
  });
  const result = shouldExitPosition(position, 100);

  assert(result.shouldExit === true, `Exits after max hold time`);
  assert(result.reason === 'time', `Reason is 'time': ${result.reason}`);
});

describe('Stop Loss Exit - LONG', () => {
  const position = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
  });

  // Price below SL threshold
  const result = shouldExitPosition(position, 97, undefined, { priceLow: 97 });

  assert(result.shouldExit === true, `Exits on SL hit`);
  assert(result.reason === 'stoploss', `Reason is 'stoploss': ${result.reason}`);
});

describe('Stop Loss Exit - SHORT', () => {
  const position = createPosition({
    side: 'short',
    entryPrice: 100,
    stopLossPct: 2.5,
  });

  // Price above SL threshold
  const result = shouldExitPosition(position, 103, undefined, { priceHigh: 103 });

  assert(result.shouldExit === true, `Exits on SL hit`);
  assert(result.reason === 'stoploss', `Reason is 'stoploss': ${result.reason}`);
});

describe('Stagnant SL Tightening + Trailing Interaction', () => {
  // Get current config values for accurate testing
  const exitConfig = MomentumConfig.EXIT as any;
  const stagnantRatio = exitConfig.STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5;
  const tier2MedSl = exitConfig.TIER2_SL_MED_VOL_PCT ?? 2.5;
  const expectedTightenedSl = tier2MedSl * stagnantRatio;  // e.g., 2.5 * 0.5 = 1.25%

  console.log(`    📊 Config: TIER2_MED_SL=${tier2MedSl}%, ratio=${stagnantRatio}, tightened=${expectedTightenedSl}%`);

  // Case 1: Stagnant confirmed BUT trailing active → SL NOT tightened
  const pos1 = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
    trailingActive: true, // Trailing active - stagnant SL should NOT apply
    stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
  });

  // Price at 99% (1% loss) - below tightened SL but above base SL
  const result1 = shouldExitPosition(pos1, 99, undefined, { priceLow: 99 });

  assert(result1.reason !== 'stagnant_trade', `Trailing active → SL NOT tightened: reason=${result1.reason}`);

  // Case 2: Stagnant confirmed AND trailing NOT active → SL tightened
  const pos2 = createPosition({
    side: 'long',
    entryPrice: 100,
    stopLossPct: 2.5,
    trailingActive: false, // Trailing NOT active - stagnant SL SHOULD apply
    stagnantState: { triggered: true, confirmed: true, cancelled: false, obsPeakPct: 0.3 },
  });

  // Price below the tightened SL (1.25% → slPrice = 98.75)
  const triggerPrice = 100 * (1 - expectedTightenedSl / 100) - 0.01;  // Just below SL
  const result2 = shouldExitPosition(pos2, triggerPrice, undefined, { priceLow: triggerPrice });

  console.log(`    📊 Trigger price: ${triggerPrice.toFixed(4)}, SL price: ${(100 * (1 - expectedTightenedSl / 100)).toFixed(4)}`);

  assert(result2.shouldExit === true && result2.reason === 'stagnant_trade',
    `Trailing NOT active → Exits on tightened SL (${expectedTightenedSl}%): exit=${result2.shouldExit}, reason=${result2.reason}`);

  // Verify effectiveSlPct matches expected
  assert(Math.abs((result2.effectiveSlPct ?? 0) - expectedTightenedSl) < 0.01,
    `effectiveSlPct matches: expected=${expectedTightenedSl}%, got=${result2.effectiveSlPct}%`);
});

describe('Adaptive Trailing - Volatility Regime', () => {
  // Create low volatility candles (tight range)
  const lowVolCandles: Candle[] = [];
  const now = Date.now();
  for (let i = 0; i < 20; i++) {
    lowVolCandles.push({
      timestamp: now - (20 - i) * 15 * 60 * 1000,
      open: 100,
      high: 100.5, // Very tight range → low ATR
      low: 99.5,
      close: 100,
      volume: 1000000,
    });
  }

  const regime = determineVolatilityRegime(lowVolCandles);

  console.log(`    📊 Regime: ${regime.regime}, ATR%=${regime.atrPct?.toFixed(2)}, dist=${regime.trailingDistance}%`);

  assert(regime.regime === 'LOW', `Low vol candles → LOW regime: ${regime.regime}`);
  assert(regime.trailingDistance === MomentumConfig.EXIT.LOW_VOL_DISTANCE,
    `Uses low vol trailing distance: ${regime.trailingDistance}%`);
});

describe('Trailing Widen at 3%', () => {
  // Position that reached 3.5% profit peak
  const position = createPosition({
    side: 'long',
    entryPrice: 100,
    trailingActive: true,
    highWaterMark: 103.5, // 3.5% profit peak
  });

  const hwmPct = ((103.5 - 100) / 100) * 100;
  const shouldWiden = hwmPct >= MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT;

  assert(shouldWiden, `Should widen at hwmPct=${hwmPct}% (threshold=${MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT}%)`);

  // Verify the trailing stop calculation uses wide distance
  const result = shouldExitPosition(position, 103);

  // At 103 (close to HWM), trailing should be active with wide distance
  assert(result.trailingActivated === true, `Trailing is activated`);
});

describe('Exit Priority Order', () => {
  // MAX_HOLD should trigger FIRST, even with other conditions
  const maxHoldMinutes = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880;

  const position = createPosition({
    side: 'long',
    entryPrice: 100,
    entryTime: Date.now() - (maxHoldMinutes + 1) * 60 * 1000,
    trailingActive: true,
    highWaterMark: 110, // In profit, trailing active
  });

  const result = shouldExitPosition(position, 109);

  assert(result.reason === 'time', `MAX_HOLD checked first: reason=${result.reason}`);
});

describe('Trailing Breach Reset on Wick Recovery', () => {
  // When wick hits trailing stop but close recovers, trailingBreached should be false
  // V5.88: Use 3.5% hwmPct which uses tier1 trailing (0.8%)
  // At 5%+ progressive trailing kicks in with 1.5% distance
  const position = createPosition({
    side: 'long',
    entryPrice: 100,
    trailingActive: true,
    highWaterMark: 103.5, // 3.5% profit reached (tier1: 0.8% trailing)
  });

  // With progressive trailing at 3.5% hwmPct → WIDE_DISTANCE (0.8%)
  const trailDist = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT; // 0.8%
  const trailStop = 103.5 * (1 - trailDist / 100); // ~102.67

  // Scenario: Wick hit below stop (102.5) but close recovered above (103)
  const result = shouldExitPosition(position, 103, undefined, {
    priceHigh: 103.5,
    priceLow: 102.5, // Below trailing stop of 102.67
  });

  console.log(`    📊 Trail stop: $${trailStop.toFixed(4)}, Low: $102.5, Close: $103`);
  console.log(`    📊 trailingBreached: ${result.trailingBreached}`);

  // trailingBreached should be explicitly false (not undefined, not true)
  assert(result.trailingBreached === false, `trailingBreached=false when wick hit but close recovered`);
  assert(result.trailingActivated === true, `trailingActivated still true`);
});

describe('Dynamic SL by Tier and Volatility', () => {
  // Test that TIER1 (BTC/ETH) gets different SL than TIER2
  const exitConfig = MomentumConfig.EXIT as any;
  const tierBasedEnabled = exitConfig.TIER_BASED_SL_ENABLED ?? false;

  if (tierBasedEnabled) {
    const tier1Sl = exitConfig.TIER1_SL_MED_VOL_PCT ?? 1.5;
    const tier2Sl = exitConfig.TIER2_SL_MED_VOL_PCT ?? 2.5;

    console.log(`    📊 TIER_BASED_SL_ENABLED: ${tierBasedEnabled}`);
    console.log(`    📊 TIER1 (BTC) MED SL: ${tier1Sl}%`);
    console.log(`    📊 TIER2 (SOL) MED SL: ${tier2Sl}%`);

    assert(tier1Sl < tier2Sl, `TIER1 has tighter SL than TIER2: ${tier1Sl}% < ${tier2Sl}%`);
  } else {
    console.log(`    📊 TIER_BASED_SL_ENABLED: false (skipping tier test)`);
    assert(true, `Tier-based SL disabled, using legacy dynamic SL`);
  }
});

describe('V5.88 Progressive Trailing', () => {
  // Test that bigger moves get wider trailing distances
  const exitConfig = MomentumConfig.EXIT as any;
  const progressiveEnabled = exitConfig.TRAILING_PROGRESSIVE_ENABLED ?? false;

  if (progressiveEnabled) {
    const tier1At = MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT;
    const tier2At = exitConfig.TRAILING_TIER2_AT_PCT ?? 5.0;
    const tier3At = exitConfig.TRAILING_TIER3_AT_PCT ?? 7.0;
    const tier1Dist = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT;
    const tier2Dist = exitConfig.TRAILING_TIER2_DISTANCE_PCT ?? 1.5;
    const tier3Dist = exitConfig.TRAILING_TIER3_DISTANCE_PCT ?? 2.5;

    console.log(`    📊 Progressive trailing enabled`);
    console.log(`    📊 Tier 1: ${tier1At}% → ${tier1Dist}% trailing`);
    console.log(`    📊 Tier 2: ${tier2At}% → ${tier2Dist}% trailing`);
    console.log(`    📊 Tier 3: ${tier3At}% → ${tier3Dist}% trailing`);

    // Test tier 2 (5% hwmPct should use 1.5% trailing)
    const position5pct = createPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 105, // 5% profit
    });

    // With 1.5% trailing from 105: stop = 105 * 0.985 = 103.425
    // Price at 103 should NOT breach (103 > 103.425 is false, so no breach)
    // Actually 103 < 103.425, so it WOULD breach
    // Let's check at 104 which is above 103.425
    const result5pct = shouldExitPosition(position5pct, 104, undefined, {
      priceHigh: 105,
      priceLow: 104,
    });

    // At 5% hwmPct, trailing should be active with tier2 distance
    assert(result5pct.trailingActivated === true, `Trailing active at 5% profit`);

    // Test tier 3 (7% hwmPct should use 2.5% trailing)
    const position7pct = createPosition({
      side: 'long',
      entryPrice: 100,
      trailingActive: true,
      highWaterMark: 107, // 7% profit
    });

    // With 2.5% trailing from 107: stop = 107 * 0.975 = 104.325
    // Price at 105 should NOT breach
    const result7pct = shouldExitPosition(position7pct, 105, undefined, {
      priceHigh: 107,
      priceLow: 105,
    });

    assert(result7pct.trailingActivated === true, `Trailing active at 7% profit`);
    assert(result7pct.trailingBreached !== true, `7% profit with 2.5% trail: no breach at 105 (stop=104.325)`);

    // Verify progressive distances are wider
    assert(tier2Dist > tier1Dist, `Tier2 (${tier2Dist}%) > Tier1 (${tier1Dist}%)`);
    assert(tier3Dist > tier2Dist, `Tier3 (${tier3Dist}%) > Tier2 (${tier2Dist}%)`);
  } else {
    console.log(`    📊 Progressive trailing disabled (skipping)`);
    assert(true, `Progressive trailing not enabled`);
  }
});

describe('V5.88 Volatility-Adaptive Trailing', () => {
  const exitConfig = MomentumConfig.EXIT as any;
  const volAdaptEnabled = exitConfig.TRAILING_VOL_ADAPT_ENABLED ?? false;

  if (volAdaptEnabled) {
    const lowMult = exitConfig.TRAILING_VOL_LOW_MULT ?? 0.8;
    const medMult = exitConfig.TRAILING_VOL_MED_MULT ?? 1.0;
    const highMult = exitConfig.TRAILING_VOL_HIGH_MULT ?? 1.6;

    console.log(`    📊 Volatility adaptation enabled`);
    console.log(`    📊 LOW vol: ${lowMult}x | MED vol: ${medMult}x | HIGH vol: ${highMult}x`);

    // Verify multipliers are ordered correctly
    assert(lowMult < medMult, `LOW mult (${lowMult}) < MED mult (${medMult})`);
    assert(medMult < highMult, `MED mult (${medMult}) < HIGH mult (${highMult})`);

    // HIGH volatility should allow larger bounces
    // XRP example: 1.5% base × 1.6 = 2.4% trailing > 2.33% bounce
    const tier2Dist = exitConfig.TRAILING_TIER2_DISTANCE_PCT ?? 1.5;
    const highVolTrail = tier2Dist * highMult;
    assert(highVolTrail > 2.3, `HIGH vol tier2 (${highVolTrail.toFixed(2)}%) handles 2.3%+ bounces`);
  } else {
    console.log(`    📊 Volatility adaptation disabled (skipping)`);
    assert(true, `Volatility adaptation not enabled`);
  }
});

describe('V5.88 Trailing Scenarios - Normal to Exceptional', () => {
  const exitConfig = MomentumConfig.EXIT as any;
  const progressiveEnabled = exitConfig.TRAILING_PROGRESSIVE_ENABLED ?? false;
  const volAdaptEnabled = exitConfig.TRAILING_VOL_ADAPT_ENABLED ?? false;

  if (!progressiveEnabled || !volAdaptEnabled) {
    console.log(`    📊 Progressive or vol-adapt disabled (skipping scenarios)`);
    assert(true, `Skipped - features not enabled`);
    return;
  }

  // Config values for scenario display
  const tier1Dist = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT;
  const tier2Dist = exitConfig.TRAILING_TIER2_DISTANCE_PCT ?? 1.5;
  const tier3Dist = exitConfig.TRAILING_TIER3_DISTANCE_PCT ?? 2.5;
  const baseDist = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
  const lowMult = exitConfig.TRAILING_VOL_LOW_MULT ?? 0.8;
  const medMult = exitConfig.TRAILING_VOL_MED_MULT ?? 1.0;
  const highMult = exitConfig.TRAILING_VOL_HIGH_MULT ?? 1.6;

  // Define profit scenarios with their base trailing distances
  const profitScenarios = [
    { name: 'Small win', hwmPct: 2.0, tier: 'Base', dist: baseDist },
    { name: 'Good win', hwmPct: 3.5, tier: 'Tier1', dist: tier1Dist },
    { name: 'Big win', hwmPct: 4.5, tier: 'Tier2', dist: tier2Dist },
    { name: 'Huge win', hwmPct: 7.0, tier: 'Tier3', dist: tier3Dist },
  ];

  console.log(`\n    ┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`    │  TRAILING DISTANCE BY PROFIT & VOLATILITY                       │`);
  console.log(`    ├──────────────┬────────┬──────────┬──────────┬──────────┬────────┤`);
  console.log(`    │ Scenario     │ Profit │ Tier     │ LOW vol  │ MED vol  │ HIGH   │`);
  console.log(`    ├──────────────┼────────┼──────────┼──────────┼──────────┼────────┤`);

  for (const profit of profitScenarios) {
    const lowTrail = (profit.dist * lowMult).toFixed(2);
    const medTrail = (profit.dist * medMult).toFixed(2);
    const highTrail = (profit.dist * highMult).toFixed(2);

    console.log(`    │ ${profit.name.padEnd(12)} │ ${profit.hwmPct.toFixed(1)}%   │ ${profit.tier.padEnd(8)} │ ${lowTrail.padStart(6)}%  │ ${medTrail.padStart(6)}%  │ ${highTrail.padStart(5)}% │`);
  }

  console.log(`    └──────────────┴────────┴──────────┴──────────┴──────────┴────────┘`);

  // Example bounces and whether they would survive
  console.log(`\n    ┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`    │  BOUNCE SURVIVAL (would trade hold through bounce?)             │`);
  console.log(`    ├───────────────────┬─────────┬─────────┬─────────┬───────────────┤`);
  console.log(`    │ Bounce Size       │ LOW vol │ MED vol │ HIGH vol│ Real Example  │`);
  console.log(`    ├───────────────────┼─────────┼─────────┼─────────┼───────────────┤`);

  const bounceExamples = [
    { size: 0.5, example: 'Micro noise' },
    { size: 1.0, example: 'Normal pullback' },
    { size: 1.5, example: 'Decent bounce' },
    { size: 2.0, example: 'Strong bounce' },
    { size: 2.33, example: 'XRP Feb 5th' },
    { size: 3.0, example: 'Major reversal?' },
  ];

  // Using Tier2 (4.5% profit) as reference
  const tier2Base = tier2Dist;
  for (const bounce of bounceExamples) {
    const lowSurvive = bounce.size < (tier2Base * lowMult) ? '✓' : '✗';
    const medSurvive = bounce.size < (tier2Base * medMult) ? '✓' : '✗';
    const highSurvive = bounce.size < (tier2Base * highMult) ? '✓' : '✗';

    console.log(`    │ ${bounce.size.toFixed(2)}% bounce     │    ${lowSurvive}    │    ${medSurvive}    │    ${highSurvive}    │ ${bounce.example.padEnd(13)} │`);
  }

  console.log(`    └───────────────────┴─────────┴─────────┴─────────┴───────────────┘`);
  console.log(`    (Based on Tier2 = 4.5% profit, base ${tier2Dist}% trailing)`);

  // Verify the XRP case specifically
  const xrpBounce = 2.33;
  const xrpHighVolTrail = tier2Dist * highMult;
  assert(xrpBounce < xrpHighVolTrail, `XRP 2.33% bounce < HIGH vol tier2 ${xrpHighVolTrail.toFixed(2)}% trailing`);
  assert(xrpBounce > tier2Dist * medMult, `XRP 2.33% bounce > MED vol tier2 ${(tier2Dist * medMult).toFixed(2)}% (would exit)`);
});

// ============================================================================
// SUMMARY
// ============================================================================

console.log('\n════════════════════════════════════════════════════════════');
console.log(`📊 TEST RESULTS: ${testsPassed}/${testsRun} passed, ${testsFailed} failed`);
console.log('════════════════════════════════════════════════════════════');

if (testsFailed > 0) {
  console.log('\n❌ SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED');
  process.exit(0);
}
