#!/usr/bin/env npx tsx
/**
 * V5.117b: Test 1m trailing replay parity
 *
 * Runs backtest with and without postProcess1m for a short date range,
 * then compares results to verify the 1m replay doesn't destroy PnL/DD.
 *
 * Expected: with 1m replay, PnL should be equal or slightly BETTER (exhaustion
 * STOP_MARKET fills at trailing price vs 15m close). DD should NOT increase
 * significantly. If DD increases massively, there's a parity issue.
 */

import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';
import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';

const SYMBOLS = [
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
  'DOT/USDT:USDT',
  'TIA/USDT:USDT',
  'IMX/USDT:USDT',
  'STX/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
  'BTC/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-06-30T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 4.5,
};

function printSummary(label: string, r: BacktestResult) {
  const s = r.summary;
  console.log(`\n=== ${label} ===`);
  console.log(`  Trades:      ${s.totalTrades} (W:${s.wins} L:${s.losses})`);
  console.log(`  Win Rate:    ${s.winRate.toFixed(1)}%`);
  console.log(`  Total PnL:   $${s.totalPnlUsd.toFixed(2)} (${s.totalPnlPct.toFixed(1)}%)`);
  console.log(`  Max DD:      ${s.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Final Cap:   $${s.finalCapital.toFixed(2)}`);
  console.log(`  Sharpe:      ${s.sharpeRatio.toFixed(2)}`);
  console.log(`  Avg Trade:   $${s.avgTradeUsd.toFixed(2)}`);
  console.log(`  Profit Fac:  ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`);
  console.log(`  Fees:        $${s.totalFeesUsd.toFixed(2)}`);
}

