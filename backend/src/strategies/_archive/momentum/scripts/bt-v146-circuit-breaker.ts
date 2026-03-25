/**
 * V5.146 — Daily Circuit Breaker Comparison
 *
 * Runs real compounded backtests with and without daily loss limit.
 * Compares DD, PnL, Sharpe, trade count.
 *
 * Usage: npx tsx scripts/bt-v146-circuit-breaker.ts
 */
import { runBacktestComputation, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;

async function loadData(startDate: Date, endDate: Date) {
  const since = startDate.getTime() - 250 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endDate.getTime());

  const allData: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) continue;
    allData[sym] = sliceCandlesByTime(local.candles, since, endDate.getTime());
  }

  return {
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: CANDLE_15M_MS,
  };
}

function analyze(label: string, r: BacktestResult) {
  const s = r.summary;
  const longs = r.trades.filter(t => (t as any).side === 'long');
  const shorts = r.trades.filter(t => (t as any).side === 'short');
  const longPnl = longs.reduce((a, t) => a + t.netPnlUsd, 0);
  const shortPnl = shorts.reduce((a, t) => a + t.netPnlUsd, 0);

  // Monthly breakdown
  const byMonth: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const t of r.trades) {
    const m = t.month || t.exitTime?.slice(0, 7) || 'unknown';
    const d = byMonth[m] ??= { trades: 0, pnl: 0, wins: 0 };
    d.trades++; d.pnl += t.netPnlUsd; if (t.netPnlUsd > 0) d.wins++;
  }

  // DD curve analysis
  let peak = 2000;
  let maxDD = 0;
  let equity = 2000;
  const sortedTrades = [...r.trades].sort((a, b) =>
    (a.exitTime || '') < (b.exitTime || '') ? -1 : 1
  );
  for (const t of sortedTrades) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Trades:  ${s.totalTrades} | WR ${s.winRate.toFixed(1)}% | PnL $${s.totalPnlUsd.toFixed(0)} | DD ${maxDD.toFixed(1)}% | Sharpe ${(s.sharpeRatio ?? 0).toFixed(2)} | PF ${(s.profitFactor ?? 0).toFixed(2)}`);
  console.log(`  LONG:    ${longs.length} trades, $${longPnl.toFixed(0)} | SHORT: ${shorts.length} trades, $${shortPnl.toFixed(0)}`);

  console.log(`\n  Monthly:`);
  console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(8)} ${'Cum$'.padStart(8)}`);
  console.log(`  ${'-'.repeat(34)}`);
  let cum = 2000;
  let posMonths = 0;
  for (const m of Object.keys(byMonth).sort()) {
    const d = byMonth[m];
    cum += d.pnl;
    if (d.pnl > 0) posMonths++;
    console.log(`  ${m.padEnd(10)} ${String(d.trades).padStart(6)} ${(d.wins / d.trades * 100).toFixed(0).padStart(5)}% $${d.pnl.toFixed(0).padStart(7)} $${cum.toFixed(0).padStart(7)}`);
  }
  console.log(`  Positive months: ${posMonths}/${Object.keys(byMonth).length}`);

  return {
    trades: s.totalTrades,
    pnl: s.totalPnlUsd,
    wr: s.winRate,
    dd: maxDD,
    sharpe: s.sharpeRatio ?? 0,
    pf: s.profitFactor ?? 0,
    longPnl,
    shortPnl,
    posMonths,
    totalMonths: Object.keys(byMonth).length,
  };
}

