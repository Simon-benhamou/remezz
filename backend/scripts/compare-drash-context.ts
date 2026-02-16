/**
 * V5.99 Drash Context Scoring: 8-Combination Comparison
 * ======================================================
 * Tests all 2^3 = 8 combinations of the 3 context factors:
 *   - SR Proximity
 *   - Breakout Quality
 *   - Market Correlation
 *
 * Runs each combination on:
 *   - Train period: Jun 2024 - Jun 2025 (12 months, in-sample)
 *   - Test period:  Jul 2025 - Dec 2025 (6 months, out-of-sample)
 *
 * Reports: trades, WR, ROI, Sharpe, PF, max DD, avg PnL/trade
 * Shows delta vs baseline (combo 0: all factors OFF)
 * Identifies best combo based on OOS composite score
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SYMBOLS = [
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'SEI/USDT:USDT',
  'SUI/USDT:USDT',
  'XRP/USDT:USDT',
];

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 4.5;

const PERIODS = [
  {
    label: 'Train (Jun 2024 - Jun 2025)',
    startDate: new Date('2024-06-01T00:00:00Z'),
    endDate: new Date('2025-06-30T23:59:59Z'),
  },
  {
    label: 'Test (Jul 2025 - Dec 2025)',
    startDate: new Date('2025-07-01T00:00:00Z'),
    endDate: new Date('2025-12-31T23:59:59Z'),
  },
];

interface RunConfig {
  label: string;
  sr: boolean;
  breakout: boolean;
  correlation: boolean;
}

const CONFIGS: RunConfig[] = [
  { label: 'Baseline (no context)',    sr: false, breakout: false, correlation: false },
  { label: 'SR only',                  sr: true,  breakout: false, correlation: false },
  { label: 'Breakout only',            sr: false, breakout: true,  correlation: false },
  { label: 'Correlation only',         sr: false, breakout: false, correlation: true  },
  { label: 'SR + Breakout',            sr: true,  breakout: true,  correlation: false },
  { label: 'SR + Correlation',         sr: true,  breakout: false, correlation: true  },
  { label: 'Breakout + Correlation',   sr: false, breakout: true,  correlation: true  },
  { label: 'ALL 3 factors',            sr: true,  breakout: true,  correlation: true  },
];

// ============================================================================
// TYPES
// ============================================================================

interface ComboResult {
  config: RunConfig;
  train: BacktestResult;
  test: BacktestResult;
}

interface MetricRow {
  label: string;
  trades: number;
  winRate: number;
  roi: number;
  sharpe: number;
  profitFactor: number;
  maxDD: number;
  avgPnlPerTrade: number;
}

// ============================================================================
// HELPERS
// ============================================================================

/** Save original DRASH_CONTEXT config values */
function saveOriginalConfig() {
  return {
    enabled: MomentumConfig.DRASH_CONTEXT.ENABLED,
    srEnabled: MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED,
    breakoutEnabled: MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED,
    correlationEnabled: MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED,
  };
}

/** Restore original DRASH_CONTEXT config values */
function restoreConfig(orig: ReturnType<typeof saveOriginalConfig>) {
  MomentumConfig.DRASH_CONTEXT.ENABLED = orig.enabled;
  MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = orig.srEnabled;
  MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = orig.breakoutEnabled;
  MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = orig.correlationEnabled;
}

/** Apply a RunConfig to MomentumConfig */
function applyConfig(cfg: RunConfig) {
  // If all factors are off, disable the whole system
  const anyEnabled = cfg.sr || cfg.breakout || cfg.correlation;
  MomentumConfig.DRASH_CONTEXT.ENABLED = anyEnabled;
  MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = cfg.sr;
  MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = cfg.breakout;
  MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = cfg.correlation;
}

/** Extract metric row from a BacktestResult */
function extractMetrics(label: string, r: BacktestResult): MetricRow {
  const s = r.summary;
  const avgPnlPerTrade = s.totalTrades > 0 ? s.totalPnlPct / s.totalTrades : 0;
  return {
    label,
    trades: s.totalTrades,
    winRate: s.winRate,
    roi: s.totalPnlPct,
    sharpe: s.sharpeRatio,
    profitFactor: s.profitFactor,
    maxDD: s.maxDrawdownPct,
    avgPnlPerTrade,
  };
}