async function main() {
  let ok = await preloadMarkets();
  if (!ok) {
    console.warn('REST unavailable, using minimal markets fallback...');
    ok = initializeMinimalMarkets();
    if (!ok) {
      console.error('Failed to initialize markets. Cannot proceed.');
      process.exit(1);
    }
  }

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  V5.117b: 1m Trailing Replay Validation Test           ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`Period: ${PARAMS.startDate.toISOString().slice(0, 10)} → ${PARAMS.endDate.toISOString().slice(0, 10)}`);
  console.log(`Symbols: ${PARAMS.symbols.length}`);
  console.log(`Capital: $${PARAMS.initialCapital} @ ${PARAMS.leverage}x leverage\n`);

  // Pass 1: 15m only
  console.log('━━━ PASS 1: 15m baseline (no 1m replay) ━━━');
  const t1 = Date.now();
  const baseline = await runBacktest({ ...PARAMS, postProcess1m: false });
  const t1End = Date.now();
  printSummary('15m BASELINE', baseline);
  console.log(`  Time: ${((t1End - t1) / 1000).toFixed(1)}s`);

  // Count trailing trades that would be replayed
  const trailingTrades = baseline.trades.filter(t =>
    t.exitReason.startsWith('TRAIL') &&
    t.exitReason !== 'TRAIL_RT' &&
    t.exitReason !== 'TRAIL_EXCHANGE' &&
    t.exitReason !== 'TRAIL_PROACTIVE' &&
    t.exitReason !== 'TRAIL_NFS_HIGH'
  );
  console.log(`\n  Trailing trades eligible for 1m replay: ${trailingTrades.length}`);

  // Break down by exit reason
  const reasonCounts: Record<string, number> = {};
  for (const t of trailingTrades) {
    reasonCounts[t.exitReason] = (reasonCounts[t.exitReason] || 0) + 1;
  }
  for (const [reason, count] of Object.entries(reasonCounts).sort()) {
    console.log(`    ${reason}: ${count}`);
  }

  // Pass 2: with 1m replay
  console.log('\n━━━ PASS 2: 15m + 1m replay (V5.117b) ━━━');
  const t2 = Date.now();
  const replay = await runBacktest({ ...PARAMS, postProcess1m: true });
  const t2End = Date.now();
  printSummary('15m + 1m REPLAY', replay);
  console.log(`  Time: ${((t2End - t2) / 1000).toFixed(1)}s`);

  // Comparison
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  COMPARISON                                             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');

  const pnlDelta = replay.summary.totalPnlUsd - baseline.summary.totalPnlUsd;
  const ddDelta = replay.summary.maxDrawdownPct - baseline.summary.maxDrawdownPct;
  const wrDelta = replay.summary.winRate - baseline.summary.winRate;

  console.log(`  PnL delta:    $${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(2)} (${pnlDelta >= 0 ? '+' : ''}${((pnlDelta / Math.abs(baseline.summary.totalPnlUsd || 1)) * 100).toFixed(1)}%)`);
  console.log(`  DD delta:     ${ddDelta >= 0 ? '+' : ''}${ddDelta.toFixed(1)}pp (${baseline.summary.maxDrawdownPct.toFixed(1)}% → ${replay.summary.maxDrawdownPct.toFixed(1)}%)`);
  console.log(`  WinRate delta: ${wrDelta >= 0 ? '+' : ''}${wrDelta.toFixed(1)}pp`);
  console.log(`  Sharpe delta: ${(replay.summary.sharpeRatio - baseline.summary.sharpeRatio) >= 0 ? '+' : ''}${(replay.summary.sharpeRatio - baseline.summary.sharpeRatio).toFixed(2)}`);

  // Validate
  console.log('\n━━━ VALIDATION ━━━');
  let pass = true;

  if (replay.summary.maxDrawdownPct > baseline.summary.maxDrawdownPct * 1.5) {
    console.log('  [FAIL] DD increased by more than 50% relative to baseline');
    console.log(`         Baseline DD: ${baseline.summary.maxDrawdownPct.toFixed(1)}%, Replay DD: ${replay.summary.maxDrawdownPct.toFixed(1)}%`);
    pass = false;
  } else {
    console.log(`  [PASS] DD within acceptable range (${replay.summary.maxDrawdownPct.toFixed(1)}% vs ${baseline.summary.maxDrawdownPct.toFixed(1)}% baseline)`);
  }

  if (replay.summary.maxDrawdownPct > 60) {
    console.log(`  [FAIL] DD exceeds 60% absolute threshold (${replay.summary.maxDrawdownPct.toFixed(1)}%)`);
    pass = false;
  } else {
    console.log(`  [PASS] DD below 60% absolute threshold (${replay.summary.maxDrawdownPct.toFixed(1)}%)`);
  }

  if (replay.summary.totalPnlUsd < baseline.summary.totalPnlUsd * 0.5 && baseline.summary.totalPnlUsd > 0) {
    console.log(`  [FAIL] PnL dropped by more than 50% (baseline: $${baseline.summary.totalPnlUsd.toFixed(2)}, replay: $${replay.summary.totalPnlUsd.toFixed(2)})`);
    pass = false;
  } else {
    console.log(`  [PASS] PnL within acceptable range`);
  }

  // Per-trade delta analysis
  console.log('\n━━━ PER-TRADE DELTA (replayed trades) ━━━');
  const baselineMap = new Map(baseline.trades.map(t => [t.id, t]));
  let improvedCount = 0;
  let worsenedCount = 0;
  let unchangedCount = 0;
  let totalImprovement = 0;
  let totalWorsening = 0;

  for (const rt of replay.trades) {
    const bt = baselineMap.get(rt.id);
    if (!bt) continue;
    const delta = rt.netPnlUsd - bt.netPnlUsd;
    if (Math.abs(delta) < 0.01) {
      unchangedCount++;
    } else if (delta > 0) {
      improvedCount++;
      totalImprovement += delta;
    } else {
      worsenedCount++;
      totalWorsening += delta;
    }
  }

  console.log(`  Improved:  ${improvedCount} trades (+$${totalImprovement.toFixed(2)})`);
  console.log(`  Worsened:  ${worsenedCount} trades ($${totalWorsening.toFixed(2)})`);
  console.log(`  Unchanged: ${unchangedCount} trades`);
  console.log(`  Net delta: $${(totalImprovement + totalWorsening).toFixed(2)}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(pass ? '  RESULT: PASS - V5.117b replay is safe' : '  RESULT: FAIL - V5.117b replay needs investigation');
  console.log('='.repeat(60));

  process.exit(pass ? 0 : 1);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
