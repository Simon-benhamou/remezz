/**
 * Compare backtest: Skip-N-trades rule ON vs OFF
 *
 * V5.63 skip rule skips 1 trade after 2 consecutive losers.
 * Bug found: paper skipped FET at 08:15 (live didn't) causing divergence.
 * Test whether removing the rule entirely is acceptable.
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = [...MomentumConfig.SYMBOLS, 'BTC/USDT:USDT'];

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
  const extraBarsMs = 3200 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  // V5.102: regime uses 15m by default, no separate 1h needed
  const btcCandlesRegime = btcCandles;
  console.log(`BTC regime (15m): ${btcCandlesRegime.length} candles`);

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
  console.log(`Skipped:       ${(result as any).skippedTrades ?? 'N/A'}`);

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

  // ── RUN 1: WITH skip rule (baseline) ──
  console.log('\n[1/2] Running backtest WITH skip rule (baseline V5.63)...');
  const withSkip = await runBacktestComputation({
    params: PARAMS,
    ...data,
  });

  // ── RUN 2: WITHOUT skip rule ──
  // Patch: set threshold to 9999 so it never triggers
  console.log('\n[2/2] Running backtest WITHOUT skip rule...');

  // We need to monkey-patch the backtestService constants.
  // The cleanest way: pass skipRuleDisabled via params
  // But since it's hardcoded, we'll use a different approach:
  // Set CONSECUTIVE_LOSER_THRESHOLD very high via the source
  // Actually, let's just use the dailyLossLimit param trick - no.
  // The simplest: temporarily modify the module's exported function behavior
  // by adding a param. But we can't modify backtestService inline here.

  // Alternative: The skip rule checks `tradesToSkip > 0` at line ~2036.
  // We can pass `skipRuleThreshold: 9999` but that param doesn't exist.
  // Let's just re-run with a patched constant by modifying the file temporarily...
  // No - bad idea. Let's just accept we need to patch backtestService to accept a param.

  // Actually, the SIMPLEST approach: since CONSECUTIVE_LOSER_THRESHOLD is a local const,
  // we can make it configurable via params. Let me check if there's a cleaner way...

  // For now, let's add skipRuleThreshold to BacktestParams
  const withoutSkip = await runBacktestComputation({
    params: { ...PARAMS, skipRuleThreshold: 9999 } as any,
    ...data,
  });

  // ── COMPARISON ──
  printSummary('WITH SKIP RULE (V5.63 baseline)', withSkip);
  printSummary('WITHOUT SKIP RULE', withoutSkip);

  const w = withSkip.summary;
  const wo = withoutSkip.summary;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DELTA (WITHOUT - WITH skip rule)`);
  console.log(`${'='.repeat(60)}`);
  console.log(`PnL:           $${(wo.totalPnlUsd - w.totalPnlUsd).toFixed(2)} (${(wo.totalPnlPct - w.totalPnlPct).toFixed(1)}%)`);
  console.log(`Win Rate:      ${(wo.winRate - w.winRate).toFixed(1)}pp`);
  console.log(`Trades:        ${wo.totalTrades - w.totalTrades} more`);
  console.log(`Max Drawdown:  ${(wo.maxDrawdownPct - w.maxDrawdownPct).toFixed(1)}pp`);
  console.log(`Sharpe:        ${(wo.sharpeRatio - w.sharpeRatio).toFixed(2)}`);
  console.log(`Profit Factor: ${(wo.profitFactor - w.profitFactor).toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
