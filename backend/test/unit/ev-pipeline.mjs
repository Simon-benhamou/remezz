import assert from 'node:assert';
import {
  fitProbabilityModel,
  evaluateOpportunity,
  updateBandit,
  recordOutcome,
  getTelemetrySummary,
} from '../../dist/src/services/intelligentAgent.js';
import { SimulatedExecutor } from '../../dist/src/ai/execution/executor.js';

process.env.ACCEPT_Q_TREND = '0.55';
process.env.ACCEPT_Q_RANGE = '0.35';
process.env.ACCEPT_Q_VOL = '0.30';
process.env.THROTTLE_PF_LOW = '0.80';
process.env.THROTTLE_PF_HIGH = '1.60';
process.env.THROTTLE_STEP = '0.02';
process.env.EV_MIN_CONSERVATIVE_PROB = '0.60';

const baseFeatures = {
  tf4h: {
    emaSlope20: 0.012,
    emaSlope50: 0.009,
    emaSlope200: 0.006,
    adx14: 28,
    bbWidth: 0.018,
    distEma200Pct: 0.021,
    trendBias: 'bull',
  },
  tf1h: {
    roc12: 0.008,
    roc24: 0.012,
    rsi: 56,
    bbp: 0.6,
    emaSlope20: 0.01,
    emaSlope50: 0.008,
    volRatio: 1.2,
  },
  tf15m: {
    roc12: 0.004,
    rsi: 54,
    bbp: 0.55,
    emaSlope20: 0.006,
    ofi: 0.1,
    volRatio: 1.1,
  },
  micro: {
    spreadBps: 6,
    bidDepthUsd: 55000,
    askDepthUsd: 56000,
    passiveFillRate: 0.65,
    volume24hUsd: 120_000_000,
  },
  driver: {
    btcRet15m: 0.001,
    btcRet1h: 0.002,
    corrBtc1h: 0.6,
  },
  session: {
    euUsOverlap: true,
    isWeekend: false,
    isNight: false,
  },
};

function cloneFeatures(overrides = {}) {
  return JSON.parse(JSON.stringify({ ...baseFeatures, ...overrides }));
}

function buildDataset() {
  const bearish = cloneFeatures({
    tf4h: { ...baseFeatures.tf4h, trendBias: 'bear', emaSlope20: -0.01, emaSlope50: -0.008, emaSlope200: -0.005 },
    tf1h: { ...baseFeatures.tf1h, roc12: -0.01, roc24: -0.015, emaSlope20: -0.012, emaSlope50: -0.01, rsi: 42 },
    tf15m: { ...baseFeatures.tf15m, roc12: -0.006, rsi: 38, bbp: 0.35 },
    driver: { btcRet15m: -0.002, btcRet1h: -0.004, corrBtc1h: -0.45 },
  });
  bearish.micro = { ...baseFeatures.micro, passiveFillRate: 0.55 };
  const altBull = cloneFeatures({
    tf1h: { ...baseFeatures.tf1h, roc12: 0.015, roc24: 0.02, rsi: 60, volRatio: 1.3 },
    micro: { ...baseFeatures.micro, passiveFillRate: 0.7 },
  });
  const momentum = cloneFeatures({
    tf4h: { ...baseFeatures.tf4h, emaSlope20: 0.018, emaSlope50: 0.014, adx14: 32 },
    tf1h: { ...baseFeatures.tf1h, roc12: 0.018, roc24: 0.026, rsi: 62, volRatio: 1.35 },
    tf15m: { ...baseFeatures.tf15m, roc12: 0.008, rsi: 58, volRatio: 1.25 },
    micro: { ...baseFeatures.micro, spreadBps: 5, passiveFillRate: 0.72 },
  });
  const followThrough = cloneFeatures({
    tf4h: { ...baseFeatures.tf4h, distEma200Pct: 0.028 },
    tf1h: { ...baseFeatures.tf1h, roc12: 0.02, roc24: 0.03, rsi: 64 },
    tf15m: { ...baseFeatures.tf15m, roc12: 0.01, rsi: 60 },
  });
  const deepBear = cloneFeatures({
    tf4h: { ...baseFeatures.tf4h, trendBias: 'bear', emaSlope20: -0.016, emaSlope50: -0.013, adx14: 30 },
    tf1h: { ...baseFeatures.tf1h, roc12: -0.02, roc24: -0.028, rsi: 35, volRatio: 0.7 },
    tf15m: { ...baseFeatures.tf15m, roc12: -0.012, rsi: 32, volRatio: 0.8 },
    micro: { ...baseFeatures.micro, spreadBps: 12, passiveFillRate: 0.45 },
  });
  return [
    { x: baseFeatures, y: 1, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'long' } },
    { x: bearish, y: 0, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'short' } },
    { x: altBull, y: 1, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'long' } },
    { x: momentum, y: 1, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'long' } },
    { x: followThrough, y: 1, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'long' } },
    { x: deepBear, y: 0, meta: { symbol: 'TEST/USDT', ts: Date.now(), side: 'short' } },
  ];
}

