#!/usr/bin/env node

/**
 * Script de validation des corrections appliquées
 * Teste les nouveaux seuils et le système de quality score
 */

import { getConfig } from './dist/src/utils/env.js';

console.log('\n🔍 VALIDATION DES CORRECTIONS APPLIQUÉES\n');
console.log('═'.repeat(70));

const cfg = getConfig();

// Test 1: Vérifier les nouveaux seuils ATR
console.log('\n📊 TEST 1: Seuils ATR (Volatilité)');
console.log('─'.repeat(70));
console.log(`Reactive ATR:     ${cfg.REACTIVE_MIN_ATR_PCT}% (attendu: 0.18%)`);
console.log(`Aggressive ATR:   ${cfg.AGGRESSIVE_MIN_ATR_PCT}% (attendu: 0.12%)`);
console.log(`Conservative ATR: ${cfg.CONSERVATIVE_MIN_ATR_PCT}% (attendu: 0.30%)`);

const atrOk = cfg.REACTIVE_MIN_ATR_PCT === 0.18 && 
              cfg.AGGRESSIVE_MIN_ATR_PCT === 0.12;
console.log(atrOk ? '✅ ATR thresholds corrects' : '❌ ATR thresholds incorrects');

// Test 2: Vérifier les nouveaux ratios de volume
console.log('\n📊 TEST 2: Volume Requirements');
console.log('─'.repeat(70));
console.log(`Volume Base:  ${cfg.QUALITY_VOLUME_RATIO_BASE} (attendu: 0.45)`);
console.log(`Volume Floor: ${cfg.QUALITY_VOLUME_RATIO_FLOOR} (attendu: 0.30)`);

const volOk = cfg.QUALITY_VOLUME_RATIO_BASE === 0.45 &&
              cfg.QUALITY_VOLUME_RATIO_FLOOR === 0.30;
console.log(volOk ? '✅ Volume ratios corrects' : '❌ Volume ratios incorrects');

// Test 3: Vérifier le hold time
console.log('\n📊 TEST 3: Minimum Hold Time');
console.log('─'.repeat(70));
const holdTimeMin = cfg.MIN_HOLD_TIME_MS / 60000; // Convert to minutes
console.log(`Hold Time: ${holdTimeMin} min (attendu: 10 min)`);

const holdOk = cfg.MIN_HOLD_TIME_MS === 600000; // 10 minutes
console.log(holdOk ? '✅ Hold time correct' : '❌ Hold time incorrect');

// Test 4: Vérifier les quality scores
console.log('\n📊 TEST 4: Quality Score Thresholds');
console.log('─'.repeat(70));
console.log(`Conservative: ${cfg.QUALITY_MIN_SCORE_CONSERVATIVE} pts (attendu: 60)`);
console.log(`Reactive:     ${cfg.QUALITY_MIN_SCORE_REACTIVE} pts (attendu: 50)`);
console.log(`Aggressive:   ${cfg.QUALITY_MIN_SCORE_AGGRESSIVE} pts (attendu: 40)`);

const scoreOk = cfg.QUALITY_MIN_SCORE_CONSERVATIVE === 60 &&
                cfg.QUALITY_MIN_SCORE_REACTIVE === 50 &&
                cfg.QUALITY_MIN_SCORE_AGGRESSIVE === 40;
console.log(scoreOk ? '✅ Quality scores corrects' : '❌ Quality scores incorrects');

// Test 5: Simuler un cas réel (XRP)
console.log('\n📊 TEST 5: Simulation XRP Case');
console.log('─'.repeat(70));

const xrpCase = {
  mode: 'reactive',
  atrPct: 0.34,
  volumeRatio: 0.60,
  adx: 42.6,
  rsi: 35.7,
  ema20: 2.9634,
  ema50: 2.9851,
};

// Calcul des points
let points = 0;
let details = [];

// 1. Trend alignment (FAIL car EMA20 < EMA50)
const emaSpread = ((xrpCase.ema20 - xrpCase.ema50) / xrpCase.ema50) * 100;
const trendPass = xrpCase.ema20 > xrpCase.ema50 && emaSpread > 0.5;
points += trendPass ? 20 : 0;
details.push(`Trend: ${trendPass ? 'PASS' : 'FAIL'} (spread: ${emaSpread.toFixed(2)}%)`);

// 2. ADX (PASS: 42.6 > 15)
const adxPass = xrpCase.adx >= 15;
points += adxPass ? 20 : 0;
details.push(`ADX: ${adxPass ? 'PASS' : 'FAIL'} (${xrpCase.adx} >= 15)`);

// 3. RSI (PASS: 35.7 dans 30-80)
const rsiPass = xrpCase.rsi >= 30 && xrpCase.rsi <= 80;
points += rsiPass ? 20 : 0;
details.push(`RSI: ${rsiPass ? 'PASS' : 'FAIL'} (${xrpCase.rsi} in 30-80)`);

