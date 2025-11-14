#!/usr/bin/env node
import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { getPrediction } from './dist/src/quantai/pythonPredictor.js';

const SYMBOLS = ['BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'ADA/USDT', 'ICP/USDT'];

console.log('\n🧪 Testing Predictor on Live Market Data\n');
console.log('═'.repeat(70));

for (const symbol of SYMBOLS) {
  try {
    console.log(`\n📊 ${symbol}`);
    console.log('─'.repeat(70));
    
    // Build technical snapshot
    const tech = await buildTechSnapshot(symbol);
    
    // Build predictor features
    const features = buildPredictorFeatures(tech);
    
    if (!features) {
      console.log('❌ No features available');
      continue;
    }
    
    // Show key indicators
    console.log('\nKey Indicators:');
    console.log(`  RSI:           ${tech.rsi14?.toFixed(2) || 'N/A'}`);
    console.log(`  MACD:          ${tech.macd?.toFixed(6) || 'N/A'}`);
    console.log(`  ADX:           ${tech.adx14?.toFixed(2) || 'N/A'}`);
    console.log(`  Volume Ratio:  ${tech.volumeRatio?.toFixed(2) || 'N/A'}`);
    console.log(`  ATR%:          ${tech.atrPct?.toFixed(2) || 'N/A'}%`);
    console.log(`  BB Position:   ${tech.bbPosition?.toFixed(2) || 'N/A'}`);
    
    // Get prediction
    const prediction = await getPrediction(features);
    
    console.log('\nPredictor Decision:');
    console.log(`  Decision:      ${prediction.decision.toUpperCase()}`);
    console.log(`  Confidence:    ${(prediction.confidence * 100).toFixed(1)}%`);
    console.log('\nProbabilities:');
    console.log(`  LONG:  ${(prediction.probabilities.long * 100).toFixed(1)}%`);
    console.log(`  SHORT: ${(prediction.probabilities.short * 100).toFixed(1)}%`);
    console.log(`  NONE:  ${(prediction.probabilities.none * 100).toFixed(1)}%`);
    
    // Analyze if prediction makes sense
    let analysis = '\nAnalysis: ';
    if (prediction.decision === 'long') {
      if (tech.rsi14 < 40) analysis += '✅ RSI oversold supports LONG';
      else if (tech.rsi14 > 60) analysis += '⚠️  RSI overbought but predicts LONG';
      else analysis += '➡️  Neutral RSI';
      
      if (tech.macd && tech.macdSignal && tech.macd > tech.macdSignal) {
        analysis += ' | ✅ MACD bullish';
      }
    } else if (prediction.decision === 'short') {
      if (tech.rsi14 > 60) analysis += '✅ RSI overbought supports SHORT';
      else if (tech.rsi14 < 40) analysis += '⚠️  RSI oversold but predicts SHORT';
      else analysis += '➡️  Neutral RSI';
      
      if (tech.macd && tech.macdSignal && tech.macd < tech.macdSignal) {
        analysis += ' | ✅ MACD bearish';
      }
    } else {
      analysis += '➡️  Predictor suggests staying out';
    }
    
    console.log(analysis);
    
  } catch (error) {
    console.log(`\n❌ Error: ${error.message}`);
  }
}

console.log('\n' + '═'.repeat(70));
console.log('\n✅ Test complete\n');
