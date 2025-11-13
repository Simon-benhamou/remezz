import dotenv from 'dotenv';
dotenv.config();

const { getPredictionSync } = await import('./dist/src/quantai/pythonPredictor.js');

const completeFeatures = {
  ema9: 50100,
  ema12: 50080,
  ema20: 50000,
  ema26: 49950,
  ema50: 49800,
  ema100: 49500,
  ema200: 48000,
  rsi7: 48,
  rsi14: 45,
  rsi21: 47,
  rsiSlope: -0.5,
  stoch_k: 40,
  stoch_d: 35,
  macd: 50,
  macd_signal: 30,
  macd_diff: 20,
  momentum3: 0.5,
  momentum5: 0.8,
  momentum10: 1.2,
  momentum20: 2.0,
  atr7: 1100,
  atr14: 1200,
  atrPct: 0.024,
  bb_width: 0.04,
  bb_position: 0.5,
  volatilityRegime: 0.025,
  adx14: 25,
  adx_pos: 15,
  adx_neg: 10,
  ema20Slope: 0.001,
  ema50Slope: 0.0005,
  trendStrength: 0.3,
  volumeRatio: 1.5,
  volumeZScore: 0.5,
  obv_slope: 0.2,
  vol_price_conf: 0.6,
  spreadProxy: 0.001,
  dist_ema20: 0.002,
  dist_ema50: 0.004,
  dist_ema200: 0.042,
  emaRatio_9_20: 1.002,
  emaRatio_20_200: 1.042,
  emaRatio_50_200: 1.038,
  emaTrendSpread: 0.004,
  atrPct_1h: 0.023,
  atrPct_4h: 0.025,
  rsi14_1h: 46,
  rsi14_4h: 44,
  microImbalance: 0.1,
  mtfAgreement: 0.5,
  vol_adj_momentum: 0.8,
  rsi_ema_div: -2.5
};

console.log('Testing with complete 52 features...');

try {
  const pred = getPredictionSync(completeFeatures);
  console.log(`✅ Decision: ${pred.decision.toUpperCase()}`);
  console.log(`Probabilities: L=${(pred.probabilityLong*100).toFixed(1)}% S=${(pred.probabilityShort*100).toFixed(1)}% N=${(pred.probabilityNone*100).toFixed(1)}%`);
  console.log(`Confidence: ${(pred.confidence*100).toFixed(1)}%`);
} catch (error) {
  console.error('❌ Error:', error.message);
}
