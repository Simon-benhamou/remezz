import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { runIntradayBacktest } = await import('../../dist/src/quantai/strategies/intradayDual/backtest.js');

function createChoppyCandles() {
  const candles = [];
  let price = 0.5;
  for (let i = 0; i < 120; i++) {
    const drift = Math.sin(i / 6) * 0.01 + (i % 10 === 0 ? 0.02 : -0.015);
    price = Math.max(0.1, price + drift);
    const high = price + 0.01;
    const low = Math.max(0.05, price - 0.015);
    candles.push({
      timestamp: 1_700_600_000_000 + i * 60_000,
      open: price - drift,
      high,
      low,
      close: price,
      volume: 1_000 + (i % 5) * 150,
    });
  }
  return candles;
}

const candles = createChoppyCandles();
const result = runIntradayBacktest(candles, {
  symbol: 'XRPUSDT',
  equityUsd: 90,
  slippageBps: 4,
  makerFeeBps: 1,
  takerFeeBps: 4,
  fundingAnnualPct: 8,
  latencyMs: 200,
  impactBpsPerMillion: 10,
});

console.log('📉 Small balance intraday dual backtest metrics');
console.log(`Total Return %: ${result.metrics.totalReturnPct.toFixed(6)}`);
console.log(`CAGR: ${result.metrics.cagr.toFixed(6)}`);
console.log(`Sharpe: ${result.metrics.sharpe.toFixed(6)}`);
console.log(`Max Drawdown %: ${result.metrics.maxDrawdownPct.toFixed(6)}`);

assert(Number.isFinite(result.metrics.cagr), 'CAGR should be finite for small balance backtest');
assert(Number.isFinite(result.metrics.maxDrawdownPct), 'Max drawdown should be finite');
assert(Number.isFinite(result.metrics.sharpe), 'Sharpe should be finite');

console.log('✅ intraday-dual-small-balance-smoke.mjs passed');
