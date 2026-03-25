/**
 * Simulate how XRP trade would have behaved with V5.88 progressive trailing
 */
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

console.log('═══════════════════════════════════════════════════════════════');
console.log('XRP TRADE SIMULATION - V5.88 Progressive Trailing');
console.log('═══════════════════════════════════════════════════════════════\n');

const entry = 1.4062;
const firstLow = 1.3422;  // First low at 11:15
const bounce = 1.3735;    // Bounced to this level
const actualExit = 1.3727;
const secondLow = 1.2172; // Actual low at 17:15

// Calculate hwmPct at first low
const hwmPct = ((entry - firstLow) / entry) * 100;
console.log(`Entry:      $${entry.toFixed(4)}`);
console.log(`First Low:  $${firstLow.toFixed(4)} (hwmPct: ${hwmPct.toFixed(2)}%)`);
console.log(`Bounce:     $${bounce.toFixed(4)}`);
console.log(`Second Low: $${secondLow.toFixed(4)}`);

// OLD behavior (0.8% trailing at 3%+)
const oldTrailDist = 0.8;
const oldTrailStop = firstLow * (1 + oldTrailDist / 100);
const oldWouldExit = bounce >= oldTrailStop;

console.log('\n─── OLD BEHAVIOR (V5.87) ───');
console.log(`hwmPct ${hwmPct.toFixed(2)}% >= 3% → 0.8% trailing`);
console.log(`Trail stop: $${firstLow.toFixed(4)} × 1.008 = $${oldTrailStop.toFixed(4)}`);
console.log(`Bounce $${bounce.toFixed(4)} >= $${oldTrailStop.toFixed(4)}? ${oldWouldExit ? '✗ YES → EXIT' : '✓ NO → HOLD'}`);

// NEW behavior (progressive trailing)
const exitConfig = MomentumConfig.EXIT as any;
const tier2At = exitConfig.TRAILING_TIER2_AT_PCT ?? 5.0;
const tier2Dist = exitConfig.TRAILING_TIER2_DISTANCE_PCT ?? 1.5;

let newTrailDist: number;
if (hwmPct >= 7.0) {
  newTrailDist = 2.5;
} else if (hwmPct >= 5.0) {
  newTrailDist = 1.5;
} else if (hwmPct >= 3.0) {
  newTrailDist = 0.8;
} else {
  newTrailDist = 0.5;
}

const newTrailStop = firstLow * (1 + newTrailDist / 100);
const newWouldExit = bounce >= newTrailStop;

console.log('\n─── NEW BEHAVIOR (V5.88) ───');
console.log(`hwmPct ${hwmPct.toFixed(2)}% → Tier ${hwmPct >= 7 ? '3' : hwmPct >= 5 ? '2' : '1'} → ${newTrailDist}% trailing`);
console.log(`Trail stop: $${firstLow.toFixed(4)} × ${(1 + newTrailDist/100).toFixed(4)} = $${newTrailStop.toFixed(4)}`);
console.log(`Bounce $${bounce.toFixed(4)} >= $${newTrailStop.toFixed(4)}? ${newWouldExit ? '✗ YES → EXIT' : '✓ NO → HOLD'}`);

// Impact
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('IMPACT');
console.log('═══════════════════════════════════════════════════════════════\n');

const actualPnl = ((entry - actualExit) / entry) * 100 * 5;
const potentialPnl = ((entry - secondLow) / entry) * 100 * 5;
const missedPnl = potentialPnl - actualPnl;

console.log(`Actual exit (old):  $${actualExit.toFixed(4)} → ${actualPnl.toFixed(2)}% lev PnL`);
console.log(`Potential (hold):   $${secondLow.toFixed(4)} → ${potentialPnl.toFixed(2)}% lev PnL`);
console.log(`Missed PnL:         ${missedPnl.toFixed(2)}%`);

if (!newWouldExit) {
  console.log(`\n✅ With V5.88, trade would have HELD through bounce`);
  console.log(`   Could have captured more of the ${potentialPnl.toFixed(0)}% move`);
} else {
  console.log(`\n❌ Even with V5.88, trade would still exit`);
  console.log(`   Bounce of ${((bounce - firstLow) / firstLow * 100).toFixed(2)}% exceeds ${newTrailDist}% trailing`);
}
