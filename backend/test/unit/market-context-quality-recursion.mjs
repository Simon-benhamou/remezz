import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state.js');

function createAgent() {
  const agent = new ReboundRejectionAgent();
  agent.profile = {
    mode: 'paper',
    symbol: 'BTC/USDT:USDT',
    maxLeverage: 2,
    riskPerTradePct: 1.2,
    dailyLossLimitPct: 4,
    startBalanceUsd: 10_000,
    aggressiveness: 'reactive',
  };

  agent.plan = {
    plan: {
      meta: { playbook: 'momentum_breakout' },
      risk: {
        max_hold_hours: 24,
        tp: [{ value: 1.8 }],
      },
    },
    symbol: 'BTC/USDT:USDT',
    tf: '15m',
    bias: 'long',
    zone: { from: 100, to: 110, mid: 105 },
    atr: 1,
    atrPct: 0.5,
    stopDistance: 10,
    rPrices: [{ r: 2, price: 90 }],
    entryOkNow: true,
    sizing: { riskPct: 1.2, maxLev: 2, notionalUsd: 2_500 },
    guards: { spreadOk: true, leverageOk: true, volumeOk: true },
  };

  return agent;
}

const agent = createAgent();

const snapshot = {
  symbol: 'BTC/USDT:USDT',
  last: 101,
  ema20: 101.6,
  ema50: 99.2,
  ema20Slope: 0.08,
  rsi14: 58,
  adx14: 27,
  atrPct: 1.1,
  volume: 1_500_000,
  volumeMA: 1_100_000,
  supports: [],
  resistances: [],
  srBias: 'neutral',
  meta: { tf: '15m' },
};

assert.doesNotThrow(() => {
  agent.resolveMarketContext(snapshot, 'momentum_breakout', 'long');
}, 'resolveMarketContext should not recurse when refreshing diagnostics');

assert(agent.previewQualityDiagnostics, 'preview diagnostics should be populated after resolving market context');
assert.equal(
  typeof agent.previewQualityDiagnostics.assessment.allow,
  'boolean',
  'assessment allow flag should be a boolean'
);

console.log('✅ market-context-quality-recursion.mjs passed');
