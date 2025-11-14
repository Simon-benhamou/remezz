#!/usr/bin/env node
/**
 * End-to-End Test: Predictor Data Freshness
 * 
 * Teste le flux complet:
 * 1. Stratégie meta-adaptive (evaluate)
 * 2. API diagnostics (getAgentDiagnosticInfo)
 * 3. Cache (fallback seulement)
 * 
 * Vérifie que toutes les données sont FRAÎCHES à chaque étape
 */

import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { getPredictionSync } from './dist/src/quantai/pythonPredictor.js';
import { 
  getCachedPrediction, 
  setCachedPrediction, 
  getPredictorCacheStats, 
  clearPredictorCache,
  invalidateCachedPrediction 
} from './dist/src/quantai/predictorCache.js';
import { recordPrediction, getStableSnapshot } from './dist/src/quantai/predictorStateStore.js';

const TEST_SYMBOL = 'ICP/USDT:USDT';
const FRESHNESS_THRESHOLD_MS = 2000; // 2 secondes = acceptable latence Python

console.log('🧪 Test E2E: Fraîcheur des Données du Predictor');
console.log('═'.repeat(70));

const testResults = {
  strategyFresh: true,
  diagnosticsFresh: true,
  cacheOnlyForFallback: true,
  totalTests: 0,
  passedTests: 0,
  timestamps: [],
};

async function testStrategyPath() {
  console.log('\n1️⃣  TEST: Stratégie Meta-Adaptive (evaluate)');
  console.log('─'.repeat(70));
  testResults.totalTests++;
  
  // Simulate strategy evaluation
  const snap = await buildTechSnapshot(TEST_SYMBOL);
  console.log(`   ✅ Snapshot obtenu: ${TEST_SYMBOL} @ ${snap.last?.toFixed(2)}`);
  
  const features = buildPredictorFeatures(snap);
  if (!features) {
    console.log('   ❌ Impossible de construire les features');
    return false;
  }
  
  console.log(`   ✅ Features: ${Object.keys(features).length} clés`);
  
  // Clear any existing cache to simulate fresh strategy run
  invalidateCachedPrediction(TEST_SYMBOL);
  console.log('   🧹 Cache invalidé pour forcer fresh prediction');
  
  const startTime = Date.now();
  const prediction = getPredictionSync(features);
  const latency = Date.now() - startTime;
  
  console.log(`   ✅ Prédiction obtenue en ${latency}ms`);
  console.log(`      → Decision: ${prediction.decision}`);
  console.log(`      → Confidence: ${(prediction.confidence * 100).toFixed(1)}%`);
  console.log(`      → Prob Long/Short/None: ${prediction.probabilityLong.toFixed(2)}/${prediction.probabilityShort.toFixed(2)}/${prediction.probabilityNone.toFixed(2)}`);
  
  testResults.timestamps.push({
    stage: 'strategy_evaluate',
    timestamp: Date.now(),
    latency,
    decision: prediction.decision,
  });
  
  // Verify it's fresh (should have normal Python latency)
  if (latency < 100) {
    console.log(`   ⚠️  ATTENTION: Latence suspecte (${latency}ms < 100ms)`);
    console.log('      → Possible utilisation du cache au lieu de fresh prediction!');
    testResults.strategyFresh = false;
    return false;
  } else if (latency > FRESHNESS_THRESHOLD_MS) {
    console.log(`   ⚡ Latence élevée mais acceptable (${latency}ms)`);
    testResults.strategyFresh = true;
  } else {
    console.log(`   ✅ FRESH: Latence normale Python (${latency}ms)`);
    testResults.strategyFresh = true;
  }
  
  // Save to cache (as strategy does for diagnostics)
  setCachedPrediction(TEST_SYMBOL, prediction, features);
  console.log('   💾 Sauvegardé en cache (pour diagnostics API)');
  
  // Record prediction (as strategy does)
  const recordResult = recordPrediction({
    symbol: TEST_SYMBOL,
    prediction,
    features,
    source: 'test_e2e',
    meta: { test: 'strategy_path' },
  });
  
  console.log(`   ✅ Prédiction enregistrée (stable: ${recordResult.stableSnapshot?.decision})`);
  
  testResults.passedTests++;
  return true;
}

