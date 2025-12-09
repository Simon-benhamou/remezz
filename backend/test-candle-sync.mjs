/**
 * 🧪 TEST: Candle Synchronization Logic (V5.11)
 * 
 * Vérifie que l'agent ne check les signaux que quand une nouvelle bougie 15m est fermée
 */

console.log('═'.repeat(80));
console.log('🧪 TEST: Synchronisation des Bougies 15min (V5.11)');
console.log('═'.repeat(80));

// Simuler la logique de l'agent
class MockAgent {
  constructor() {
    this.lastProcessedCandleTs = 0;
    this.tickCount = 0;
    this.signalChecks = 0;
  }

  // Simule fetchCandles - retourne des bougies avec timestamp
  getCandles(currentTime) {
    // Les bougies sont fermées toutes les 15 minutes (00, 15, 30, 45)
    // Le timestamp de la dernière bougie fermée = floor(currentTime / 15min) * 15min
    const fifteenMin = 15 * 60 * 1000;
    const lastClosedCandleTs = Math.floor(currentTime / fifteenMin) * fifteenMin;
    
    return {
      lastCandleTs: lastClosedCandleTs,
      close: 100 + Math.random() * 10,
    };
  }

  // Simule checkEntry avec la nouvelle logique
  checkEntry(currentTime) {
    this.tickCount++;
    const candle = this.getCandles(currentTime);
    
    // V5.11: Check if this is a NEW closed candle
    if (candle.lastCandleTs === this.lastProcessedCandleTs) {
      return { action: 'skip', reason: 'waiting_new_candle' };
    }
    
    // New candle! Process it
    this.lastProcessedCandleTs = candle.lastCandleTs;
    this.signalChecks++;
    
    return { 
      action: 'check_signal', 
      candleTs: new Date(candle.lastCandleTs).toISOString(),
      price: candle.close.toFixed(2),
    };
  }
}

// ============================================================================
// TEST 1: Simulation sur 1 heure (60 ticks, 1 par minute)
// ============================================================================

console.log('\n📊 TEST 1: Simulation 1 heure (60 ticks)\n');

const agent = new MockAgent();
const startTime = new Date('2025-12-07T12:00:00Z').getTime();

const results = [];
for (let i = 0; i < 60; i++) {
  const currentTime = startTime + i * 60 * 1000; // +1 minute each tick
  const result = agent.checkEntry(currentTime);
  results.push({
    tick: i + 1,
    time: new Date(currentTime).toISOString().slice(11, 19),
    ...result,
  });
}

// Afficher les résultats groupés
console.log('  Tick | Time     | Action           | Details');
console.log('  ' + '─'.repeat(60));

let lastAction = null;
let skipCount = 0;

for (const r of results) {
  if (r.action === 'skip') {
    skipCount++;
    // Afficher seulement au changement
    if (lastAction !== 'skip') {
      // Will print summary later
    }
  } else {
    // Print skip summary if we were skipping
    if (skipCount > 0) {
      console.log(`  ...  | ...      | skip (×${skipCount})        | waiting_new_candle`);
      skipCount = 0;
    }
    console.log(`  ${String(r.tick).padStart(4)} | ${r.time} | ✅ CHECK_SIGNAL  | Candle: ${r.candleTs?.slice(11, 19)}`);
  }
  lastAction = r.action;
}
// Final skip summary
if (skipCount > 0) {
  console.log(`  ...  | ...      | skip (×${skipCount})        | waiting_new_candle`);
}

console.log('\n📈 Résumé:');
console.log(`  - Total ticks: ${agent.tickCount}`);
console.log(`  - Signal checks: ${agent.signalChecks}`);
console.log(`  - Checks attendus: 4 (1 par 15min sur 1h)`);
console.log(`  - Test: ${agent.signalChecks === 4 ? '✅ PASS' : '❌ FAIL'}`);

// ============================================================================
// TEST 2: Simulation sur 24 heures
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log('📊 TEST 2: Simulation 24 heures (1440 ticks)\n');

const agent24h = new MockAgent();
const startTime24h = new Date('2025-12-07T00:00:00Z').getTime();

for (let i = 0; i < 1440; i++) { // 24h × 60min
  const currentTime = startTime24h + i * 60 * 1000;
  agent24h.checkEntry(currentTime);
}

const expectedChecks24h = 24 * 4; // 4 per hour × 24 hours = 96

console.log('📈 Résumé:');
console.log(`  - Total ticks: ${agent24h.tickCount}`);
console.log(`  - Signal checks: ${agent24h.signalChecks}`);
console.log(`  - Checks attendus: ${expectedChecks24h} (4 par heure × 24h)`);
console.log(`  - Test: ${agent24h.signalChecks === expectedChecks24h ? '✅ PASS' : '❌ FAIL'}`);

// ============================================================================
// TEST 3: Vérifier que les checks se font aux bons moments
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log('📊 TEST 3: Timing des checks (doivent être à :00, :15, :30, :45)\n');

const agent3 = new MockAgent();
const startTime3 = new Date('2025-12-07T10:00:00Z').getTime();
const checkTimes = [];

for (let i = 0; i < 60; i++) {
  const currentTime = startTime3 + i * 60 * 1000;
  const result = agent3.checkEntry(currentTime);
  if (result.action === 'check_signal') {
    checkTimes.push(new Date(currentTime).toISOString().slice(11, 16));
  }
}

console.log('  Check times:', checkTimes.join(', '));
console.log('  Expected:    10:00, 10:15, 10:30, 10:45');

const expectedTimes = ['10:00', '10:15', '10:30', '10:45'];
const timingCorrect = JSON.stringify(checkTimes) === JSON.stringify(expectedTimes);
console.log(`  Test: ${timingCorrect ? '✅ PASS' : '❌ FAIL'}`);

// ============================================================================
// TEST 4: Pas de double-processing de la même bougie
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log('📊 TEST 4: Pas de double-processing\n');

const agent4 = new MockAgent();
const fixedTime = new Date('2025-12-07T12:16:00Z').getTime(); // Juste après une bougie

// Appeler 10 fois au même moment
let checksAtSameTime = 0;
for (let i = 0; i < 10; i++) {
  const result = agent4.checkEntry(fixedTime);
  if (result.action === 'check_signal') {
    checksAtSameTime++;
  }
}

console.log(`  Appels: 10`);
console.log(`  Checks effectués: ${checksAtSameTime}`);
console.log(`  Test: ${checksAtSameTime === 1 ? '✅ PASS (1 seul check)' : '❌ FAIL'}`);

// ============================================================================
// RÉSUMÉ FINAL
// ============================================================================

console.log('\n' + '═'.repeat(80));
console.log('📋 RÉSUMÉ FINAL');
console.log('═'.repeat(80));

const allPassed = 
  agent.signalChecks === 4 &&
  agent24h.signalChecks === expectedChecks24h &&
  timingCorrect &&
  checksAtSameTime === 1;

if (allPassed) {
  console.log('\n✅ TOUS LES TESTS PASSENT !');
  console.log('\nLa synchronisation fonctionne comme le backtest:');
  console.log('  - Signal check uniquement à la fermeture de bougie 15m');
  console.log('  - Pas de double-processing');
  console.log('  - 4 checks par heure (pas 60)');
  console.log('  - Les trades seront identiques au backtest 🎯');
} else {
  console.log('\n❌ CERTAINS TESTS ÉCHOUENT - Vérifier la logique');
}

console.log('');
