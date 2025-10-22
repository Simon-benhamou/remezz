import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { evaluateRecognizedStrategies } = await import('../../dist/src/quantai/strategies/metaAdaptive/recognizedStrategies.js');
const { metaAdaptiveStrategyAgent } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

metaAdaptiveStrategyAgent.reset();
metaAdaptiveStrategyAgent.setRandomSeed(7);

const snapshot = {
  symbol: 'ETH/USDT',
  last: 2800,
  ema20: 2810,
  ema50: 2795,
  ema100: 2750,
  ema200: 2680,
  rsi14: 61,
  atr14: 24,
  atrPct: 0.9,
  adx14: 26,
  ema20Slope: 1.4,
  support: 2700,
  resistance: 2900,
  supports: [{ price: 2700, label: 'S1', touches: 4, strength: 3 }],
  resistances: [{ price: 2900, label: 'R1', touches: 2, strength: 2 }],
  pivots: {
    P: 2800,
    S1: 2750,
    S2: 2700,
    R1: 2850,
    R2: 2900,
    refDay: new Date().toISOString().slice(0, 10),
  },
  trend: 1.2,
  srBias: 'neutral',
  meta: { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
  realizedVol: 1.1,
  hurst: 0.58,
  trendStrength: 0.82,
  trendBias: 'bullish',
  volume: 1_500_000,
  volumeMA: 1_000_000,
  volume24h: 320_000_000,
  cmf20: 0.28,
  multiTimeframe: {
    timeframes: {
      '4h': { tf: '4h', bias: 'bullish', momentumPct: 0.48, rsi: 58 },
      '1h': { tf: '1h', bias: 'bullish', momentumPct: 0.41, rsi: 55 },
      '15m': { tf: '15m', bias: 'bullish', momentumPct: 0.36, rsi: 53 },
    },
    agreementScore: 3,
    divergenceScore: 0,
  },
};

const signals = evaluateRecognizedStrategies(snapshot, {
  sessionId: 'python-signal',
  symbol: 'ETH/USDT',
  bias: 'long',
});

assert(signals.length > 0, 'Expected strategy signals for bullish snapshot');

for (const signal of signals) {
  assert(signal.meta?.pythonSignal, 'Each signal should expose pythonSignal in meta');
  assert(signal.meta.pythonSignal?.bias === 'long', 'Stub predictor should bias signals long');
  assert(signal.reasons.some(reason => reason.startsWith('python_bias=')), 'Reason list must annotate python bias');
}

console.log('✅ python predictor weighting influences adaptive signals');