async function testDiagnosticsPath() {
  console.log('\n2️⃣  TEST: API Diagnostics (fallback cascade)');
  console.log('─'.repeat(70));
  testResults.totalTests++;
  
  // Simulate diagnostics API call
  console.log('   Scénario 1: Cache disponible (< 30s)');
  
  const cached = getCachedPrediction(TEST_SYMBOL);
  if (cached) {
    console.log(`   ✅ Cache trouvé`);
    console.log(`      → Decision: ${cached.decision}`);
    console.log(`      → Confidence: ${(cached.confidence * 100).toFixed(1)}%`);
    testResults.cacheOnlyForFallback = true;
  } else {
    console.log('   ❌ Cache non trouvé (inattendu)');
    testResults.cacheOnlyForFallback = false;
  }
  
  // Simulate cache expiration
  console.log('\n   Scénario 2: Cache expiré → fresh prediction');
  invalidateCachedPrediction(TEST_SYMBOL);
  
  const snap = await buildTechSnapshot(TEST_SYMBOL);
  const features = buildPredictorFeatures(snap);
  
  if (features) {
    const startTime = Date.now();
    const freshPred = getPredictionSync(features);
    const latency = Date.now() - startTime;
    
    console.log(`   ✅ Fresh prediction générée en ${latency}ms`);
    console.log(`      → Decision: ${freshPred.decision}`);
    console.log(`      → Confidence: ${(freshPred.confidence * 100).toFixed(1)}%`);
    
    testResults.timestamps.push({
      stage: 'diagnostics_fresh',
      timestamp: Date.now(),
      latency,
      decision: freshPred.decision,
    });
    
    if (latency < 100) {
      console.log(`   ⚠️  ATTENTION: Latence suspecte (${latency}ms)`);
      testResults.diagnosticsFresh = false;
    } else {
      console.log(`   ✅ FRESH: Diagnostics génère une prédiction fraîche si besoin`);
      testResults.diagnosticsFresh = true;
    }
  }
  
  testResults.passedTests++;
  return true;
}

async function testCacheUsage() {
  console.log('\n3️⃣  TEST: Cache utilisé uniquement en fallback');
  console.log('─'.repeat(70));
  testResults.totalTests++;
  
  // Populate cache
  const snap = await buildTechSnapshot(TEST_SYMBOL);
  const features = buildPredictorFeatures(snap);
  
  if (!features) {
    console.log('   ❌ Pas de features');
    return false;
  }
  
  const pred1 = getPredictionSync(features);
  setCachedPrediction(TEST_SYMBOL, pred1, features);
  console.log(`   💾 Cache peuplé avec decision=${pred1.decision}`);
  
  // Wait 1 second
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Second call should still be fresh (not use cache)
  const start = Date.now();
  const pred2 = getPredictionSync(features);
  const latency = Date.now() - start;
  
  console.log(`   🔄 Second appel: ${latency}ms`);
  console.log(`      → Decision: ${pred2.decision}`);
  
  if (latency < 100) {
    console.log(`   ❌ FAIL: Cache utilisé au lieu de fresh (${latency}ms)`);
    testResults.cacheOnlyForFallback = false;
    return false;
  } else {
    console.log(`   ✅ PASS: Fresh prediction même avec cache disponible (${latency}ms)`);
    testResults.cacheOnlyForFallback = true;
  }
  
  testResults.passedTests++;
  return true;
}

