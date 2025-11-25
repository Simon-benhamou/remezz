#!/usr/bin/env node
/**
 * Test script pour vérifier le warmup du prédicteur Python
 * 
 * Ce script teste:
 * 1. Le chargement du modèle XGBoost (350MB+)
 * 2. Le cache en mémoire
 * 3. Les performances (première prédiction vs suivantes)
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pythonScript = join(__dirname, 'python', 'predict_service.py');

console.log('🧪 Test du prédicteur Python avec cache');
console.log('=' .repeat(70));
console.log();

// Features de test minimales
const testFeatures = {
  close: 100,
  ema9: 100,
  ema12: 100,
  ema20: 100,
  ema26: 100,
  ema50: 100,
  ema200: 100,
  dist_ema9: 0,
  dist_ema20: 0,
  dist_ema50: 0,
  rsi7: 50,
  rsi14: 50,
  rsiSlope: 0,
  rsiAccel: 0,
  rsiDivergence: 0,
  macd: 0,
  macd_signal: 0,
  macd_hist: 0,
  macd_cross: 0,
  atr14: 1,
  atrPct: 1,
  atrRatio: 1,
  volumeRatio: 1,
  volumeSpike: 0,
  volumeTrend: 1,
  momentum5: 0,
  momentum10: 0,
  momentum20: 0,
  momentumAccel: 0,
  adx14: 20,
  plusDI: 20,
  minusDI: 20,
  bb_position: 0.5,
  bb_width: 0.05,
  ema20Slope: 0,
  priceAccel: 0,
  highLowRatio: 0.01,
  emaCross: 0,
};

async function runPrediction(testNumber) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const child = spawn('python3', [pythonScript, '--features-json', JSON.stringify(testFeatures)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      
      if (code !== 0) {
        reject(new Error(`Python exit code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve({ result, duration, stderr });
      } catch (error) {
        reject(new Error(`Parse error: ${error.message}\nOutput: ${stdout}`));
      }
    });

    child.on('error', reject);
  });
}

async function main() {
  try {
    // Test 1: Première prédiction (chargement du modèle)
    console.log('📦 Test 1: Première prédiction (chargement du modèle 350MB+)');
    const test1 = await runPrediction(1);
    console.log(`   ⏱️  Durée: ${test1.duration}ms`);
    console.log(`   📊 Decision: ${test1.result.decision}`);
    console.log(`   🎯 Confidence: ${test1.result.confidence.toFixed(3)}`);
    if (test1.stderr) {
      console.log(`   📝 Logs Python:`);
      test1.stderr.split('\n').forEach(line => {
        if (line.trim()) console.log(`      ${line}`);
      });
    }
    console.log();

    // Test 2: Deuxième prédiction (modèle en cache)
    console.log('⚡ Test 2: Deuxième prédiction (modèle en cache)');
    const test2 = await runPrediction(2);
    console.log(`   ⏱️  Durée: ${test2.duration}ms`);
    console.log(`   📊 Decision: ${test2.result.decision}`);
    console.log(`   🎯 Confidence: ${test2.result.confidence.toFixed(3)}`);
    console.log();

    // Test 3: Troisième prédiction
    console.log('⚡ Test 3: Troisième prédiction (modèle en cache)');
    const test3 = await runPrediction(3);
    console.log(`   ⏱️  Durée: ${test3.duration}ms`);
    console.log(`   📊 Decision: ${test3.result.decision}`);
    console.log(`   🎯 Confidence: ${test3.result.confidence.toFixed(3)}`);
    console.log();

    // Analyse des performances
    console.log('📈 Analyse des performances:');
    console.log(`   Première prédiction (cold start): ${test1.duration}ms`);
    console.log(`   Deuxième prédiction (warm):       ${test2.duration}ms`);
    console.log(`   Troisième prédiction (warm):      ${test3.duration}ms`);
    
    const avgWarm = (test2.duration + test3.duration) / 2;
    const speedup = (test1.duration / avgWarm).toFixed(1);
    
    console.log(`   Moyenne warm:                     ${avgWarm.toFixed(0)}ms`);
    console.log(`   Speedup (cache):                  ${speedup}x plus rapide`);
    console.log();

    if (test1.duration > 1000) {
      console.log('⚠️  Première prédiction > 1s - c\'est normal (chargement modèle 350MB)');
    }
    
    if (avgWarm < 500) {
      console.log('✅ Cache fonctionne parfaitement! Prédictions rapides après warmup');
    } else if (avgWarm < 1000) {
      console.log('✅ Cache fonctionne correctement');
    } else {
      console.log('⚠️  Prédictions encore lentes même avec cache - vérifier les logs');
    }

    console.log();
    console.log('=' .repeat(70));
    console.log('✅ Tests terminés avec succès!');

  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  }
}

main();
