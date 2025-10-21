import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { PositionSizer } = await import('../../dist/src/quantai/risk/positionSizing.js');

const sizer = new PositionSizer(1.0);

function nearlyEqual(a, b, tolerance = 1e-6) {
  assert(Math.abs(a - b) <= tolerance, `Expected ${a} ≈ ${b}`);
}

const baseParams = {
  equityUsd: 10_000,
  entryPrice: 100,
  stopPrice: 98,
};

const neutral = sizer.computeSize({ ...baseParams });
nearlyEqual(neutral.riskPct, 1.0);
nearlyEqual(neutral.riskUsd, 100);
nearlyEqual(neutral.qty, 50);

const suppressed = sizer.computeSize({
  ...baseParams,
  currentAtrPct: 2.0,
  targetAtrPct: 1.0,
});
nearlyEqual(Number(suppressed.riskPct.toFixed(6)), 0.5);
nearlyEqual(Number(suppressed.riskUsd.toFixed(2)), 50);
nearlyEqual(Number(suppressed.qty.toFixed(4)), 25.0);

const boosted = sizer.computeSize({
  ...baseParams,
  currentAtrPct: 0.5,
  targetAtrPct: 1.0,
});
nearlyEqual(Number(boosted.riskPct.toFixed(6)), 1.6);
nearlyEqual(Number(boosted.riskUsd.toFixed(2)), 160);
nearlyEqual(Number(boosted.qty.toFixed(4)), 80.0);

const bounded = sizer.computeSize({
  ...baseParams,
  currentAtrPct: 0.2,
  targetAtrPct: 1.0,
  maxRiskPct: 1.4,
  minRiskPct: 0.6,
});
nearlyEqual(Number(bounded.riskPct.toFixed(6)), 1.4);

const returns = [
  neutral.riskPct / 100,
  suppressed.riskPct / 100,
  boosted.riskPct / 100,
  bounded.riskPct / 100,
];

let equity = 1;
let peak = 1;
const perTradeReturns = [];
for (const r of returns) {
  const gain = 0.25 * r;
  perTradeReturns.push(gain);
  equity *= (1 + gain);
  if (equity > peak) peak = equity;
}

const trades = perTradeReturns.length;
const cagrPerTrade = Math.pow(equity, 1 / trades) - 1;

let runningEquity = 1;
let runningPeak = 1;
let maxDrawdown = 0;
for (const ret of perTradeReturns) {
  runningEquity *= (1 + ret);
  if (runningEquity > runningPeak) runningPeak = runningEquity;
  const dd = (runningPeak - runningEquity) / runningPeak;
  if (dd > maxDrawdown) maxDrawdown = dd;
}

const mean = perTradeReturns.reduce((sum, r) => sum + r, 0) / trades;
const variance = perTradeReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / trades;
const stdev = Math.sqrt(variance);
const sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(trades);

console.log('📊 Position sizing volatility metrics');
console.log(`CAGR per trade: ${(cagrPerTrade * 100).toFixed(4)}%`);
console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(4)}%`);
console.log(`Sharpe-like: ${sharpe.toFixed(4)}`);

assert(Number.isFinite(cagrPerTrade), 'CAGR must be finite');
assert(Number.isFinite(maxDrawdown), 'Max drawdown must be finite');
assert(Number.isFinite(sharpe), 'Sharpe must be finite');

console.log('✅ position-sizing-volatility.mjs passed');
