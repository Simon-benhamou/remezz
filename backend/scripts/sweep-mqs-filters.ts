/**
 * V5.144 — MQS (Momentum Quality Score) Filter Sweep
 *
 * Tests ROC Acceleration + RSI Divergence filters discovered via post-hoc
 * MQS analysis (Cohen's d = 0.698 and 0.312 respectively).
 *
 * CRITICAL WARNING (V5.143 lesson): Post-hoc analysis OVERSTATES filter impact.
 * This script validates with real runBacktestComputation() — compounded, with
 * signal competition, position limits, and all existing filters active.
 *
 * Configs tested:
 *   1. BASELINE (no new filters)
 *   2. ROC Acceleration only
 *   3. RSI Divergence only (lookback 5)
 *   4. RSI Divergence only (lookback 10)
 *   5. RSI Divergence only (lookback 15)
 *   6. ROC Accel + RSI Divergence (LB=5)
 *   7. ROC Accel + RSI Divergence (LB=10)
 *   8. ROC Accel + RSI Divergence (LB=15)
 *
 * For each: total + LONG-only + SHORT-only metrics.
 * Walk-forward H1/H2 for top 3 configs.
 *
 * Usage: npx tsx scripts/sweep-mqs-filters.ts
 */
import { runBacktestComputation, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;

// ═══════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════════
async function loadData(startDate: Date, endDate: Date) {
  const since = startDate.getTime() - 250 * CANDLE_15M_MS;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endDate.getTime());

  const allData: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) {
      console.warn(`WARNING: No local data for ${sym}, skipping`);
      continue;
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARIZE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
interface SummaryRow {
  label: string;
  trades: number;
  pnl: number;
  wr: number;
  dd: number;
  sharpe: number;
  pf: number;
  longTrades: number;
  longPnl: number;
  longWr: number;
  shortTrades: number;
  shortPnl: number;
  shortWr: number;
}

function summarize(label: string, r: BacktestResult): SummaryRow {
  const s = r.summary;
  const longTrades = r.trades.filter(t => t.side === 'long');
  const shortTrades = r.trades.filter(t => t.side === 'short');
  const longWins = longTrades.filter(t => t.netPnlUsd > 0).length;
  const shortWins = shortTrades.filter(t => t.netPnlUsd > 0).length;
  const longPnl = longTrades.reduce((a, t) => a + t.netPnlUsd, 0);
  const shortPnl = shortTrades.reduce((a, t) => a + t.netPnlUsd, 0);
  const longWr = longTrades.length > 0 ? (longWins / longTrades.length) * 100 : 0;
  const shortWr = shortTrades.length > 0 ? (shortWins / shortTrades.length) * 100 : 0;

  return {
    label,
    trades: s.totalTrades,
    pnl: s.totalPnlUsd,
    wr: s.winRate,
    dd: s.maxDrawdownPct,
    sharpe: s.sharpeRatio ?? 0,
    pf: s.profitFactor,
    longTrades: longTrades.length,
    longPnl,
    longWr,
    shortTrades: shortTrades.length,
    shortPnl,
    shortWr,
  };
}

function printRow(r: SummaryRow) {
  console.log(
    `${r.label.padEnd(36)} ` +
    `${String(r.trades).padStart(4)} ` +
    `${r.wr.toFixed(1).padStart(5)}% ` +
    `$${r.pnl.toFixed(0).padStart(7)} ` +
    `${r.dd.toFixed(1).padStart(5)}% ` +
    `${r.sharpe.toFixed(2).padStart(5)} ` +
    `${r.pf.toFixed(2).padStart(5)} ` +
    `| L:${String(r.longTrades).padStart(3)} ${r.longWr.toFixed(0).padStart(3)}% $${r.longPnl.toFixed(0).padStart(6)} ` +
    `| S:${String(r.shortTrades).padStart(3)} ${r.shortWr.toFixed(0).padStart(3)}% $${r.shortPnl.toFixed(0).padStart(6)}`
  );
}

function printHeader() {
  console.log(
    `${'Config'.padEnd(36)} ` +
    `${'Trd'.padStart(4)} ` +
    `${'WR%'.padStart(6)} ` +
    `${'PnL$'.padStart(8)} ` +
    `${'DD%'.padStart(6)} ` +
    `${'Shp'.padStart(5)} ` +
    `${'PF'.padStart(5)} ` +
    `| ${'LONG'.padStart(20)} ` +
    `| ${'SHORT'.padStart(20)}`
  );
  console.log('-'.repeat(130));
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG SAVE/RESTORE
// ═══════════════════════════════════════════════════════════════════════════
function saveOriginals() {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  return {
    ROC_ACCEL_ENABLED: eq.ROC_ACCEL_ENABLED ?? false,
    RSI_DIVERGENCE_ENABLED: eq.RSI_DIVERGENCE_ENABLED ?? false,
    RSI_DIVERGENCE_LOOKBACK: eq.RSI_DIVERGENCE_LOOKBACK ?? 10,
    RSI_DIVERGENCE_BUFFER: eq.RSI_DIVERGENCE_BUFFER ?? 2,
  };
}

function restoreOriginals(orig: ReturnType<typeof saveOriginals>) {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  eq.ROC_ACCEL_ENABLED = orig.ROC_ACCEL_ENABLED;
  eq.RSI_DIVERGENCE_ENABLED = orig.RSI_DIVERGENCE_ENABLED;
  eq.RSI_DIVERGENCE_LOOKBACK = orig.RSI_DIVERGENCE_LOOKBACK;
  eq.RSI_DIVERGENCE_BUFFER = orig.RSI_DIVERGENCE_BUFFER;
}

function setConfig(rocAccel: boolean, rsiDiv: boolean, rsiLookback: number = 10) {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  eq.ROC_ACCEL_ENABLED = rocAccel;
  eq.RSI_DIVERGENCE_ENABLED = rsiDiv;
  eq.RSI_DIVERGENCE_LOOKBACK = rsiLookback;
  eq.RSI_DIVERGENCE_BUFFER = 2;  // Fixed buffer for all tests
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('V5.144 — MQS Filter Sweep (ROC Acceleration + RSI Divergence)');
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log(`Symbols: ${SYMBOLS.length} (${SYMBOLS.map(s => s.split('/')[0]).join(', ')})`);
  console.log(`Capital: $2,000, Leverage: 5x`);
  console.log(`Period: Jan-Dec 2025 (full year)`);
  console.log(`WARNING: Post-hoc analysis overstates impact (V5.143 lesson). Real BT validation.`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: Full Year Sweep (Jan-Dec 2025)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════════════════');
  console.log('PHASE 1: Full Year Sweep (Jan 2025 - Dec 2025)');
  console.log('═══════════════════════════════════════════════════════════════════════════');

  const fullData = await loadData(
    new Date('2025-01-01T00:00:00.000Z'),
    new Date('2025-12-31T00:00:00.000Z')
  );
  const orig = saveOriginals();

  printHeader();

  const results: SummaryRow[] = [];

  // 1. BASELINE
  restoreOriginals(orig);
  setConfig(false, false);
  const baseResult = await runBacktestComputation(fullData);
  const base = summarize('1. BASELINE (current)', baseResult);
  printRow(base);
  results.push(base);

  // 2. ROC Acceleration only
  restoreOriginals(orig);
  setConfig(true, false);
  const r2 = await runBacktestComputation(fullData);
  const s2 = summarize('2. ROC Accel only', r2);
  printRow(s2);
  results.push(s2);

  // 3. RSI Divergence only (LB=5)
  restoreOriginals(orig);
  setConfig(false, true, 5);
  const r3 = await runBacktestComputation(fullData);
  const s3 = summarize('3. RSI Div (LB=5)', r3);
  printRow(s3);
  results.push(s3);

  // 4. RSI Divergence only (LB=10)
  restoreOriginals(orig);
  setConfig(false, true, 10);
  const r4 = await runBacktestComputation(fullData);
  const s4 = summarize('4. RSI Div (LB=10)', r4);
  printRow(s4);
  results.push(s4);

  // 5. RSI Divergence only (LB=15)
  restoreOriginals(orig);
  setConfig(false, true, 15);
  const r5 = await runBacktestComputation(fullData);
  const s5 = summarize('5. RSI Div (LB=15)', r5);
  printRow(s5);
  results.push(s5);

  // 6. ROC Accel + RSI Div (LB=5)
  restoreOriginals(orig);
  setConfig(true, true, 5);
  const r6 = await runBacktestComputation(fullData);
  const s6 = summarize('6. Accel+RSI Div (LB=5)', r6);
  printRow(s6);
  results.push(s6);

  // 7. ROC Accel + RSI Div (LB=10)
  restoreOriginals(orig);
  setConfig(true, true, 10);
  const r7 = await runBacktestComputation(fullData);
  const s7 = summarize('7. Accel+RSI Div (LB=10)', r7);
  printRow(s7);
  results.push(s7);

  // 8. ROC Accel + RSI Div (LB=15)
  restoreOriginals(orig);
  setConfig(true, true, 15);
  const r8 = await runBacktestComputation(fullData);
  const s8 = summarize('8. Accel+RSI Div (LB=15)', r8);
  printRow(s8);
  results.push(s8);

  // ═══════════════════════════════════════════════════════════════════════════
  // RANKING TABLE
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(130));
  console.log('RANKED BY SHARPE (descending):');
  console.log('-'.repeat(110));
  console.log(
    `${'Config'.padEnd(36)} ` +
    `${'Trd'.padStart(4)} ` +
    `${'WR%'.padStart(6)} ` +
    `${'PnL$'.padStart(8)} ` +
    `${'DD%'.padStart(6)} ` +
    `${'Sharpe'.padStart(6)} ` +
    `${'PF'.padStart(5)} ` +
    `${'vs BL PnL'.padStart(10)} ` +
    `${'vs BL Shp'.padStart(10)}`
  );
  console.log('-'.repeat(110));

  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);
  for (const r of sorted) {
    const deltaPnl = r.pnl - base.pnl;
    const deltaSharpe = r.sharpe - base.sharpe;
    const pnlStr = deltaPnl >= 0 ? `+$${deltaPnl.toFixed(0)}` : `-$${Math.abs(deltaPnl).toFixed(0)}`;
    const shpStr = deltaSharpe >= 0 ? `+${deltaSharpe.toFixed(2)}` : `${deltaSharpe.toFixed(2)}`;
    console.log(
      `${r.label.padEnd(36)} ` +
      `${String(r.trades).padStart(4)} ` +
      `${r.wr.toFixed(1).padStart(5)}% ` +
      `$${r.pnl.toFixed(0).padStart(7)} ` +
      `${r.dd.toFixed(1).padStart(5)}% ` +
      `${r.sharpe.toFixed(2).padStart(6)} ` +
      `${r.pf.toFixed(2).padStart(5)} ` +
      `${pnlStr.padStart(10)} ` +
      `${shpStr.padStart(10)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Walk-Forward H1/H2 for Top 3
  // ═══════════════════════════════════════════════════════════════════════════
  const top3 = sorted.slice(0, 3);
  console.log('\n' + '═'.repeat(130));
  console.log('PHASE 2: Walk-Forward H1/H2 for Top 3 Configs');
  console.log('  H1 = Jan-Jun 2025 (in-sample), H2 = Jul-Dec 2025 (out-of-sample)');
  console.log('═'.repeat(130));

  const h1Data = await loadData(
    new Date('2025-01-01T00:00:00.000Z'),
    new Date('2025-06-30T00:00:00.000Z')
  );
  const h2Data = await loadData(
    new Date('2025-07-01T00:00:00.000Z'),
    new Date('2025-12-31T00:00:00.000Z')
  );

  // Baseline H1/H2 for reference
  restoreOriginals(orig);
  setConfig(false, false);
  const baseH1 = summarize('BASELINE H1', await runBacktestComputation(h1Data));
  const baseH2 = summarize('BASELINE H2', await runBacktestComputation(h2Data));

  console.log('\nBASELINE reference:');
  printHeader();
  printRow(baseH1);
  printRow(baseH2);

  for (const topCfg of top3) {
    // Parse config from label
    const isAccel = topCfg.label.includes('Accel');
    const isRsiDiv = topCfg.label.includes('RSI Div') || topCfg.label.includes('RSI Div');
    let lookback = 10;
    const lbMatch = topCfg.label.match(/LB=(\d+)/);
    if (lbMatch) lookback = parseInt(lbMatch[1]);

    console.log(`\n${topCfg.label}:`);
    printHeader();

    restoreOriginals(orig);
    setConfig(isAccel, isRsiDiv, lookback);
    const cfgH1 = summarize(`${topCfg.label} H1`, await runBacktestComputation(h1Data));
    const cfgH2 = summarize(`${topCfg.label} H2`, await runBacktestComputation(h2Data));
    printRow(cfgH1);
    printRow(cfgH2);

    // H2 vs baseline H2 delta
    const h2DeltaPnl = cfgH2.pnl - baseH2.pnl;
    const h2DeltaSharpe = cfgH2.sharpe - baseH2.sharpe;
    console.log(
      `  H2 vs BASELINE: PnL ${h2DeltaPnl >= 0 ? '+' : ''}$${h2DeltaPnl.toFixed(0)}, ` +
      `Sharpe ${h2DeltaSharpe >= 0 ? '+' : ''}${h2DeltaSharpe.toFixed(2)}, ` +
      `WR ${(cfgH2.wr - baseH2.wr).toFixed(1)}pp, ` +
      `DD ${(cfgH2.dd - baseH2.dd).toFixed(1)}pp`
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  restoreOriginals(orig);  // Restore config

  console.log('\n' + '═'.repeat(130));
  console.log('DECISION CRITERIA:');
  console.log('  - Full year Sharpe > baseline + 0.1');
  console.log('  - H2 (OOS) Sharpe >= baseline (no degradation)');
  console.log('  - DD <= baseline + 5pp');
  console.log('  - Post-hoc claimed: ROC Accel d=0.698, RSI Div d=0.312');
  console.log('  - Real BT validates or REJECTS the post-hoc claims');
  console.log('═'.repeat(130));

  const winner = sorted[0];
  const winnerVsBase = winner.sharpe - base.sharpe;
  if (winnerVsBase > 0.1) {
    console.log(`\nPOTENTIAL WINNER: ${winner.label}`);
    console.log(`  Sharpe: ${base.sharpe.toFixed(2)} → ${winner.sharpe.toFixed(2)} (+${winnerVsBase.toFixed(2)})`);
    console.log(`  PnL: $${base.pnl.toFixed(0)} → $${winner.pnl.toFixed(0)}`);
    console.log(`  DD: ${base.dd.toFixed(1)}% → ${winner.dd.toFixed(1)}%`);
    console.log(`  → REQUIRES H2 validation before enabling in production`);
  } else {
    console.log(`\nNO SIGNIFICANT IMPROVEMENT FOUND.`);
    console.log(`  Best: ${winner.label} (Sharpe +${winnerVsBase.toFixed(2)} vs baseline)`);
    console.log(`  Post-hoc analysis OVERSTATED impact (as expected from V5.143 lesson).`);
    console.log(`  → Keep filters DISABLED (ROC_ACCEL_ENABLED: false, RSI_DIVERGENCE_ENABLED: false)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
