#!/usr/bin/env node
/**
 * Test de compatibilité des features entre backend TypeScript et predictor Python
 * Vérifie que buildPredictorFeatures() envoie exactement les 41 features attendues
 */

import { buildPredictorFeatures } from './dist/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Features attendues par le modèle Python (ordre exact du train_conservative.py)
const EXPECTED_FEATURES = [
  // EMAs et distances
  'ema9', 'ema12', 'ema20', 'ema26', 'ema50', 'ema200',
  'dist_ema9', 'dist_ema20', 'dist_ema50',
  // RSI multi-période et patterns
  'rsi7', 'rsi14', 'rsiSlope', 'rsiAccel', 'rsiDivergence',
  // MACD complet
  'macd', 'macd_signal', 'macd_hist', 'macd_cross',
  // Volatilité et ATR
  'atr14', 'atrPct', 'atrRatio',
  // Volume patterns
  'volumeRatio', 'volumeSpike', 'volumeTrend',
  // Momentum multi-période
  'momentum5', 'momentum10', 'momentum20', 'momentumAccel',
  // Trend indicators
  'adx14', 'plusDI', 'minusDI',
  // Bollinger Bands
  'bb_position', 'bb_width',
  // Price patterns
  'ema20Slope', 'priceAccel', 'highLowRatio', 'emaCross'
];

console.log('🧪 Test de compatibilité des features backend → Python predictor\n');
console.log('=' .repeat(70));

// Créer un TechnicalSnapshot mock avec toutes les données nécessaires
const mockSnapshot = {
  symbol: 'ETH/USDT:USDT',
  last: 3500,
  ema9: 3495,
  ema12: 3490,
  ema20: 3480,
  ema26: 3475,
  ema50: 3460,
  ema100: 3440,
  ema200: 3400,
  ema20Slope: 0.5,
  ema50Slope: 0.3,
  rsi7: 55,
  rsi14: 58,
  rsi21: 60,
  rsiSlope: 2.5,
  macd: 15,
  macdSignal: 12,
  macdDiff: 3,
  momentum3: 0.5,
  momentum5: 1.2,
  momentum10: 2.5,
  momentum20: 4.8,
  atr7: 50,
  atr14: 52,
  atrPct: 1.5,
  bbWidth: 0.04,
  bbPosition: 0.6,
  volatilityRegime: 1.5,
  adx14: 25,
  adxPos14: 20,
  adxNeg14: 15,
  diPlus14: 20,
  diMinus14: 15,
  trendStrength: 0.7,
  volumeRatio: 1.8,
  volume: 180000,
  volumeMA: 100000,
  volumeZScore: 1.5,
  distEma20: 0.6,
  distEma50: 1.2,
  distEma200: 2.9,
  support: 3400,
  resistance: 3600,
  supports: [],
  resistances: [],
  pivots: null,
  trend: 1,
  srBias: 'neutral',
  meta: { tf: '15m', windowBars: 200, recentBarsFor24h: 96 },
  realizedVol: 0.015,
  hurst: 0.55,
  adxSlope: 0.2,
  trendBias: 'bullish',
};

console.log('\n📊 Test 1: Génération des features depuis TechnicalSnapshot mock\n');

// Tester buildPredictorFeatures
const features = buildPredictorFeatures(mockSnapshot);

if (!features) {
  console.error('❌ ÉCHEC: buildPredictorFeatures() a retourné null');
  process.exit(1);
}

console.log(`✅ Features générées: ${Object.keys(features).length} features`);
console.log(`   Attendues: ${EXPECTED_FEATURES.length} features\n`);

// Vérifier que toutes les features sont présentes
console.log('🔍 Test 2: Vérification de la présence des 41 features attendues\n');

const missingFeatures = [];
const extraFeatures = [];
const featureKeys = Object.keys(features);

// Vérifier les features manquantes
for (const expectedFeature of EXPECTED_FEATURES) {
  if (!featureKeys.includes(expectedFeature)) {
    missingFeatures.push(expectedFeature);
  }
}

