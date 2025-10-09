import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { deriveDirectionalBias } = await import('../../dist/src/ai/orchestrator.js');

const bullishSnapshot = {
  trend: 0.42,
  rsi14: 67.2,
  atrPct: 1.9,
  srBias: 'nearSupport',
  ema20: 102,
  ema50: 98,
};

assert.equal(
  deriveDirectionalBias(bullishSnapshot),
  'long',
  'Bullish structure with RSI in high 60s should still unlock long bias when ATR is contained.'
);

const neutralStretch = {
  trend: 0.18,
  rsi14: 72,
  atrPct: 3.1,
  srBias: 'neutral',
  ema20: 101,
  ema50: 99,
};

assert.equal(
  deriveDirectionalBias(neutralStretch),
  'range',
  'Overbought neutral context with elevated ATR should remain range/neutral.'
);

const bearishMomentum = {
  trend: -0.35,
  rsi14: 32,
  atrPct: 2.1,
  srBias: 'nearResistance',
  ema20: 97,
  ema50: 101,
};

assert.equal(
  deriveDirectionalBias(bearishMomentum),
  'short',
  'Downtrend near resistance with contained ATR and RSI near 30 should trigger short bias.'
);

console.log('✅ bias-decision.mjs passed');
