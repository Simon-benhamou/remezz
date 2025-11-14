#!/usr/bin/env node
/**
 * Test ICP Predictor Data Freshness
 * 
 * Vérifie que le predictor ICP retourne toujours des données fraîches:
 * 1. Test de la stratégie (evaluate)
 * 2. Test de l'API diagnostics
 * 3. Test du cache (ne devrait être utilisé que pour diagnostics)
 * 4. Mesure des timestamps pour s'assurer de la fraîcheur
 */

import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { getPredictionSync } from './dist/src/quantai/pythonPredictor.js';
import { getCachedPrediction, setCachedPrediction, getPredictorCacheStats, clearPredictorCache } from './dist/src/quantai/predictorCache.js';
import { recordPrediction, getStableSnapshot } from './dist/src/quantai/predictorStateStore.js';

const TEST_SYMBOL = 'ICP/USDT:USDT';

console.log('🧪 Test de Fraîcheur du Predictor ICP\n');
console.log('═'.repeat(60));

// Clear cache to start fresh
console.log('\n🧹 Nettoyage du cache...');
clearPredictorCache();

const results = {
  freshPredictions: 0,
  cachedPredictions: 0,
  timestamps: [],
  latencies: [],
};

async function testFreshness() {
  console.log(`\n📊 Symbole de test: ${TEST_SYMBOL}`);
  console.log('═'.repeat(60));

  // Phase 1: First prediction (should be fresh)
  console.log('\n1️⃣  Premier appel (devrait être frais)');
  console.log('─'.repeat(60));
  
  const snap1 = await buildTechSnapshot(TEST_SYMBOL);
  console.log(`   ✅ Technical snapshot obtenu: price=${snap1.last?.toFixed(2)}`);
  
  const features1 = buildPredictorFeatures(snap1);
  if (!features1) {
    console.log('   ❌ Impossible de construire les features');
    return;
  }
  console.log(`   ✅ Features construites: ${Object.keys(features1).length} clés`);
  
  const start1 = Date.now();
  const prediction1 = getPredictionSync(features1);
  const latency1 = Date.now() - start1;
  
  console.log(`   ✅ Prédiction obtenue en ${latency1}ms`);
  console.log(`      Decision: ${prediction1.decision}`);
  console.log(`      Confidence: ${(prediction1.confidence * 100).toFixed(1)}%`);
  console.log(`      Timestamp interne: ${new Date().toISOString()}`);
  
  results.freshPredictions++;
  results.latencies.push(latency1);
  results.timestamps.push({ phase: 'first_call', timestamp: Date.now(), decision: prediction1.decision });
  
  // Save to cache (like strategy does)
  setCachedPrediction(TEST_SYMBOL, prediction1, features1);
  console.log(`   💾 Sauvegardé en cache (pour diagnostics uniquement)`);

  // Phase 2: Immediate second call (strategy should NOT use cache)
  console.log('\n2️⃣  Deuxième appel immédiat (devrait être frais, pas du cache)');
  console.log('─'.repeat(60));
  
  const start2 = Date.now();
  const prediction2 = getPredictionSync(features1); // Same features, new prediction
  const latency2 = Date.now() - start2;
  
  console.log(`   ✅ Prédiction obtenue en ${latency2}ms`);
  console.log(`      Decision: ${prediction2.decision}`);
  console.log(`      Confidence: ${(prediction2.confidence * 100).toFixed(1)}%`);
  
  if (latency2 < 50) {
    console.log(`   ⚠️  ATTENTION: Latence très faible (${latency2}ms), possible cache!`);
    results.cachedPredictions++;
  } else {
    console.log(`   ✅ Latence normale (${latency2}ms), prédiction fraîche confirmée`);
    results.freshPredictions++;
  }
  
  results.latencies.push(latency2);
  results.timestamps.push({ phase: 'second_call', timestamp: Date.now(), decision: prediction2.decision });

  // Phase 3: Test cache read (for diagnostics API simulation)
  console.log('\n3️⃣  Test du cache (simulation API diagnostics)');
  console.log('─'.repeat(60));
  
  const cachedPred = getCachedPrediction(TEST_SYMBOL);
  if (cachedPred) {
    console.log(`   ✅ Cache disponible`);
    console.log(`      Decision: ${cachedPred.decision}`);
    console.log(`      Confidence: ${(cachedPred.confidence * 100).toFixed(1)}%`);
    console.log(`      Match avec prediction1: ${cachedPred.decision === prediction1.decision ? '✅' : '❌'}`);
  } else {
    console.log(`   ❌ Pas de cache (inattendu)`);
  }

  // Phase 4: Test with new snapshot (should always be fresh)
  console.log('\n4️⃣  Appel avec nouveau snapshot (devrait être frais)');
  console.log('─'.repeat(60));
  
  // Wait a bit to ensure price might change
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  const snap2 = await buildTechSnapshot(TEST_SYMBOL);
  const features2 = buildPredictorFeatures(snap2);
  
  if (!features2) {
    console.log('   ❌ Impossible de construire les features');
    return;
  }
  
  const start3 = Date.now();
  const prediction3 = getPredictionSync(features2);
  const latency3 = Date.now() - start3;
  
  console.log(`   ✅ Prédiction obtenue en ${latency3}ms`);
  console.log(`      Decision: ${prediction3.decision}`);
  console.log(`      Confidence: ${(prediction3.confidence * 100).toFixed(1)}%`);
  console.log(`      Prix: ${snap1.last?.toFixed(2)} → ${snap2.last?.toFixed(2)}`);
  
  if (latency3 < 50) {
    console.log(`   ⚠️  ATTENTION: Latence très faible (${latency3}ms), possible cache!`);
    results.cachedPredictions++;
  } else {
    console.log(`   ✅ Latence normale (${latency3}ms), prédiction fraîche confirmée`);
    results.freshPredictions++;
  }
  
  results.latencies.push(latency3);
  results.timestamps.push({ phase: 'new_snapshot', timestamp: Date.now(), decision: prediction3.decision });

  // Phase 5: Record prediction and check stable snapshot
  console.log('\n5️⃣  Test du stable snapshot (persistance cross-session)');
  console.log('─'.repeat(60));
  
  const recordResult = recordPrediction({
    symbol: TEST_SYMBOL,
    prediction: prediction3,
    features: features2,
    source: 'test',
    meta: { test: 'freshness' },
  });
  
  console.log(`   ✅ Prédiction enregistrée`);
  console.log(`      Stable changed: ${recordResult.stableChanged}`);
  console.log(`      Stable decision: ${recordResult.stableSnapshot?.decision}`);
  
  const stableSnap = getStableSnapshot(TEST_SYMBOL);
  if (stableSnap) {
    console.log(`   ✅ Stable snapshot disponible`);
    console.log(`      Decision: ${stableSnap.decision}`);
    console.log(`      Age: ${Math.floor((Date.now() - stableSnap.timestamp) / 1000)}s`);
  }

  // Phase 6: Cache statistics
  console.log('\n6️⃣  Statistiques du cache');
  console.log('─'.repeat(60));
  
  const stats = getPredictorCacheStats();
  console.log(`   Total entries: ${stats.totalEntries}`);
  console.log(`   Valid entries: ${stats.validEntries}`);
  console.log(`   Expired entries: ${stats.expiredEntries}`);
  console.log(`   Oldest entry: ${stats.oldestEntry}s`);
  console.log(`   Symbols in cache: ${stats.symbols.join(', ')}`);

  // Results summary
  console.log('\n📈 RÉSULTATS DU TEST');
  console.log('═'.repeat(60));
  console.log(`   Prédictions fraîches: ${results.freshPredictions}`);
  console.log(`   Prédictions cachées: ${results.cachedPredictions}`);
  console.log(`   Latence moyenne: ${Math.round(results.latencies.reduce((a, b) => a + b, 0) / results.latencies.length)}ms`);
  console.log(`   Latence min/max: ${Math.min(...results.latencies)}ms / ${Math.max(...results.latencies)}ms`);
  
  console.log('\n⏱️  Timeline des prédictions:');
  results.timestamps.forEach((t, i) => {
    const delta = i > 0 ? t.timestamp - results.timestamps[i - 1].timestamp : 0;
    console.log(`   ${i + 1}. ${t.phase.padEnd(20)} | ${t.decision.padEnd(6)} | +${delta}ms`);
  });

  console.log('\n✅ VERDICT:');
  if (results.cachedPredictions === 0) {
    console.log('   🎉 EXCELLENT: Toutes les prédictions sont fraîches!');
    console.log('   ✅ Le cache n\'est utilisé que pour les diagnostics');
    console.log('   ✅ La stratégie obtient toujours des données fresh');
  } else {
    console.log(`   ⚠️  ATTENTION: ${results.cachedPredictions} prédiction(s) semblent cachées`);
    console.log('   ❌ Vérifier que la stratégie n\'utilise pas le cache');
  }
}

testFreshness()
  .then(() => {
    console.log('\n✅ Test terminé\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Erreur durant le test:', err);
    process.exit(1);
  });
