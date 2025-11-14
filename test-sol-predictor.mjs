#!/usr/bin/env node
/**
 * Test du predictor sur SOL pour vérifier les prédictions actuelles
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔮 Test Predictor SOL/USDT\n');

// Simuler des features réalistes pour SOL
const features = {
  // Prix et EMAs
  ema_9: 136.2,
  ema_12: 136.3,
  ema_20: 136.5,
  ema_26: 136.4,
  ema_50: 137.2,
  ema_200: 138.5,
  
  // Ratios EMAs
  ema_ratio_9_20: 0.998,
  ema_ratio_20_200: 0.986,
  ema_ratio_50_200: 0.991,
  
  // RSI
  rsi_7: 42,
  rsi_14: 45,
  rsi_21: 48,
  
  // MACD
  macd: -0.8,
  macd_signal: -0.6,
  macd_histogram: -0.2,
  
  // Stochastic
  stoch_k: 35,
  stoch_d: 38,
  
  // Momentum
  momentum_3: -0.005,
  momentum_5: -0.008,
  momentum_10: -0.012,
  momentum_20: -0.015,
  
  // ATR et Volatilité
  atr_7: 2.8,
  atr_14: 3.2,
  atr_14_pct: 2.35,
  volatility_regime: 1.2,
  
  // Bollinger Bands
  bb_upper: 142.5,
  bb_lower: 131.2,
  bb_mid: 136.85,
  bb_width: 11.3,
  bb_position: 0.42,
  
  // Volume
  volume_ratio: 3.27,
  volume_zscore: 2.1,
  obv: 45823000,
  volume_price_confirm: 0.8,
  
  // Distance from EMAs
  dist_ema20: -0.003,
  dist_ema50: -0.007,
  dist_ema200: -0.017,
  
  // Slopes
  ema20_slope: -0.002,
  ema50_slope: -0.004,
  
  // Pattern Recognition
  rsi_ema_divergence: -0.05,
  mtf_agreement: 0.3,
  vol_adjusted_momentum: -0.018,
  
  // Prix change
  price_change_1h_pct: -1.2,
  price_change_4h_pct: -2.5,
  price_change_24h_pct: -1.37,
};

console.log('📊 Features SOL (Scenario baissier actuel):');
console.log(`  - Prix: ~136.31 USDT`);
console.log(`  - RSI 14: ${features.rsi_14}`);
console.log(`  - MACD: ${features.macd} (signal: ${features.macd_signal})`);
console.log(`  - Volume Ratio: ${features.volume_ratio}x`);
console.log(`  - Momentum 10: ${features.momentum_10}%`);
console.log(`  - EMA 20 > 50 > 200: NON (marché baissier)\n`);

const pythonScript = join(__dirname, 'backend', 'python', 'ccxt_xgboost_module.py');

const args = [
  pythonScript,
  'predict',
  JSON.stringify(features)
];

console.log('🐍 Appel Python predictor...\n');

const python = spawn('python3', args, {
  cwd: join(__dirname, 'backend'),
  env: { ...process.env },
});

let stdout = '';
let stderr = '';

python.stdout.on('data', (data) => {
  stdout += data.toString();
});

python.stderr.on('data', (data) => {
  stderr += data.toString();
});

python.on('close', (code) => {
  if (code !== 0) {
    console.error('❌ Erreur Python:');
    console.error(stderr);
    process.exit(1);
  }

  try {
    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine);

    console.log('✅ Résultat Predictor:\n');
    console.log(`📍 Decision: ${result.decision.toUpperCase()}`);
    console.log(`📊 Probabilities:`);
    console.log(`   - Long:  ${(result.probabilities.long * 100).toFixed(2)}%`);
    console.log(`   - Short: ${(result.probabilities.short * 100).toFixed(2)}%`);
    console.log(`   - None:  ${(result.probabilities.none * 100).toFixed(2)}%`);
    console.log(`💪 Confidence: ${(result.confidence * 100).toFixed(2)}%`);
    
    console.log('\n🔍 Analyse:');
    if (result.decision === 'long') {
      console.log('⚠️  ATTENTION: Le predictor dit LONG mais le marché semble baissier!');
      console.log('   → Possible sur-fitting ou features manquantes');
      console.log('   → Recommandation: RÉENTRAÎNER le modèle');
    } else if (result.decision === 'short') {
      console.log('✅ CORRECT: Le predictor détecte bien la baisse');
      console.log('   → Aligné avec les indicateurs techniques');
      console.log('   → RSI < 50, MACD négatif, EMAs descendantes');
    } else {
      console.log('🤷 NEUTRE: Le predictor ne détecte pas de signal clair');
      console.log('   → Peut-être trop conservateur');
      console.log('   → Ou pas assez de conviction dans les patterns');
    }
    
    // Vérifier les seuils
    console.log('\n🎯 Passage des Seuils (metaAdaptiveAgent):');
    const longPass = result.probabilities.long >= 0.45;
    const shortPass = result.probabilities.short >= 0.45;
    const confPass = result.confidence >= 0.20;
    
    console.log(`   - Long prob >= 0.45:  ${longPass ? '✅' : '❌'} (${(result.probabilities.long * 100).toFixed(2)}%)`);
    console.log(`   - Short prob >= 0.45: ${shortPass ? '✅' : '❌'} (${(result.probabilities.short * 100).toFixed(2)}%)`);
    console.log(`   - Confidence >= 0.20: ${confPass ? '✅' : '❌'} (${(result.confidence * 100).toFixed(2)}%)`);
    
    if (result.decision !== 'none' && !(longPass || shortPass) && confPass) {
      console.log('\n⚠️  Le predictor donne une decision mais les seuils ne sont pas atteints!');
      console.log('   → La stratégie va ignorer ce signal');
    }

  } catch (e) {
    console.error('❌ Erreur parsing résultat:', e.message);
    console.log('Raw output:', stdout);
    process.exit(1);
  }
});