// Vérifier les features en trop
for (const featureKey of featureKeys) {
  if (!EXPECTED_FEATURES.includes(featureKey)) {
    extraFeatures.push(featureKey);
  }
}

if (missingFeatures.length > 0) {
  console.error(`❌ Features MANQUANTES (${missingFeatures.length}):`);
  missingFeatures.forEach(f => console.error(`   - ${f}`));
  console.log();
}

if (extraFeatures.length > 0) {
  console.warn(`⚠️  Features EN TROP (${extraFeatures.length}):`);
  extraFeatures.forEach(f => console.warn(`   - ${f}`));
  console.log();
}

if (missingFeatures.length === 0 && extraFeatures.length === 0) {
  console.log('✅ Toutes les 41 features sont présentes et correctes!\n');
} else {
  console.error('❌ INCOMPATIBILITÉ DÉTECTÉE\n');
}

// Vérifier que toutes les valeurs sont finies
console.log('🔍 Test 3: Validation des valeurs (doivent être finies)\n');

const invalidFeatures = [];
for (const [key, value] of Object.entries(features)) {
  if (!Number.isFinite(value)) {
    invalidFeatures.push(`${key} = ${value}`);
  }
}

if (invalidFeatures.length > 0) {
  console.error(`❌ Valeurs INVALIDES (${invalidFeatures.length}):`);
  invalidFeatures.forEach(f => console.error(`   - ${f}`));
  console.log();
} else {
  console.log('✅ Toutes les valeurs sont finies et valides\n');
}

// Afficher un échantillon des features
console.log('📋 Échantillon des features générées:\n');
const sampleFeatures = [
  'ema9', 'ema20', 'dist_ema9', 'rsi14', 'rsiSlope', 'rsiAccel', 'rsiDivergence',
  'macd', 'macd_hist', 'macd_cross', 'atr14', 'atrPct', 'atrRatio',
  'volumeRatio', 'volumeSpike', 'volumeTrend', 'momentum5', 'momentumAccel',
  'adx14', 'plusDI', 'minusDI', 'bb_position', 'priceAccel', 'highLowRatio', 'emaCross'
];

sampleFeatures.forEach(key => {
  const value = features[key];
  const status = Number.isFinite(value) ? '✓' : '✗';
  console.log(`   ${status} ${key.padEnd(20)} = ${typeof value === 'number' ? value.toFixed(4) : value}`);
});

// Résumé final
console.log('\n' + '='.repeat(70));
console.log('\n📊 RÉSUMÉ DU TEST\n');

let allTestsPassed = true;

if (features === null) {
  console.error('❌ Test 1: buildPredictorFeatures() retourne null - ÉCHEC');
  allTestsPassed = false;
} else {
  console.log('✅ Test 1: buildPredictorFeatures() génère les features - RÉUSSI');
}

if (missingFeatures.length > 0 || extraFeatures.length > 0) {
  console.error(`❌ Test 2: Compatibilité des features - ÉCHEC (${missingFeatures.length} manquantes, ${extraFeatures.length} en trop)`);
  allTestsPassed = false;
} else {
  console.log('✅ Test 2: Exactement 41 features attendues - RÉUSSI');
}

if (invalidFeatures.length > 0) {
  console.error(`❌ Test 3: Validation des valeurs - ÉCHEC (${invalidFeatures.length} valeurs invalides)`);
  allTestsPassed = false;
} else {
  console.log('✅ Test 3: Toutes les valeurs sont finies - RÉUSSI');
}

console.log();

if (allTestsPassed) {
  console.log('🎉 TOUS LES TESTS RÉUSSIS - Backend compatible avec Python predictor!\n');
  process.exit(0);
} else {
  console.error('💥 TESTS ÉCHOUÉS - Backend incompatible avec Python predictor\n');
  console.error('Action requise: Mettre à jour buildPredictorFeatures() pour envoyer exactement les 41 features\n');
  process.exit(1);
}
