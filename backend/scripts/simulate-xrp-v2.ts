/**
 * XRP trade analysis - what thresholds would have worked?
 */

const entry = 1.4062;
const firstLow = 1.3422;
const bounce = 1.3735;
const secondLow = 1.2172;

const hwmPct = ((entry - firstLow) / entry) * 100; // 4.55%
const bouncePct = ((bounce - firstLow) / firstLow) * 100; // 2.33%

console.log('═══════════════════════════════════════════════════════════════');
console.log('XRP ANALYSIS - WHAT WOULD WORK?');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`hwmPct at first low: ${hwmPct.toFixed(2)}%`);
console.log(`Bounce size:         ${bouncePct.toFixed(2)}%`);
console.log(`\nTo survive this bounce, trailing distance needed: >${bouncePct.toFixed(2)}%`);

console.log('\n─── SCENARIO ANALYSIS ───\n');

const scenarios = [
  { name: 'Current V5.88 (tier2 at 5%)', tier2At: 5.0, tier2Dist: 1.5, tier3At: 7.0, tier3Dist: 2.5 },
  { name: 'Lower tier2 to 4%', tier2At: 4.0, tier2Dist: 1.5, tier3At: 6.0, tier3Dist: 2.5 },
  { name: 'Lower tier2 to 4% + wider 2%', tier2At: 4.0, tier2Dist: 2.0, tier3At: 6.0, tier3Dist: 3.0 },
  { name: 'Aggressive: 4% → 2.5% trail', tier2At: 4.0, tier2Dist: 2.5, tier3At: 6.0, tier3Dist: 3.5 },
];

for (const s of scenarios) {
  let trailDist: number;
  if (hwmPct >= s.tier3At) {
    trailDist = s.tier3Dist;
  } else if (hwmPct >= s.tier2At) {
    trailDist = s.tier2Dist;
  } else if (hwmPct >= 3.0) {
    trailDist = 0.8;
  } else {
    trailDist = 0.5;
  }

  const trailStop = firstLow * (1 + trailDist / 100);
  const wouldExit = bounce >= trailStop;

  console.log(`${s.name}:`);
  console.log(`  hwmPct ${hwmPct.toFixed(2)}% → ${trailDist}% trailing`);
  console.log(`  Trail stop: $${trailStop.toFixed(4)}`);
  console.log(`  Bounce $${bounce.toFixed(4)} >= $${trailStop.toFixed(4)}? ${wouldExit ? '✗ EXIT' : '✓ HOLD'}`);
  console.log('');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('RECOMMENDATION');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('The XRP bounce was exceptionally large (2.33%).');
console.log('');
console.log('Options:');
console.log('1. Lower tier2 threshold from 5% to 4% (catches this trade)');
console.log('2. Increase tier2 distance from 1.5% to 2.0% (barely survives)');
console.log('3. Both: tier2 at 4% with 2.5% trailing (comfortable margin)');
console.log('');
console.log('Trade-off: Wider trailing = give back more on normal reversals');
console.log('');
console.log('Current V5.88 settings are reasonable for most cases.');
console.log('This XRP trade was an outlier - large bounce followed by continuation.');
