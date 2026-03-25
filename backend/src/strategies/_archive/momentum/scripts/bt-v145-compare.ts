/**
 * V5.145 — Compare LONG vs SHORT performance after ADX15+WICK60 filters
 *
 * Usage: npx tsx scripts/bt-v145-compare.ts
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
    params: { startDate, endDate, initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false },
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
  const longWins = longs.filter(t => t.netPnlUsd > 0).length;
  const shortWins = shorts.filter(t => t.netPnlUsd > 0).length;
  const longWR = longs.length > 0 ? longWins / longs.length * 100 : 0;
  const shortWR = shorts.length > 0 ? shortWins / shorts.length * 100 : 0;

  // Exit reason breakdown
  const slTrades = r.trades.filter(t => t.exitReason === 'SL');
  const trailTrades = r.trades.filter(t => t.exitReason.startsWith('TRAIL'));
  const stagTrades = r.trades.filter(t => t.exitReason === 'STAGNANT_TRADE');
  const slPnl = slTrades.reduce((a, t) => a + t.netPnlUsd, 0);
  const trailPnl = trailTrades.reduce((a, t) => a + t.netPnlUsd, 0);
  const stagPnl = stagTrades.reduce((a, t) => a + t.netPnlUsd, 0);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Total:    ${s.totalTrades} trades | ${s.winRate.toFixed(1)}% WR | $${s.totalPnlUsd.toFixed(0)} PnL | ${s.maxDrawdownPct.toFixed(1)}% DD | Sharpe ${(s.sharpeRatio ?? 0).toFixed(2)} | PF ${(s.profitFactor ?? 0).toFixed(2)}`);
  console.log(`  LONG:     ${longs.length} trades | ${longWR.toFixed(1)}% WR | $${longPnl.toFixed(0)} PnL`);
  console.log(`  SHORT:    ${shorts.length} trades | ${shortWR.toFixed(1)}% WR | $${shortPnl.toFixed(0)} PnL`);
  console.log(`  SL:       ${slTrades.length} trades | $${slPnl.toFixed(0)}`);
  console.log(`  Trail:    ${trailTrades.length} trades | $${trailPnl.toFixed(0)}`);
  console.log(`  Stagnant: ${stagTrades.length} trades | $${stagPnl.toFixed(0)}`);

  // Per-symbol breakdown
  const bySymbol: Record<string, { l: number; s: number; lPnl: number; sPnl: number; lW: number; sW: number }> = {};
  for (const t of r.trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    const d = bySymbol[sym] ??= { l: 0, s: 0, lPnl: 0, sPnl: 0, lW: 0, sW: 0 };
    const isLong = (t as any).side === 'long';
    if (isLong) { d.l++; d.lPnl += t.netPnlUsd; if (t.netPnlUsd > 0) d.lW++; }
    else { d.s++; d.sPnl += t.netPnlUsd; if (t.netPnlUsd > 0) d.sW++; }
  }
  console.log(`\n  ${'Symbol'.padEnd(10)} ${'L#'.padStart(4)} ${'LWR%'.padStart(6)} ${'L PnL'.padStart(8)} | ${'S#'.padStart(4)} ${'SWR%'.padStart(6)} ${'S PnL'.padStart(8)} | ${'Total'.padStart(8)}`);
  console.log(`  ${'-'.repeat(68)}`);
  for (const [sym, d] of Object.entries(bySymbol).sort((a, b) => (b[1].lPnl + b[1].sPnl) - (a[1].lPnl + a[1].sPnl))) {
    const lwr = d.l > 0 ? (d.lW / d.l * 100).toFixed(0) : '-';
    const swr = d.s > 0 ? (d.sW / d.s * 100).toFixed(0) : '-';
    console.log(
      `  ${sym.padEnd(10)} ${String(d.l).padStart(4)} ${(lwr + '%').padStart(6)} $${d.lPnl.toFixed(0).padStart(7)} | ` +
      `${String(d.s).padStart(4)} ${(swr + '%').padStart(6)} $${d.sPnl.toFixed(0).padStart(7)} | ` +
      `$${(d.lPnl + d.sPnl).toFixed(0).padStart(7)}`
    );
  }

  // Monthly breakdown
  const byMonth: Record<string, { trades: number; pnl: number; wins: number }> = {};
  for (const t of r.trades) {
    const m = t.month || t.exitTime?.slice(0, 7) || 'unknown';
    const d = byMonth[m] ??= { trades: 0, pnl: 0, wins: 0 };
    d.trades++; d.pnl += t.netPnlUsd; if (t.netPnlUsd > 0) d.wins++;
  }
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

  return { trades: s.totalTrades, pnl: s.totalPnlUsd, wr: s.winRate, dd: s.maxDrawdownPct, sharpe: s.sharpeRatio ?? 0, pf: s.profitFactor ?? 0, longPnl, shortPnl, longCount: longs.length, shortCount: shorts.length };
}

async function main() {
  console.log('V5.145 — Backtest Comparison');
  console.log(`Config: V5.141 + BE=0.7% + ADX_MIN_SHORT=15 + WICK_REJ_SHORT>60%`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Period: Jan-Dec 2025, $2K, 5x`);

  // Full year
  const data = await loadData(new Date('2025-01-01'), new Date('2025-12-31'));
  const result = await runBacktestComputation(data);
  const full = analyze('FULL YEAR (Jan-Dec 2025)', result);

  // H1
  const dataH1 = await loadData(new Date('2025-01-01'), new Date('2025-06-30'));
  const resultH1 = await runBacktestComputation(dataH1);
  const h1 = analyze('H1 (Jan-Jun 2025)', resultH1);

  // H2
  const dataH2 = await loadData(new Date('2025-07-01'), new Date('2025-12-31'));
  const resultH2 = await runBacktestComputation(dataH2);
  const h2 = analyze('H2 (Jul-Dec 2025)', resultH2);

  // Summary comparison
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  COMPARISON SUMMARY`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  ${'Period'.padEnd(20)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'PnL$'.padStart(8)} ${'DD%'.padStart(6)} ${'Sharpe'.padStart(7)} | ${'L PnL'.padStart(7)} ${'S PnL'.padStart(7)} ${'L/S ratio'.padStart(10)}`);
  console.log(`  ${'-'.repeat(80)}`);
  for (const [lbl, r] of [['Full Year', full], ['H1 (Jan-Jun)', h1], ['H2 (Jul-Dec)', h2]] as const) {
    const ratio = r.shortPnl !== 0 ? (r.longPnl / Math.abs(r.shortPnl)).toFixed(1) : 'inf';
    console.log(
      `  ${lbl.padEnd(20)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(5)}% $${r.pnl.toFixed(0).padStart(7)} ${r.dd.toFixed(1).padStart(5)}% ${r.sharpe.toFixed(2).padStart(7)} | ` +
      `$${r.longPnl.toFixed(0).padStart(6)} $${r.shortPnl.toFixed(0).padStart(6)} ${ratio.padStart(10)}`
    );
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
