/**
 * Compare backtest: Exhaustion Detector ON vs OFF
 *
 * Tests whether the exhaustion-based proactive STOP_MARKET improves
 * exit quality vs the standard NFS 2-candle confirmation approach.
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  mergeDedupCandles,
  CANDLE_15M_MS,
  CANDLE_1H_MS,
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
  const extraBarsMs = 200 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  // Load BTC 15m
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  // Load BTC 1h
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btc1hLocal) throw new Error('No local BTC 1h data');
  const btcCandlesRegime = sliceCandlesByTime(btc1hLocal.candles, since, endMs);
  console.log(`BTC 1h: ${btcCandlesRegime.length} candles`);

  // Load symbol data
  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`No data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
    console.log(`${symbol}: ${allData[symbol].length} candles`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const CANDLE_REGIME_INTERVAL_MS = configTfMin * 60 * 1000;

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS };
}

function exitReasonStats(trades: any[]) {
  const counts: Record<string, { count: number; totalPnl: number }> = {};
  for (const t of trades) {
    const r = t.exitReason || 'UNKNOWN';
    if (!counts[r]) counts[r] = { count: 0, totalPnl: 0 };
    counts[r].count++;
    counts[r].totalPnl += t.netPnlUsd;
  }
  return counts;
}

function printSummary(label: string, result: any) {
  const s = result.summary;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Trades:        ${s.totalTrades} (${s.longTrades} long, ${s.shortTrades} short)`);
  console.log(`Win Rate:      ${s.winRate.toFixed(1)}%`);
  console.log(`Net PnL:       $${s.totalPnlUsd.toFixed(2)} (${s.totalPnlPct.toFixed(1)}%)`);
  console.log(`Final Capital: $${s.finalCapital.toFixed(2)}`);
  console.log(`Max Drawdown:  ${s.maxDrawdownPct.toFixed(1)}%`);
  console.log(`Sharpe:        ${s.sharpeRatio.toFixed(2)}`);
  console.log(`Profit Factor: ${s.profitFactor.toFixed(2)}`);
  console.log(`Avg Hold:      ${s.avgHoldMinutes.toFixed(0)} min`);
  console.log(`Total Fees:    $${s.totalFeesUsd.toFixed(2)}`);

  const reasons = exitReasonStats(result.trades);
  console.log(`\n  Exit Reason Breakdown:`);
  const sorted = Object.entries(reasons).sort((a, b) => b[1].count - a[1].count);
  for (const [reason, data] of sorted) {
    const avgPnl = data.totalPnl / data.count;
    console.log(`    ${reason.padEnd(28)} ${String(data.count).padStart(4)} trades  total=$${data.totalPnl.toFixed(2)}  avg=$${avgPnl.toFixed(2)}`);
  }
}

async function main() {
  console.log('Loading local candle data...');
  const data = await loadData();

  // ── RUN 1: WITH exhaustion detector ──
  console.log('\n[1/2] Running backtest WITH exhaustion detector...');
  const withExhaustion = await runBacktestComputation({
    params: PARAMS,
    ...data,
  });

  // ── RUN 2: WITHOUT exhaustion detector ──
  console.log('\n[2/2] Running backtest WITHOUT exhaustion detector...');
  const origEnabled = (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED;
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const withoutExhaustion = await runBacktestComputation({
    params: PARAMS,
    ...data,
  });
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = origEnabled;

  // ── COMPARISON ──
  printSummary('WITH EXHAUSTION DETECTOR (V5.110)', withExhaustion);
  printSummary('WITHOUT EXHAUSTION (NFS only)', withoutExhaustion);

  const w = withExhaustion.summary;
  const wo = withoutExhaustion.summary;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DELTA (WITH - WITHOUT)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`PnL:           $${(w.totalPnlUsd - wo.totalPnlUsd).toFixed(2)} (${(w.totalPnlPct - wo.totalPnlPct).toFixed(1)}%)`);
  console.log(`Win Rate:      ${(w.winRate - wo.winRate).toFixed(1)}%`);
  console.log(`Trades:        ${w.totalTrades - wo.totalTrades}`);
  console.log(`Max Drawdown:  ${(w.maxDrawdownPct - wo.maxDrawdownPct).toFixed(1)}%`);
  console.log(`Sharpe:        ${(w.sharpeRatio - wo.sharpeRatio).toFixed(2)}`);
  console.log(`Profit Factor: ${(w.profitFactor - wo.profitFactor).toFixed(2)}`);

  // Count TRAIL_PROACTIVE exits specifically
  const proactiveExits = withExhaustion.trades.filter((t: any) => t.exitReason === 'TRAIL_PROACTIVE');
  if (proactiveExits.length > 0) {
    const avgPnl = proactiveExits.reduce((s: number, t: any) => s + t.netPnlUsd, 0) / proactiveExits.length;
    const wins = proactiveExits.filter((t: any) => t.netPnlUsd >= 0).length;
    console.log(`\nTRAIL_PROACTIVE exits: ${proactiveExits.length} trades | wins=${wins} | avg PnL $${avgPnl.toFixed(2)}`);

    // Compare those specific trades against what would have happened without exhaustion
    console.log('\nSample TRAIL_PROACTIVE exits (first 10):');
    for (const t of proactiveExits.slice(0, 10)) {
      console.log(`  ${t.symbol.padEnd(18)} exit=$${t.exitPrice.toFixed(4)} entry=$${t.entryPrice.toFixed(4)} PnL=$${t.netPnlUsd.toFixed(2)} hold=${t.holdMinutes}min`);
    }
  } else {
    console.log(`\nNote: 0 TRAIL_PROACTIVE exits. Threshold might be too high or exhaustion rarely detected on 15m.`);
    console.log('Consider lowering EXHAUSTION_PLACEMENT_THRESHOLD from 65 to 55.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
