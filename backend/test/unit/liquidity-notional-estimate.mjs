import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { ReboundRejectionAgent } = await import('../../dist/src/agent/state/index.js');

const agent = new ReboundRejectionAgent();

const riskModeNotional = agent.estimateLiquidityNotional({
  balanceUsd: 10_000,
  riskPct: 1.5,
  leverage: 10,
  stopPct: 1.0,
  maxNotionalCapUsd: Number.POSITIVE_INFINITY,
  sizingMode: 'risk',
});

assert.strictEqual(Math.round(riskModeNotional), 15_000, 'Risk sizing should ignore leverage multiplier');

const budgetModeNotional = agent.estimateLiquidityNotional({
  balanceUsd: 10_000,
  riskPct: 1.5,
  leverage: 3,
  stopPct: 1.0,
  maxNotionalCapUsd: Number.POSITIVE_INFINITY,
  sizingMode: 'budget',
});

assert.strictEqual(budgetModeNotional, 30_000, 'Budget sizing should scale with leverage');

const cappedNotional = agent.estimateLiquidityNotional({
  balanceUsd: 10_000,
  riskPct: 1.5,
  leverage: 5,
  stopPct: 1.0,
  maxNotionalCapUsd: 20_000,
  sizingMode: 'budget',
});

assert.strictEqual(cappedNotional, 20_000, 'Cap should clamp estimated notional');

const fallbackStopNotional = agent.estimateLiquidityNotional({
  balanceUsd: 10_000,
  riskPct: 2.0,
  leverage: 2,
  stopPct: null,
  maxNotionalCapUsd: Number.POSITIVE_INFINITY,
  sizingMode: 'risk',
});

assert.strictEqual(fallbackStopNotional, 200, 'Missing stop should revert to risk capital only');

const returns = [
  riskModeNotional / 100_000,
  budgetModeNotional / 100_000,
  cappedNotional / 100_000,
  fallbackStopNotional / 100_000,
];

let equity = 1;
let peak = 1;
const equityTrail = [];
for (const r of returns) {
  equity *= (1 + r);
  equityTrail.push(equity);
  if (equity > peak) peak = equity;
}

const trades = returns.length;
const cagr = Math.pow(equity, 1 / trades) - 1;

let runningEquity = 1;
let runningPeak = 1;
let maxDrawdown = 0;
for (const r of returns) {
  runningEquity *= (1 + r);
  if (runningEquity > runningPeak) runningPeak = runningEquity;
  const drawdown = runningPeak > 0 ? (runningPeak - runningEquity) / runningPeak : 0;
  if (drawdown > maxDrawdown) maxDrawdown = drawdown;
}

const mean = returns.reduce((acc, value) => acc + value, 0) / trades;
const variance = returns.reduce((acc, value) => acc + (value - mean) ** 2, 0) / trades;
const stdev = Math.sqrt(variance);
const sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(trades);

console.log('📊 Liquidity notional estimation metrics');
console.log(`CAGR per trade: ${(cagr * 100).toFixed(4)}%`);
console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(4)}%`);
console.log(`Sharpe-like: ${sharpe.toFixed(4)}`);

assert(Number.isFinite(cagr), 'CAGR should be finite');
assert(Number.isFinite(maxDrawdown), 'Max drawdown should be finite');
assert(Number.isFinite(sharpe), 'Sharpe should be finite');

console.log('✅ liquidity-notional-estimate.mjs passed');
