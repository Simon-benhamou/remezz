#!/usr/bin/env node
/**
 * Test Direct du Modèle Python
 * Appelle le prédicteur Python avec des vraies features et affiche le résultat brut
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const techPath = join(__dirname, 'dist/src/ai/tech.js');
const agentPath = join(__dirname, 'dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');
const predictorPath = join(__dirname, 'dist/src/quantai/pythonPredictor.js');

const { buildTechSnapshot } = await import(techPath);
const { buildPredictorFeatures } = await import(agentPath);
const { getPredictionSync } = await import(predictorPath);

console.log('\n═══════════════════════════════════════════════════════');
console.log('  🧪 TEST DIRECT DU MODÈLE PYTHON');
console.log('═══════════════════════════════════════════════════════\n');

const testSymbols = ['BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'SOL/USDT', 'ADA/USDT'];

for (const symbol of testSymbols) {
  console.log(`\n🔍 Test: ${symbol}`);
  
  try {
    // 1. Construire snapshot
    const snap = await buildTechSnapshot(symbol);
    
    // 2. Construire features
    const features = buildPredictorFeatures(snap);
    
    // 3. Appeler prédicteur Python DIRECTEMENT
    console.log('   📤 Envoi des features au modèle Python...');
    const prediction = getPredictionSync(features);
    
    // 4. Afficher résultat brut
    console.log('   📥 Résultat brut du modèle:');
    console.log('   ', JSON.stringify(prediction, null, 2).split('\n').join('\n    '));
    
    // 5. Analyser
    const { decision, confidence, probabilities } = prediction;
    const emoji = decision === 'long' ? '🟢' : decision === 'short' ? '🔴' : '⚪';
    
    console.log(`\n   ${emoji} Décision: ${decision.toUpperCase()}`);
    console.log(`   📊 Confiance: ${(confidence * 100).toFixed(1)}%`);
    console.log(`   📈 Prob Long: ${(probabilities.long * 100).toFixed(1)}%`);
    console.log(`   📉 Prob Short: ${(probabilities.short * 100).toFixed(1)}%`);
    console.log(`   ⚪ Prob None: ${(probabilities.none * 100).toFixed(1)}%`);
    
    // Contexte technique
    console.log(`\n   📊 Contexte technique:`);
    console.log(`      RSI: ${features.rsi14.toFixed(1)}`);
    console.log(`      ATR%: ${(features.atrPct * 100).toFixed(2)}%`);
    console.log(`      ADX: ${features.adx14.toFixed(1)}`);
    console.log(`      MACD: ${features.macd.toFixed(2)}`);
    console.log(`      Volume Ratio: ${features.volumeRatio.toFixed(2)}`);
    
  } catch (error) {
    console.log(`   ❌ Erreur: ${error.message}`);
  }
}

console.log('\n\n═══════════════════════════════════════════════════════');
console.log('  📊 ANALYSE');
console.log('═══════════════════════════════════════════════════════\n');

console.log('Si toutes les prédictions sont identiques (ex: toujours 95% none):');
console.log('  → Le modèle Python lui-même est défectueux');
console.log('  → Cause: Probablement le hybrid_state.json ou le modèle .pkl corrompu');
console.log('  → Solution: Supprimer hybrid_state.json et tester à nouveau');
console.log('');
console.log('Si les prédictions varient par symbole:');
console.log('  → Le modèle fonctionne correctement!');
console.log('  → Le problème est ailleurs (seuils, temperature, etc.)');
console.log('');

console.log('═══════════════════════════════════════════════════════\n');
