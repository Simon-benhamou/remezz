/**
 * ✅ TEST: Late Invalidation Exit Fix
 * 
 * Vérifie que l'agent ferme automatiquement les positions quand le prix
 * reste hors de la zone d'entrée pendant 3+ ticks consécutifs.
 * 
 * Ce fix résout le problème des 238 alertes "late_invalidation_exit"
 * en ajoutant une logique de sortie automatique dans checkExitConditions()
 */

import { ReboundRejectionAgent } from './dist/agent/state.js';

console.log('\n🧪 TEST: Late Invalidation Exit Fix\n');
console.log('=' .repeat(60));

// Scénario de test
const SCENARIO = {
  symbol: 'ADA/USDT',
  side: 'buy',
  entry: 0.8717,
  zone: { from: 0.8650, to: 0.8750 }, // Entry zone ±1%
  stopDistance: 0.0087, // 1% stop
  
  // Prix test
  prices: [
    { tick: 1, price: 0.8700, desc: 'In zone', expectExit: false },
    { tick: 2, price: 0.8720, desc: 'In zone', expectExit: false },
    { tick: 3, price: 0.8600, desc: 'Below zone (tick 1)', expectExit: false },
    { tick: 4, price: 0.8580, desc: 'Below zone (tick 2)', expectExit: false },
    { tick: 5, price: 0.8570, desc: 'Below zone (tick 3) → EXIT', expectExit: true },
  ]
};

console.log(`\n📊 Scenario: ${SCENARIO.symbol} ${SCENARIO.side.toUpperCase()}`);
console.log(`   Entry: $${SCENARIO.entry}`);
console.log(`   Zone: $${SCENARIO.zone.from} - $${SCENARIO.zone.to}`);
console.log(`   Hysteresis: 0.5% (standard)`);

// Créer un mock agent pour tester la logique
class TestAgent extends ReboundRejectionAgent {
  // Exposer les méthodes privées pour le test
  testCheckExitConditions(price, snap) {
    return this.checkExitConditions(price, snap);
  }
  
  testShouldExitOnLateInvalidation(price) {
    return this.shouldExitOnLateInvalidation(price);
  }
  
  getInvalidationTicks() {
    return this.invalidationTicks || 0;
  }
}

