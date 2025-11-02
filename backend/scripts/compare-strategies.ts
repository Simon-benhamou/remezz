process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.META_ADAPTIVE_BENCHMARK_SILENT = process.env.META_ADAPTIVE_BENCHMARK_SILENT ?? 'true';

const BASE_EQUITY_USD = 50_000;

if (process.env.META_ADAPTIVE_BENCHMARK_SILENT === 'true') {
  const originalLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === 'string') {
      const payload = args[0];
      if (
        payload.startsWith('{"level":"info","event":"adaptive_trade_')
        || payload.startsWith('{"level":"info","event":"meta_entry_checklist"')
        || payload.startsWith('[StrategyHealth]')
        || payload.startsWith('risk scaled by StrategyHealth')
      ) {
        return;
      }
    }
    originalLog(...args);
  };
}

function formatPercent(value: number, digits = 2) {
  return `${(value * 100).toFixed(digits)}%`;
}

function formatRatio(value: number, digits = 2) {
  return value.toFixed(digits);
}

function formatAverage(rowLabel: string, rawValue: number): string {
  if (Number.isNaN(rawValue) || !Number.isFinite(rawValue)) return '—';
  if (rowLabel.includes('Scenarios')) {
    return `${rawValue.toFixed(2)}%`;
  }
  return `${((rawValue / BASE_EQUITY_USD) * 100).toFixed(2)}%`;
}

async function main() {
  const { compareStrategies } = await import('../src/quantai/strategies/metaAdaptive/comparison.js');
  const report = await compareStrategies();

  console.log('=== Strategy Comparison Summary ===');
  const summaryTable = report.summaryTable.map((row) => ({
    Strategy: row.label,
    Trades: row.trades,
    HitRate: formatPercent(row.hitRate),
    ProfitFactor: formatRatio(row.profitFactor),
    AvgWin: formatAverage(row.label, row.avgWin),
    AvgLoss: formatAverage(row.label, row.avgLoss),
    Sharpe: formatRatio(row.sharpe),
    MaxDD: `${row.maxDrawdownPct.toFixed(2)}%`,
    CAGR: `${(row.cagr * 100).toFixed(2)}%`,
  }));
  console.table(summaryTable);

  const intradayRow = report.summaryTable.find((row) => row.label === 'Intraday Dual');
  const metaRow = report.summaryTable.find((row) => row.label.startsWith('Meta-Adaptive (Backtest)'));
  if (intradayRow && metaRow) {
    const tradesImproved = metaRow.trades < intradayRow.trades;
    const profitFactorImproved = metaRow.profitFactor > intradayRow.profitFactor;
    const avgWinImproved = metaRow.avgWin > intradayRow.avgWin;
    console.log('\nValidation checks vs Intraday:');
    console.log(`  Trades: ${metaRow.trades} vs ${intradayRow.trades} ${tradesImproved ? '✅ (less)' : '⚠️'}`);
    console.log(`  Profit Factor: ${metaRow.profitFactor.toFixed(2)} vs ${intradayRow.profitFactor.toFixed(2)} ${profitFactorImproved ? '✅ (higher)' : '⚠️'}`);
    console.log(`  Avg Win: ${formatAverage(metaRow.label, metaRow.avgWin)} vs ${formatAverage(intradayRow.label, intradayRow.avgWin)} ${avgWinImproved ? '✅ (higher)' : '⚠️'}`);
  }

  if (report.metaAdaptiveWalkForward.length) {
    console.log('\nMeta-Adaptive walk-forward segments:');
    for (const segment of report.metaAdaptiveWalkForward) {
      const start = new Date(segment.start).toISOString().split('T')[0];
      const end = new Date(segment.end).toISOString().split('T')[0];
      console.log(
        `  ${start} → ${end} | CAGR ${(segment.metrics.cagr * 100).toFixed(2)}% | PF ${segment.metrics.profitFactor.toFixed(2)} | Sharpe ${segment.metrics.sharpe.toFixed(2)}`,
      );
    }
  }

  console.log('\nConfidence gate diagnostics (Meta-Adaptive scenarios):');
  console.log(
    `  Threshold: ${report.metaAdaptive.metrics.confidenceGateThreshold.toFixed(2)} | Blocked signals: ${report.metaAdaptive.metrics.confidenceGateBlockedSignalsPct.toFixed(2)}% | Blocked primary: ${report.metaAdaptive.metrics.confidenceGateBlockedPrimaryPct.toFixed(2)}%`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('❌ Strategy comparison failed', error);
    process.exit(1);
  });
