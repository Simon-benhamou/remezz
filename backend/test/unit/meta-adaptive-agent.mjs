import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
} = await import('../../dist/src/quantai/strategy/recognizedStrategies.js');

const sessionId = 'meta-test-session';

function buildSnapshot(overrides = {}) {
  const last = overrides.last ?? 100;
  return {
    symbol: overrides.symbol ?? 'BTC/USDT',
    last,
    ema20: overrides.ema20 ?? last * 1.01,
    ema50: overrides.ema50 ?? last * 1.005,
    ema100: overrides.ema100 ?? last * 0.998,
    ema200: overrides.ema200 ?? last * 0.99,
    rsi14: overrides.rsi14 ?? 62,
    atr14: overrides.atr14 ?? (last * 0.012),
    atrPct: overrides.atrPct ?? 1.2,
    adx14: overrides.adx14 ?? 28,
    ema20Slope: overrides.ema20Slope ?? last * 0.0015,
    support: overrides.support ?? last * 0.97,
    resistance: overrides.resistance ?? last * 1.03,
    supports: overrides.supports ?? [{ price: last * 0.97, label: 'S1', touches: 3, strength: 2 }],
    resistances: overrides.resistances ?? [{ price: last * 1.03, label: 'R1', touches: 2, strength: 2 }],
    pivots: overrides.pivots ?? {
      P: last,
      S1: last * 0.99,
      S2: last * 0.98,
      R1: last * 1.01,
      R2: last * 1.02,
      refDay: new Date().toISOString().slice(0, 10),
    },
    trend: overrides.trend ?? 1.4,
    srBias: overrides.srBias ?? 'nearSupport',
    meta: overrides.meta ?? { tf: '15m', windowBars: 120, recentBarsFor24h: 96 },
    realizedVol: overrides.realizedVol ?? 1.4,
    hurst: overrides.hurst ?? 0.62,
    trendStrength: overrides.trendStrength ?? 0.9,
    trendBias: overrides.trendBias ?? 'bullish',
    volume: overrides.volume ?? 1_000_000,
    volumeMA: overrides.volumeMA ?? 600_000,
    volume24h: overrides.volume24h ?? 80_000_000,
    cmf20: overrides.cmf20 ?? 0.35,
  };
}

const strongTrendSnap = buildSnapshot();
const result = evaluateRecognizedStrategies(strongTrendSnap, {
  sessionId,
  symbol: 'BTC/USDT',
  bias: 'long',
  regime: 'trend_following',
  allowMomentumOverride: true,
  favorMeanReversion: false,
});

assert.equal(result.length, 4, 'Expected four strategy signals');
const selected = result.find(signal => signal.meta?.token);
assert(selected, 'Primary strategy should include token metadata');
const acceptable = new Set(['classic_trend_following', 'momentum_scanner_focus']);
assert(acceptable.has(selected.id), 'Trending context should select a trend-aware family');
assert.equal(selected.active, true, 'Trend strategy should be active');

// Simulate a run of consecutive losses to trigger guardrail logic
for (let i = 0; i < 6; i += 1) {
  registerAdaptiveTradeEntry({
    sessionId,
    symbol: 'BTC/USDT',
    signal: selected,
    qty: 1,
    entryPrice: 100,
    stopDistance: 1,
  });
  registerAdaptiveTradeOutcome({
    sessionId,
    symbol: 'BTC/USDT',
    token: selected.meta?.token ?? null,
    realizedPnlUsd: -25,
  });
}

const postLoss = evaluateRecognizedStrategies(strongTrendSnap, {
  sessionId,
  symbol: 'BTC/USDT',
  bias: 'long',
  regime: 'trend_following',
  allowMomentumOverride: true,
  favorMeanReversion: false,
});

const afterGuardrail = postLoss.find(signal => signal.id === selected.id);
assert(afterGuardrail, 'Trend strategy should still be present');
assert.equal(afterGuardrail.active, false, 'Guardrail should deactivate trend strategy after repeated losses');
assert(afterGuardrail.meta?.guardrail?.includes('winrate'), 'Guardrail reason should mention winrate');

console.log('✅ meta-adaptive-agent logic test passed');
