#!/usr/bin/env node
/**
 * Test Predictor sur Tous les Agents Actifs
 * 
 * Ce script teste le prédicteur Python sur tous les agents en cours
 * et génère un rapport détaillé avec statistiques par symbole
 */

import dotenv from 'dotenv';
dotenv.config();

const { getPredictionSync, getPredictorReliabilityMetrics } = await import('./dist/src/quantai/pythonPredictor.js');
const { buildTechSnapshot } = await import('./dist/src/ai/tech.js');
const { buildPredictorFeatures } = await import('./dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const { PrismaClient } = await import('@prisma/client');

const prisma = new PrismaClient();

console.log('\n═══════════════════════════════════════════════════════');
console.log('  🤖 TEST PREDICTOR - TOUS LES AGENTS ACTIFS');
console.log('═══════════════════════════════════════════════════════\n');

// Récupérer tous les agents actifs
const activeAgents = await prisma.agentSession.findMany({
  where: {
    stoppedAt: null,
  },
  select: {
    id: true,
    symbol: true,
    mode: true,
    startedAt: true,
    startBalanceUsd: true,
    isSmartAgent: true,
    userId: true,
  },
  orderBy: {
    startedAt: 'desc',
  },
});

if (activeAgents.length === 0) {
  console.log('❌ Aucun agent actif trouvé\n');
  process.exit(0);
}

console.log(`📊 ${activeAgents.length} agent(s) actif(s) trouvé(s)\n`);

// Structure pour les résultats
const results = {
  totalAgents: activeAgents.length,
  successful: 0,
  failed: 0,
  bySymbol: new Map(),
  byDecision: {
    long: 0,
    short: 0,
    none: 0,
  },
  predictions: [],
};

// Tester chaque agent
for (const agent of activeAgents) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🔍 Agent: ${agent.id.slice(0, 12)}...`);
  console.log(`   Symbole: ${agent.symbol}`);
  console.log(`   Mode: ${agent.mode.toUpperCase()}`);
  console.log(`   Smart: ${agent.isSmartAgent ? 'OUI' : 'NON'}`);
  console.log(`   Démarré: ${new Date(agent.startedAt).toLocaleString('fr-FR')}`);
  
  try {
    // 1. Construire le snapshot technique
    console.log(`\n   📡 Récupération des données techniques...`);
    const snap = await buildTechSnapshot(agent.symbol, agent.userId);
    
    if (!snap) {
      console.log(`   ❌ Pas de données disponibles`);
      results.failed++;
      continue;
    }
    
    console.log(`   ✅ Snapshot obtenu: last=${snap.last?.toFixed(2)}`);
    
    // 2. Construire les features
    const features = buildPredictorFeatures(snap);
    
    if (!features) {
      console.log(`   ❌ Impossible de construire les features`);
      results.failed++;
      continue;
    }
    
    const featureCount = Object.keys(features).length;
    console.log(`   ✅ ${featureCount} features construites`);
    
    // 3. Obtenir la prédiction
    console.log(`\n   🤖 Appel du prédicteur...`);
    const prediction = getPredictionSync(features);
    
    results.successful++;
    results.byDecision[prediction.decision]++;
    
    // Calculer les métriques
    const primaryProb = prediction.decision === 'long' 
      ? prediction.probabilityLong 
      : prediction.decision === 'short'
        ? prediction.probabilityShort
        : prediction.probabilityNone;
    
    const edge = Math.abs(prediction.probabilityLong - prediction.probabilityShort);
    const directionalClarity = prediction.decision === 'none' 
      ? 0 
      : (primaryProb - prediction.probabilityNone);
    
    // Stocker par symbole
    if (!results.bySymbol.has(agent.symbol)) {
      results.bySymbol.set(agent.symbol, {
        count: 0,
        predictions: [],
        avgConfidence: 0,
        avgEdge: 0,
        byDecision: { long: 0, short: 0, none: 0 },
      });
    }
    
    const symbolStats = results.bySymbol.get(agent.symbol);
    symbolStats.count++;
    symbolStats.byDecision[prediction.decision]++;
    symbolStats.avgConfidence += prediction.confidence;
    symbolStats.avgEdge += edge;
    symbolStats.predictions.push({
      agentId: agent.id,
      decision: prediction.decision,
      confidence: prediction.confidence,
      edge,
      directionalClarity,
    });
    
    // Stocker globalement
    results.predictions.push({
      agentId: agent.id,
      symbol: agent.symbol,
      mode: agent.mode,
      isSmartAgent: agent.isSmartAgent,
      decision: prediction.decision,
      confidence: prediction.confidence,
      edge,
      directionalClarity,
      probLong: prediction.probabilityLong,
      probShort: prediction.probabilityShort,
      probNone: prediction.probabilityNone,
      primaryProb,
      // Contexte technique
      rsi: features.rsi14,
      atr: features.atrPct,
      adx: features.adx14,
    });
    
    // Afficher résultat
    const emoji = prediction.decision === 'long' ? '🟢' 
                : prediction.decision === 'short' ? '🔴' 
                : '⚪';
    
    console.log(`\n   ${emoji} DÉCISION: ${prediction.decision.toUpperCase()}`);
    console.log(`   📊 Confiance: ${(prediction.confidence * 100).toFixed(1)}%`);
    console.log(`   🎯 Edge: ${(edge * 100).toFixed(1)}%`);
    console.log(`   🔍 Clarté directionnelle: ${(directionalClarity * 100).toFixed(1)}%`);
    console.log(`   📈 Probabilités:`);
    console.log(`      LONG:  ${(prediction.probabilityLong*100).toFixed(1)}%`);
    console.log(`      SHORT: ${(prediction.probabilityShort*100).toFixed(1)}%`);
    console.log(`      NONE:  ${(prediction.probabilityNone*100).toFixed(1)}%`);
    console.log(`   📊 Contexte technique:`);
    console.log(`      RSI: ${features.rsi14.toFixed(1)}`);
    console.log(`      ATR: ${(features.atrPct*100).toFixed(2)}%`);
    console.log(`      ADX: ${features.adx14.toFixed(1)}`);
    
    // Évaluation de la qualité du signal
    const meetsEdge = edge >= 0.05; // 5% minimum
    const meetsConfidence = prediction.confidence >= 0.50; // 50% minimum
    const meetsClarity = directionalClarity >= 0.10; // 10% minimum
    const isDirectional = prediction.decision !== 'none';
    
    const passesGate = isDirectional && meetsEdge && meetsConfidence && meetsClarity;
    
    console.log(`\n   🚪 Évaluation du gate prédicteur:`);
    console.log(`      ${meetsEdge ? '✅' : '❌'} Edge (${(edge*100).toFixed(1)}% ${meetsEdge ? '≥' : '<'} 5%)`);
    console.log(`      ${meetsConfidence ? '✅' : '❌'} Confiance (${(prediction.confidence*100).toFixed(1)}% ${meetsConfidence ? '≥' : '<'} 50%)`);
    console.log(`      ${meetsClarity ? '✅' : '❌'} Clarté (${(directionalClarity*100).toFixed(1)}% ${meetsClarity ? '≥' : '<'} 10%)`);
    console.log(`      ${isDirectional ? '✅' : '❌'} Directionnel (${prediction.decision !== 'none' ? 'OUI' : 'NON'})`);
    console.log(`      ${passesGate ? '✅ PASSE LE GATE' : '❌ NE PASSE PAS LE GATE'}`);
    
  } catch (error) {
    console.log(`\n   ❌ Erreur: ${error.message}`);
    results.failed++;
  }
}

// Calculer les moyennes par symbole
for (const [symbol, stats] of results.bySymbol.entries()) {
  stats.avgConfidence /= stats.count;
  stats.avgEdge /= stats.count;
}

// Métriques de fiabilité du prédicteur
const reliabilityMetrics = getPredictorReliabilityMetrics();

// Afficher le rapport final
console.log('\n\n═══════════════════════════════════════════════════════');
console.log('  📊 RAPPORT GLOBAL');
console.log('═══════════════════════════════════════════════════════\n');

console.log('🎯 STATISTIQUES GLOBALES:\n');
console.log(`   Total d'agents testés: ${results.totalAgents}`);
console.log(`   Succès: ${results.successful} (${((results.successful / results.totalAgents) * 100).toFixed(1)}%)`);
console.log(`   Échecs: ${results.failed} (${((results.failed / results.totalAgents) * 100).toFixed(1)}%)`);

console.log('\n\n📊 DISTRIBUTION DES PRÉDICTIONS:\n');
console.log(`   🟢 LONG:  ${results.byDecision.long.toString().padStart(2)} (${((results.byDecision.long / results.successful) * 100).toFixed(1)}%)`);
console.log(`   🔴 SHORT: ${results.byDecision.short.toString().padStart(2)} (${((results.byDecision.short / results.successful) * 100).toFixed(1)}%)`);
console.log(`   ⚪ NONE:  ${results.byDecision.none.toString().padStart(2)} (${((results.byDecision.none / results.successful) * 100).toFixed(1)}%)`);

console.log('\n\n📈 STATISTIQUES PAR SYMBOLE:\n');
for (const [symbol, stats] of results.bySymbol.entries()) {
  console.log(`   ${symbol}:`);
  console.log(`      Agents: ${stats.count}`);
  console.log(`      Distribution: L=${stats.byDecision.long} | S=${stats.byDecision.short} | N=${stats.byDecision.none}`);
  console.log(`      Confiance moy: ${(stats.avgConfidence * 100).toFixed(1)}%`);
  console.log(`      Edge moyen: ${(stats.avgEdge * 100).toFixed(1)}%`);
  console.log('');
}

console.log('\n🤖 MÉTRIQUES DE FIABILITÉ DU PRÉDICTEUR:\n');
console.log(`   Total d'appels: ${reliabilityMetrics.totalCalls}`);
console.log(`   Succès: ${reliabilityMetrics.successfulCalls} (${(reliabilityMetrics.reliabilityRate * 100).toFixed(1)}%)`);
console.log(`   Échecs: ${reliabilityMetrics.failedCalls}`);
console.log(`   Échecs consécutifs: ${reliabilityMetrics.consecutiveFailures}`);
console.log(`   Fiable (≥95%): ${reliabilityMetrics.isReliable ? '✅ OUI' : '❌ NON'}`);

if (reliabilityMetrics.lastErrorMessage) {
  console.log(`   Dernière erreur: ${reliabilityMetrics.lastErrorMessage}`);
}

// Analyse des signaux NONE
const nonePredictions = results.predictions.filter(p => p.decision === 'none');
if (nonePredictions.length > 0) {
  console.log('\n\n🔍 ANALYSE DES PRÉDICTIONS "NONE":\n');
  
  const avgNoneConfidence = nonePredictions.reduce((sum, p) => sum + p.confidence, 0) / nonePredictions.length;
  const avgNoneEdge = nonePredictions.reduce((sum, p) => sum + p.edge, 0) / nonePredictions.length;
  const avgNoneClarity = nonePredictions.reduce((sum, p) => sum + p.directionalClarity, 0) / nonePredictions.length;
  const avgNoneRSI = nonePredictions.reduce((sum, p) => sum + p.rsi, 0) / nonePredictions.length;
  const avgNoneATR = nonePredictions.reduce((sum, p) => sum + p.atr, 0) / nonePredictions.length;
  const avgNoneADX = nonePredictions.reduce((sum, p) => sum + p.adx, 0) / nonePredictions.length;
  
  console.log(`   Confiance moyenne: ${(avgNoneConfidence * 100).toFixed(1)}%`);
  console.log(`   Edge moyen: ${(avgNoneEdge * 100).toFixed(1)}%`);
  console.log(`   Clarté moyenne: ${(avgNoneClarity * 100).toFixed(1)}%`);
  console.log(`   RSI moyen: ${avgNoneRSI.toFixed(1)}`);
  console.log(`   ATR moyen: ${(avgNoneATR*100).toFixed(2)}%`);
  console.log(`   ADX moyen: ${avgNoneADX.toFixed(1)}`);
  
  // Identifier les patterns
  const lowVolatility = nonePredictions.filter(p => p.atr < 0.01).length;
  const extremeRSI = nonePredictions.filter(p => p.rsi < 30 || p.rsi > 70).length;
  const weakTrend = nonePredictions.filter(p => p.adx < 20).length;
  
  console.log('\n   📊 Patterns identifiés:');
  console.log(`      Faible volatilité (ATR<1%): ${lowVolatility}/${nonePredictions.length} (${((lowVolatility/nonePredictions.length)*100).toFixed(0)}%)`);
  console.log(`      RSI extrême (<30 ou >70): ${extremeRSI}/${nonePredictions.length} (${((extremeRSI/nonePredictions.length)*100).toFixed(0)}%)`);
  console.log(`      Tendance faible (ADX<20): ${weakTrend}/${nonePredictions.length} (${((weakTrend/nonePredictions.length)*100).toFixed(0)}%)`);
}

// Top prédictions directionnelles
const directionalPredictions = results.predictions.filter(p => p.decision !== 'none');
if (directionalPredictions.length > 0) {
  console.log('\n\n🏆 TOP PRÉDICTIONS DIRECTIONNELLES (par edge):\n');
  const topPredictions = directionalPredictions
    .sort((a, b) => b.edge - a.edge)
    .slice(0, Math.min(5, directionalPredictions.length));

  topPredictions.forEach((pred, idx) => {
    const emoji = pred.decision === 'long' ? '🟢' : '🔴';
    console.log(`   ${idx + 1}. ${emoji} ${pred.symbol.padEnd(18)} | Edge: ${(pred.edge*100).toFixed(1)}% | Conf: ${(pred.confidence*100).toFixed(1)}% | ${pred.decision.toUpperCase()}`);
    console.log(`      Agent: ${pred.agentId.slice(0, 12)}... | Mode: ${pred.mode} | Smart: ${pred.isSmartAgent ? 'Oui' : 'Non'}`);
  });
}

console.log('\n\n💡 RECOMMANDATIONS:\n');

const nonePercent = (results.byDecision.none / results.successful) * 100;

if (nonePercent > 70) {
  console.log('   ⚠️  Le prédicteur retourne trop de "none" (>70%)');
  console.log('   📝 Interprétation: Marchés actuellement peu clairs ou faible volatilité');
  console.log('   🔧 Actions:');
  console.log('      • Le prédicteur fonctionne correctement - il filtre les mauvais setups');
  console.log('      • Attendre des conditions de marché plus favorables');
  console.log('      • Les agents existants peuvent continuer (NONE = "ne pas trader maintenant")');
} else if (nonePercent > 50) {
  console.log('   ℹ️  Le prédicteur est prudent (>50% de "none")');
  console.log('   📝 Interprétation: Comportement normal en marchés calmes');
  console.log('   ✅ Le système fonctionne comme prévu');
} else {
  console.log('   ✅ Distribution équilibrée des prédictions');
  console.log('   📝 Le prédicteur identifie des opportunités directionnelles claires');
  console.log('   🎯 Le gate prédicteur peut filtrer efficacement les nouveaux agents');
}

if (directionalPredictions.length > 0) {
  const avgDirectionalConfidence = directionalPredictions.reduce((sum, p) => sum + p.confidence, 0) / directionalPredictions.length;
  const avgDirectionalEdge = directionalPredictions.reduce((sum, p) => sum + p.edge, 0) / directionalPredictions.length;
  
  console.log(`\n   📊 Qualité des signaux directionnels:`);
  console.log(`      Confiance moyenne: ${(avgDirectionalConfidence * 100).toFixed(1)}%`);
  console.log(`      Edge moyen: ${(avgDirectionalEdge * 100).toFixed(1)}%`);
  
  if (avgDirectionalConfidence >= 0.55 && avgDirectionalEdge >= 0.08) {
    console.log(`      ✅ Excellente qualité de signaux`);
  } else if (avgDirectionalConfidence >= 0.45 && avgDirectionalEdge >= 0.05) {
    console.log(`      ℹ️  Qualité acceptable`);
  } else {
    console.log(`      ⚠️  Signaux faibles - marchés incertains`);
  }
}

console.log('\n═══════════════════════════════════════════════════════\n');

await prisma.$disconnect();
