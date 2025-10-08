import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state.js');

function sumPoints(filters) {
  return Object.values(filters).reduce((sum, filter) => sum + (filter.points || 0), 0);
}

function createAgent(playbook, bias = 'long') {
  const agent = new ReboundRejectionAgent();
  agent.profile = {
    mode: 'paper',
    symbol: 'SOL/USDT:USDT',
    maxLeverage: 3,
    riskPerTradePct: 1.5,
    dailyLossLimitPct: 3.5,
    startBalanceUsd: 5000,
    aggressiveness: 'reactive',
  };

  agent.plan = {
    plan: {
      meta: { playbook },
      risk: {
        max_hold_hours: 36,
        tp: [{ value: 2 }],
      },
    },
    symbol: 'SOL/USDT:USDT',
    tf: '15m',
    bias,
    zone: { from: 229, to: 231, mid: 230 },
    atr: 1,
    atrPct: 0.5,
    stopDistance: 11,
    rPrices: [{ r: 2, price: 208 }],
    entryOkNow: true,
    sizing: { riskPct: 1.5, maxLev: 3, notionalUsd: 1500 },
    guards: { spreadOk: true, leverageOk: true, volumeOk: true },
  };

  return agent;
}

const momentumAgent = createAgent('momentum_breakout', 'long');
const momentumSnap = {
  symbol: 'SOL/USDT:USDT',
  last: 123.4,
  ema20: 124.6,
  ema50: 120.8,
  rsi14: 62.5,
  adx14: 27.2,
  atrPct: 1.15,
  volume: 1850,
  volumeMA: 1400,
  supports: [],
  resistances: [],
  srBias: 'neutral',
};

const momentumFilters = momentumAgent['getQualityFiltersDiagnostics'](momentumSnap);
const momentumPoints = sumPoints(momentumFilters);
assert(momentumPoints >= 55, `momentum setup should clear breakout threshold (got ${momentumPoints})`);
assert.equal(momentumFilters.momentum.status, 'PASS', 'momentum filter should pass for breakout context');

const meanAgent = createAgent('mean_reversion', 'long');
const meanSnap = {
  symbol: 'SOL/USDT:USDT',
  last: 102.1,
  ema20: 102.5,
  ema50: 101.7,
  rsi14: 32.4,
  adx14: 15.3,
  atrPct: 0.75,
  volume: 900,
  volumeMA: 1200,
  supports: [{ price: 99.7, touches: 3, strength: 3 }],
  resistances: [],
  srBias: 'nearSupport',
};

const meanFilters = meanAgent['getQualityFiltersDiagnostics'](meanSnap);
const meanPoints = sumPoints(meanFilters);
assert(meanPoints >= 40, `mean reversion setup should clear relaxed threshold (got ${meanPoints})`);
assert.equal(meanFilters.momentum.status, 'PASS', 'mean reversion should accept low ADX as range confirmation');
assert.equal(meanFilters.rsiPosition.status, 'PASS', 'RSI divergence near support should qualify mean reversion entries');

const poorMeanSnap = {
  symbol: 'SOL/USDT:USDT',
  last: 104.2,
  ema20: 106.8,
  ema50: 101.5,
  rsi14: 48.1,
  adx14: 29.9,
  atrPct: 0.01,
  volume: 100,
  volumeMA: 1200,
  supports: [],
  resistances: [],
  srBias: 'neutral',
};

const poorMeanFilters = meanAgent['getQualityFiltersDiagnostics'](poorMeanSnap);
const poorMeanPoints = sumPoints(poorMeanFilters);
assert(poorMeanPoints < 40, `uninspired range trade should stay blocked (got ${poorMeanPoints})`);
assert.equal(poorMeanFilters.rsiPosition.status, 'FAIL', 'lack of RSI extremes should not qualify mean reversion');

console.log('✅ quality-filters-playbook.mjs passed');
