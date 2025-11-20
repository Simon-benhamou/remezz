#!/usr/bin/env node
/**
 * Test rapide du predictor conservateur
 * Vérifie le chargement et les niveaux de confidence
 */

import { callPythonPredictor } from './dist/quantai/pythonPredictor.js';

console.log('='.repeat(70));
console.log('🧪 TEST PREDICTOR CONSERVATEUR');
console.log('='.repeat(70));
console.log();

// Simuler un snapshot de marché avec RSI extrême (comme ETH le 19 nov)
const mockSnapshot = {
  symbol: 'ETH/USDT',
  timestamp: Date.now(),
  close: 2900,
  volume: 12000000,
  
  // Indicators d'opportunité forte (RSI < 25, ATR > 100%)
  ema9: 2950,
  ema12: 2960,
  ema20: 2970,
  ema26: 2980,
  ema50: 3000,
  ema200: 3100,
  
  rsi7: 22.5,
  rsi14: 24.2,
  rsiSlope: -5.3,
  
  macd: -15.2,
  macd_signal: -8.1,
  
  atr14: 95.0,
  atrPct: 106.5,
  
  volumeRatio: 1.8,
  momentum10: -3.2,
  
  adx14: 42.3,
  ema20Slope: -0.8,
};

console.log('📊 Test avec conditions de marché extrêmes:');
console.log(`   - RSI: ${mockSnapshot.rsi14} (< 25 = oversold)`);
console.log(`   - ATR: ${mockSnapshot.atrPct}% (> 100% = haute volatilité)`);
console.log(`   - Prix: $${mockSnapshot.close}`);
console.log();

console.log('🔮 Appel du predictor...');
console.log();

try {
  const result = await callPythonPredictor(mockSnapshot);
  
  console.log('✅ RESULTAT:');
  console.log(`   Direction: ${result.direction}`);
  console.log(`   Confidence: ${(result.confidence * 100).toFixed(1)}%`);
  console.log();
  console.log(`   Probabilités:`);
  console.log(`     - Long:  ${(result.longProb * 100).toFixed(1)}%`);
  console.log(`     - None:  ${(result.noneProb * 100).toFixed(1)}%`);
  console.log(`     - Short: ${(result.shortProb * 100).toFixed(1)}%`);
  console.log();
  
  // Validation
  const expectedMinConfidence = 0.50; // On s'attend à > 50% vs 23-35% du fallback
  
  if (result.confidence >= expectedMinConfidence) {
    console.log('✅ SUCCÈS: Confidence élevée (modèle conservateur chargé)');
    console.log(`   ${(result.confidence * 100).toFixed(1)}% >= ${(expectedMinConfidence * 100).toFixed(1)}%`);
  } else {
    console.log('⚠️  ATTENTION: Confidence faible (possiblement fallback)');
    console.log(`   ${(result.confidence * 100).toFixed(1)}% < ${(expectedMinConfidence * 100).toFixed(1)}%`);
    console.log();
    console.log('   Vérifier dans les logs backend:');
    console.log('   - "XGBoost model loaded" → OK');
    console.log('   - "fallback" → Problème de chargement');
  }
  
  console.log();
  console.log('='.repeat(70));
  
} catch (error) {
  console.error('❌ ERREUR:', error.message);
  console.error();
  console.error('Causes possibles:');
  console.error('  1. Backend non démarré');
  console.error('  2. Modèles Python manquants');
  console.error('  3. DISABLE_PYTHON_PREDICTOR=true dans .env');
  console.error();
  process.exit(1);
}