function buildOhlcv(seedPrice) {
  const now = Date.now();
  return Array.from({ length: 256 }, (_, idx) => {
    const base = seedPrice + idx * 0.05;
    return [
      now - (255 - idx) * 900_000,
      base,
      base + 0.25,
      base - 0.25,
      base + (idx % 5 === 0 ? 0.3 : 0),
      12_000 + idx * 10,
    ];
  });
}

async function runUnitTest() {
  const dataset = buildDataset();
  fitProbabilityModel(dataset);

  const evaluation = await evaluateOpportunity('TEST/USDT', 150, {
    context: baseFeatures,
    ohlcv15m: buildOhlcv(100),
    playbooks: ['PULLBACK', 'BREAKOUT', 'MR'],
  });
  assert.ok(evaluation.accepted, 'opportunity should be accepted');
  assert.ok(typeof evaluation.ev === 'number' && Number.isFinite(evaluation.ev), 'EV must be a finite number');
  assert.ok(evaluation.plan, 'plan must exist');
}

async function runSmokeBacktest() {
  const executor = new SimulatedExecutor();
  const scenarios = [
    { ctx: baseFeatures, seedPrice: 101, move: 0.012 },
    { ctx: cloneFeatures({ tf4h: { ...baseFeatures.tf4h, trendBias: 'neutral', adx14: 18 } }), seedPrice: 99.5, move: -0.004 },
    { ctx: cloneFeatures({ tf4h: { ...baseFeatures.tf4h, trendBias: 'bull', emaSlope20: 0.014 }, tf1h: { ...baseFeatures.tf1h, roc12: 0.02 } }), seedPrice: 102.5, move: 0.02 },
  ];
  let equity = 1_000;
  let peak = equity;
  let maxDrawdown = 0;
  const returns = [];

  for (let i = 0; i < scenarios.length; i++) {
    const { ctx, seedPrice, move } = scenarios[i];
    const ohlcv = buildOhlcv(seedPrice);
    const result = await evaluateOpportunity('TEST/USDT', 150, {
      context: ctx,
      ohlcv15m: ohlcv,
    });
    if (!result.accepted || !result.plan) continue;
    const fillPrice = ohlcv[ohlcv.length - 1][4];
    const side = ctx.tf4h.trendBias === 'bear' ? 'short' : 'long';
    const direction = side === 'long' ? 1 : -1;
    const exitPrice = fillPrice * (1 + move * direction);
    const exec = executor.run({
      plan: result.plan,
      side,
      notional: 150,
      fillPrice,
      exitPrice,
      timestamp: Date.now() + i * 600_000,
    });
    recordOutcome(exec.pnlUsd);
    if (result.action) {
      updateBandit('TEST/USDT', ctx, result.action, exec.rMultiple);
    }
    const pnl = exec.pnlUsd.toNumber();
    const prevEquity = equity;
    equity += pnl;
    const ret = pnl / prevEquity;
    returns.push(ret);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  assert.ok(returns.length > 0, 'smoke backtest must produce returns');
  const years = Math.max(returns.length / 252, 1 / 252);
  const cagr = Math.pow(equity / 1_000, 1 / years) - 1;
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - avgReturn) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpe = std === 0 ? 0 : (avgReturn * Math.sqrt(252)) / std;

  if (![cagr, maxDrawdown, sharpe].every((m) => Number.isFinite(m))) {
    throw new Error('Backtest metrics contain NaN');
  }

  console.log('CAGR:', cagr.toFixed(4), 'MaxDD:', maxDrawdown.toFixed(4), 'Sharpe:', sharpe.toFixed(4));
  const telemetry = getTelemetrySummary();
  console.log('Telemetry summary:', telemetry);
}

(async () => {
  await runUnitTest();
  await runSmokeBacktest();
  console.log('EV pipeline unit + smoke tests passed');
})();
