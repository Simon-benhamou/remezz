import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { registerAdaptiveTradeEntry, registerAdaptiveTradeOutcome } = await import('../../dist/src/quantai/strategies/metaAdaptive/recognizedStrategies.js');
const { metaAdaptiveStrategyAgent } = await import('../../dist/src/quantai/strategies/metaAdaptive/metaAdaptiveAgent.js');

metaAdaptiveStrategyAgent.reset();

const sessionId = 'python-hybrid-session';
const symbol = 'BTC/USDT';

const recognizedSignal = {
  id: 'classic_trend_following',
  label: 'Trend',
  bias: 'long',
  confidence: 0.82,
  active: true,
  reasons: ['test'],
  metrics: {},
  meta: {
    score: 0.76,
    penalties: [],
    exploration: false,
    token: 'test-trade-token',
    executionMode: 'market',
    riskPct: '1.0',
    stopAtrMult: '1.0',
    takeProfitMultiples: ['1.5', '2.0'],
    riskUsd: '0',
    targetProfitUsd: '0',
    entryWeight: '1.2',
    pythonRiskMultiplier: '1.3',
    predictorFeatures: { feature_a: 1 },
    pythonSignal: {
      bias: 'long',
      probability: 0.72,
      bearishProbability: 0.28,
      confidence: 0.64,
      entryWeight: 1.2,
      riskMultiplier: 1.3,
      cooldown: { active: false, reason: null, seconds: null },
      meta: { source: 'test' },
    },
  },
};

await registerAdaptiveTradeEntry({
  sessionId,
  symbol,
  signal: recognizedSignal,
  qty: 2,
  entryPrice: 100,
  stopDistance: 5,
});

const activeMap = metaAdaptiveStrategyAgent.activeTrades;
assert(activeMap instanceof Map, 'Active trades map should be available');
const queue = activeMap.get(sessionId);
assert(Array.isArray(queue) && queue.length === 1, 'Queue should contain one active trade');
const trade = queue[0];
assert.equal(trade.pythonRiskMultiplier, 1.3, 'Python risk multiplier should be stored');
assert.equal(trade.pythonEntryWeight, 1.2, 'Python entry weight should be stored');

await registerAdaptiveTradeOutcome({
  sessionId,
  symbol,
  token: recognizedSignal.meta.token,
  realizedPnlUsd: 25,
});

const metrics = metaAdaptiveStrategyAgent.pythonPerformance.getMetrics();
assert.equal(metrics.samples, 1, 'Python performance tracker should record one sample');
assert(metrics.hitRate > 0.5, 'Hit rate should reflect profitable outcome');

metaAdaptiveStrategyAgent.reset();
