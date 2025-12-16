import { runBacktest } from '../src/services/backtestService.js';

function iso(d: Date) {
  return d.toISOString();
}

async function main() {
  const startDate = new Date(process.env.START_DATE || '2025-01-01T00:00:00.000Z');
  const endDate = new Date(process.env.END_DATE || '2025-12-16T00:00:00.000Z');

  const params = {
    startDate,
    endDate,
    initialCapital: 2000,
    symbols: [
      'DOGE/USDT:USDT',
      'IMX/USDT:USDT',
      'SEI/USDT:USDT',
      'SUI/USDT:USDT',
      'XRP/USDT:USDT',
      'ETH/USDT:USDT',
    ],
    leverage: 4.5,
  };

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`[BacktestScript] Unified Backtest`);
  console.log(`[BacktestScript] Range: ${iso(params.startDate)} → ${iso(params.endDate)}`);
  console.log(`[BacktestScript] Capital: $${params.initialCapital}, Lev: ${params.leverage}`);
  console.log(`[BacktestScript] Symbols: ${params.symbols.join(', ')}`);

  const t0 = Date.now();
  const result = await runBacktest({
    startDate: params.startDate,
    endDate: params.endDate,
    initialCapital: params.initialCapital,
    symbols: [...params.symbols],
    leverage: params.leverage,
  });
  const ms = Date.now() - t0;

  const eqLast = result.equityCurve[result.equityCurve.length - 1];
  const ddLast = result.drawdownCurve[result.drawdownCurve.length - 1];

  console.log('[BacktestScript] Done');
  console.log(`[BacktestScript] Runtime: ${(ms / 1000).toFixed(1)}s`);
  console.log(`[BacktestScript] Trades: ${result.summary.totalTrades}, WinRate: ${result.summary.winRate.toFixed(2)}%`);
  console.log(`[BacktestScript] PnL: $${result.summary.totalPnlUsd.toFixed(2)} (${result.summary.totalPnlPct.toFixed(2)}%)`);
  console.log(`[BacktestScript] FinalCapital: $${result.summary.finalCapital.toFixed(2)}`);
  console.log(`[BacktestScript] MaxDD: ${result.summary.maxDrawdownPct.toFixed(2)}%`);
  console.log(`[BacktestScript] Fees: $${result.summary.totalFeesUsd.toFixed(2)}`);

  // Exit reason breakdown
  const byReason = new Map<string, { n: number; pnl: number }>();
  for (const t of result.trades) {
    const key = t.exitReason || 'UNKNOWN';
    const cur = byReason.get(key) || { n: 0, pnl: 0 };
    cur.n += 1;
    cur.pnl += t.netPnlUsd;
    byReason.set(key, cur);
  }
  const topReasons = [...byReason.entries()]
    .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
    .slice(0, 8);
  console.log('[BacktestScript] Exit reasons (top by abs PnL):');
  for (const [reason, v] of topReasons) {
    console.log(`  ${reason}: n=${v.n}, pnl=$${v.pnl.toFixed(2)}, avg=$${(v.pnl / v.n).toFixed(2)}`);
  }

  // Per-symbol PnL
  const bySymbol = new Map<string, { n: number; pnl: number }>();
  for (const t of result.trades) {
    const cur = bySymbol.get(t.symbol) || { n: 0, pnl: 0 };
    cur.n += 1;
    cur.pnl += t.netPnlUsd;
    bySymbol.set(t.symbol, cur);
  }
  const symRows = [...bySymbol.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  console.log('[BacktestScript] PnL by symbol:');
  for (const [sym, v] of symRows) {
    console.log(`  ${sym}: trades=${v.n}, pnl=$${v.pnl.toFixed(2)}, avg=$${(v.pnl / v.n).toFixed(2)}`);
  }

  if (eqLast) console.log(`[BacktestScript] EquityCurve last: ${eqLast.date} -> ${eqLast.equity.toFixed(2)}`);
  if (ddLast) console.log(`[BacktestScript] DrawdownCurve last: ${ddLast.date} -> ${ddLast.drawdown.toFixed(2)}%`);

  const lastMonths = result.monthlyStats.slice(-3);
  console.log('[BacktestScript] Last months:');
  for (const m of lastMonths) {
    console.log(`  ${m.month}: trades=${m.trades}, pnl=$${m.pnlUsd.toFixed(2)} (${m.pnlPct.toFixed(2)}%), capEnd=$${m.capitalEnd.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error('[BacktestScript] Failed:', err);
  process.exitCode = 1;
});