async function runTest() {
  const agent = new TestAgent();
  
  // Setup mock position and plan
  agent.pos = {
    side: SCENARIO.side,
    entry: SCENARIO.entry,
    qty: 100,
    stop: SCENARIO.entry - SCENARIO.stopDistance,
    tp: [SCENARIO.entry + SCENARIO.stopDistance * 2],
    openedAt: Date.now() - 5 * 60 * 1000, // 5 min ago
    extended: false,
  };
  
  agent.plan = {
    zone: SCENARIO.zone,
    stopDistance: SCENARIO.stopDistance,
    bias: SCENARIO.side === 'buy' ? 'long' : 'short',
    plan: { risk: { max_hold_hours: 24 } },
  };
  
  agent.profile = {
    symbol: SCENARIO.symbol,
    mode: 'paper',
    maxLeverage: 5,
    riskPerTradePct: 2,
    dailyLossLimitPct: 3,
    timestamp: new Date().toISOString(),
  };
  
  console.log('\n📈 Testing price movements:\n');
  
  let exitDetected = false;
  let exitReason = null;
  
  for (const test of SCENARIO.prices) {
    const snap = {
      last: test.price,
      ema20: test.price,
      ema50: test.price,
      rsi14: 50,
      adx14: 25,
      atr14: 0.01,
    };
    
    const shouldExit = agent.testShouldExitOnLateInvalidation(test.price);
    const exitCondition = agent.testCheckExitConditions(test.price, snap);
    const invalidTicks = agent.getInvalidationTicks();
    
    const exitStatus = shouldExit ? '🚨 EXIT' : '✅ Hold';
    const tickStatus = invalidTicks > 0 ? `[Invalid: ${invalidTicks}]` : '[Valid]';
    
    console.log(`Tick ${test.tick}: $${test.price.toFixed(4)} - ${test.desc.padEnd(25)} ${tickStatus.padEnd(15)} ${exitStatus}`);
    
    if (exitCondition === 'late_invalidation_exit') {
      exitDetected = true;
      exitReason = exitCondition;
    }
    
    // Vérifier que le comportement correspond aux attentes
    if (test.expectExit && !shouldExit) {
      console.log(`   ❌ FAIL: Expected exit but agent held position`);
      return false;
    }
    
    if (!test.expectExit && shouldExit) {
      console.log(`   ❌ FAIL: Unexpected exit (should hold position)`);
      return false;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  
  if (exitDetected) {
    console.log('✅ SUCCESS: Agent correctly detected late invalidation and exited');
    console.log(`   Exit reason: ${exitReason}`);
  } else {
    console.log('❌ FAIL: Agent did not exit when price stayed outside zone');
    return false;
  }
  
  return true;
}

// Test supplémentaire: prix revient dans la zone
async function testPriceReturnToZone() {
  console.log('\n\n🧪 TEST 2: Price returns to zone (should reset counter)\n');
  console.log('=' .repeat(60));
  
  const agent = new TestAgent();
  
  agent.pos = {
    side: 'buy',
    entry: 0.8717,
    qty: 100,
    stop: 0.8630,
    tp: [0.8804],
    openedAt: Date.now() - 5 * 60 * 1000,
    extended: false,
  };
  
  agent.plan = {
    zone: { from: 0.8650, to: 0.8750 },
    stopDistance: 0.0087,
    bias: 'long',
    plan: { risk: { max_hold_hours: 24 } },
  };
  
  agent.profile = {
    symbol: 'ADA/USDT',
    mode: 'paper',
    maxLeverage: 5,
    riskPerTradePct: 2,
    dailyLossLimitPct: 3,
    timestamp: new Date().toISOString(),
  };
  
  const testPrices = [
    { price: 0.8600, desc: 'Below zone (tick 1)' },
    { price: 0.8590, desc: 'Below zone (tick 2)' },
    { price: 0.8700, desc: 'Back in zone → RESET' },
    { price: 0.8580, desc: 'Below zone again (tick 1)' },
  ];
  
  console.log('Testing counter reset when price returns to zone:\n');
  
  for (let i = 0; i < testPrices.length; i++) {
    const { price, desc } = testPrices[i];
    
    agent.testShouldExitOnLateInvalidation(price);
    const invalidTicks = agent.getInvalidationTicks();
    
    console.log(`Tick ${i + 1}: $${price.toFixed(4)} - ${desc.padEnd(30)} [Invalid: ${invalidTicks}]`);
    
    // Vérifier reset après retour dans la zone
    if (i === 2 && invalidTicks !== 0) {
      console.log('   ❌ FAIL: Counter should reset to 0 when price returns to zone');
      return false;
    }
    
    // Vérifier qu'on recommence à compter
    if (i === 3 && invalidTicks !== 1) {
      console.log('   ❌ FAIL: Counter should restart at 1 after reset');
      return false;
    }
  }
  
  console.log('\n✅ SUCCESS: Counter correctly resets when price returns to zone');
  return true;
}

// Exécuter les tests
(async () => {
  try {
    const test1 = await runTest();
    const test2 = await testPriceReturnToZone();
    
    console.log('\n\n' + '='.repeat(60));
    console.log('📊 TEST RESULTS:');
    console.log('='.repeat(60));
    console.log(`Test 1 (Late Invalidation Exit): ${test1 ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Test 2 (Counter Reset):          ${test2 ? '✅ PASS' : '❌ FAIL'}`);
    
    if (test1 && test2) {
      console.log('\n🎉 ALL TESTS PASSED!');
      console.log('\n💡 Impact:');
      console.log('   • No more 238 "late_invalidation_exit" alerts');
      console.log('   • Positions automatically close when price invalidates zone');
      console.log('   • Counter resets if price returns to zone (no false exits)');
      process.exit(0);
    } else {
      console.log('\n❌ SOME TESTS FAILED');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Test error:', err);
    process.exit(1);
  }
})();
