import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';

const { runIntradayBacktest } = await import('../../dist/src/quantai/intraday/backtest.js');

function createScenarioCandles() {
  const candles = [];
  let price = 100;
  for (let i = 0; i < 240; i++) {
    const trend = i < 120 ? 0.2 : i < 180 ? -0.3 : 0.25;
    price += trend;
    const high = price + 0.5;
    const low = price - 0.8;
    candles.push({
      timestamp: 1_700_500_000_000 + i * 60_000,
      open: price - trend,
      high,
      low,
      close: price,
      volume: 200 + (i % 30) * 5,
    });
  }
  return candles;
}

const candles = createScenarioCandles();
const result = runIntradayBacktest(candles, { symbol: 'BTCUSDT', equityUsd: 50_000, slippageBps: 3 });

console.log('📈 Intraday dual strategy backtest metrics');
console.log(`Total Return %: ${result.metrics.totalReturnPct.toFixed(4)}`);
console.log(`CAGR: ${result.metrics.cagr.toFixed(6)}`);
console.log(`Sharpe: ${result.metrics.sharpe.toFixed(6)}`);
console.log(`Max Drawdown %: ${result.metrics.maxDrawdownPct.toFixed(4)}`);

assert(Number.isFinite(result.metrics.cagr), 'CAGR should be finite');
assert(Number.isFinite(result.metrics.maxDrawdownPct), 'Max drawdown should be finite');
assert(Number.isFinite(result.metrics.sharpe), 'Sharpe should be finite');

console.log('✅ intraday-dual-backtest-smoke.mjs passed');
