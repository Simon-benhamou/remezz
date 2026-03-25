/**
 * V5.146 — Circuit Breaker Sweep: losses x cooldown hours
 *
 * Tests combinations of:
 *   - Loss threshold: 1, 2, 3
 *   - Cooldown: 2h, 3h, 4h, 6h, 8h, full day
 *
 * Usage: npx tsx scripts/sweep-circuit-breaker.ts
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;
const START = new Date('2025-01-01');
const END = new Date('2025-12-31');

async function loadData() {
  const since = START.getTime() - 250 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, END.getTime());

  const allData: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) continue;
    allData[sym] = sliceCandlesByTime(local.candles, since, END.getTime());
  }

  return { btcCandles, btcCandlesRegime: btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: CANDLE_15M_MS };
}

async function main() {
  console.log('V5.146 — Circuit Breaker Sweep');
  console.log(`Symbols: ${SYMBOLS.length} | Period: Jan-Dec 2025 | $2K, 5x`);
  console.log('═'.repeat(90));

  const data = await loadData();

  const configs: Array<{ label: string; dailyLossLimit: number; lossBreakHours: number }> = [
    { label: 'BASELINE', dailyLossLimit: 0, lossBreakHours: 0 },
    // 1 loss threshold
    { label: '1L → 2h break', dailyLossLimit: 1, lossBreakHours: 2 },
    { label: '1L → 3h break', dailyLossLimit: 1, lossBreakHours: 3 },
    { label: '1L → 4h break', dailyLossLimit: 1, lossBreakHours: 4 },
    { label: '1L → 6h break', dailyLossLimit: 1, lossBreakHours: 6 },
    { label: '1L → 8h break', dailyLossLimit: 1, lossBreakHours: 8 },
    { label: '1L → full day', dailyLossLimit: 1, lossBreakHours: 0 },
    // 2 loss threshold
    { label: '2L → 2h break', dailyLossLimit: 2, lossBreakHours: 2 },
    { label: '2L → 3h break', dailyLossLimit: 2, lossBreakHours: 3 },
    { label: '2L → 4h break', dailyLossLimit: 2, lossBreakHours: 4 },
    { label: '2L → 6h break', dailyLossLimit: 2, lossBreakHours: 6 },
    // 3 loss threshold
    { label: '3L → 2h break', dailyLossLimit: 3, lossBreakHours: 2 },
    { label: '3L → 3h break', dailyLossLimit: 3, lossBreakHours: 3 },
    { label: '3L → 4h break', dailyLossLimit: 3, lossBreakHours: 4 },
  ];

  const results: Array<{ label: string; trades: number; wr: number; pnl: number; dd: number; sharpe: number; pf: number }> = [];

  for (const cfg of configs) {
    process.stdout.write(`  ${cfg.label.padEnd(18)} ...`);
    const result = await runBacktestComputation({
      ...data,
      params: {
        startDate: START,
        endDate: END,
        initialCapital: 2000,
        leverage: 5,
        symbols: SYMBOLS,
        postProcess1m: false,
        dailyLossLimit: cfg.dailyLossLimit,
        lossBreakHours: cfg.lossBreakHours,
      },
    });

    // Compute DD from trade-level equity
    let peak = 2000, maxDD = 0, equity = 2000;
    const sorted = [...result.trades].sort((a, b) => (a.exitTime || '') < (b.exitTime || '') ? -1 : 1);
    for (const t of sorted) {
      equity += t.netPnlUsd;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    const s = result.summary;
    const r = { label: cfg.label, trades: s.totalTrades, wr: s.winRate, pnl: s.totalPnlUsd, dd: maxDD, sharpe: s.sharpeRatio ?? 0, pf: s.profitFactor ?? 0 };
    results.push(r);
    console.log(` ${r.trades} trades | ${r.wr.toFixed(1)}% WR | $${r.pnl.toFixed(0)} | ${r.dd.toFixed(1)}% DD | Sharpe ${r.sharpe.toFixed(2)}`);
  }

  // Summary table sorted by DD
  const baseline = results[0];
  console.log(`\n${'═'.repeat(95)}`);
  console.log(`  RESULTS SORTED BY DD (lower = better)`);
  console.log(`${'═'.repeat(95)}`);
  console.log(`  ${'Config'.padEnd(18)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(8)} ${'DD%'.padStart(6)} ${'ΔDD'.padStart(6)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)} ${'ΔPnL$'.padStart(8)}`);
  console.log(`  ${'-'.repeat(80)}`);

  const sortedResults = [...results].sort((a, b) => a.dd - b.dd);
  for (const r of sortedResults) {
    const ddDelta = r.dd - baseline.dd;
    const pnlDelta = r.pnl - baseline.pnl;
    console.log(
      `  ${r.label.padEnd(18)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(5)}% $${r.pnl.toFixed(0).padStart(7)} ${r.dd.toFixed(1).padStart(5)}% ${(ddDelta > 0 ? '+' : '') + ddDelta.toFixed(1).padStart(5)}  ${r.sharpe.toFixed(2).padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${(pnlDelta > 0 ? '+' : '') + '$' + pnlDelta.toFixed(0).padStart(6)}`
    );
  }

  // Also sort by Sharpe
  console.log(`\n  SORTED BY SHARPE (higher = better)`);
  console.log(`  ${'-'.repeat(80)}`);
  const bySharpeSorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
  for (const r of bySharpeSorted.slice(0, 5)) {
    const ddDelta = r.dd - baseline.dd;
    const pnlDelta = r.pnl - baseline.pnl;
    console.log(
      `  ${r.label.padEnd(18)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(5)}% $${r.pnl.toFixed(0).padStart(7)} ${r.dd.toFixed(1).padStart(5)}% ${(ddDelta > 0 ? '+' : '') + ddDelta.toFixed(1).padStart(5)}  ${r.sharpe.toFixed(2).padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${(pnlDelta > 0 ? '+' : '') + '$' + pnlDelta.toFixed(0).padStart(6)}`
    );
  }

  // Best DD reduction that doesn't destroy PnL
  const viable = results.filter(r => r.pnl >= baseline.pnl * 0.7 && r.dd < baseline.dd);
  if (viable.length > 0) {
    const best = viable.sort((a, b) => a.dd - b.dd)[0];
    console.log(`\n  ★ BEST VIABLE (DD reduction, PnL >= 70% baseline): ${best.label}`);
    console.log(`    DD: ${best.dd.toFixed(1)}% (${(best.dd - baseline.dd).toFixed(1)}pp) | PnL: $${best.pnl.toFixed(0)} | Sharpe: ${best.sharpe.toFixed(2)}`);
  } else {
    console.log(`\n  ✗ No config reduces DD without losing >30% PnL`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
