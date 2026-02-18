/**
 * Compare exhaustion detector WITH vs WITHOUT using 1m candle data.
 *
 * This script tests the exhaustion detector at 1m resolution — matching
 * live behavior exactly. The main strategy stays on 15m, but within each
 * 15m bar, the exhaustion detector runs on 1m candles and stop execution
 * is simulated at 1m resolution.
 *
 * Prerequisites:
 *   npx tsx scripts/download-1m-candles.ts   (downloads ~500MB of 1m data)
 *
 * Run:
 *   npx tsx scripts/compare-exhaustion-1m.ts
 *
 * Optional: sweep thresholds
 *   npx tsx scripts/compare-exhaustion-1m.ts --sweep
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = [
  'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
  'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
  'STX/USDT:USDT', 'BTC/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
};

async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000; // 200 bars of 15m warmup
  const since = startMs - extraBarsMs;

  // Load BTC 15m
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  // Load BTC 1h
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btc1hLocal) throw new Error('No local BTC 1h data');
  const btcCandles1h = sliceCandlesByTime(btc1hLocal.candles, since, endMs);

  // Load 15m symbol data
  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`No 15m data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  // Load 1m symbol data (optional — may not exist yet)
  const allData1m: Record<string, any[]> = {};
  let has1m = false;
  for (const symbol of SYMBOLS) {
    const local1m = await loadLocalJsonCandles(symbol, '1m');
    if (!local1m) continue;
    allData1m[symbol] = sliceCandlesByTime(local1m.candles, since, endMs);
    has1m = true;
    console.log(`  1m ${symbol}: ${allData1m[symbol].length} candles`);
  }

  if (!has1m) {
    console.warn('\n⚠ No 1m candle data found!');
    console.warn('  Run: npx tsx scripts/download-1m-candles.ts');
    console.warn('  Falling back to 15m approximation.\n');
  } else {
    console.log(`\n✓ Loaded 1m data for ${Object.keys(allData1m).length} symbols\n`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return {
    btcCandles,
    btcCandles1h,
    allData,
    allData1m: has1m ? allData1m : undefined,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };
}

function exitReasonStats(trades: any[]) {
  const counts: Record<string, { count: number; totalPnl: number; wins: number }> = {};
  for (const t of trades) {
    const r = t.exitReason || 'UNKNOWN';
    if (!counts[r]) counts[r] = { count: 0, totalPnl: 0, wins: 0 };
    counts[r].count++;
    counts[r].totalPnl += t.netPnlUsd;
    if (t.netPnlUsd >= 0) counts[r].wins++;
  }
  return counts;
}

async function runComparison(data: Awaited<ReturnType<typeof loadData>>) {
  // Baseline: exhaustion OFF
  console.log('[1/2] Running baseline (no exhaustion)...');
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const baseline = await runBacktestComputation({ params: PARAMS, ...data });
  const b = baseline.summary;

  // With exhaustion
  console.log('[2/2] Running with exhaustion detector...');
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = true;
  const withExhaustion = await runBacktestComputation({ params: PARAMS, ...data });
  const w = withExhaustion.summary;

  // Print results
  console.log('\n' + '='.repeat(70));
  console.log('  BASELINE (no exhaustion)');
  console.log('='.repeat(70));
  console.log(`Trades: ${b.totalTrades} | WR: ${b.winRate.toFixed(1)}% | PnL: $${b.totalPnlUsd.toFixed(0)} (${b.totalPnlPct.toFixed(1)}%)`);
  console.log(`DD: ${b.maxDrawdownPct.toFixed(1)}% | PF: ${b.profitFactor.toFixed(2)} | Sharpe: ${b.sharpeRatio.toFixed(2)}`);

  console.log('\n' + '='.repeat(70));
  console.log(`  WITH EXHAUSTION (threshold=${(MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD})`);
  console.log('='.repeat(70));
  console.log(`Trades: ${w.totalTrades} | WR: ${w.winRate.toFixed(1)}% | PnL: $${w.totalPnlUsd.toFixed(0)} (${w.totalPnlPct.toFixed(1)}%)`);
  console.log(`DD: ${w.maxDrawdownPct.toFixed(1)}% | PF: ${w.profitFactor.toFixed(2)} | Sharpe: ${w.sharpeRatio.toFixed(2)}`);

  // Delta
  const deltaPnl = w.totalPnlUsd - b.totalPnlUsd;
  console.log('\n' + '='.repeat(70));
  console.log('  DELTA (with - without)');
  console.log('='.repeat(70));
  console.log(`PnL:    ${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)} (${(w.totalPnlPct - b.totalPnlPct).toFixed(1)}%)`);
  console.log(`WR:     ${(w.winRate - b.winRate).toFixed(1)}%`);
  console.log(`DD:     ${(w.maxDrawdownPct - b.maxDrawdownPct).toFixed(1)}%`);
  console.log(`Sharpe: ${(w.sharpeRatio - b.sharpeRatio).toFixed(2)}`);
  console.log(`PF:     ${(w.profitFactor - b.profitFactor).toFixed(2)}`);

  // TRAIL_PROACTIVE breakdown
  const proactive = withExhaustion.trades.filter((t: any) => t.exitReason === 'TRAIL_PROACTIVE');
  if (proactive.length > 0) {
    const avgPnl = proactive.reduce((s: number, t: any) => s + t.netPnlUsd, 0) / proactive.length;
    const wins = proactive.filter((t: any) => t.netPnlUsd >= 0).length;
    console.log(`\nTRAIL_PROACTIVE: ${proactive.length} trades | ${wins} wins | avg $${avgPnl.toFixed(2)}`);
    console.log('\nSample TRAIL_PROACTIVE exits:');
    for (const t of proactive.slice(0, 15)) {
      console.log(`  ${t.symbol.padEnd(18)} PnL=$${t.netPnlUsd.toFixed(2).padStart(8)} hold=${t.holdMinutes.toFixed(0)}min exit=$${t.exitPrice.toFixed(4)}`);
    }
  } else {
    console.log('\nNo TRAIL_PROACTIVE exits. Threshold may be too high or exhaustion rarely detected.');
  }

  // Exit reason comparison
  console.log('\n' + '='.repeat(70));
  console.log('  EXIT REASON COMPARISON');
  console.log('='.repeat(70));
  const baseReasons = exitReasonStats(baseline.trades);
  const withReasons = exitReasonStats(withExhaustion.trades);
  const allReasons = new Set([...Object.keys(baseReasons), ...Object.keys(withReasons)]);
  console.log(`${'Reason'.padEnd(28)} ${'Base#'.padStart(5)} ${'With#'.padStart(5)} ${'Delta'.padStart(6)} ${'AvgPnl(base)'.padStart(12)} ${'AvgPnl(with)'.padStart(12)}`);
  for (const r of Array.from(allReasons).sort()) {
    const bc = baseReasons[r] || { count: 0, totalPnl: 0 };
    const wc = withReasons[r] || { count: 0, totalPnl: 0 };
    const bAvg = bc.count > 0 ? bc.totalPnl / bc.count : 0;
    const wAvg = wc.count > 0 ? wc.totalPnl / wc.count : 0;
    console.log(`${r.padEnd(28)} ${String(bc.count).padStart(5)} ${String(wc.count).padStart(5)} ${String(wc.count - bc.count).padStart(6)} ${('$' + bAvg.toFixed(2)).padStart(12)} ${('$' + wAvg.toFixed(2)).padStart(12)}`);
  }
}

async function runSweep(data: Awaited<ReturnType<typeof loadData>>) {
  // Baseline
  console.log('Running baseline...');
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const baseline = await runBacktestComputation({ params: PARAMS, ...data });
  const b = baseline.summary;
  console.log(`BASELINE: ${b.totalTrades} trades | PnL=$${b.totalPnlUsd.toFixed(0)} | WR=${b.winRate.toFixed(1)}% | DD=${b.maxDrawdownPct.toFixed(1)}%\n`);

  const thresholds = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];

  console.log('Thresh | Trades | Proactive | PnL ($)    | Delta ($) | WR%   | DD%   | PF   | Sharpe');
  console.log('-'.repeat(95));

  for (const thresh of thresholds) {
    (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = true;
    (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD = thresh;
    (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD = Math.max(20, thresh - 20);

    const result = await runBacktestComputation({ params: PARAMS, ...data });
    const s = result.summary;

    const proactiveCount = result.trades.filter((t: any) => t.exitReason === 'TRAIL_PROACTIVE').length;
    const delta = s.totalPnlUsd - b.totalPnlUsd;

    console.log(
      `  ${String(thresh).padStart(3)}  |  ${String(s.totalTrades).padStart(4)}  |    ${String(proactiveCount).padStart(3)}    | ${('$' + s.totalPnlUsd.toFixed(0)).padStart(10)} | ${(delta >= 0 ? '+' : '') + '$' + delta.toFixed(0).padStart(6)} | ${s.winRate.toFixed(1)}% | ${s.maxDrawdownPct.toFixed(1)}% | ${s.profitFactor.toFixed(2)} | ${s.sharpeRatio.toFixed(2)}`
    );
  }

  // Restore defaults
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = true;
  (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD = 65;
  (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD = 45;
}

async function main() {
  const sweep = process.argv.includes('--sweep');

  console.log('Loading data...');
  const data = await loadData();
  console.log('Data loaded.\n');

  if (sweep) {
    await runSweep(data);
  } else {
    await runComparison(data);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
