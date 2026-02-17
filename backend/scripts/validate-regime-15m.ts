/**
 * Validate 15m Regime: Out-of-sample symbols + walk-forward split
 * ================================================================
 * Test 1: Different symbols (ADA, DOT, STX, TIA) — not used in discovery
 * Test 2: Walk-forward — first half (Jan-Jul 2025) vs second half (Aug 2025-Feb 2026)
 *
 * Both tests compare 15m SMA200 vs 1h SMA200 (baseline)
 * If 15m wins in BOTH, the finding is robust.
 *
 * Usage: npx tsx scripts/validate-regime-15m.ts
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

// OUT-OF-SAMPLE symbols (NOT used in the discovery test)
const OOS_SYMBOLS = [
  'ADA/USDT:USDT',
  'DOT/USDT:USDT',
  'STX/USDT:USDT',
  'TIA/USDT:USDT',
];

// Original symbols (for walk-forward)
const ORIG_SYMBOLS = [
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
];

// ALL symbols combined
const ALL_SYMBOLS = [...ORIG_SYMBOLS, ...OOS_SYMBOLS];

function printCompact(label: string, r: BacktestResult) {
  const s = r.summary;
  const longT = r.trades.filter(t => t.side === 'long');
  const shortT = r.trades.filter(t => t.side === 'short');
  const longWR = longT.length > 0 ? (longT.filter(t => t.netPnlPct > 0).length / longT.length * 100) : 0;
  const shortWR = shortT.length > 0 ? (shortT.filter(t => t.netPnlPct > 0).length / shortT.length * 100) : 0;
  const longPnl = longT.reduce((a, t) => a + t.netPnlUsd, 0);
  const shortPnl = shortT.reduce((a, t) => a + t.netPnlUsd, 0);
  console.log(`  ${label}`);
  console.log(`    ${s.totalTrades} trades (L:${longT.length} S:${shortT.length}) | WR ${s.winRate.toFixed(1)}% (L:${longWR.toFixed(1)}% S:${shortWR.toFixed(1)}%) | ROI ${s.totalPnlPct.toFixed(0)}% | Sharpe ${s.sharpeRatio.toFixed(2)} | PF ${s.profitFactor.toFixed(2)} | DD ${s.maxDrawdownPct.toFixed(1)}%`);
  console.log(`    PnL: L $${longPnl.toFixed(0)} | S $${shortPnl.toFixed(0)} | Total $${(s.finalCapital - 2000).toFixed(0)}`);
}

async function runConfig(label: string, symbols: string[], start: Date, end: Date, regimeTfMin: number, smaPeriod: number, mtfLookback: number): Promise<BacktestResult> {
  // Override config
  const origSma = MomentumConfig.ENTRY.BTC_SMA_PERIOD;
  const origMtf = MomentumConfig.MULTI_TIMEFRAME_FILTER.LOOKBACK_CANDLES;
  (MomentumConfig.ENTRY as any).BTC_SMA_PERIOD = smaPeriod;
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = mtfLookback;

  const t0 = Date.now();
  const result = await runBacktest({
    startDate: start,
    endDate: end,
    initialCapital: 2000,
    symbols,
    leverage: 4.5,
    regimeTimeframeMinutes: regimeTfMin,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

  // Restore
  (MomentumConfig.ENTRY as any).BTC_SMA_PERIOD = origSma;
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = origMtf;

  console.log(`  [${elapsed}s] ${label}: ${result.summary.totalTrades} trades, ${result.summary.winRate.toFixed(1)}% WR, ROI ${result.summary.totalPnlPct.toFixed(0)}%`);
  return result;
}

function printComparison(label: string, baseline: BacktestResult, test: BacktestResult) {
  const bS = baseline.summary;
  const tS = test.summary;
  console.log(`\n  ${label}:`);
  console.log(`                       1h SMA200        15m SMA200       Delta`);
  console.log(`    Trades:        ${bS.totalTrades.toString().padStart(10)}    ${tS.totalTrades.toString().padStart(10)}    ${(tS.totalTrades - bS.totalTrades).toString().padStart(+10)}`);
  console.log(`    Win Rate:      ${bS.winRate.toFixed(1).padStart(9)}%    ${tS.winRate.toFixed(1).padStart(9)}%    ${(tS.winRate - bS.winRate >= 0 ? '+' : '') + (tS.winRate - bS.winRate).toFixed(1)}pp`);
  console.log(`    ROI:           ${bS.totalPnlPct.toFixed(0).padStart(9)}%    ${tS.totalPnlPct.toFixed(0).padStart(9)}%    ${(tS.totalPnlPct - bS.totalPnlPct >= 0 ? '+' : '') + (tS.totalPnlPct - bS.totalPnlPct).toFixed(0)}%`);
  console.log(`    Sharpe:        ${bS.sharpeRatio.toFixed(2).padStart(10)}    ${tS.sharpeRatio.toFixed(2).padStart(10)}    ${(tS.sharpeRatio - bS.sharpeRatio >= 0 ? '+' : '') + (tS.sharpeRatio - bS.sharpeRatio).toFixed(2)}`);
  console.log(`    Profit Factor: ${bS.profitFactor.toFixed(2).padStart(10)}    ${tS.profitFactor.toFixed(2).padStart(10)}    ${(tS.profitFactor - bS.profitFactor >= 0 ? '+' : '') + (tS.profitFactor - bS.profitFactor).toFixed(2)}`);
  console.log(`    Max DD:        ${bS.maxDrawdownPct.toFixed(1).padStart(9)}%    ${tS.maxDrawdownPct.toFixed(1).padStart(9)}%    ${(tS.maxDrawdownPct - bS.maxDrawdownPct >= 0 ? '+' : '') + (tS.maxDrawdownPct - bS.maxDrawdownPct).toFixed(1)}%`);
  const verdict = tS.totalPnlPct > bS.totalPnlPct && tS.sharpeRatio > bS.sharpeRatio;
  console.log(`    Verdict: ${verdict ? 'PASS — 15m wins on ROI + Sharpe' : 'FAIL — 15m does NOT beat baseline'}`);
  return verdict;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║      VALIDATION: 15m SMA200 Regime (Out-of-Sample + Walk-Forward)  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  // Preload markets
  console.log('\nPreloading markets...');
  let ok = false;
  try { ok = await preloadMarkets(); } catch { ok = false; }
  if (!ok) {
    console.log('  API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('  Markets ready.\n');

  let passCount = 0;
  let totalTests = 0;

  // ═══════════════════════════════════════════════════════════════════
  // TEST 1: Out-of-sample symbols (ADA, DOT, STX, TIA)
  // ═══════════════════════════════════════════════════════════════════
  console.log('═'.repeat(70));
  console.log('TEST 1: OUT-OF-SAMPLE SYMBOLS (ADA, DOT, STX, TIA)');
  console.log('  Period: Jan 2025 - Feb 2026 | Never used in discovery');
  console.log('═'.repeat(70));

  const oos1h = await runConfig('OOS 1h baseline', OOS_SYMBOLS,
    new Date('2025-01-01'), new Date('2026-02-09'), 60, 200, 10);
  const oos15m = await runConfig('OOS 15m test', OOS_SYMBOLS,
    new Date('2025-01-01'), new Date('2026-02-09'), 15, 200, 40);

  totalTests++;
  if (printComparison('Out-of-Sample Symbols', oos1h, oos15m)) passCount++;

  // ═══════════════════════════════════════════════════════════════════
  // TEST 2: Walk-forward — First half
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 2: WALK-FORWARD — FIRST HALF (Jan-Jul 2025)');
  console.log('  Original symbols | Tests temporal stability');
  console.log('═'.repeat(70));

  const wf1_1h = await runConfig('WF-H1 1h baseline', ORIG_SYMBOLS,
    new Date('2025-01-01'), new Date('2025-07-31'), 60, 200, 10);
  const wf1_15m = await runConfig('WF-H1 15m test', ORIG_SYMBOLS,
    new Date('2025-01-01'), new Date('2025-07-31'), 15, 200, 40);

  totalTests++;
  if (printComparison('Walk-Forward First Half (Jan-Jul 2025)', wf1_1h, wf1_15m)) passCount++;

  // ═══════════════════════════════════════════════════════════════════
  // TEST 3: Walk-forward — Second half
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 3: WALK-FORWARD — SECOND HALF (Aug 2025-Feb 2026)');
  console.log('  Original symbols | Tests temporal stability');
  console.log('═'.repeat(70));

  const wf2_1h = await runConfig('WF-H2 1h baseline', ORIG_SYMBOLS,
    new Date('2025-08-01'), new Date('2026-02-09'), 60, 200, 10);
  const wf2_15m = await runConfig('WF-H2 15m test', ORIG_SYMBOLS,
    new Date('2025-08-01'), new Date('2026-02-09'), 15, 200, 40);

  totalTests++;
  if (printComparison('Walk-Forward Second Half (Aug 2025-Feb 2026)', wf2_1h, wf2_15m)) passCount++;

  // ═══════════════════════════════════════════════════════════════════
  // TEST 4: ALL symbols combined (maximum sample size)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(70));
  console.log('TEST 4: ALL 9 SYMBOLS COMBINED (Maximum sample)');
  console.log('  DOGE, IMX, AVAX, FET, WIF, ADA, DOT, STX, TIA');
  console.log('═'.repeat(70));

  const all1h = await runConfig('ALL 1h baseline', ALL_SYMBOLS,
    new Date('2025-01-01'), new Date('2026-02-09'), 60, 200, 10);
  const all15m = await runConfig('ALL 15m test', ALL_SYMBOLS,
    new Date('2025-01-01'), new Date('2026-02-09'), 15, 200, 40);

  totalTests++;
  if (printComparison('All 9 Symbols Combined', all1h, all15m)) passCount++;

  // ═══════════════════════════════════════════════════════════════════
  // FINAL VERDICT
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('FINAL VERDICT');
  console.log('═'.repeat(70));
  console.log(`  Tests passed: ${passCount}/${totalTests}`);

  if (passCount === totalTests) {
    console.log('  VALIDATED: 15m SMA200 regime consistently beats 1h SMA200');
    console.log('  Safe to deploy to production.');
  } else if (passCount >= totalTests / 2) {
    console.log('  PARTIALLY VALIDATED: 15m wins in most but not all scenarios');
    console.log('  Consider deploying with monitoring.');
  } else {
    console.log('  NOT VALIDATED: 15m does not consistently outperform 1h');
    console.log('  Keep current 1h SMA200 config.');
  }

  // Detailed results for each test
  console.log('\n  Detailed results:');
  printCompact('OOS Symbols — 1h', oos1h);
  printCompact('OOS Symbols — 15m', oos15m);
  printCompact('WF H1 — 1h', wf1_1h);
  printCompact('WF H1 — 15m', wf1_15m);
  printCompact('WF H2 — 1h', wf2_1h);
  printCompact('WF H2 — 15m', wf2_15m);
  printCompact('ALL — 1h', all1h);
  printCompact('ALL — 15m', all15m);
}

main().catch(console.error);
