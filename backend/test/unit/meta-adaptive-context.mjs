import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { evaluateRecognizedStrategies } = await import('../../dist/src/quantai/strategy/recognizedStrategies.js');

function buildConflictSnapshot() {
  const last = 100;
  return {
    symbol: 'SOL/USDT',
    last,
    ema20: last * 1.005,
    ema50: last * 1.007,
    ema100: last * 1.01,
    ema200: last * 1.012,
    rsi14: 48,
    atr14: last * 0.011,
    atrPct: 1.1,
    adx14: 18,
    ema20Slope: last * 0.0004,
    support: last * 0.97,
    resistance: last * 1.03,
    supports: [{ price: last * 0.97, label: 'S1', touches: 2, strength: 2 }],
    resistances: [{ price: last * 1.03, label: 'R1', touches: 1, strength: 1 }],
    pivots: {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date().toISOString().slice(0, 10),
    },
    trend: 0.6,
    srBias: 'neutral',
    meta: { tf: '15m', contextTf: '4h', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: 1.2,
    hurst: 0.55,
    adxSlope: 0.2,
    trendStrength: 0.42,
    trendBias: 'bullish',
    volume: 900_000,
    volumeMA: 600_000,
    volume24h: 45_000_000,
    cmf20: 0.05,
    multiTimeframe: {
      timeframes: {
        '4h': { tf: '4h', bias: 'bullish', momentumPct: 0.6, rsi: 58 },
        '1h': { tf: '1h', bias: 'bullish', momentumPct: 0.4, rsi: 56 },
        '15m': { tf: '15m', bias: 'bearish', momentumPct: -0.5, rsi: 44 },
      },
      agreementScore: 2,
      divergenceScore: 1,
    },
  };
}

const conflictSnap = buildConflictSnapshot();
const signals = evaluateRecognizedStrategies(conflictSnap, {
  sessionId: 'context-alignment-test',
  symbol: 'SOL/USDT',
  bias: 'long',
  regime: 'trend_following',
  allowMomentumOverride: true,
});

const trendSignal = signals.find(signal => signal.id === 'classic_trend_following');
assert(trendSignal, 'trend signal should be present');
assert(trendSignal.meta?.penalties.includes('htf_conflict'), 'trend signal should record htf conflict');
assert.equal(trendSignal.meta?.riskPct, '0.600000', 'trend risk must be cut under conflict');
assert.equal(trendSignal.meta?.executionMode, 'limit', 'trend execution should remain passive under conflict');

const meanSignal = signals.find(signal => signal.id === 'bollinger_mean_reversion');
assert(meanSignal, 'mean reversion signal should be present');
assert(meanSignal.active, 'mean reversion should stay active under conflict');
assert.equal(meanSignal.meta?.riskPct, '1.000000', 'mean reversion risk should flex higher under conflict');
assert(meanSignal.reasons.some(reason => reason.startsWith('context_inverse=')), 'mean reversion should log context inverse reason');

console.log('✅ meta-adaptive context alignment test passed');
