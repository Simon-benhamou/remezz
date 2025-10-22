import { compareStrategies } from '../src/quantai/strategies/metaAdaptive/comparison.js';

function formatPrecise(value: { toFixed: (decimals: number) => string }, decimals = 2) {
  return value.toFixed(decimals);
}

async function main() {
  const report = await compareStrategies();

  console.log('=== Intraday Dual Strategy (BOM/MR) ===');
  console.log(`Total Return %: ${report.intraday.metrics.totalReturnPct.toFixed(4)}`);
  console.log(`CAGR: ${report.intraday.metrics.cagr.toFixed(6)}`);
  console.log(`Sharpe: ${report.intraday.metrics.sharpe.toFixed(6)}`);
  console.log(`Max Drawdown %: ${report.intraday.metrics.maxDrawdownPct.toFixed(4)}`);
  console.log(`Trades: ${report.intraday.metrics.pnlSeries.length}`);
  console.log('Trades (timestamp UTC ms, side, qty, price, cumulative PnL):');
  for (const trade of report.intraday.trades) {
    console.log(
      `${trade.timestamp},${trade.side},${trade.quantity.toFixed(4)},${trade.price.toFixed(4)},${trade.cumulativePnl.toFixed(4)},${trade.reason}`,
    );
  }

  console.log('\n=== Meta-Adaptive Strategy ===');
  console.log(`Total Return %: ${report.metaAdaptive.metrics.totalReturnPct.toFixed(4)}`);
  console.log(`CAGR: ${report.metaAdaptive.metrics.cagr.toFixed(6)}`);
  console.log(`Sharpe: ${report.metaAdaptive.metrics.sharpe.toFixed(6)}`);
  console.log(`Max Drawdown %: ${report.metaAdaptive.metrics.maxDrawdownPct.toFixed(4)}`);
  console.log(`Trades: ${report.metaAdaptive.metrics.trades}`);
  console.log('Trades (timestamp UTC ms, side, qty, entry, exit, pnl%, cumulative PnL%):');
  for (const trade of report.metaAdaptive.trades) {
    console.log(
      `${trade.timestamp},${trade.side},${formatPrecise(trade.quantity)},${formatPrecise(trade.entryPrice)},${formatPrecise(trade.exitPrice)},${formatPrecise(trade.pnlPct)},${formatPrecise(trade.cumulativePnlPct)}`,
    );
  }
}

main().catch((error) => {
  console.error('❌ Strategy comparison failed', error);
  process.exit(1);
});
