/**
 * V5.146 — Choppy Crash Filter Sweep
 *
 * Tests: consecRed (1,2,3) × BTC Δ24h (-3,-4,-5,-7) + combos
 * Full year + walk-forward H1/H2 for top configs.
 *
 * Usage: npx tsx scripts/sweep-choppy-filters.ts
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
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

  return { btcCandles, btcCandlesRegime: btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: CANDLE_15M_MS };
}

type Result = { label: string; trades: number; wr: number; pnl: number; dd: number; sharpe: number; pf: number; shortPnl: number; shortTrades: number };

async function runConfig(label: string, startDate: Date, endDate: Date, data: any, consecRed: number, btcDrop: number): Promise<Result> {
  // Temporarily override config
  const origConsecRed = (MomentumConfig.ENTRY_QUALITY as any).SHORT_MIN_CONSEC_RED;
  const origBtcDrop = (MomentumConfig.ENTRY_QUALITY as any).SHORT_BTC_DROP_24H_MAX;
  (MomentumConfig.ENTRY_QUALITY as any).SHORT_MIN_CONSEC_RED = consecRed;
  (MomentumConfig.ENTRY_QUALITY as any).SHORT_BTC_DROP_24H_MAX = btcDrop;

  try {
    const result = await runBacktestComputation({
      ...data,
      params: { startDate, endDate, initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false },
    });

    const s = result.summary;
    const shorts = result.trades.filter(t => (t as any).side === 'short');
    const shortPnl = shorts.reduce((a, t) => a + t.netPnlUsd, 0);

    // Compute DD from trade equity
    let peak = 2000, maxDD = 0, equity = 2000;
    const sorted = [...result.trades].sort((a, b) => (a.exitTime || '') < (b.exitTime || '') ? -1 : 1);
    for (const t of sorted) {
      equity += t.netPnlUsd;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }

    return { label, trades: s.totalTrades, wr: s.winRate, pnl: s.totalPnlUsd, dd: maxDD, sharpe: s.sharpeRatio ?? 0, pf: s.profitFactor ?? 0, shortPnl, shortTrades: shorts.length };
  } finally {
    (MomentumConfig.ENTRY_QUALITY as any).SHORT_MIN_CONSEC_RED = origConsecRed;
    (MomentumConfig.ENTRY_QUALITY as any).SHORT_BTC_DROP_24H_MAX = origBtcDrop;
  }
}

async function main() {
  console.log('V5.146 — Choppy Crash Filter Sweep');
  console.log(`Symbols: ${SYMBOLS.length} | Period: Jan-Dec 2025 | $2K, 5x`);
  console.log('═'.repeat(100));

  const START = new Date('2025-01-01');
  const END = new Date('2025-12-31');
  const data = await loadData(START, END);

  const configs: Array<{ label: string; consecRed: number; btcDrop: number }> = [
    { label: 'BASELINE', consecRed: 0, btcDrop: 0 },
    // ConsecRed alone
    { label: 'ConsecRed≥1', consecRed: 1, btcDrop: 0 },
    { label: 'ConsecRed≥2', consecRed: 2, btcDrop: 0 },
    { label: 'ConsecRed≥3', consecRed: 3, btcDrop: 0 },
    // BTC 24h drop alone
    { label: 'BTC24h>-3%', consecRed: 0, btcDrop: -3 },
    { label: 'BTC24h>-4%', consecRed: 0, btcDrop: -4 },
    { label: 'BTC24h>-5%', consecRed: 0, btcDrop: -5 },
    { label: 'BTC24h>-7%', consecRed: 0, btcDrop: -7 },
    // Combos
    { label: 'CR≥1 + 24h>-5%', consecRed: 1, btcDrop: -5 },
    { label: 'CR≥1 + 24h>-4%', consecRed: 1, btcDrop: -4 },
    { label: 'CR≥2 + 24h>-5%', consecRed: 2, btcDrop: -5 },
    { label: 'CR≥1 + 24h>-7%', consecRed: 1, btcDrop: -7 },
  ];

  const results: Result[] = [];

  for (const cfg of configs) {
    process.stdout.write(`  ${cfg.label.padEnd(18)}...`);
    const r = await runConfig(cfg.label, START, END, data, cfg.consecRed, cfg.btcDrop);
    results.push(r);
    console.log(` ${r.trades}t | ${r.wr.toFixed(1)}%WR | $${r.pnl.toFixed(0)} | ${r.dd.toFixed(1)}%DD | S${r.sharpe.toFixed(2)} | SHORT: ${r.shortTrades}t $${r.shortPnl.toFixed(0)}`);
  }

  // Summary sorted by Sharpe
  const baseline = results[0];
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  SORTED BY SHARPE`);
  console.log(`${'═'.repeat(110)}`);
  console.log(`  ${'Config'.padEnd(18)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(8)} ${'DD%'.padStart(6)} ${'ΔDD'.padStart(6)} ${'Sharpe'.padStart(7)} ${'PF'.padStart(5)} ${'S#'.padStart(5)} ${'S PnL'.padStart(8)} ${'ΔPnL'.padStart(8)}`);
  console.log(`  ${'-'.repeat(90)}`);

  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
  for (const r of sorted) {
    const ddDelta = r.dd - baseline.dd;
    const pnlDelta = r.pnl - baseline.pnl;
    console.log(
      `  ${r.label.padEnd(18)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(5)}% $${r.pnl.toFixed(0).padStart(7)} ${r.dd.toFixed(1).padStart(5)}% ${(ddDelta > 0 ? '+' : '') + ddDelta.toFixed(1).padStart(5)} ${r.sharpe.toFixed(2).padStart(7)} ${r.pf.toFixed(2).padStart(5)} ${String(r.shortTrades).padStart(5)} $${r.shortPnl.toFixed(0).padStart(7)} ${(pnlDelta > 0 ? '+' : '') + '$' + pnlDelta.toFixed(0).padStart(6)}`
    );
  }

  // Walk-forward for top 3 by Sharpe (excluding baseline)
  const top3 = sorted.filter(r => r !== baseline).slice(0, 3);
  console.log(`\n${'═'.repeat(110)}`);
  console.log(`  WALK-FORWARD: H1 vs H2 for top 3 configs`);
  console.log(`${'═'.repeat(110)}`);

  for (const [label, start, end] of [
    ['H1 (Jan-Jun)', '2025-01-01', '2025-06-30'],
    ['H2 (Jul-Dec)', '2025-07-01', '2025-12-31'],
  ] as const) {
    const periodData = await loadData(new Date(start), new Date(end));
    console.log(`\n  ${label}:`);

    const baseWF = await runConfig('Baseline', new Date(start), new Date(end), periodData, 0, 0);
    console.log(`    ${'Baseline'.padEnd(18)} ${baseWF.trades}t | ${baseWF.wr.toFixed(1)}%WR | $${baseWF.pnl.toFixed(0)} | ${baseWF.dd.toFixed(1)}%DD | S${baseWF.sharpe.toFixed(2)} | SHORT: ${baseWF.shortTrades}t $${baseWF.shortPnl.toFixed(0)}`);

    for (const cfg of top3) {
      const origCfg = configs.find(c => c.label === cfg.label)!;
      const r = await runConfig(cfg.label, new Date(start), new Date(end), periodData, origCfg.consecRed, origCfg.btcDrop);
      const ddDelta = r.dd - baseWF.dd;
      const pnlDelta = r.pnl - baseWF.pnl;
      console.log(
        `    ${r.label.padEnd(18)} ${r.trades}t | ${r.wr.toFixed(1)}%WR | $${r.pnl.toFixed(0)} | ${r.dd.toFixed(1)}%DD | S${r.sharpe.toFixed(2)} | ΔDD${(ddDelta > 0 ? '+' : '') + ddDelta.toFixed(1)}pp ΔPnL${(pnlDelta > 0 ? '+' : '') + '$' + pnlDelta.toFixed(0)}`
      );
    }
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
