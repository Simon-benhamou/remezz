#!/usr/bin/env node
/**
 * Test du Predictor en Direct - Fiabilité et Distribution des Prédictions
 * 
 * Ce script teste le prédicteur Python sur plusieurs symboles actifs
 * pour analyser sa fiabilité et comprendre pourquoi il retourne principalement "none"
 * 
 * Usage:
 *   node test-predictor-reliability.mjs
 *   node test-predictor-reliability.mjs --symbols BTC/USDT,ETH/USDT,XRP/USDT
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les modules compilés
const pythonPredictorPath = join(__dirname, 'dist/src/quantai/pythonPredictor.js');
const techPath = join(__dirname, 'dist/src/ai/tech.js');

const { getPredictionSync, getPredictorReliabilityMetrics, isPythonPredictorAvailable } = await import(pythonPredictorPath);
const { buildTechSnapshot } = await import(techPath);

// Parse arguments
const args = process.argv.slice(2);
const symbolsArg = args.find(arg => arg.startsWith('--symbols='));
const defaultSymbols = [
  'BTC/USDT',
  'ETH/USDT',
  'XRP/USDT',
  'SOL/USDT',
  'BNB/USDT',
  'ADA/USDT',
  'DOT/USDT',
  'MATIC/USDT',
  'LINK/USDT',
  'UNI/USDT'
];

const testSymbols = symbolsArg 
  ? symbolsArg.split('=')[1].split(',').map(s => s.trim())
  : defaultSymbols;

console.log('\n═══════════════════════════════════════════════════════');
console.log('  🧪 TEST DE FIABILITÉ DU PREDICTOR PYTHON');
console.log('═══════════════════════════════════════════════════════\n');

// Vérifier disponibilité Python
console.log('🔍 Vérification de la disponibilité du prédicteur Python...\n');
const pythonAvailable = isPythonPredictorAvailable();

if (!pythonAvailable) {
  console.error('❌ Le prédicteur Python n\'est pas disponible!');
  console.error('   Vérifiez que Python 3 est installé et que le modèle est entraîné.\n');
  process.exit(1);
}

console.log('✅ Prédicteur Python disponible\n');

// Fonction helper pour construire les features
function buildPredictorFeatures(snap) {
  if (!snap) return null;
  
  try {
    const ema20_50_pct = snap.ema20 && snap.ema50 ? ((snap.ema20 - snap.ema50) / snap.ema50) * 100 : 0;
    const bb_position = snap.bb?.position ?? 0.5;
    const bb_width_pct = snap.bb?.widthPct ?? 1;
    
    return {
      rsi_14: snap.rsi14 ?? 50,
      macd_line: snap.macd?.macd ?? 0,
      macd_signal: snap.macd?.signal ?? 0,
      macd_histogram: snap.macd?.histogram ?? 0,
      ema_20: snap.ema20 ?? 0,
      ema_50: snap.ema50 ?? 0,
      ema20_50_pct,
      atr_14: snap.atr14 ?? 0,
      atr_14_pct: snap.atrPct ?? 0,
      adx_14: snap.adx14 ?? 0,
      bb_upper: snap.bb?.upper ?? 0,
      bb_middle: snap.bb?.middle ?? 0,
      bb_lower: snap.bb?.lower ?? 0,
      bb_position,
      bb_width_pct,
      volume_sma_20: snap.volumeSma20 ?? 0,
      volume_ratio: snap.volumeRatio ?? 1,
      obv: snap.obv ?? 0,
      obv_ema: snap.obvEma ?? 0,
      price_change_1h_pct: snap.priceChange1h ?? 0,
      price_change_4h_pct: snap.priceChange4h ?? 0,
      price_change_24h_pct: snap.priceChange24h ?? 0,
      high_low_range_pct: snap.highLowRangePct ?? 0,
      close_open_pct: snap.closeOpenPct ?? 0,
      ema20_slope: snap.ema20Slope ?? 0,
    };
  } catch (error) {
    console.error('Erreur construction features:', error);
    return null;
  }
}

// Statistiques globales
const results = {
  total: 0,
  successful: 0,
  failed: 0,
  byDecision: {
    long: 0,
    short: 0,
    none: 0
  },
  confidenceSum: 0,
  edgeSum: 0,
  predictions: []
};

console.log(`📊 Test sur ${testSymbols.length} symboles...\n`);

// Tester chaque symbole
for (const symbol of testSymbols) {
  try {
    console.log(`\n🔍 Test: ${symbol}`);
    
    // 1. Construire le snapshot technique
    const snap = await buildTechSnapshot(symbol);
    
    if (!snap) {
      console.log(`   ⚠️  Pas de données disponibles`);
      results.failed++;
      continue;
    }
    
    // 2. Construire les features
    const features = buildPredictorFeatures(snap);
    
    if (!features) {
      console.log(`   ⚠️  Impossible de construire les features`);
      results.failed++;
      continue;
    }
    
    // 3. Appeler le prédicteur
    const prediction = getPredictionSync(features);
    
    // 4. Analyser la réponse
    results.total++;
    results.successful++;
    results.byDecision[prediction.decision]++;
    results.confidenceSum += prediction.confidence;
    
    const primaryProb = prediction.decision === 'long' 
      ? prediction.probabilityLong 
      : prediction.decision === 'short'
        ? prediction.probabilityShort
        : prediction.probabilityNone;
    
    const edge = Math.abs(primaryProb - 0.5);
    results.edgeSum += edge;
    
    // Stocker pour analyse détaillée
    results.predictions.push({
      symbol,
      decision: prediction.decision,
      confidence: prediction.confidence,
      edge,
      probLong: prediction.probabilityLong,
      probShort: prediction.probabilityShort,
      probNone: prediction.probabilityNone,
      primaryProb,
      // Contexte technique
      rsi: features.rsi_14,
      atr: features.atr_14_pct,
      adx: features.adx_14,
      macdHist: features.macd_histogram,
      volumeRatio: features.volume_ratio
    });
    
    // Afficher résumé
    const emoji = prediction.decision === 'long' ? '🟢' 
                : prediction.decision === 'short' ? '🔴' 
                : '⚪';
    
    console.log(`   ${emoji} Décision: ${prediction.decision.toUpperCase()}`);
    console.log(`   📊 Confiance: ${(prediction.confidence * 100).toFixed(1)}%`);
    console.log(`   🎯 Edge: ${(edge * 100).toFixed(1)}%`);
    console.log(`   📈 Probabilities: L=${(prediction.probabilityLong*100).toFixed(1)}% | S=${(prediction.probabilityShort*100).toFixed(1)}% | N=${(prediction.probabilityNone*100).toFixed(1)}%`);
    console.log(`   📊 Context: RSI=${features.rsi_14.toFixed(1)} | ATR=${features.atr_14_pct.toFixed(2)}% | ADX=${features.adx_14.toFixed(1)}`);
    
  } catch (error) {
    console.log(`   ❌ Erreur: ${error.message}`);
    results.failed++;
    results.total++;
  }
}

// Récupérer les métriques de fiabilité
const reliabilityMetrics = getPredictorReliabilityMetrics();

// Afficher le rapport final
console.log('\n\n═══════════════════════════════════════════════════════');
console.log('  📊 RAPPORT DE FIABILITÉ DU PREDICTOR');
console.log('═══════════════════════════════════════════════════════\n');

console.log('🎯 MÉTRIQUES DE FIABILITÉ:\n');
console.log(`   Total d'appels: ${reliabilityMetrics.totalCalls}`);
console.log(`   Succès: ${reliabilityMetrics.successfulCalls} (${(reliabilityMetrics.reliabilityRate * 100).toFixed(1)}%)`);
console.log(`   Échecs: ${reliabilityMetrics.failedCalls}`);
console.log(`   Échecs consécutifs: ${reliabilityMetrics.consecutiveFailures}`);
console.log(`   Fiable (≥95%): ${reliabilityMetrics.isReliable ? '✅ OUI' : '❌ NON'}`);

if (reliabilityMetrics.lastErrorMessage) {
  console.log(`   Dernière erreur: ${reliabilityMetrics.lastErrorMessage}`);
}

console.log('\n\n📊 DISTRIBUTION DES PRÉDICTIONS:\n');
console.log(`   🟢 LONG:  ${results.byDecision.long.toString().padStart(2)} (${((results.byDecision.long / results.successful) * 100).toFixed(1)}%)`);
console.log(`   🔴 SHORT: ${results.byDecision.short.toString().padStart(2)} (${((results.byDecision.short / results.successful) * 100).toFixed(1)}%)`);
console.log(`   ⚪ NONE:  ${results.byDecision.none.toString().padStart(2)} (${((results.byDecision.none / results.successful) * 100).toFixed(1)}%)`);

console.log('\n\n📈 STATISTIQUES DE QUALITÉ:\n');
const avgConfidence = results.successful > 0 ? results.confidenceSum / results.successful : 0;
const avgEdge = results.successful > 0 ? results.edgeSum / results.successful : 0;

console.log(`   Confiance moyenne: ${(avgConfidence * 100).toFixed(1)}%`);
console.log(`   Edge moyen: ${(avgEdge * 100).toFixed(1)}%`);

// Analyser les 'none' en détail
const nonePredictions = results.predictions.filter(p => p.decision === 'none');
if (nonePredictions.length > 0) {
  console.log('\n\n🔍 ANALYSE DES PRÉDICTIONS "NONE":\n');
  
  const avgNoneConfidence = nonePredictions.reduce((sum, p) => sum + p.confidence, 0) / nonePredictions.length;
  const avgNoneEdge = nonePredictions.reduce((sum, p) => sum + p.edge, 0) / nonePredictions.length;
  const avgNoneRSI = nonePredictions.reduce((sum, p) => sum + p.rsi, 0) / nonePredictions.length;
  const avgNoneATR = nonePredictions.reduce((sum, p) => sum + p.atr, 0) / nonePredictions.length;
  const avgNoneADX = nonePredictions.reduce((sum, p) => sum + p.adx, 0) / nonePredictions.length;
  
  console.log(`   Confiance moyenne: ${(avgNoneConfidence * 100).toFixed(1)}%`);
  console.log(`   Edge moyen: ${(avgNoneEdge * 100).toFixed(1)}%`);
  console.log(`   RSI moyen: ${avgNoneRSI.toFixed(1)}`);
  console.log(`   ATR moyen: ${avgNoneATR.toFixed(2)}%`);
  console.log(`   ADX moyen: ${avgNoneADX.toFixed(1)}`);
  
  // Identifier les patterns
  const lowVolatility = nonePredictions.filter(p => p.atr < 1.0).length;
  const neutralRSI = nonePredictions.filter(p => p.rsi > 40 && p.rsi < 60).length;
  const weakTrend = nonePredictions.filter(p => p.adx < 20).length;
  
  console.log('\n   📊 Patterns identifiés:');
  console.log(`      Faible volatilité (ATR<1%): ${lowVolatility}/${nonePredictions.length} (${((lowVolatility/nonePredictions.length)*100).toFixed(0)}%)`);
  console.log(`      RSI neutre (40-60): ${neutralRSI}/${nonePredictions.length} (${((neutralRSI/nonePredictions.length)*100).toFixed(0)}%)`);
  console.log(`      Tendance faible (ADX<20): ${weakTrend}/${nonePredictions.length} (${((weakTrend/nonePredictions.length)*100).toFixed(0)}%)`);
}

// Top predictions par edge
console.log('\n\n🏆 TOP 5 PRÉDICTIONS PAR EDGE:\n');
const topPredictions = results.predictions
  .filter(p => p.decision !== 'none')
  .sort((a, b) => b.edge - a.edge)
  .slice(0, 5);

topPredictions.forEach((pred, idx) => {
  const emoji = pred.decision === 'long' ? '🟢' : '🔴';
  console.log(`   ${idx + 1}. ${emoji} ${pred.symbol.padEnd(12)} | Edge: ${(pred.edge*100).toFixed(1)}% | Conf: ${(pred.confidence*100).toFixed(1)}% | ${pred.decision.toUpperCase()}`);
});

console.log('\n\n💡 RECOMMANDATIONS:\n');

const nonePercent = (results.byDecision.none / results.successful) * 100;

if (nonePercent > 70) {
  console.log('   ⚠️  Le prédicteur retourne trop de "none" (>70%)');
  console.log('   📝 Causes possibles:');
  console.log('      • Seuil de confiance trop strict dans le modèle');
  console.log('      • Marchés trop calmes (faible volatilité)');
  console.log('      • Modèle entraîné sur des données plus volatiles');
  console.log('\n   🔧 Solutions:');
  console.log('      1. Ré-entraîner le modèle avec des données 15m récentes');
  console.log('      2. Ajuster les seuils de confiance dans predict_service.py');
  console.log('      3. Utiliser le prédicteur comme "prior" soft au lieu de gate dur');
} else if (nonePercent > 50) {
  console.log('   ⚠️  Le prédicteur est prudent (>50% de "none")');
  console.log('   📝 Considérer:');
  console.log('      • Utiliser le prédicteur en mode "soft prior" pour la sélection');
  console.log('      • Ne gater que les signaux fortement opposés');
} else {
  console.log('   ✅ Distribution saine des prédictions');
  console.log('   📝 Le prédicteur peut être utilisé comme gate avec:');
  console.log('      • requireSignalAtStart: true (démarrage)');
  console.log('      • minStartEdge: 0.015-0.02');
  console.log('      • minStartConfidence: 0.55-0.60');
}

if (avgConfidence < 0.6) {
  console.log('\n   ⚠️  Confiance moyenne faible (<60%)');
  console.log('   📝 Envisager un ré-entraînement avec plus de données');
}

if (avgEdge < 0.05) {
  console.log('\n   ⚠️  Edge moyen faible (<5%)');
  console.log('   📝 Le prédicteur manque de conviction - utiliser en mode "advisory"');
}

if (!reliabilityMetrics.isReliable) {
  console.log('\n   🚨 FIABILITÉ CRITIQUE: Taux de succès < 95%!');
  console.log('   📝 Actions immédiates:');
  console.log('      • Vérifier les logs Python pour les erreurs');
  console.log('      • Vérifier que le modèle xgb_predictor.pkl existe');
  console.log('      • Tester manuellement: python3 python/predict_service.py');
}

console.log('\n═══════════════════════════════════════════════════════\n');

// Charger les métriques d'entraînement si disponibles
try {
  const metricsPath = join(__dirname, 'python/training_metrics.json');
  const metricsContent = readFileSync(metricsPath, 'utf-8');
  const trainingMetrics = JSON.parse(metricsContent);
  
  console.log('📚 MÉTRIQUES D\'ENTRAÎNEMENT (training_metrics.json):\n');
  console.log(`   Accuracy: ${(trainingMetrics.accuracy * 100).toFixed(1)}%`);
  console.log(`   F1-Score: ${(trainingMetrics.f1_score * 100).toFixed(1)}%`);
  console.log(`   Precision: ${(trainingMetrics.precision * 100).toFixed(1)}%`);
  console.log(`   Recall: ${(trainingMetrics.recall * 100).toFixed(1)}%`);
  console.log(`   Samples: ${trainingMetrics.samples}`);
  console.log(`   Timestamp: ${new Date(trainingMetrics.timestamp).toLocaleString()}`);
  
  const daysSinceTraining = (Date.now() - trainingMetrics.timestamp) / (1000 * 60 * 60 * 24);
  console.log(`   Age: ${daysSinceTraining.toFixed(1)} jours\n`);
  
  if (daysSinceTraining > 7) {
    console.log('   ⚠️  Modèle ancien (>7 jours) - considérer un ré-entraînement\n');
  }
  
} catch (error) {
  console.log('⚠️  training_metrics.json introuvable - le modèle n\'a peut-être pas été entraîné\n');
}

console.log('═══════════════════════════════════════════════════════\n');
