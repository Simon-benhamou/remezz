/**
 * quick-h2-check.ts — Quick check: missing H2 symbols + combined portfolio comparison
 * Runs only H2 (Jul-Dec) to be fast (~5min instead of 1h)
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';
import path from 'node:path';

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

async function loadData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');
  const symbolFiles = new Map<string, string>();

  for (const f of fs.readdirSync(dataDir)) {
    const m = f.match(/^([A-Z]+_USDT)_15m\.json$/);
    if (m) symbolFiles.set(m[1].replace('_', '/') + ':USDT', path.join(dataDir, f));
  }
  if (fs.existsSync(data2024Dir)) {
    for (const f of fs.readdirSync(data2024Dir)) {
      const m = f.match(/^([A-Z]+_USDT)_15m\.json$/);
      if (m) {
        const sym = m[1].replace('_', '/') + ':USDT';
        if (!symbolFiles.has(sym)) symbolFiles.set(sym, path.join(data2024Dir, f));
      }
    }
  }

  const allData: Record<string, BacktestCandle[]> = {};
  for (const [symbol, filepath] of symbolFiles) {
    if (symbol === 'BTC/USDT:USDT') continue;
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      const json = JSON.parse(raw);
      if (!Array.isArray(json) || json.length < 100) continue;
      const candles: BacktestCandle[] = json
        .filter((c: any) => c.openTime && c.open && c.close)
        .map((c: any) => ({ timestamp: c.openTime, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0) }))
        .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);
      const sliced = sliceCandlesByTime(candles, since, endMs);
      if (sliced.length >= 300) allData[symbol] = sliced;
    } catch { /* skip */ }
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  return { btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

async function runSingle(data: any, symbol: string, start: string, end: string) {
  const fullSym = `${symbol}/USDT:USDT`;
  if (!data.allData[fullSym]) return null;
  const input: BacktestComputationInput = {
    params: { startDate: new Date(start + 'T00:00:00Z'), endDate: new Date(end + 'T23:59:59Z'), initialCapital: INITIAL_CAPITAL, symbols: [fullSym], leverage: LEVERAGE },
    btcCandles: data.btcCandles, btcCandlesRegime: data.btcCandles,
    allData: { [fullSym]: data.allData[fullSym] },
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };
  const r = await runBacktestComputation(input);
  return r.summary;
}

async function runCombined(data: any, symbols: string[], start: string, end: string) {
  const fullSyms = symbols.map(s => `${s}/USDT:USDT`);
  const symData: Record<string, BacktestCandle[]> = {};
  for (const s of fullSyms) { if (data.allData[s]) symData[s] = data.allData[s]; }
  const input: BacktestComputationInput = {
    params: { startDate: new Date(start + 'T00:00:00Z'), endDate: new Date(end + 'T23:59:59Z'), initialCapital: INITIAL_CAPITAL, symbols: fullSyms, leverage: LEVERAGE },
    btcCandles: data.btcCandles, btcCandlesRegime: data.btcCandles,
    allData: symData,
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };
  return (await runBacktestComputation(input)).summary;
}

async function main() {
  console.log('=== Quick H1/H2 Symbol Check ===\n');

  const data = await loadData(
    new Date('2025-01-01').getTime(),
    new Date('2025-12-31T23:59:59Z').getTime()
  );
  console.log(`BTC: ${data.btcCandles.length} candles\n`);

  // Part 1: Missing H2 symbols
  console.log('--- Missing H2 per-symbol results ---');
  for (const sym of ['TIA', 'UNI', 'WIF', 'XRP']) {
    const r = await runSingle(data, sym, '2025-07-01', '2025-12-31');
    if (r) console.log(`  ${padR(sym, 8)} H2: ${r.totalTrades}tr $${r.totalPnlUsd.toFixed(0)} ${r.winRate.toFixed(1)}%WR Sh=${r.sharpeRatio.toFixed(2)} PF=${r.profitFactor.toFixed(2)}`);
  }

  // Part 1b: Full H1 results for reference
  console.log('\n--- Full H1 per-symbol ---');
  const allSymbols = ['WIF', 'UNI', 'FET', 'STX', 'IMX', 'ARB', 'SEI', 'SUI', 'NEAR', 'ETH',
    'ADA', 'APT', 'BCH', 'RENDER', 'SONIC', 'DOGE', 'DOT', 'XRP', 'SOL',
    'OP', 'LINK', 'AVAX', 'TIA', 'ATOM', 'LTC'];

  const h1Results: Record<string, any> = {};
  const h2Results: Record<string, any> = {};

  for (const sym of allSymbols) {
    const r = await runSingle(data, sym, '2025-01-01', '2025-06-30');
    if (r) {
      h1Results[sym] = r;
      console.log(`  ${padR(sym, 8)} H1: ${r.totalTrades}tr $${r.totalPnlUsd.toFixed(0)} Sh=${r.sharpeRatio.toFixed(2)}`);
    }
  }

  console.log('\n--- Full H2 per-symbol ---');
  for (const sym of allSymbols) {
    const r = await runSingle(data, sym, '2025-07-01', '2025-12-31');
    if (r) {
      h2Results[sym] = r;
      console.log(`  ${padR(sym, 8)} H2: ${r.totalTrades}tr $${r.totalPnlUsd.toFixed(0)} Sh=${r.sharpeRatio.toFixed(2)}`);
    }
  }

  // Part 2: Classify
  console.log('\n\n=== CLASSIFICATION ===\n');

  type SymClass = { sym: string; h1Sh: number; h2Sh: number; h1Pnl: number; h2Pnl: number; avgSh: number; minSh: number; };
  const classified: SymClass[] = [];

  for (const sym of allSymbols) {
    if (!h1Results[sym] || !h2Results[sym]) continue;
    const h1 = h1Results[sym];
    const h2 = h2Results[sym];
    classified.push({
      sym, h1Sh: h1.sharpeRatio, h2Sh: h2.sharpeRatio,
      h1Pnl: h1.totalPnlUsd, h2Pnl: h2.totalPnlUsd,
      avgSh: (h1.sharpeRatio + h2.sharpeRatio) / 2,
      minSh: Math.min(h1.sharpeRatio, h2.sharpeRatio),
    });
  }

  classified.sort((a, b) => b.avgSh - a.avgSh);

  console.log(`${padR('Symbol', 8)} | ${padL('H1 Sh', 7)} ${padL('H2 Sh', 7)} ${padL('Avg', 7)} ${padL('Min', 7)} | ${padL('H1 PnL', 8)} ${padL('H2 PnL', 8)} ${padL('Total', 8)} | Status`);
  console.log('-'.repeat(100));

  const consistent: string[] = [];
  const h1only: string[] = [];
  const h2only: string[] = [];

  for (const c of classified) {
    const h1ok = c.h1Sh >= 1 && h1Results[c.sym].profitFactor >= 1.1 && h1Results[c.sym].totalTrades >= 20;
    const h2ok = c.h2Sh >= 1 && h2Results[c.sym].profitFactor >= 1.1 && h2Results[c.sym].totalTrades >= 20;

    let status: string;
    if (h1ok && h2ok) { status = 'CONSISTENT'; consistent.push(c.sym); }
    else if (h1ok) { status = 'H1-only'; h1only.push(c.sym); }
    else if (h2ok) { status = 'H2-only'; h2only.push(c.sym); }
    else { status = c.h1Pnl + c.h2Pnl > 0 ? 'MARGINAL' : 'AVOID'; }

    console.log(`${padR(c.sym, 8)} | ${padL(c.h1Sh.toFixed(2), 7)} ${padL(c.h2Sh.toFixed(2), 7)} ${padL(c.avgSh.toFixed(2), 7)} ${padL(c.minSh.toFixed(2), 7)} | ${padL('$' + c.h1Pnl.toFixed(0), 8)} ${padL('$' + c.h2Pnl.toFixed(0), 8)} ${padL('$' + (c.h1Pnl + c.h2Pnl).toFixed(0), 8)} | ${status}`);
  }

  console.log('-'.repeat(100));
  console.log(`\nCONSISTENT: ${consistent.join(', ')}`);
  console.log(`H1-only:    ${h1only.join(', ')}`);
  console.log(`H2-only:    ${h2only.join(', ')}`);

  // Part 3: Combined portfolio comparisons (H2 only = OOS, much faster)
  console.log('\n\n=== COMBINED PORTFOLIO BACKTESTS (H2 = Out-of-Sample) ===\n');

  const current19 = ['WIF', 'UNI', 'FET', 'STX', 'IMX', 'ARB', 'SEI', 'SUI', 'NEAR', 'ADA', 'APT', 'ETH', 'SONIC', 'RENDER', 'XRP', 'DOGE', 'DOT', 'BCH', 'SOL'];

  // Top N by avg Sharpe (consistent + others ranked)
  const topByAvgSh = classified.filter(c => c.avgSh > 0 && c.minSh > -0.5).map(c => c.sym);

  const portfolios = [
    { label: 'Current 19 (V5.130)', syms: current19 },
    { label: 'CONSISTENT only', syms: consistent },
    { label: 'Top-8 avgSharpe', syms: topByAvgSh.slice(0, 8) },
    { label: 'Top-10 avgSharpe', syms: topByAvgSh.slice(0, 10) },
    { label: 'Top-12 avgSharpe', syms: topByAvgSh.slice(0, 12) },
    { label: 'Top-15 avgSharpe', syms: topByAvgSh.slice(0, 15) },
  ];

  for (const p of portfolios) {
    if (p.syms.length === 0) { console.log(`  ${padR(p.label, 35)} (empty)`); continue; }

    // H2 only (fast)
    const rH2 = await runCombined(data, p.syms, '2025-07-01', '2025-12-31');
    console.log(`  H2: ${padR(p.label, 30)} (${p.syms.length}sym) ${rH2.totalTrades}tr $${rH2.totalPnlUsd.toFixed(0)} ${rH2.winRate.toFixed(1)}%WR Sh=${rH2.sharpeRatio.toFixed(2)} PF=${rH2.profitFactor.toFixed(2)} DD=${rH2.maxDrawdownPct.toFixed(1)}%`);
  }

  // Also full year for the 2-3 best
  console.log('\n--- Full Year for top portfolios ---\n');
  const topPortfolios = [
    { label: 'Current 19', syms: current19 },
    { label: 'CONSISTENT', syms: consistent },
    { label: 'Top-10 avgSh', syms: topByAvgSh.slice(0, 10) },
  ];

  for (const p of topPortfolios) {
    if (p.syms.length === 0) continue;
    const rFull = await runCombined(data, p.syms, '2025-01-01', '2025-12-31');
    console.log(`  FULL: ${padR(p.label, 28)} (${p.syms.length}sym) ${rFull.totalTrades}tr $${rFull.totalPnlUsd.toFixed(0)} ${rFull.winRate.toFixed(1)}%WR Sh=${rFull.sharpeRatio.toFixed(2)} PF=${rFull.profitFactor.toFixed(2)} DD=${rFull.maxDrawdownPct.toFixed(1)}%`);
  }

  console.log('\n\nSymbol lists:');
  for (const p of portfolios) {
    console.log(`  ${p.label}: ${p.syms.join(', ')}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
