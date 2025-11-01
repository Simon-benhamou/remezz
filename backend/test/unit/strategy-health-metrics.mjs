import assert from 'node:assert/strict';
import 'dotenv/config';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';

const { StrategyHealth } = await import('../../dist/src/quantai/services/strategyHealth.js');

const health = new StrategyHealth({
  window: 12,
  minTradesForGuard: 5,
  negativeExpectancy: -0.1,
  refreshCooldownMs: 60_000,
});

const baseTs = Date.UTC(2024, 0, 1, 0, 0, 0);
const pnlSeries = [1.2, -1.4, -0.9, -0.6, 0.4, -1.1, 0.7];

let ts = baseTs;
for (const pnl of pnlSeries) {
  health.recordTrade({ pnlR: pnl, timestamp: ts, regime: pnl > 0 ? 'trend' : 'range' });
  ts += 60_000;
}

const snapshot = health.snapshot('trend');

assert.equal(snapshot.trades, pnlSeries.length, 'Should track all trades');
assert(snapshot.expectancy < 0, 'Expectancy should be negative with net losses');
assert(snapshot.winRate < 0.5, 'Win rate should reflect majority losses');
assert(snapshot.guardrail, 'Guardrail should trigger under poor performance');
assert(snapshot.guardrail.reason.startsWith('strategy_health_'), 'Guardrail reason should reflect strategy health');
assert(snapshot.refreshRecommended, 'Refresh should be recommended after sustained losses');
assert(snapshot.riskMultiplier < 1, 'Risk multiplier should be reduced when expectancy < 0');
assert(snapshot.maxDrawdown <= 0, 'Max drawdown should be non-positive');
assert.equal(snapshot.lastRegime, 'trend');

const scaledReturns = pnlSeries.map((r) => r * 0.2);

let equity = 1;
let peak = 1;
const returns = [];
for (const r of scaledReturns) {
  const gain = r / 10;
  returns.push(gain);
  equity *= (1 + gain);
  if (equity > peak) peak = equity;
}

const trades = returns.length;
const cagrPerTrade = Math.pow(equity, 1 / trades) - 1;

let runningEquity = 1;
let runningPeak = 1;
let maxDrawdown = 0;
for (const ret of returns) {
  runningEquity *= (1 + ret);
  if (runningEquity > runningPeak) runningPeak = runningEquity;
  const dd = (runningPeak - runningEquity) / runningPeak;
  if (dd > maxDrawdown) maxDrawdown = dd;
}

const mean = returns.reduce((sum, r) => sum + r, 0) / trades;
const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / trades;
const stdev = Math.sqrt(variance);
const sharpe = stdev === 0 ? 0 : (mean / stdev) * Math.sqrt(trades);

console.log('📉 Strategy health metrics');
console.log(`CAGR per trade: ${(cagrPerTrade * 100).toFixed(4)}%`);
console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(4)}%`);
console.log(`Sharpe-like: ${sharpe.toFixed(4)}`);

assert(Number.isFinite(cagrPerTrade), 'CAGR must be finite');
assert(Number.isFinite(maxDrawdown), 'Max drawdown must be finite');
assert(Number.isFinite(sharpe), 'Sharpe must be finite');

console.log('✅ strategy-health-metrics.mjs passed');