/** Format number with sign */
function fmtDelta(val: number, decimals: number = 2): string {
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(decimals)}`;
}

/** Print a metrics table */
function printMetricsTable(title: string, rows: MetricRow[]) {
  console.log(`\n${'='.repeat(120)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(120)}`);

  // Header
  const hdr = [
    'Config'.padEnd(28),
    'Trades'.padStart(7),
    'WR%'.padStart(7),
    'ROI%'.padStart(10),
    'Sharpe'.padStart(8),
    'PF'.padStart(7),
    'MaxDD%'.padStart(8),
    'AvgPnL%'.padStart(9),
  ].join(' | ');
  console.log(`  ${hdr}`);
  console.log(`  ${'-'.repeat(hdr.length)}`);

  for (const row of rows) {
    const line = [
      row.label.padEnd(28),
      row.trades.toString().padStart(7),
      row.winRate.toFixed(1).padStart(7),
      row.roi.toFixed(2).padStart(10),
      row.sharpe.toFixed(2).padStart(8),
      row.profitFactor.toFixed(2).padStart(7),
      row.maxDD.toFixed(2).padStart(8),
      row.avgPnlPerTrade.toFixed(3).padStart(9),
    ].join(' | ');
    console.log(`  ${line}`);
  }
}

/** Print delta table (each combo vs baseline) */
function printDeltaTable(title: string, rows: MetricRow[], baseline: MetricRow) {
  console.log(`\n${'='.repeat(120)}`);
  console.log(`  ${title} (delta vs baseline)`);
  console.log(`${'='.repeat(120)}`);

  const hdr = [
    'Config'.padEnd(28),
    'dTrades'.padStart(8),
    'dWR(pp)'.padStart(8),
    'dROI%'.padStart(10),
    'dSharpe'.padStart(8),
    'dPF'.padStart(7),
    'dMaxDD%'.padStart(8),
    'dAvgPnL%'.padStart(9),
  ].join(' | ');
  console.log(`  ${hdr}`);
  console.log(`  ${'-'.repeat(hdr.length)}`);

  for (const row of rows) {
    const line = [
      row.label.padEnd(28),
      fmtDelta(row.trades - baseline.trades, 0).padStart(8),
      fmtDelta(row.winRate - baseline.winRate, 1).padStart(8),
      fmtDelta(row.roi - baseline.roi, 2).padStart(10),
      fmtDelta(row.sharpe - baseline.sharpe, 2).padStart(8),
      fmtDelta(row.profitFactor - baseline.profitFactor, 2).padStart(7),
      fmtDelta(row.maxDD - baseline.maxDD, 2).padStart(8),
      fmtDelta(row.avgPnlPerTrade - baseline.avgPnlPerTrade, 3).padStart(9),
    ].join(' | ');
    console.log(`  ${line}`);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║     V5.99 DRASH CONTEXT: 8-COMBINATION COMPARISON                  ║');
  console.log('║     Train: Jun 2024 - Jun 2025 | Test: Jul - Dec 2025              ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`\nSymbols: ${SYMBOLS.join(', ')}`);
  console.log(`Capital: $${INITIAL_CAPITAL} | Leverage: ${LEVERAGE}x`);
  console.log(`Combinations: ${CONFIGS.length} (2^3 factor combos)`);
  console.log(`Periods: ${PERIODS.map(p => p.label).join(' + ')}`);

  // Preload markets
  console.log('\nPreloading markets...');
  let ok = false;
  try {
    ok = await preloadMarkets();
  } catch {
    ok = false;
  }
  if (!ok) {
    console.log('   API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('   Markets ready.\n');

  // Save original config
  const originalConfig = saveOriginalConfig();

  const results: ComboResult[] = [];

  try {
    for (let i = 0; i < CONFIGS.length; i++) {
      const cfg = CONFIGS[i];
      console.log(`\n[${'='.repeat(60)}]`);
      console.log(`  Combo ${i + 1}/${CONFIGS.length}: ${cfg.label}`);
      console.log(`  SR=${cfg.sr ? 'ON' : 'OFF'} | Breakout=${cfg.breakout ? 'ON' : 'OFF'} | Correlation=${cfg.correlation ? 'ON' : 'OFF'}`);
      console.log(`[${'='.repeat(60)}]`);

      applyConfig(cfg);

      // Run Train period
      console.log(`\n  Running TRAIN period (${PERIODS[0].label})...`);
      const t1 = Date.now();
      const trainResult = await runBacktest({
        startDate: PERIODS[0].startDate,
        endDate: PERIODS[0].endDate,
        initialCapital: INITIAL_CAPITAL,
        symbols: SYMBOLS,
        leverage: LEVERAGE,
      });
      console.log(`    Done in ${((Date.now() - t1) / 1000).toFixed(1)}s | ${trainResult.summary.totalTrades} trades | WR: ${trainResult.summary.winRate.toFixed(1)}% | ROI: ${trainResult.summary.totalPnlPct.toFixed(1)}%`);

      // Run Test period
      console.log(`  Running TEST period (${PERIODS[1].label})...`);
      const t2 = Date.now();
      const testResult = await runBacktest({
        startDate: PERIODS[1].startDate,
        endDate: PERIODS[1].endDate,
        initialCapital: INITIAL_CAPITAL,
        symbols: SYMBOLS,
        leverage: LEVERAGE,
      });
      console.log(`    Done in ${((Date.now() - t2) / 1000).toFixed(1)}s | ${testResult.summary.totalTrades} trades | WR: ${testResult.summary.winRate.toFixed(1)}% | ROI: ${testResult.summary.totalPnlPct.toFixed(1)}%`);

      results.push({ config: cfg, train: trainResult, test: testResult });
    }
  } finally {
    // Always restore original config
    restoreConfig(originalConfig);
    console.log('\nOriginal config restored.');
  }

  // ========================================================================
  // RESULTS TABLES
  // ========================================================================

  // Train period table
  const trainMetrics = results.map((r, i) => extractMetrics(CONFIGS[i].label, r.train));
  printMetricsTable('TRAIN PERIOD: Jun 2024 - Jun 2025 (In-Sample)', trainMetrics);

  // Test period table
  const testMetrics = results.map((r, i) => extractMetrics(CONFIGS[i].label, r.test));
  printMetricsTable('TEST PERIOD: Jul 2025 - Dec 2025 (Out-of-Sample)', testMetrics);

  // ========================================================================
  // DELTA TABLES (vs baseline = combo 0)
  // ========================================================================

  const trainBaseline = trainMetrics[0];
  const testBaseline = testMetrics[0];

  printDeltaTable('TRAIN DELTA', trainMetrics.slice(1), trainBaseline);
  printDeltaTable('TEST DELTA (OOS)', testMetrics.slice(1), testBaseline);

  // ========================================================================
  // BEST COMBO SELECTION (based on OOS composite score)
  // ========================================================================

  console.log(`\n${'='.repeat(120)}`);
  console.log('  BEST COMBO SELECTION (Out-of-Sample Composite Score)');
  console.log(`${'='.repeat(120)}`);
  console.log('  Composite = Sharpe * 0.5 + ROI_norm * 0.3 + WR_norm * 0.2');

  // Normalize ROI and WR across all test combos for composite scoring
  const maxROI = Math.max(...testMetrics.map(m => m.roi));
  const minROI = Math.min(...testMetrics.map(m => m.roi));
  const roiRange = maxROI - minROI || 1;

  const maxWR = Math.max(...testMetrics.map(m => m.winRate));
  const minWR = Math.min(...testMetrics.map(m => m.winRate));
  const wrRange = maxWR - minWR || 1;

  const maxSharpe = Math.max(...testMetrics.map(m => m.sharpe));
  const minSharpe = Math.min(...testMetrics.map(m => m.sharpe));
  const sharpeRange = maxSharpe - minSharpe || 1;

  interface ScoredCombo {
    idx: number;
    label: string;
    composite: number;
    sharpeNorm: number;
    roiNorm: number;
    wrNorm: number;
  }

  const scored: ScoredCombo[] = testMetrics.map((m, i) => {
    const sharpeNorm = (m.sharpe - minSharpe) / sharpeRange;
    const roiNorm = (m.roi - minROI) / roiRange;
    const wrNorm = (m.winRate - minWR) / wrRange;
    const composite = sharpeNorm * 0.5 + roiNorm * 0.3 + wrNorm * 0.2;
    return { idx: i, label: m.label, composite, sharpeNorm, roiNorm, wrNorm };
  });

  scored.sort((a, b) => b.composite - a.composite);

  console.log(`\n  ${'Rank'.padStart(4)} | ${'Config'.padEnd(28)} | ${'Composite'.padStart(9)} | ${'Sharpe_n'.padStart(8)} | ${'ROI_n'.padStart(6)} | ${'WR_n'.padStart(6)}`);
  console.log(`  ${'-'.repeat(80)}`);
  for (let rank = 0; rank < scored.length; rank++) {
    const s = scored[rank];
    const marker = rank === 0 ? ' <-- BEST' : '';
    console.log(`  ${(rank + 1).toString().padStart(4)} | ${s.label.padEnd(28)} | ${s.composite.toFixed(4).padStart(9)} | ${s.sharpeNorm.toFixed(4).padStart(8)} | ${s.roiNorm.toFixed(4).padStart(6)} | ${s.wrNorm.toFixed(4).padStart(6)}${marker}`);
  }

  // ========================================================================
  // VERDICT
  // ========================================================================

  const best = scored[0];
  const bestTest = testMetrics[best.idx];
  const baseTest = testMetrics[0];

  console.log(`\n${'='.repeat(120)}`);
  console.log('  VERDICT');
  console.log(`${'='.repeat(120)}`);
  console.log(`\n  Best combo (OOS): ${best.label}`);
  console.log(`  Composite score:  ${best.composite.toFixed(4)}`);

  // Pass/fail criteria
  const wrDelta = bestTest.winRate - baseTest.winRate;
  const roiRatio = baseTest.roi !== 0 ? bestTest.roi / baseTest.roi : (bestTest.roi > 0 ? Infinity : 0);
  const sharpeDelta = bestTest.sharpe - baseTest.sharpe;

  const wrPass = wrDelta >= 1.0;         // WR >= +1pp OOS
  const roiPass = roiRatio >= 0.95;      // ROI >= 95% of baseline
  const sharpePass = sharpeDelta >= 0.10; // Sharpe >= +0.10 OOS

  console.log(`\n  Pass/Fail Criteria (OOS):`);
  console.log(`    WR >= +1pp OOS:          ${wrPass ? 'PASS' : 'FAIL'} (${fmtDelta(wrDelta, 1)}pp)`);
  console.log(`    ROI >= 95% of baseline:  ${roiPass ? 'PASS' : 'FAIL'} (${(roiRatio * 100).toFixed(1)}%)`);
  console.log(`    Sharpe >= +0.10 OOS:     ${sharpePass ? 'PASS' : 'FAIL'} (${fmtDelta(sharpeDelta, 2)})`);

  const allPass = wrPass && roiPass && sharpePass;
  const anyPass = wrPass || roiPass || sharpePass;

  if (allPass) {
    console.log(`\n  RESULT: ALL CRITERIA PASS -- ${best.label} is production-ready`);
  } else if (anyPass) {
    const passCount = [wrPass, roiPass, sharpePass].filter(Boolean).length;
    console.log(`\n  RESULT: PARTIAL (${passCount}/3 criteria pass) -- ${best.label} needs more work`);
  } else {
    console.log(`\n  RESULT: FAIL -- Drash context does not improve OOS performance`);
  }

  // If best is baseline, note it
  if (best.idx === 0) {
    console.log(`\n  NOTE: Baseline (no context) scored highest -- context factors do not help on OOS data`);
  }

  console.log(`\n${'='.repeat(120)}`);
  console.log('  Done.\n');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