// 4. ATR avec NOUVEAU seuil (0.18 au lieu de 0.25)
const atrThreshold = cfg.REACTIVE_MIN_ATR_PCT;
const atrPass = xrpCase.atrPct >= atrThreshold;
points += atrPass ? 20 : 0;
details.push(`ATR: ${atrPass ? 'PASS' : 'FAIL'} (${xrpCase.atrPct}% >= ${atrThreshold}%)`);

// 5. Volume avec NOUVEAU seuil (0.45 base - 0.05 reactive = 0.40)
const volThreshold = cfg.QUALITY_VOLUME_RATIO_BASE - 0.05; // reactive adjustment
const volPass = xrpCase.volumeRatio >= volThreshold;
points += volPass ? 20 : 0;
details.push(`Volume: ${volPass ? 'PASS' : 'FAIL'} (${xrpCase.volumeRatio} >= ${volThreshold})`);

console.log('Filters:');
details.forEach(d => console.log(`  ${d}`));

console.log(`\nQuality Score: ${points}/100`);
console.log(`Required for ${xrpCase.mode}: ${cfg.QUALITY_MIN_SCORE_REACTIVE}`);

const canTrade = points >= cfg.QUALITY_MIN_SCORE_REACTIVE;
console.log(canTrade ? '✅ TRADE AUTORISÉ' : '❌ TRADE BLOQUÉ');

// Résumé final
console.log('\n═'.repeat(70));
console.log('\n📋 RÉSUMÉ DES TESTS\n');

const allOk = atrOk && volOk && holdOk && scoreOk;

if (allOk) {
  console.log('✅ TOUTES LES CORRECTIONS SONT APPLIQUÉES CORRECTEMENT\n');
  console.log('🚀 Les agents devraient maintenant trader plus fréquemment!');
  console.log('   - ATR réduit: Plus de cryptos éligibles');
  console.log('   - Volume réduit: Accepte liquidité modérée');
  console.log('   - Hold time réduit: Permet scalps rapides');
  console.log('   - Quality score ajusté: 2-3 filtres suffisent au lieu de 4-5');
} else {
  console.log('❌ CERTAINES CORRECTIONS NE SONT PAS APPLIQUÉES\n');
  if (!atrOk) console.log('   - ATR thresholds incorrect');
  if (!volOk) console.log('   - Volume ratios incorrect');
  if (!holdOk) console.log('   - Hold time incorrect');
  if (!scoreOk) console.log('   - Quality scores incorrect');
}

// Test supplémentaire: Momentum entry
console.log('\n📊 TEST BONUS: Momentum Entry Mode');
console.log('─'.repeat(70));
console.log('Scenario: BTC en forte hausse (+2%), EMA20 > EMA50');
console.log('Prix: 61200, EMA20: 61000, EMA50: 60500, ADX: 32');

const btcMomentum = {
  price: 61200,
  ema20: 61000,
  ema50: 60500,
  adx: 32,
};

const emaSpreadBtc = ((btcMomentum.ema20 - btcMomentum.ema50) / btcMomentum.ema50) * 100;
const priceTo20 = Math.abs((btcMomentum.price - btcMomentum.ema20) / btcMomentum.ema20);

const strongMomentum = btcMomentum.ema20 > btcMomentum.ema50 && 
                       emaSpreadBtc > 0.8 && 
                       priceTo20 < 0.025 && 
                       btcMomentum.adx > 25;

console.log(`EMA Spread: ${emaSpreadBtc.toFixed(2)}% (> 0.8% requis)`);
console.log(`Distance EMA20: ${(priceTo20 * 100).toFixed(2)}% (< 2.5% requis)`);
console.log(`ADX: ${btcMomentum.adx} (> 25 requis)`);

if (strongMomentum) {
  console.log('✅ MOMENTUM FORT DÉTECTÉ - Entry au prix actuel autorisée!');
  const range = btcMomentum.price * 0.008; // ±0.8%
  console.log(`   Zone d'entrée: ${(btcMomentum.price - range).toFixed(2)} - ${(btcMomentum.price + range).toFixed(2)}`);
  console.log('   🚀 Pas d\'attente de pullback nécessaire!');
} else {
  console.log('❌ Momentum insuffisant - Attente de pullback');
}

console.log('\n═'.repeat(70));
console.log('\n💡 PROCHAINES ÉTAPES:');
console.log('   1. Redémarrer le backend: npm -w backend run dev');
console.log('   2. Activer des agents en mode auto-select');
console.log('   3. Observer les diagnostics pendant 1-2h');
console.log('   4. Vérifier que canTrade = true plus souvent');
console.log('   5. Mesurer le nombre de trades vs avant\n');

process.exit(allOk ? 0 : 1);
