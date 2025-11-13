#!/usr/bin/env node
import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { getPredictionSyncSafe } from './dist/src/quantai/pythonPredictor.js';

async function analyzeXRP() {
  console.log('='.repeat(80));
  console.log('🔍 XRP/USDT Predictor Deep Dive');
  console.log('='.repeat(80));
  
  const snap = await buildTechSnapshot('XRP/USDT');
  const features = buildPredictorFeatures(snap);
  
  if (!features) {
    console.log('❌ Could not build features');
    process.exit(1);
  }
  
  const pred = getPredictionSyncSafe(features, { allowFallback: true });
  
  console.log('\n🤖 PREDICTOR DECISION:');
  console.log('  Decision:', pred.decision.toUpperCase());
  console.log('  Confidence:', (pred.confidence * 100).toFixed(2) + '%');
  console.log('  Source:', pred.source || 'unknown');
  
  console.log('\n📊 PROBABILITIES:');
  console.log('  🟢 LONG:  ', (pred.probabilities.long * 100).toFixed(2) + '%');
  console.log('  🔴 SHORT: ', (pred.probabilities.short * 100).toFixed(2) + '%');
  console.log('  ⚪ NONE:  ', (pred.probabilities.none * 100).toFixed(2) + '%');
  
  console.log('\n📈 MARKET STATE:');
  console.log('  Price:', snap.last?.toFixed(4));
  console.log('  RSI 14:', features.rsi14?.toFixed(2), features.rsi14 < 30 ? '⚠️ OVERSOLD' : features.rsi14 > 70 ? '⚠️ OVERBOUGHT' : '');
  console.log('  RSI Slope:', features.rsiSlope?.toFixed(4), features.rsiSlope > 0 ? '📈 Rising' : '📉 Falling');
  console.log('  ADX:', features.adx14?.toFixed(2), features.adx14 > 25 ? '💪 Strong trend' : '😴 Weak trend');
  console.log('  Trend Bias:', features.trendBias, features.trendBias > 0 ? '🟢 Bullish' : features.trendBias < 0 ? '🔴 Bearish' : '⚪ Neutral');
  console.log('  ATR %:', (features.atrPct * 100)?.toFixed(2) + '%');
  
  console.log('\n🎯 EMAs:');
  console.log('  EMA 9:', snap.ema9?.toFixed(4));
  console.log('  EMA 20:', snap.ema20?.toFixed(4));
  console.log('  EMA 50:', snap.ema50?.toFixed(4));
  console.log('  EMA 200:', snap.ema200?.toFixed(4));
  console.log('  Position: Price', snap.last < snap.ema20 ? '< EMA20' : '> EMA20');
  
  console.log('\n⚡ MOMENTUM:');
  console.log('  3-bar:', (features.momentum3 * 100)?.toFixed(2) + '%');
  console.log('  5-bar:', (features.momentum5 * 100)?.toFixed(2) + '%');
  console.log('  10-bar:', (features.momentum10 * 100)?.toFixed(2) + '%');
  console.log('  MACD:', features.macd?.toFixed(4));
  
  console.log('\n💧 VOLUME:');
  console.log('  Z-Score:', features.volumeZScore?.toFixed(2));
  console.log('  Ratio:', features.volumeRatio?.toFixed(2));
  
  console.log('\n🤔 ANALYSIS:');
  if (pred.decision === 'long' && features.trendBias < 0) {
    console.log('  ⚠️  CONTRADICTION: Predictor says LONG but trend is BEARISH!');
    console.log('  🔍 Possible reasons:');
    console.log('     - RSI oversold (', features.rsi14?.toFixed(2), ') = bounce expected?');
    console.log('     - RSI slope positive = momentum shift?');
    console.log('     - Volume surge = reversal signal?');
  }
  
  console.log('\n' + '='.repeat(80));
}

analyzeXRP().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
