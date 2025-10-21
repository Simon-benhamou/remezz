import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state/index.js');

const agent = new ReboundRejectionAgent();
agent.sessionId = 'bias-switch-test';

const profile = {
  symbol: 'ADA/USDT:USDT',
  mode: 'paper',
  maxLeverage: 2,
  riskPerTradePct: 1,
  dailyLossLimitPct: 3,
  timestamp: new Date().toISOString(),
  aggressiveness: 'reactive',
};

agent.profile = profile;
agent.ensurePerformanceMetricsSkeleton(profile);

const bearishSnapshot = {
  capturedAt: new Date().toISOString(),
  reason: 'stop_loss_hit',
  agentState: 'EXIT',
  sessionId: agent.sessionId,
  symbol: profile.symbol,
  exitOrderId: 'exit-1',
  exitSide: 'sell',
  exitPrice: 0.66,
  realizedPnl: -18,
  protectiveSnapshot: { slOrderId: null, tpOrderId: null, qty: 1200, side: 'buy' },
  indicators: {
    last: 0.66,
    ema20: 0.645,
    ema50: 0.672,
    ema100: 0.689,
    ema200: 0.702,
    rsi14: 34.8,
    atr14: 0.011,
    atrPct: 1.7,
    adx14: 18.5,
    cmf20: null,
    support: 0.64,
    resistance: 0.69,
    trendBias: 'bearish',
    srBias: 'nearResistance',
  },
};

agent.updateBiasSwitchingState({
  planBias: 'long',
  realizedPnl: -12,
  exitSnapshot: bearishSnapshot,
  exitReason: 'stop_loss_hit',
  side: 'buy',
});

assert.equal(
  agent.performanceMetrics.biasSwitching.consecutiveLosses,
  1,
  'First loss should increment consecutive loss counter without switching yet.',
);

const secondBearishSnapshot = {
  ...bearishSnapshot,
  exitOrderId: 'exit-2',
  capturedAt: new Date(Date.now() + 1000).toISOString(),
};

agent.updateBiasSwitchingState({
  planBias: 'long',
  realizedPnl: -20,
  exitSnapshot: secondBearishSnapshot,
  exitReason: 'stop_loss_hit',
  side: 'buy',
});

assert.equal(
  agent.performanceMetrics.biasSwitching.currentBias,
  'short',
  'Two bearish losses with strong reversal signals should flip adaptive bias to short.',
);
assert.equal(
  agent.performanceMetrics.biasSwitching.triggerThreshold,
  3,
  'After a switch the trigger threshold should widen slightly to reduce churn.',
);

const bullishSnapshot = {
  capturedAt: new Date(Date.now() + 2000).toISOString(),
  reason: 'target_hit',
  agentState: 'EXIT',
  sessionId: agent.sessionId,
  symbol: profile.symbol,
  exitOrderId: 'exit-3',
  exitSide: 'buy',
  exitPrice: 0.612,
  realizedPnl: 24,
  protectiveSnapshot: { slOrderId: null, tpOrderId: null, qty: 900, side: 'sell' },
  indicators: {
    last: 0.612,
    ema20: 0.618,
    ema50: 0.602,
    ema100: 0.595,
    ema200: 0.59,
    rsi14: 64.2,
    atr14: 0.009,
    atrPct: 1.1,
    adx14: 22.1,
    cmf20: null,
    support: 0.6,
    resistance: 0.64,
    trendBias: 'bullish',
    srBias: 'nearSupport',
  },
};

agent.updateBiasSwitchingState({
  planBias: 'short',
  realizedPnl: 30,
  exitSnapshot: bullishSnapshot,
  exitReason: 'target_hit',
  side: 'sell',
});

assert.equal(
  agent.performanceMetrics.biasSwitching.currentBias,
  'standby',
  'Winning trade should reset adaptive bias back to standby.',
);
assert.equal(
  agent.performanceMetrics.biasSwitching.triggerThreshold,
  2,
  'Resetting to standby should restore the default trigger threshold.',
);

console.log('✅ bias-switching.mjs passed');
