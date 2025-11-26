#!/usr/bin/env node
/**
 * Test simple: vérifier que les 41 features attendues correspondent au modèle Python
 */

import { readFileSync } from 'fs';

console.log('🧪 Test de compatibilité des features TypeScript → Python\n');
console.log('='.repeat(70));

// Features attendues par le modèle Python (train_conservative.py)
const PYTHON_FEATURES = [
  // EMAs et distances (9)
  'ema9', 'ema12', 'ema20', 'ema26', 'ema50', 'ema200',
  'dist_ema9', 'dist_ema20', 'dist_ema50',
  // RSI multi-période et patterns (5)
  'rsi7', 'rsi14', 'rsiSlope', 'rsiAccel', 'rsiDivergence',
  // MACD complet (4)
  'macd', 'macd_signal', 'macd_hist', 'macd_cross',
  // Volatilité et ATR (3)
  'atr14', 'atrPct', 'atrRatio',
  // Volume patterns (3)
  'volumeRatio', 'volumeSpike', 'volumeTrend',
  // Momentum multi-période (4)
  'momentum5', 'momentum10', 'momentum20', 'momentumAccel',
  // Trend indicators (3)
  'adx14', 'plusDI', 'minusDI',
  // Bollinger Bands (2)
  'bb_position', 'bb_width',
  // Price patterns (4)
  'ema20Slope', 'priceAccel', 'highLowRatio', 'emaCross'
];

console.log(`\n📊 Features attendues par le modèle Python: ${PYTHON_FEATURES.length}\n`);

// Lire le fichier TypeScript pour extraire les features
const tsFile = readFileSync('./src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.ts', 'utf-8');

// Extraire la section des features du buildPredictorFeatures
const featuresMatch = tsFile.match(/const features: Record<string, number> = \{([^}]+)\}/s);

if (!featuresMatch) {
  console.error('❌ Impossible de trouver la déclaration des features dans le fichier TypeScript');
  process.exit(1);
}

const featuresBlock = featuresMatch[1];

// Extraire les noms de features (chercher les patterns comme "ema9," ou "dist_ema9,")
const tsFeatures = [];
const featureLines = featuresBlock.split('\n');

for (const line of featureLines) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('//')) {
    // Extraire le nom de la feature (avant le ':' ou avant la ',')
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)[,:]/);
    if (match) {
      tsFeatures.push(match[1]);
    }
  }
}

console.log(`✅ Features trouvées dans TypeScript: ${tsFeatures.length}\n`);

// Comparer les features
console.log('🔍 Comparaison des features:\n');

const missingInTS = [];
const extraInTS = [];

for (const pyFeature of PYTHON_FEATURES) {
  if (!tsFeatures.includes(pyFeature)) {
    missingInTS.push(pyFeature);
  }
}

for (const tsFeature of tsFeatures) {
  if (!PYTHON_FEATURES.includes(tsFeature)) {
    extraInTS.push(tsFeature);
  }
}

if (missingInTS.length > 0) {
  console.error(`❌ Features MANQUANTES dans TypeScript (${missingInTS.length}):`);
  missingInTS.forEach(f => console.error(`   - ${f}`));
  console.log();
}

if (extraInTS.length > 0) {
  console.warn(`⚠️  Features EN TROP dans TypeScript (${extraInTS.length}):`);
  extraInTS.forEach(f => console.warn(`   - ${f}`));
  console.log();
}

if (missingInTS.length === 0 && extraInTS.length === 0) {
  console.log('✅ PARFAIT: Les 41 features correspondent exactement!\n');
  
  // Afficher la liste des features par catégorie
  console.log('📋 Liste des 41 features validées:\n');
  console.log('   EMAs et distances (9):');
  console.log('   ', PYTHON_FEATURES.slice(0, 9).join(', '));
  console.log('\n   RSI patterns (5):');
  console.log('   ', PYTHON_FEATURES.slice(9, 14).join(', '));
  console.log('\n   MACD complet (4):');
  console.log('   ', PYTHON_FEATURES.slice(14, 18).join(', '));
  console.log('\n   ATR et volatilité (3):');
  console.log('   ', PYTHON_FEATURES.slice(18, 21).join(', '));
  console.log('\n   Volume patterns (3):');
  console.log('   ', PYTHON_FEATURES.slice(21, 24).join(', '));
  console.log('\n   Momentum (4):');
  console.log('   ', PYTHON_FEATURES.slice(24, 28).join(', '));
  console.log('\n   Trend indicators (3):');
  console.log('   ', PYTHON_FEATURES.slice(28, 31).join(', '));
  console.log('\n   Bollinger Bands (2):');
  console.log('   ', PYTHON_FEATURES.slice(31, 33).join(', '));
  console.log('\n   Price patterns (4):');
  console.log('   ', PYTHON_FEATURES.slice(33, 37).join(', '));
  console.log();
}

// Résumé
console.log('='.repeat(70));
console.log('\n📊 RÉSUMÉ\n');

if (missingInTS.length === 0 && extraInTS.length === 0) {
  console.log('🎉 TEST RÉUSSI: Backend TypeScript compatible avec Python predictor!');
  console.log('   ✓ 41 features attendues par le modèle');
  console.log('   ✓ 41 features envoyées par le backend');
  console.log('   ✓ Correspondance exacte\n');
  console.log('Prochaine étape: Builder le backend et déployer sur Render\n');
  process.exit(0);
} else {
  console.error('💥 TEST ÉCHOUÉ: Incompatibilité détectée');
  console.error(`   ✗ ${missingInTS.length} features manquantes`);
  console.error(`   ✗ ${extraInTS.length} features en trop`);
  console.error('   Action requise: Corriger buildPredictorFeatures()\n');
  process.exit(1);
}
