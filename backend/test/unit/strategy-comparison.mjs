import assert from 'node:assert/strict';

process.env.UNIT_TEST_MODE = 'true';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.MARKET_TYPE = 'futures';
process.env.EXCHANGE_ID = 'binanceusdm';

const { compareStrategies } = await import('../../dist/src/quantai/strategies/metaAdaptive/comparison.js');

const report = await compareStrategies();

console.log('📊 Strategy comparison metrics');
console.log(`Intraday Total Return %: ${report.intraday.metrics.totalReturnPct.toFixed(4)}`);
console.log(`Intraday CAGR: ${report.intraday.metrics.cagr.toFixed(6)}`);
console.log(`Intraday Sharpe: ${report.intraday.metrics.sharpe.toFixed(6)}`);
console.log(`Intraday Max Drawdown %: ${report.intraday.metrics.maxDrawdownPct.toFixed(4)}`);
console.log(`Meta Total Return %: ${report.metaAdaptive.metrics.totalReturnPct.toFixed(4)}`);
console.log(`Meta CAGR: ${report.metaAdaptive.metrics.cagr.toFixed(6)}`);
console.log(`Meta Sharpe: ${report.metaAdaptive.metrics.sharpe.toFixed(6)}`);
console.log(`Meta Max Drawdown %: ${report.metaAdaptive.metrics.maxDrawdownPct.toFixed(4)}`);
console.log(`Intraday trades: ${report.intraday.trades.length}`);
console.log(`Meta trades: ${report.metaAdaptive.metrics.trades}`);

assert(Array.isArray(report.intraday.trades), 'Intraday trades must be an array');
assert(report.metaAdaptive.metrics.trades > 0, 'Meta adaptive scenarios should produce trades');
assert.notStrictEqual(
  report.intraday.metrics.totalReturnPct.toFixed(4),
  report.metaAdaptive.metrics.totalReturnPct.toFixed(4),
  'Strategies should differ in total return',
);

console.log('✅ strategy-comparison.mjs passed');
