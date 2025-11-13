import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const { getPredictionSync } = await import('./dist/src/quantai/pythonPredictor.js');

console.log('Testing with simple feature set...');

const testFeatures = {
  rsi_14: 45,
  macd_line: 0.5,
  macd_signal: 0.3,
  macd_histogram: 0.2,
  ema_20: 50000,
  ema_50: 49000,
  ema20_50_pct: 2.04,
  atr_14: 1200,
  atr_14_pct: 2.4,
  adx_14: 25,
  bb_upper: 51000,
  bb_middle: 50000,
  bb_lower: 49000,
  bb_position: 0.5,
  bb_width_pct: 4,
  volume_sma_20: 1000000,
  volume_ratio: 1.5,
  obv: 5000000,
  obv_ema: 4500000,
  price_change_1h_pct: 0.5,
  price_change_4h_pct: 1.2,
  price_change_24h_pct: 3.5,
  high_low_range_pct: 2.0,
  close_open_pct: 0.8,
  ema20_slope: 0.1
};

try {
  const pred = getPredictionSync(testFeatures);
  console.log(`Decision: ${pred.decision.toUpperCase()}`);
  console.log(`Probabilities: L=${(pred.probabilityLong*100).toFixed(1)}% S=${(pred.probabilityShort*100).toFixed(1)}% N=${(pred.probabilityNone*100).toFixed(1)}%`);
  console.log(`Confidence: ${(pred.confidence*100).toFixed(1)}%`);
} catch (error) {
  console.error('Error:', error.message);
}
