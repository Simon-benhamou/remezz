#!/usr/bin/env node
/**
 * Test Short Detection - Vérifie que la stratégie peut maintenant shorter
 */

import { evaluateRecognizedStrategies } from './dist/src/quantai/strategies/metaAdaptive/recognizedStrategies.js';

console.log('🧪 TEST: Détection de SHORT avec nouvelles règles\n');

// Scénario 1: 15m+1h bearish, 4h encore bullish (early short signal)
const snapshot1 = {
  symbol: 'AERO/USDT',
  last: 1.20,
  atr14: 0.024,
  atrPct: 2.0,
  adx14: 24,
  rsi14: 42,
  trendBias: 'bearish',
  srBias: 'below_support',
  cmf20: -0.15,
  volume: 1500000,
  volumeMA: 1000000,
  trendStrength: 0.72,
  multiTimeframe: {
    timeframes: {
      '15m': { tf: '15m', bias: 'bearish', momentumPct: -0.38, rsi: 41 },
      '1h': { tf: '1h', bias: 'bearish', momentumPct: -0.32, rsi: 43 },
      '4h': { tf: '4h', bias: 'bullish', momentumPct: 0.15, rsi: 54 }, // 🔥 Lag!
    },
    agreementScore: 2,
    divergenceScore: 1,
  },
};

// Scénario 2: Toutes timeframes bearish (75% alignment = OK maintenant)
const snapshot2 = {
  symbol: 'AERO/USDT',
  last: 1.18,
  atr14: 0.022,
  atrPct: 1.86,
  adx14: 26,
  rsi14: 38,
  trendBias: 'bearish',
  srBias: 'below_support',
  cmf20: -0.22,
  volume: 1800000,
  volumeMA: 1000000,
  trendStrength: 0.78,
  multiTimeframe: {
    timeframes: {
      '15m': { tf: '15m', bias: 'bearish', momentumPct: -0.45, rsi: 37 },
      '1h': { tf: '1h', bias: 'bearish', momentumPct: -0.38, rsi: 39 },
      '4h': { tf: '4h', bias: 'bearish', momentumPct: -0.28, rsi: 42 },
    },
    agreementScore: 3,
    divergenceScore: 0,
  },
};

// Scénario 3: Signal mixte (bias='both') - devrait être bloqué
const snapshot3 = {
  symbol: 'AERO/USDT',
  last: 1.21,
  atr14: 0.028,
  atrPct: 2.31,
  adx14: 16,
  rsi14: 52,
  trendBias: 'neutral',
  srBias: 'near_support',
  cmf20: 0.05,
  volume: 1100000,
  volumeMA: 1000000,
  trendStrength: 0.48,
  multiTimeframe: {
    timeframes: {
      '15m': { tf: '15m', bias: 'bullish', momentumPct: 0.18, rsi: 56 },
      '1h': { tf: '1h', bias: 'bearish', momentumPct: -0.12, rsi: 48 },
      '4h': { tf: '4h', bias: 'neutral', momentumPct: 0.05, rsi: 51 },
    },
    agreementScore: 0,
    divergenceScore: 2,
  },
};

async function runTest(scenarioName, snapshot) {
  console.log(`📌 ${scenarioName}`);
  console.log(`   15m: ${snapshot.multiTimeframe.timeframes['15m'].bias}`);
  console.log(`   1h:  ${snapshot.multiTimeframe.timeframes['1h'].bias}`);
  console.log(`   4h:  ${snapshot.multiTimeframe.timeframes['4h'].bias}`);
  console.log(`   ADX: ${snapshot.adx14}, RSI: ${snapshot.rsi14}\n`);

  try {
    const signals = await evaluateRecognizedStrategies(snapshot, {
      sessionId: 'test-short-detection',
      symbol: snapshot.symbol,
    });

    if (signals.length === 0) {
      console.log(`   ❌ Aucun signal généré\n`);
      return;
    }

    const shortSignals = signals.filter(s => s.bias === 'short');
    const longSignals = signals.filter(s => s.bias === 'long');
    const bothSignals = signals.filter(s => s.bias === 'both');

    console.log(`   🎯 Signaux générés: ${signals.length}`);
    console.log(`      - SHORT: ${shortSignals.length}`);
    console.log(`      - LONG: ${longSignals.length}`);
    console.log(`      - BOTH: ${bothSignals.length} (bloqués si présents)`);

    if (shortSignals.length > 0) {
      console.log(`\n   ✅ SHORT DÉTECTÉ!`);
      shortSignals.forEach(s => {
        console.log(`      Strategy: ${s.id}`);
        console.log(`      Confidence: ${(s.confidence * 100).toFixed(1)}%`);
        console.log(`      Score: ${s.meta?.score?.toFixed(3)}`);
      });
    }

    if (bothSignals.length > 0) {
      console.log(`\n   ⚠️  Signal BOTH détecté (devrait être bloqué par backtest)`);
    }

    console.log('\n');
  } catch (error) {
    console.error(`   ❌ Erreur:`, error.message);
    console.log('\n');
  }
}

async function main() {
  await runTest('SCÉNARIO 1: Early Short (15m+1h bearish, 4h lag)', snapshot1);
  await runTest('SCÉNARIO 2: Full Short (3/3 bearish, 75% alignment)', snapshot2);
  await runTest('SCÉNARIO 3: Signal Mixte (devrait être bloqué)', snapshot3);

  console.log('✅ Tests terminés\n');
  console.log('📝 Résultats attendus:');
  console.log('   - Scénario 1: SHORT détecté (early detection)');
  console.log('   - Scénario 2: SHORT détecté (75% seuil)');
  console.log('   - Scénario 3: BOTH bloqué (pas de trade)\n');
}

main().catch(console.error);