async function main() {
  console.log('V5.146 — Daily Circuit Breaker Comparison');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Period: Jan-Dec 2025, $2K, 5x`);
  console.log('═'.repeat(70));

  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const data = await loadData(startDate, endDate);

  const configs = [
    { label: 'BASELINE (no circuit breaker)', dailyLossLimit: 0 },
    { label: 'Stop after 1 loss/day', dailyLossLimit: 1 },
    { label: 'Stop after 2 losses/day', dailyLossLimit: 2 },
    { label: 'Stop after 3 losses/day', dailyLossLimit: 3 },
  ];

  const results: Array<ReturnType<typeof analyze> & { label: string }> = [];

  for (const cfg of configs) {
    console.log(`\nRunning: ${cfg.label}...`);
    const result = await runBacktestComputation({
      ...data,
      params: {
        startDate,
        endDate,
        initialCapital: 2000,
        leverage: 5,
        symbols: SYMBOLS,
        postProcess1m: false,
        dailyLossLimit: cfg.dailyLossLimit,
      },
    });
    const r = analyze(cfg.label, result);
    results.push({ ...r, label: cfg.label });
  }

  // Summary comparison
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  COMPARISON SUMMARY`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  ${'Config'.padEnd(28)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(8)} ${'DD%'.padStart(6)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)} ${'Pos Mo'.padStart(7)}`);
  console.log(`  ${'-'.repeat(76)}`);

  const baseline = results[0];
  for (const r of results) {
    const ddDelta = r.dd - baseline.dd;
    const pnlDelta = r.pnl - baseline.pnl;
    console.log(
      `  ${r.label.padEnd(28)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(5)}% $${r.pnl.toFixed(0).padStart(7)} ${r.dd.toFixed(1).padStart(5)}% ${r.sharpe.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(5)} ${r.posMonths}/${r.totalMonths}`.padEnd(1) +
      (r !== baseline ? `  (DD ${ddDelta > 0 ? '+' : ''}${ddDelta.toFixed(1)}pp, PnL ${pnlDelta > 0 ? '+' : ''}$${pnlDelta.toFixed(0)})` : '')
    );
  }

  // Walk-forward: H1 vs H2
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`  WALK-FORWARD: H1 vs H2 (best circuit breaker vs baseline)`);
  console.log(`${'═'.repeat(80)}`);

  // Find best DD reduction config
  const bestIdx = results.slice(1).reduce((best, r, i) =>
    r.dd < results[best + 1].dd ? i : best, 0) + 1;
  const bestCfg = configs[bestIdx];

  for (const [label, start, end] of [
    ['H1 (Jan-Jun)', '2025-01-01', '2025-06-30'],
    ['H2 (Jul-Dec)', '2025-07-01', '2025-12-31'],
  ] as const) {
    const periodData = await loadData(new Date(start), new Date(end));

    const baseResult = await runBacktestComputation({
      ...periodData,
      params: { startDate: new Date(start), endDate: new Date(end), initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false, dailyLossLimit: 0 },
    });
    const cbResult = await runBacktestComputation({
      ...periodData,
      params: { startDate: new Date(start), endDate: new Date(end), initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false, dailyLossLimit: bestCfg.dailyLossLimit },
    });

    const b = baseResult.summary;
    const c = cbResult.summary;
    console.log(`\n  ${label}:`);
    console.log(`    Baseline:        ${b.totalTrades} trades, ${b.winRate.toFixed(1)}% WR, $${b.totalPnlUsd.toFixed(0)} PnL, ${b.maxDrawdownPct.toFixed(1)}% DD, Sharpe ${(b.sharpeRatio ?? 0).toFixed(2)}`);
    console.log(`    CB(${bestCfg.dailyLossLimit} loss/day): ${c.totalTrades} trades, ${c.winRate.toFixed(1)}% WR, $${c.totalPnlUsd.toFixed(0)} PnL, ${c.maxDrawdownPct.toFixed(1)}% DD, Sharpe ${(c.sharpeRatio ?? 0).toFixed(2)}`);
    console.log(`    Delta:           ${c.totalTrades - b.totalTrades} trades, ${(c.winRate - b.winRate).toFixed(1)}pp WR, $${(c.totalPnlUsd - b.totalPnlUsd).toFixed(0)} PnL, ${(c.maxDrawdownPct - b.maxDrawdownPct).toFixed(1)}pp DD`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
