import { buildTechSnapshot } from './dist/src/ai/tech.js';
import { buildPredictorFeatures } from './dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { getPrediction } from './dist/src/quantai/pythonPredictor.js';

const symbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'];

console.log('\n🔍 TEST: Label-Prediction Consistency\n');
console.log('Checking if predictions match current market movements...\n');

for (const symbol of symbols) {
  try {
    const snap = await buildTechSnapshot(symbol, undefined);
    const features = buildPredictorFeatures(snap);
    
    if (!features) {
      console.log(`⚠️  ${symbol}: No features`);
      continue;
    }
    
    const pred = await getPrediction(features);
    
    // Check recent price movement (last 5 candles)
    const candles = snap.candles.slice(-5);
    const oldPrice = candles[0]?.close || 0;
    const newPrice = candles[candles.length - 1]?.close || 0;
    const movement = ((newPrice - oldPrice) / oldPrice * 100).toFixed(2);
    
    const actualTrend = parseFloat(movement) > 0.5 ? '📈 UP' : 
                        parseFloat(movement) < -0.5 ? '📉 DOWN' : 
                        '➡️  FLAT';
    
    const predictedTrend = pred.probabilities.long > pred.probabilities.short ? '📈 LONG' : 
                           pred.probabilities.short > pred.probabilities.long ? '📉 SHORT' : 
                           '➡️  NONE';
    
    const match = (actualTrend.includes('UP') && predictedTrend.includes('LONG')) ||
                  (actualTrend.includes('DOWN') && predictedTrend.includes('SHORT')) ||
                  (actualTrend.includes('FLAT') && predictedTrend.includes('NONE'));
    
    console.log(`${match ? '✅' : '❌'} ${symbol}:`);
    console.log(`   Recent movement: ${movement}% ${actualTrend}`);
    console.log(`   Prediction: ${predictedTrend} (${(pred.probabilities.long * 100).toFixed(1)}% L / ${(pred.probabilities.short * 100).toFixed(1)}% S)`);
    console.log(`   Confidence: ${(pred.confidence * 100).toFixed(1)}%`);
    console.log(`   RSI: ${snap.indicators.rsi.toFixed(1)}, ADX: ${snap.indicators.adx.toFixed(1)}`);
    console.log('');
  } catch (error) {
    console.log(`⚠️  ${symbol}: ${error.message}\n`);
  }
}

console.log('Legend:');
console.log('  ✅ = Prediction matches recent movement');
console.log('  ❌ = Prediction contradicts recent movement');
