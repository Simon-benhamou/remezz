/**
 * Test MAX_CONSEC_DOWN filter effectiveness
 *
 * Tests whether the consecutive-down-candle filter in bear regime SHORT entries
 * actually improves quality or just blocks good trades.
 *
 * Phase 1: Test 7 variants on Jan-Jun 2025 (10 symbols)
 * Phase 2: Validate best variant on full year 2025
 *
 * Current production: MAX_CONSEC_DOWN = 4
 * The filter blocks SHORT entries when consecDown > MAX_CONSEC_DOWN
 *
 * Usage:
 *   npx tsx scripts/test-consec-down-filter.ts
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

// ============================================================================
// CONFIG
// ============================================================================

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 4.5;

// Phase 1: Sample period (6 months)
const SAMPLE_START = new Date('2025-01-01T00:00:00.000Z');
const SAMPLE_END = new Date('2025-06-30T23:59:59.000Z');

// Phase 2: Full year validation
const FULL_START = new Date('2025-01-01T00:00:00.000Z');
const FULL_END = new Date('2025-12-31T23:59:59.000Z');

// 10 symbols from the user's watchlist
const SYMBOLS = [
  'DOGE/USDT:USDT',
  'DOT/USDT:USDT',
  'WIF/USDT:USDT',
  'IMX/USDT:USDT',
  'FET/USDT:USDT',
  'AVAX/USDT:USDT',
  'ADA/USDT:USDT',
  'TIA/USDT:USDT',
  'STX/USDT:USDT',
  'BTC/USDT:USDT',
];

// Values to test for MAX_CONSEC_DOWN
// 999 = effectively disabled (never blocks)
const CONSEC_DOWN_VALUES = [2, 3, 4, 5, 6, 8, 999];

// ============================================================================
// TYPES
// ============================================================================

interface RunResult {
  label: string;
  maxConsecDown: number;
  trades: number;
  shortTrades: number;
  wins: number;
  winRate: number;
  netPnl: number;
  netPnlPct: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  fees: number;
  avgHoldMin: number;
  runtimeSec: number;
}

// ============================================================================
// HELPERS
// ============================================================================

function padR(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}

function printTable(title: string, results: RunResult[]): void {
  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);

  console.log(`\n${'═'.repeat(155)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(155));
  console.log(
    padR('Rank', 5) +
    padR('Label', 28) +
    padR('MaxCD', 6) +
    padR('Trades', 7) +
    padR('Shorts', 7) +
    padR('WinRate', 8) +
    padR('NetPnL', 12) +
    padR('PnL%', 9) +
    padR('MaxDD%', 8) +
    padR('Sharpe', 8) +
    padR('PF', 7) +
    padR('Fees', 10) +
    padR('AvgHold', 8) +
    padR('Time', 6)
  );
  console.log('─'.repeat(155));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const rank = i === 0 ? '★ 1' : `  ${i + 1}`;
    const current = r.maxConsecDown === 4 ? ' ◄' : '';
    console.log(
      padR(rank, 5) +
      padR(r.label + current, 28) +
      padR(String(r.maxConsecDown), 6) +
      padR(String(r.trades), 7) +
      padR(String(r.shortTrades), 7) +
      padR(r.winRate.toFixed(1) + '%', 8) +
      padR('$' + r.netPnl.toFixed(0), 12) +
      padR(r.netPnlPct.toFixed(1) + '%', 9) +
      padR(r.maxDD.toFixed(1) + '%', 8) +
      padR(r.sharpe.toFixed(2), 8) +
      padR(r.profitFactor.toFixed(2), 7) +
      padR('$' + r.fees.toFixed(0), 10) +
      padR(r.avgHoldMin.toFixed(0) + 'm', 8) +
      padR(r.runtimeSec.toFixed(0) + 's', 6)
    );
  }
  console.log('═'.repeat(155));

  if (sorted.length > 0) {
    const best = sorted[0];
    const baseline = sorted.find(r => r.maxConsecDown === 4);
    console.log(`\n★ Best: "${best.label}" → Sharpe ${best.sharpe.toFixed(2)}, PnL $${best.netPnl.toFixed(0)} (${best.netPnlPct.toFixed(1)}%), WR ${best.winRate.toFixed(1)}%, DD ${best.maxDD.toFixed(1)}%`);
    if (baseline && best.maxConsecDown !== 4) {
      const pnlDiff = best.netPnl - baseline.netPnl;
      const wrDiff = best.winRate - baseline.winRate;
      const sharpeDiff = best.sharpe - baseline.sharpe;
      console.log(`  vs BASELINE (CD=4): PnL ${pnlDiff >= 0 ? '+' : ''}$${pnlDiff.toFixed(0)}, WR ${wrDiff >= 0 ? '+' : ''}${wrDiff.toFixed(1)}%, Sharpe ${sharpeDiff >= 0 ? '+' : ''}${sharpeDiff.toFixed(2)}`);
    }
  }
}

async function runOneTest(
  maxConsecDown: number,
  startDate: Date,
  endDate: Date,
): Promise<RunResult> {
  const label = maxConsecDown === 999 ? 'DISABLED (no limit)' : `MAX_CONSEC_DOWN=${maxConsecDown}`;

  // Save original value
  const originalValue = MomentumConfig.ENTRY_SHORT.MAX_CONSEC_DOWN;

  try {
    // Mutate config
    (MomentumConfig.ENTRY_SHORT as any).MAX_CONSEC_DOWN = maxConsecDown;

    const t0 = Date.now();
    const result: BacktestResult = await runBacktest({
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols: [...SYMBOLS],
      leverage: LEVERAGE,
    });
    const runtimeSec = (Date.now() - t0) / 1000;

    const s = result.summary;

    const shortTrades = s.shortTrades;

    return {
      label,
      maxConsecDown,
      trades: s.totalTrades,
      shortTrades,
      wins: s.wins,
      winRate: s.winRate,
      netPnl: s.totalPnlUsd,
      netPnlPct: s.totalPnlPct,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
      fees: s.totalFeesUsd,
      avgHoldMin: s.avgHoldMinutes,
      runtimeSec,
    };
  } finally {
    // Always restore
    (MomentumConfig.ENTRY_SHORT as any).MAX_CONSEC_DOWN = originalValue;
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  MAX_CONSEC_DOWN Filter Test — Is it helping or hurting?        ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Current production value: MAX_CONSEC_DOWN = ${MomentumConfig.ENTRY_SHORT.MAX_CONSEC_DOWN}              ║`);
  console.log(`║  Symbols: ${SYMBOLS.length} (${SYMBOLS.map(s => s.split('/')[0]).join(', ')})`);
  console.log(`║  Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x                       ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');

  // Preload markets once
  console.log('\n⏳ Loading exchange markets...');
  await preloadMarkets();
  console.log('✅ Markets loaded\n');

  // ========================================================================
  // PHASE 1: Sample period (Jan-Jun 2025)
  // ========================================================================
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  PHASE 1: Sample Test — Jan-Jun 2025');
  console.log('═══════════════════════════════════════════════════════════════════');

  const phase1Results: RunResult[] = [];

  for (const value of CONSEC_DOWN_VALUES) {
    const label = value === 999 ? 'DISABLED' : `CD=${value}`;
    console.log(`\n🔬 Testing ${label}...`);
    const result = await runOneTest(value, SAMPLE_START, SAMPLE_END);
    phase1Results.push(result);
    console.log(`   → ${result.trades} trades (${result.shortTrades} shorts), WR ${result.winRate.toFixed(1)}%, PnL $${result.netPnl.toFixed(0)}, Sharpe ${result.sharpe.toFixed(2)}`);
  }

  printTable('PHASE 1 RESULTS — Jan-Jun 2025 (sorted by Sharpe)', phase1Results);

  // ========================================================================
  // PHASE 2: Validate top 3 on full year 2025
  // ========================================================================
  console.log('\n\n═══════════════════════════════════════════════════════════════════');
  console.log('  PHASE 2: Full Year Validation — Jan-Dec 2025');
  console.log('═══════════════════════════════════════════════════════════════════');

  // Get top 3 by Sharpe + always include baseline (CD=4)
  const sortedPhase1 = [...phase1Results].sort((a, b) => b.sharpe - a.sharpe);
  const top3Values = new Set(sortedPhase1.slice(0, 3).map(r => r.maxConsecDown));
  top3Values.add(4); // Always include current baseline

  const phase2Results: RunResult[] = [];

  for (const value of top3Values) {
    const label = value === 999 ? 'DISABLED' : `CD=${value}`;
    console.log(`\n🔬 Validating ${label} on full year...`);
    const result = await runOneTest(value, FULL_START, FULL_END);
    phase2Results.push(result);
    console.log(`   → ${result.trades} trades (${result.shortTrades} shorts), WR ${result.winRate.toFixed(1)}%, PnL $${result.netPnl.toFixed(0)}, Sharpe ${result.sharpe.toFixed(2)}`);
  }

  printTable('PHASE 2 RESULTS — Full Year 2025 (sorted by Sharpe)', phase2Results);

  // ========================================================================
  // CONCLUSION
  // ========================================================================
  const bestPhase2 = [...phase2Results].sort((a, b) => b.sharpe - a.sharpe)[0];
  const baselinePhase2 = phase2Results.find(r => r.maxConsecDown === 4);

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  CONCLUSION                                                      ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');

  if (bestPhase2 && baselinePhase2) {
    if (bestPhase2.maxConsecDown === 4) {
      console.log('║  ✅ Current value (CD=4) is already optimal                     ║');
      console.log('║  → No changes recommended                                       ║');
    } else {
      const newVal = bestPhase2.maxConsecDown === 999 ? 'DISABLED' : String(bestPhase2.maxConsecDown);
      console.log(`║  🔄 Recommend: MAX_CONSEC_DOWN = ${padR(newVal, 10)}                    ║`);
      console.log(`║  Sharpe: ${baselinePhase2.sharpe.toFixed(2)} → ${bestPhase2.sharpe.toFixed(2)}  |  WR: ${baselinePhase2.winRate.toFixed(1)}% → ${bestPhase2.winRate.toFixed(1)}%  |  PnL: $${baselinePhase2.netPnl.toFixed(0)} → $${bestPhase2.netPnl.toFixed(0)}`);
    }
  }

  console.log('╚══════════════════════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
