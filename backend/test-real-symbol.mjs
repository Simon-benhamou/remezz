import dotenv from 'dotenv';
dotenv.config();

const { getPredictionSync } = await import('./dist/src/quantai/pythonPredictor.js');
const { buildTechSnapshot } = await import('./dist/src/ai/tech.js');
const { buildPredictorFeatures } = await import('./dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

const symbol = 'BTC/USDT:USDT';

console.log(`Testing with real data from ${symbol}...`);

try {
  const snap = await buildTechSnapshot(symbol);
  if (!snap) {
    console.error('No snapshot available');
    process.exit(1);
  }
  
  console.log(`✅ Got snapshot: last=${snap.last?.toFixed(2)}`);
  
  const features = buildPredictorFeatures(snap);
  if (!features) {
    console.error('Failed to build features');
    process.exit(1);
  }
  
  const featureCount = Object.keys(features).length;
  console.log(`✅ Built ${featureCount} features`);
  console.log(`   Sample: rsi14=${features.rsi14?.toFixed(1)}, adx14=${features.adx14?.toFixed(1)}, atrPct=${(features.atrPct*100).toFixed(2)}%`);
  
  const pred = getPredictionSync(features);
  console.log(`\n✅ Decision: ${pred.decision.toUpperCase()}`);
  console.log(`Probabilities: L=${(pred.probabilityLong*100).toFixed(1)}% S=${(pred.probabilityShort*100).toFixed(1)}% N=${(pred.probabilityNone*100).toFixed(1)}%`);
  console.log(`Confidence: ${(pred.confidence*100).toFixed(1)}%`);
  
} catch (error) {
  console.error('❌ Error:', error.message);
  console.error(error.stack);
}
