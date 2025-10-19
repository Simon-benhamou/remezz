import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state/index.js');

function buildSnapshot({ price, adx, biases }) {
  const tfBiases = biases ?? { '4h': 'bullish', '1h': 'bullish', '15m': 'bullish' };
  return {
    symbol: 'BTC/USDT',
    last: price,
    ema20: price * 1.002,
    ema50: price * 0.998,
    ema20Slope: price * 0.001,
    trendBias: tfBiases['15m'] === 'bearish' ? 'bearish' : 'bullish',
    atr14: 5,
    realizedVol: 1.1,
    adx14: adx,
    multiTimeframe: {
      timeframes: {
        '4h': { tf: '4h', bias: tfBiases['4h'], momentumPct: 0.6, rsi: 58 },
        '1h': { tf: '1h', bias: tfBiases['1h'], momentumPct: 0.5, rsi: 56 },
        '15m': { tf: '15m', bias: tfBiases['15m'], momentumPct: 0.4, rsi: 54 },
      },
      agreementScore: 3,
      divergenceScore: 0,
    },
  };
}

const agent = new ReboundRejectionAgent();
agent.profile = {
  mode: 'paper',
  symbol: 'BTC/USDT',
  maxLeverage: 3,
};
agent.plan = {
  plan: { risk: { max_hold_hours: 36, tp: [{ value: 2 }] } },
  symbol: 'BTC/USDT',
  tf: '15m',
  bias: 'long',
  zone: { from: 100, to: 101, mid: 100.5 },
  atr: 5,
  atrPct: 0.5,
  stopDistance: 5,
  rPrices: [{ r: 2, price: 110 }],
  entryOkNow: true,
  sizing: { riskPct: 1, maxLev: 3, notionalUsd: 1000 },
  guards: { spreadOk: true, leverageOk: true, volumeOk: true },
};
agent.marketContext = {
  regime: 'trend_following',
  basePlaybook: 'trend_following',
  effectivePlaybook: 'trend_following',
  strongTrend: true,
  moderateTrend: false,
  direction: 'long',
  allowMomentumOverride: true,
  favorMeanReversion: false,
  confidence: 0.8,
  notes: [],
  recognizedStrategies: [],
  primaryStrategy: {
    id: 'classic_trend_following',
    label: 'Trend',
    bias: 'long',
    confidence: 0.9,
    active: true,
    reasons: [],
    metrics: {},
    meta: {
      trailingPolicy: {
        breakevenArmR: 1.6,
        trailActivationR: 1.8,
        atrLookback: 'atr15m',
        atrMultiplier: 1,
        contextAlignmentThreshold: 0.65,
        adxThreshold: 20,
      },
    },
  },
  strategyToken: 'token',
  strategyFamily: 'trend',
};

const entryPrice = 100;
agent.pos = {
  side: 'buy',
  entry: entryPrice,
  qty: 1,
  stop: 95,
  tp: [entryPrice + 10],
  openedAt: Date.now() - 60_000,
  extended: false,
  partialTaken: false,
  trail: [],
  maeR: 0,
  mfeR: 0,
  breakeven: entryPrice,
  initialStopDistance: 5,
};

agent.applyContextTrailPreference();

assert(agent.pos.contextTrail?.enabled === true, 'Context trailing should be enabled');
assert.equal(agent.pos.tp.length, 0, 'TP ladder should be cleared when trailing enabled');

const favorableSnap = buildSnapshot({ price: 109, adx: 28 });
agent.maybeActivateContextTrail(109, favorableSnap, (109 - entryPrice) / 5);

assert(agent.pos.stop >= entryPrice, 'Stop should move to breakeven once threshold reached');
assert(agent.pos.trailConfig?.armed === true, 'Trailing config should be armed');
assert(agent.pos.contextTrail?.trailActivated === true, 'Context trail should be activated');
assert(agent.pos.contextTrail?.shouldExit === false, 'Exit flag should remain false while context aligned');

const deterioratingSnap = buildSnapshot({ price: 111, adx: 18, biases: { '4h': 'bullish', '1h': 'bearish', '15m': 'neutral' } });
agent.maybeActivateContextTrail(111, deterioratingSnap, (111 - entryPrice) / 5);

assert(agent.pos.contextTrail?.shouldExit === true, 'Context loss should request exit');
assert.equal(agent.pos.contextTrail?.contextSatisfied, false, 'Context satisfied flag should be false after deterioration');

console.log('context-trailing-policy ✅');
