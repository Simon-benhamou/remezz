/**
 * Drash Context Weight Sensitivity Analysis
 * ==========================================
 * Tests breakout-only factor at lower weights on OOS period only.
 * Baseline (weight=0) vs 0.05, 0.10, 0.15 weights.
 * OOS period: Jul 2025 - Dec 2025 (~3 min per run, ~12 min total)
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { preloadMarkets, initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';

const SYMBOLS = [
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'SEI/USDT:USDT',
  'SUI/USDT:USDT',
  'XRP/USDT:USDT',
];

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 4.5;

const OOS_PERIOD = {
  startDate: new Date('2025-07-01T00:00:00Z'),
  endDate: new Date('2025-12-31T23:59:59Z'),
};

const WEIGHTS = [0, 0.05, 0.10, 0.15];

interface MetricRow {
  weight: number;
  trades: number;
  winRate: number;
  roi: number;
  sharpe: number;
  profitFactor: number;
  maxDD: number;
  avgPnl: number;
}

function fmtDelta(val: number, dec: number = 2): string {
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(dec)}`;
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  DRASH WEIGHT SENSITIVITY: Breakout-only on OOS      ║');
  console.log('║  Weights: 0.00, 0.05, 0.10, 0.15                    ║');
  console.log('║  Period: Jul 2025 - Dec 2025 (Out-of-Sample)         ║');
  console.log('╚════════════════════════════════════════════════════════╝');

  // Preload markets
  console.log('\nPreloading markets...');
  let ok = false;
  try { ok = await preloadMarkets(); } catch { ok = false; }
  if (!ok) {
    console.log('  API unavailable, using minimal markets...');
    initializeMinimalMarkets();
  }
  console.log('  Markets ready.\n');

  // Save original config
  const orig = {
    enabled: MomentumConfig.DRASH_CONTEXT.ENABLED,
    weight: MomentumConfig.DRASH_CONTEXT.WEIGHT_IN_SIGNAL_SCORE,
    sr: MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED,
    breakout: MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED,
    correlation: MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED,
  };

  const results: MetricRow[] = [];

  try {
    for (const weight of WEIGHTS) {
      const isBaseline = weight === 0;
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  Weight: ${weight.toFixed(2)}${isBaseline ? ' (BASELINE — context disabled)' : ''}`);
      console.log(`${'─'.repeat(60)}`);

      if (isBaseline) {
        MomentumConfig.DRASH_CONTEXT.ENABLED = false;
      } else {
        MomentumConfig.DRASH_CONTEXT.ENABLED = true;
        MomentumConfig.DRASH_CONTEXT.WEIGHT_IN_SIGNAL_SCORE = weight;
        // Breakout only
        MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = false;
        MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = true;
        MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = false;
      }

      const t0 = Date.now();
      const r = await runBacktest({
        startDate: OOS_PERIOD.startDate,
        endDate: OOS_PERIOD.endDate,
        initialCapital: INITIAL_CAPITAL,
        symbols: SYMBOLS,
        leverage: LEVERAGE,
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      const s = r.summary;
      const avgPnl = s.totalTrades > 0 ? s.totalPnlPct / s.totalTrades : 0;
      console.log(`  Done in ${elapsed}s | ${s.totalTrades} trades | WR: ${s.winRate.toFixed(1)}% | ROI: ${s.totalPnlPct.toFixed(1)}%`);

      results.push({
        weight,
        trades: s.totalTrades,
        winRate: s.winRate,
        roi: s.totalPnlPct,
        sharpe: s.sharpeRatio,
        profitFactor: s.profitFactor,
        maxDD: s.maxDrawdownPct,
        avgPnl,
      });
    }
  } finally {
    // Restore
    MomentumConfig.DRASH_CONTEXT.ENABLED = orig.enabled;
    MomentumConfig.DRASH_CONTEXT.WEIGHT_IN_SIGNAL_SCORE = orig.weight;
    MomentumConfig.DRASH_CONTEXT.FACTORS.SR_PROXIMITY.ENABLED = orig.sr;
    MomentumConfig.DRASH_CONTEXT.FACTORS.BREAKOUT_QUALITY.ENABLED = orig.breakout;
    MomentumConfig.DRASH_CONTEXT.FACTORS.MARKET_CORRELATION.ENABLED = orig.correlation;
    console.log('\nConfig restored.');
  }

  // Results table
  console.log(`\n${'='.repeat(100)}`);
  console.log('  SENSITIVITY RESULTS: Breakout-only at varying weights (OOS Jul-Dec 2025)');
  console.log(`${'='.repeat(100)}`);

  const hdr = [
    'Weight'.padEnd(10),
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

  for (const row of results) {
    const line = [
      (row.weight === 0 ? '0.00 (BL)' : row.weight.toFixed(2)).padEnd(10),
      row.trades.toString().padStart(7),
      row.winRate.toFixed(1).padStart(7),
      row.roi.toFixed(2).padStart(10),
      row.sharpe.toFixed(2).padStart(8),
      row.profitFactor.toFixed(2).padStart(7),
      row.maxDD.toFixed(2).padStart(8),
      row.avgPnl.toFixed(3).padStart(9),
    ].join(' | ');
    console.log(`  ${line}`);
  }

  // Delta vs baseline
  const baseline = results[0];
  console.log(`\n  Delta vs baseline:`);
  console.log(`  ${'Weight'.padEnd(10)} | ${'dROI%'.padStart(10)} | ${'dWR(pp)'.padStart(8)} | ${'dSharpe'.padStart(8)} | ${'dPF'.padStart(7)} | ${'dMaxDD%'.padStart(8)}`);
  console.log(`  ${'-'.repeat(65)}`);

  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const line = [
      r.weight.toFixed(2).padEnd(10),
      fmtDelta(r.roi - baseline.roi, 2).padStart(10),
      fmtDelta(r.winRate - baseline.winRate, 1).padStart(8),
      fmtDelta(r.sharpe - baseline.sharpe, 2).padStart(8),
      fmtDelta(r.profitFactor - baseline.profitFactor, 2).padStart(7),
      fmtDelta(r.maxDD - baseline.maxDD, 2).padStart(8),
    ].join(' | ');
    console.log(`  ${line}`);
  }

  // Verdict
  const best = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
  console.log(`\n  Best weight by Sharpe: ${best.weight.toFixed(2)} (Sharpe ${best.sharpe.toFixed(2)}, ROI ${best.roi.toFixed(1)}%)`);

  if (best.weight === 0) {
    console.log('  VERDICT: Baseline still wins — context weight should remain disabled');
  } else {
    const roiPct = baseline.roi !== 0 ? (best.roi / baseline.roi * 100).toFixed(1) : 'N/A';
    console.log(`  VERDICT: Weight ${best.weight.toFixed(2)} improves Sharpe. ROI = ${roiPct}% of baseline.`);
  }

  console.log(`\n${'='.repeat(100)}\n  Done.\n`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
