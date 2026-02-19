/**
 * Simulate XRP with V5.88 volatility-adaptive progressive trailing
 */
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

const entry = 1.4062;
const firstLow = 1.3422;
const bounce = 1.3735;
const secondLow = 1.2172;

const hwmPct = ((entry - firstLow) / entry) * 100; // 4.55%
const bouncePct = ((bounce - firstLow) / firstLow) * 100; // 2.33%

console.log('═══════════════════════════════════════════════════════════════');
console.log('XRP SIMULATION - V5.88 Volatility-Adaptive Progressive Trailing');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Entry:        $${entry.toFixed(4)}`);
console.log(`First Low:    $${firstLow.toFixed(4)} (hwmPct: ${hwmPct.toFixed(2)}%)`);
console.log(`Bounce:       $${bounce.toFixed(4)} (+${bouncePct.toFixed(2)}% from low)`);
console.log(`Actual Low:   $${secondLow.toFixed(4)}`);

// Get config values
const exitConfig = MomentumConfig.EXIT as any;
const tier2At = exitConfig.TRAILING_TIER2_AT_PCT ?? 4.0;
const tier2Dist = exitConfig.TRAILING_TIER2_DISTANCE_PCT ?? 1.5;
const highMult = exitConfig.TRAILING_VOL_HIGH_MULT ?? 1.6;

console.log('\n─── CONFIG (V5.88) ───');
console.log(`Tier 2 threshold: ${tier2At}%`);
console.log(`Tier 2 base distance: ${tier2Dist}%`);
console.log(`HIGH volatility multiplier: ${highMult}x`);

// Simulate different volatility regimes
const regimes = [
  { name: 'LOW', mult: exitConfig.TRAILING_VOL_LOW_MULT ?? 0.8 },
  { name: 'MEDIUM', mult: exitConfig.TRAILING_VOL_MED_MULT ?? 1.0 },
  { name: 'HIGH', mult: exitConfig.TRAILING_VOL_HIGH_MULT ?? 1.6 },
];

console.log('\n─── SIMULATION BY VOLATILITY REGIME ───\n');

for (const regime of regimes) {
  // hwmPct 4.55% >= tier2At 4.0% → tier2 distance
  const effectiveDistance = tier2Dist * regime.mult;
  const trailStop = firstLow * (1 + effectiveDistance / 100);
  const wouldExit = bounce >= trailStop;

  console.log(`${regime.name} volatility (${regime.mult}x):`);
  console.log(`  Trailing: ${tier2Dist}% × ${regime.mult} = ${effectiveDistance.toFixed(2)}%`);
  console.log(`  Trail stop: $${firstLow.toFixed(4)} × ${(1 + effectiveDistance/100).toFixed(4)} = $${trailStop.toFixed(4)}`);
  console.log(`  Bounce $${bounce.toFixed(4)} >= $${trailStop.toFixed(4)}? ${wouldExit ? '✗ EXIT' : '✓ HOLD'}`);
  console.log('');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('RESULT');
console.log('═══════════════════════════════════════════════════════════════\n');

// XRP on a crash day = HIGH volatility
const xrpDistance = tier2Dist * highMult;
const xrpTrailStop = firstLow * (1 + xrpDistance / 100);
const xrpWouldExit = bounce >= xrpTrailStop;

if (!xrpWouldExit) {
  const potentialPnl = ((entry - secondLow) / entry) * 100 * 5;
  console.log(`✅ On HIGH volatility day, XRP trade would HOLD through bounce`);
  console.log(`   Trailing distance: ${xrpDistance.toFixed(2)}%`);
  console.log(`   Trail stop: $${xrpTrailStop.toFixed(4)}`);
  console.log(`   Bounce: $${bounce.toFixed(4)} < $${xrpTrailStop.toFixed(4)}`);
  console.log(`   Could capture: ${potentialPnl.toFixed(2)}% leveraged PnL (vs 11.91% actual)`);
} else {
  console.log(`❌ Even with HIGH vol × ${highMult}, trade would still exit`);
  console.log(`   Need higher multiplier or wider base distance`);
}

console.log('\n─── SUMMARY ───');
console.log(`XRP crash day = HIGH volatility → ${highMult}x multiplier`);
console.log(`Tier 2 (4%+): ${tier2Dist}% × ${highMult} = ${xrpDistance.toFixed(2)}% trailing`);
console.log(`This handles bounces up to ${xrpDistance.toFixed(2)}%`);
console.log(`XRP bounce was ${bouncePct.toFixed(2)}% → ${bouncePct < xrpDistance ? 'SURVIVES' : 'EXITS'}`);
