#!/usr/bin/env node
/**
 * Diagnostic: Pourquoi l'agent n'est pas re-entré en LONG sur ETH après l'exit SHORT
 */

import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { getPredictionSyncSafe } from './dist/src/quantai/pythonPredictor.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

async function diagnoseETHReentry() {
  console.log('\n' + '═'.repeat(80));
  console.log('🔍 DIAGNOSTIC: Pourquoi pas de RE-ENTRY LONG sur ETH?');
  console.log('═'.repeat(80) + '\n');

  try {
    const symbol = 'ETH/USDT';
    
    console.log(`📊 Analysing ${symbol} conditions NOW...\n`);

    // 1. Get current technical snapshot
    console.log('1️⃣ Technical Snapshot (15m):');
    console.log('-'.repeat(80));
    
    const snap = await buildTechSnapshot(symbol, '15m');
    
    console.log(`   Price: $${snap.last.toFixed(2)}`);
    console.log(`   EMA20: $${snap.ema20?.toFixed(2) || 'N/A'}`);
    console.log(`   EMA50: $${snap.ema50?.toFixed(2) || 'N/A'}`);
    console.log(`   RSI: ${snap.rsi14?.toFixed(1) || 'N/A'}`);
    console.log(`   ADX: ${snap.adx14?.toFixed(1) || 'N/A'}`);
    console.log(`   ATR%: ${snap.atrPct?.toFixed(2) || 'N/A'}%`);
    console.log(`   Trend: ${snap.trendBias || 'N/A'}`);
    console.log();

    // 2. Multi-timeframe analysis
    console.log('2️⃣ Multi-Timeframe Bias:');
    console.log('-'.repeat(80));
    
    const tf = snap.multiTimeframe?.timeframes || {};
    const tf15m = tf['15m']?.bias || 'unknown';
    const tf1h = tf['1h']?.bias || 'unknown';
    const tf4h = tf['4h']?.bias || 'unknown';
    
    console.log(`   15m: ${tf15m}`);
    console.log(`   1h:  ${tf1h}`);
    console.log(`   4h:  ${tf4h}`);
    
    const bullishStack = tf15m === 'bullish' && tf1h === 'bullish' && tf4h === 'bullish';
    const hasConflict = 
      (tf4h === 'bullish' && tf1h === 'bearish') ||
      (tf4h === 'bearish' && tf1h === 'bullish');
    
    if (bullishStack) {
      console.log(`   ✅ BULLISH STACK → Long entry possible`);
    } else if (hasConflict) {
      console.log(`   ❌ CONFLICT → Standby (no entry)`);
    } else {
      console.log(`   ⚠️  NO CLEAR ALIGNMENT → Standby`);
    }
    console.log();

    // 3. Predictor ML Analysis
    console.log('3️⃣ ML Predictor Bias:');
    console.log('-'.repeat(80));
    
    try {
      const features = await buildPredictorFeatures(symbol, snap);
      const prediction = await getPredictionSyncSafe(symbol, features);
      
      if (prediction) {
        console.log(`   Signal: ${prediction.signal || 'N/A'}`);
        console.log(`   Bias: ${prediction.bias || 'N/A'}`);
        console.log(`   Confidence: ${((prediction.confidence || 0) * 100).toFixed(1)}%`);
        console.log(`   Probabilities:`);
        console.log(`      Long:  ${((prediction.probabilities?.long || 0) * 100).toFixed(1)}%`);
        console.log(`      Short: ${((prediction.probabilities?.short || 0) * 100).toFixed(1)}%`);
        console.log(`      Neutral: ${((prediction.probabilities?.neutral || 0) * 100).toFixed(1)}%`);
        
        if (prediction.bias === 'long' && prediction.confidence >= 0.15) {
          console.log(`   ✅ PREDICTOR ALLOWS LONG (confidence >= 15%)`);
        } else if (prediction.bias === 'short') {
          console.log(`   ❌ PREDICTOR STILL BEARISH → No long entry`);
        } else {
          console.log(`   ⚠️  LOW CONFIDENCE (${(prediction.confidence * 100).toFixed(1)}%) → No entry`);
        }
      } else {
        console.log(`   ⚠️  Predictor not available`);
      }
    } catch (err) {
      console.log(`   ❌ Predictor error: ${err.message}`);
    }
    console.log();

    // 4. Entry Conditions Summary
    console.log('4️⃣ Entry Conditions Check:');
    console.log('-'.repeat(80));
    
    const conditions = {
      'ADX >= 15': (snap.adx14 || 0) >= 15,
      'RSI 30-80': (snap.rsi14 || 50) >= 30 && (snap.rsi14 || 50) <= 80,
      'Bullish EMA': (snap.ema20 || 0) > (snap.ema50 || 0),
      'No HTF conflict': !hasConflict,
      'Bullish stack': bullishStack,
    };
    
    Object.entries(conditions).forEach(([name, passed]) => {
      console.log(`   ${passed ? '✅' : '❌'} ${name}`);
    });
    
    const allPassed = Object.values(conditions).every(v => v);
    console.log();
    
    if (allPassed) {
      console.log('═'.repeat(80));
      console.log('🎯 VERDICT: CONDITIONS MET → Long entry SHOULD be possible');
      console.log('   → Check for cooldown or stale data');
      console.log('═'.repeat(80));
    } else {
      console.log('═'.repeat(80));
      console.log('⚠️  VERDICT: CONDITIONS NOT MET → Standby is CORRECT behavior');
      console.log('   → System is waiting for better setup');
      console.log('═'.repeat(80));
    }

  } catch (error) {
    console.error('\n❌ Diagnostic failed:', error);
    console.error(error.stack);
  }
}

diagnoseETHReentry();