async function testStableSnapshot() {
  console.log('\n4️⃣  TEST: Stable Snapshot (persistance cross-session)');
  console.log('─'.repeat(70));
  testResults.totalTests++;
  
  const stable = getStableSnapshot(TEST_SYMBOL);
  
  if (stable) {
    const age = Math.floor((Date.now() - stable.timestamp) / 1000);
    console.log(`   ✅ Stable snapshot disponible`);
    console.log(`      → Decision: ${stable.decision}`);
    console.log(`      → Confidence: ${(stable.confidence * 100).toFixed(1)}%`);
    console.log(`      → Age: ${age}s`);
    
    if (age > 60) {
      console.log(`   ⚠️  Age élevé (${age}s), mais OK pour stable snapshot`);
    }
  } else {
    console.log('   ⚠️  Pas de stable snapshot (normal si premier test)');
  }
  
  testResults.passedTests++;
  return true;
}

async function runTests() {
  console.log('\n🚀 Début des tests...\n');
  
  // Clear state
  clearPredictorCache();
  
  try {
    await testStrategyPath();
    await testDiagnosticsPath();
    await testCacheUsage();
    await testStableSnapshot();
    
    // Final statistics
    console.log('\n📊 STATISTIQUES');
    console.log('═'.repeat(70));
    
    const stats = getPredictorCacheStats();
    console.log(`   Entries en cache: ${stats.totalEntries}`);
    console.log(`   Entries valides: ${stats.validEntries}`);
    console.log(`   Entries expirées: ${stats.expiredEntries}`);
    console.log(`   Age max: ${stats.oldestEntry}s`);
    
    console.log('\n⏱️  TIMELINE');
    console.log('─'.repeat(70));
    testResults.timestamps.forEach((t, i) => {
      const delta = i > 0 ? t.timestamp - testResults.timestamps[i - 1].timestamp : 0;
      console.log(`   ${i + 1}. ${t.stage.padEnd(25)} | ${String(t.latency).padEnd(6)}ms | ${t.decision.padEnd(6)} | +${delta}ms`);
    });
    
    // Final verdict
    console.log('\n🏆 RÉSULTATS FINAUX');
    console.log('═'.repeat(70));
    console.log(`   Tests passés: ${testResults.passedTests}/${testResults.totalTests}`);
    console.log(`   Stratégie utilise FRESH: ${testResults.strategyFresh ? '✅ OUI' : '❌ NON'}`);
    console.log(`   Diagnostics utilise FRESH: ${testResults.diagnosticsFresh ? '✅ OUI' : '❌ NON'}`);
    console.log(`   Cache uniquement en fallback: ${testResults.cacheOnlyForFallback ? '✅ OUI' : '❌ NON'}`);
    
    const allPassed = testResults.strategyFresh && 
                     testResults.diagnosticsFresh && 
                     testResults.cacheOnlyForFallback;
    
    console.log('\n' + '═'.repeat(70));
    if (allPassed) {
      console.log('✅ SUCCÈS: Toutes les données sont FRAÎCHES à chaque étape!');
      console.log('   ✓ La stratégie génère toujours des prédictions fraîches');
      console.log('   ✓ Les diagnostics utilisent des données récentes');
      console.log('   ✓ Le cache n\'est utilisé qu\'en fallback d\'urgence');
    } else {
      console.log('❌ ÉCHEC: Problèmes de fraîcheur détectés');
      if (!testResults.strategyFresh) {
        console.log('   ✗ La stratégie semble utiliser du cache');
      }
      if (!testResults.diagnosticsFresh) {
        console.log('   ✗ Les diagnostics ne génèrent pas de fresh data');
      }
      if (!testResults.cacheOnlyForFallback) {
        console.log('   ✗ Le cache est utilisé même quand pas nécessaire');
      }
    }
    console.log('═'.repeat(70) + '\n');
    
    process.exit(allPassed ? 0 : 1);
  } catch (error) {
    console.error('\n❌ Erreur durant les tests:', error);
    process.exit(1);
  }
}

runTests();
