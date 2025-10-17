import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state.js');
const { clearOpsEvents, recentOpsEvents } = await import('../../dist/src/monitor/ops.js');

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
  ema20Slope: 0.07,
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

const strongMomentumSnap = {
  symbol: 'SOL/USDT:USDT',
  last: 124.1,
  ema20: 125.2,
  ema50: 121.0,
  ema20Slope: 0.16,
  adx14: 28.7,
  atrPct: 1.7,
  momentumPct: 1.9,
  volume: 2100,
  volumeMA: 1500,
};

assert(momentumAgent['passesEntryMomentumGates'](strongMomentumSnap, 'enter'), 'momentum gates should allow strong trending context with slope and ATR above tightened thresholds');

const weakMomentumSnap = {
  symbol: 'SOL/USDT:USDT',
  last: 123.6,
  ema20: 124.0,
  ema50: 122.5,
  ema20Slope: 0.02,
  adx14: 24.3,
  atrPct: 0.9,
  momentumPct: 1.1,
  volume: 1900,
  volumeMA: 1700,
};

assert(!momentumAgent['passesEntryMomentumGates'](weakMomentumSnap, 'enter'), 'momentum gates should now reject shallow slope / low ATR breakouts');

const ltfCompressionBreak = {
  symbol: 'SOL/USDT:USDT',
  last: 124.4,
  ema20: 124.6,
  ema50: 121.8,
  ema20Slope: 0.06,
  adx14: 31.4,
  atrPct: 1.28,
  momentumPct: 1.8,
  volume: 2100,
  volumeMA: 1750,
  meta: { tf: '5m' },
};

assert(momentumAgent['passesEntryMomentumGates'](ltfCompressionBreak, 'enter'), 'high ADX breakout on LTF should allow slightly flatter slopes');

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

// Regression: diagnostics should emit VOS block events with detailed reason codes
clearOpsEvents();
const vosAgent = createAgent('momentum_breakout', 'long');
vosAgent.sessionId = 'unit-test-session';
vosAgent.state = 'ARMED';
(vosAgent).pos = null;
(vosAgent).entering = false;
(vosAgent).plan.zone = { from: 229, to: 231, mid: 230 };
(vosAgent).plan.bias = 'long';
(vosAgent).profile.symbol = 'SOL/USDT:USDT';
(vosAgent).profile.mode = 'paper';
(vosAgent).profile.aggressiveness = 'reactive';
(vosAgent).getDiagnosticSnapshot = async () => ({
  symbol: 'SOL/USDT:USDT',
  last: 245.1,
  ema20: 246.5,
  ema50: 240.2,
  rsi14: 58.2,
  adx14: 26.4,
  atrPct: 1.05,
  volume: 1800,
  volumeMA: 1500,
});

const vosDiag = await vosAgent.getDiagnostics();
assert.equal(vosDiag.canTrade, false, 'diagnostics should report blocked state');

const vosEvents = recentOpsEvents(5);
const vosBlock = vosEvents.find((evt) => evt.message === 'validator_of_signal_block');
assert(vosBlock, 'expected validator_of_signal_block event');
assert.equal(vosBlock.sessionId, 'unit-test-session');
const primaryKey = vosBlock.details?.primary?.key;
assert(['inEntryZone', 'liquidity'].includes(primaryKey), 'primary failing check should be entry zone or liquidity');
if (primaryKey === 'inEntryZone') {
  assert.equal(vosBlock.details?.primary?.code, 'entry_zone.out_of_zone', 'event should include entry zone reason code');
} else {
  assert.equal(vosBlock.details?.primary?.code, 'liquidity.insufficient', 'event should include liquidity reason code');
}

console.log('✅ quality-filters-playbook.mjs passed');
