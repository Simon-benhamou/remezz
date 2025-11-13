#!/usr/bin/env node
/**
 * Diagnostic des Features du Prédicteur
 * Compare les features attendues vs fournies
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Charger les modules
const metadataPath = join(__dirname, 'python/predictor_metadata.json');
const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'));
const expectedFeatures = metadata.features;

const techPath = join(__dirname, 'dist/src/ai/tech.js');
const agentPath = join(__dirname, 'dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

const { buildTechSnapshot } = await import(techPath);
const { buildPredictorFeatures } = await import(agentPath);

console.log('\n═══════════════════════════════════════════════════════');
console.log('  🔍 DIAGNOSTIC DES FEATURES DU PREDICTOR');
console.log('═══════════════════════════════════════════════════════\n');

const testSymbol = 'BTC/USDT';

console.log(`📊 Test sur ${testSymbol}...\n`);

// 1. Construire le snapshot
const snap = await buildTechSnapshot(testSymbol);

// 2. Construire les features
const features = buildPredictorFeatures(snap);

console.log('✅ FEATURES ATTENDUES PAR LE MODÈLE (' + expectedFeatures.length + '):\n');
console.log(expectedFeatures.join(', '));

console.log('\n\n✅ FEATURES FOURNIES PAR buildPredictorFeatures (' + Object.keys(features).length + '):\n');
console.log(Object.keys(features).sort().join(', '));

// Analyse des différences
const provided = new Set(Object.keys(features));
const expected = new Set(expectedFeatures);

const missing = expectedFeatures.filter(f => !provided.has(f));
const extra = Object.keys(features).filter(f => !expected.has(f));

console.log('\n\n📊 ANALYSE DES DIFFÉRENCES:\n');

if (missing.length === 0 && extra.length === 0) {
  console.log('✅ PARFAIT! Toutes les features correspondent.');
} else {
  if (missing.length > 0) {
    console.log(`❌ FEATURES MANQUANTES (${missing.length}):\n`);
    missing.forEach(f => {
      console.log(`   - ${f}`);
    });
  }
  
  if (extra.length > 0) {
    console.log(`\n⚠️  FEATURES EN TROP (${extra.length}) - seront ignorées:\n`);
    extra.forEach(f => {
      console.log(`   - ${f}`);
    });
  }
}

// Vérifier les valeurs nulles/invalides
console.log('\n\n🔍 VÉRIFICATION DES VALEURS:\n');

let nullCount = 0;
let nanCount = 0;
let infCount = 0;
let validCount = 0;

for (const [key, value] of Object.entries(features)) {
  if (value === null || value === undefined) {
    nullCount++;
    console.log(`   ⚠️  ${key}: null/undefined`);
  } else if (Number.isNaN(value)) {
    nanCount++;
    console.log(`   ⚠️  ${key}: NaN`);
  } else if (!Number.isFinite(value)) {
    infCount++;
    console.log(`   ⚠️  ${key}: Infinity`);
  } else {
    validCount++;
  }
}

console.log(`\n   ✅ Valides: ${validCount}`);
if (nullCount > 0) console.log(`   ❌ Null/Undefined: ${nullCount}`);
if (nanCount > 0) console.log(`   ❌ NaN: ${nanCount}`);
if (infCount > 0) console.log(`   ❌ Infinity: ${infCount}`);

// Échantillon de valeurs
console.log('\n\n📝 ÉCHANTILLON DE VALEURS (premières 10):\n');
Object.entries(features).slice(0, 10).forEach(([key, value]) => {
  const formatted = typeof value === 'number' ? value.toFixed(6) : String(value);
  console.log(`   ${key.padEnd(20)}: ${formatted}`);
});

console.log('\n\n💡 RECOMMANDATIONS:\n');

if (missing.length > 0) {
  console.log('   ❌ PROBLÈME MAJEUR: Features manquantes!');
  console.log('      Le modèle ne peut pas prédire correctement sans ces features.');
  console.log('\n   🔧 SOLUTIONS:');
  console.log('      1. Ajouter les features manquantes dans buildPredictorFeatures()');
  console.log('      2. OU ré-entraîner le modèle avec seulement les features disponibles');
  console.log('\n   📝 Pour ajouter les features manquantes:');
  console.log('      - Vérifier si elles existent dans TechnicalSnapshot');
  console.log('      - Calculer les features manquantes si nécessaire');
  console.log('      - Mettre à jour buildPredictorFeatures() dans metaAdaptiveAgent.ts');
}

if (nullCount > 0 || nanCount > 0 || infCount > 0) {
  console.log('   ⚠️  Valeurs invalides détectées!');
  console.log('      Le modèle peut avoir des comportements imprévisibles.');
  console.log('\n   🔧 SOLUTION: Ajouter des valeurs par défaut pour ces features.');
}

if (missing.length === 0 && nullCount === 0 && nanCount === 0 && infCount === 0) {
  console.log('   ✅ Tout semble correct!');
  console.log('      Si le prédicteur retourne toujours "none", le problème est ailleurs:');
  console.log('      - Vérifier la calibration du modèle (temperature)');
  console.log('      - Vérifier les seuils de confiance dans prediction_engine.py');
  console.log('      - Tester le modèle Python directement avec ces features');
}

console.log('\n═══════════════════════════════════════════════════════\n');
