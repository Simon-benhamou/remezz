/**
 * Strategy Optimization Script — Parameter Sweep
 *
 * Mutates MomentumConfig fields before each backtest run, then restores them.
 * Three sequential phases:
 *   Phase A — Entry quality (ROC_MIN, VOL_MULTIPLIER, LONG_MAX_GREEN_RATIO)
 *   Phase B — Exit tuning (stagnant, trailing, SL) using best entry from A
 *   Phase C — Symbol selection using best config from A+B
 *
 * Usage:
 *   npx tsx scripts/optimize-strategy.ts              # Run all phases
 *   PHASE=A npx tsx scripts/optimize-strategy.ts      # Run phase A only
 *   PHASE=B npx tsx scripts/optimize-strategy.ts      # Run phase B only (uses hardcoded best-A)
 *   PHASE=C npx tsx scripts/optimize-strategy.ts      # Run phase C only (uses hardcoded best-A+B)
 */

import { runBacktest, type BacktestResult } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';

// ============================================================================
// TYPES
// ============================================================================

interface ConfigOverride {
  // Entry (Phase A)
  'ENTRY_LONG.ROC_MIN'?: number;
  'ENTRY_LONG.VOL_MULTIPLIER'?: number;
  'CANDLE_PATTERN_FILTER.LONG_MAX_GREEN_RATIO'?: number;
  // Exit (Phase B)
  'EXIT.STAGNANT_TRADE_TIME_MINUTES'?: number;
  'EXIT.STAGNANT_TRADE_MIN_PROFIT_PCT'?: number;
  'EXIT.TRAILING_ACTIVATION_PCT'?: number;
  'EXIT.TRAILING_DISTANCE_PCT'?: number;
  'EXIT.STOP_LOSS_PCT'?: number;
  // Generic index
  [key: string]: number | undefined;
}

interface RunResult {
  label: string;
  overrides: ConfigOverride;
  symbols: string[];
  trades: number;
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
// CONSTANTS
// ============================================================================

const START_DATE = new Date(process.env.START_DATE || '2025-01-01T00:00:00.000Z');
const END_DATE = new Date(process.env.END_DATE || '2025-12-31T00:00:00.000Z');
const INITIAL_CAPITAL = Number(process.env.INITIAL_CAPITAL || 2000);
const LEVERAGE = Number(process.env.LEVERAGE || 4.5);

const ALL_SYMBOLS = [
  'DOGE/USDT:USDT',
  'IMX/USDT:USDT',
  'SEI/USDT:USDT',
  'SUI/USDT:USDT',
  'XRP/USDT:USDT',
  'ETH/USDT:USDT',
];

// ============================================================================
// CONFIG MUTATION HELPERS
// ============================================================================

/** Deep-clone the mutable parts of MomentumConfig that we'll mutate */
function snapshotConfig(): Record<string, Record<string, unknown>> {
  return {
    ENTRY_LONG: { ...MomentumConfig.ENTRY_LONG },
    CANDLE_PATTERN_FILTER: { ...MomentumConfig.CANDLE_PATTERN_FILTER },
    EXIT: { ...MomentumConfig.EXIT },
  };
}

/** Restore MomentumConfig from a snapshot */
function restoreConfig(snap: Record<string, Record<string, unknown>>): void {
  Object.assign(MomentumConfig.ENTRY_LONG, snap.ENTRY_LONG);
  Object.assign(MomentumConfig.CANDLE_PATTERN_FILTER, snap.CANDLE_PATTERN_FILTER);
  Object.assign(MomentumConfig.EXIT, snap.EXIT);
}

/** Apply overrides (dotted keys like 'EXIT.STOP_LOSS_PCT') to MomentumConfig */
function applyOverrides(overrides: ConfigOverride): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const parts = key.split('.');
    if (parts.length !== 2) {
      console.warn(`[Optimize] Ignoring invalid override key: ${key}`);
      continue;
    }
    const [section, field] = parts;
    const target = (MomentumConfig as Record<string, any>)[section];
    if (!target || !(field in target)) {
      console.warn(`[Optimize] Unknown config path: ${key}`);
      continue;
    }
    target[field] = value;
  }
}

// ============================================================================
// SINGLE BACKTEST RUN
// ============================================================================

async function runOne(label: string, overrides: ConfigOverride, symbols: string[]): Promise<RunResult> {
  const snap = snapshotConfig();
  try {
    applyOverrides(overrides);

    const t0 = Date.now();
    const result: BacktestResult = await runBacktest({
      startDate: START_DATE,
      endDate: END_DATE,
      initialCapital: INITIAL_CAPITAL,
      symbols: [...symbols],
      leverage: LEVERAGE,
    });
    const runtimeSec = (Date.now() - t0) / 1000;

    const s = result.summary;
    return {
      label,
      overrides,
      symbols,
      trades: s.totalTrades,
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
    restoreConfig(snap);
  }
}

// ============================================================================
// OUTPUT HELPERS
// ============================================================================

function printTable(results: RunResult[], sortKey: keyof RunResult = 'netPnl'): void {
  const sorted = [...results].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return bv - av; // descending
  });

  console.log('\n' + '═'.repeat(140));
  console.log(
    padR('Rank', 5) +
    padR('Label', 35) +
    padR('Trades', 7) +
    padR('WinRate', 8) +
    padR('NetPnL', 12) +
    padR('PnL%', 9) +
    padR('MaxDD%', 8) +
    padR('Sharpe', 8) +
    padR('PF', 6) +
    padR('Fees', 10) +
    padR('AvgHold', 8) +
    padR('Time', 6)
  );
  console.log('─'.repeat(140));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const rank = i === 0 ? '★ 1' : `  ${i + 1}`;
    console.log(
      padR(rank, 5) +
      padR(r.label, 35) +
      padR(String(r.trades), 7) +
      padR(r.winRate.toFixed(1) + '%', 8) +
      padR('$' + r.netPnl.toFixed(0), 12) +
      padR(r.netPnlPct.toFixed(1) + '%', 9) +
      padR(r.maxDD.toFixed(1) + '%', 8) +
      padR(r.sharpe.toFixed(2), 8) +
      padR(r.profitFactor.toFixed(2), 6) +
      padR('$' + r.fees.toFixed(0), 10) +
      padR(r.avgHoldMin.toFixed(0) + 'm', 8) +
      padR(r.runtimeSec.toFixed(0) + 's', 6)
    );
  }
  console.log('═'.repeat(140));

  if (sorted.length > 0) {
    const best = sorted[0];
    console.log(`\n★ Best: "${best.label}" → PnL $${best.netPnl.toFixed(0)} (${best.netPnlPct.toFixed(1)}%), WR ${best.winRate.toFixed(1)}%, DD ${best.maxDD.toFixed(1)}%, Sharpe ${best.sharpe.toFixed(2)}`);
    console.log('  Overrides:', JSON.stringify(best.overrides));
    if (best.symbols.length !== ALL_SYMBOLS.length) {
      console.log('  Symbols:', best.symbols.map(s => s.split('/')[0]).join(', '));
    }
  }
}

function padR(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}

// ============================================================================
// PHASE DEFINITIONS
// ============================================================================

function buildPhaseA(): { label: string; overrides: ConfigOverride }[] {
  const configs: { label: string; overrides: ConfigOverride }[] = [];

  // Baseline (no overrides)
  configs.push({ label: 'BASELINE', overrides: {} });

  // ROC_MIN variations
  for (const roc of [0.02, 0.025]) {
    configs.push({
      label: `ROC=${roc}`,
      overrides: { 'ENTRY_LONG.ROC_MIN': roc },
    });
  }

  // VOL_MULTIPLIER variations
  for (const vol of [1.3, 1.5]) {
    configs.push({
      label: `VOL=${vol}`,
      overrides: { 'ENTRY_LONG.VOL_MULTIPLIER': vol },
    });
  }

  // GREEN_RATIO variations
  for (const gr of [0.60, 0.65]) {
    configs.push({
      label: `GREEN=${gr}`,
      overrides: { 'CANDLE_PATTERN_FILTER.LONG_MAX_GREEN_RATIO': gr },
    });
  }

  // Best combo candidates (ROC + VOL)
  configs.push({
    label: 'ROC=0.02+VOL=1.3',
    overrides: { 'ENTRY_LONG.ROC_MIN': 0.02, 'ENTRY_LONG.VOL_MULTIPLIER': 1.3 },
  });

  configs.push({
    label: 'ROC=0.025+VOL=1.3',
    overrides: { 'ENTRY_LONG.ROC_MIN': 0.025, 'ENTRY_LONG.VOL_MULTIPLIER': 1.3 },
  });

  configs.push({
    label: 'ROC=0.02+VOL=1.3+GR=0.60',
    overrides: {
      'ENTRY_LONG.ROC_MIN': 0.02,
      'ENTRY_LONG.VOL_MULTIPLIER': 1.3,
      'CANDLE_PATTERN_FILTER.LONG_MAX_GREEN_RATIO': 0.60,
    },
  });

  return configs;
}

function buildPhaseB(bestAOverrides: ConfigOverride): { label: string; overrides: ConfigOverride }[] {
  const configs: { label: string; overrides: ConfigOverride }[] = [];

  // Baseline = best A config with no exit changes
  configs.push({
    label: 'BEST-A (baseline)',
    overrides: { ...bestAOverrides },
  });

  // Stagnant time
  for (const t of [30, 60]) {
    configs.push({
      label: `STAG_TIME=${t}`,
      overrides: { ...bestAOverrides, 'EXIT.STAGNANT_TRADE_TIME_MINUTES': t },
    });
  }

  // Stagnant min profit
  for (const p of [0.5, 1.0]) {
    configs.push({
      label: `STAG_PROFIT=${p}`,
      overrides: { ...bestAOverrides, 'EXIT.STAGNANT_TRADE_MIN_PROFIT_PCT': p },
    });
  }

  // Trailing activation
  for (const a of [0.5, 1.0, 1.2]) {
    configs.push({
      label: `TRAIL_ACT=${a}`,
      overrides: { ...bestAOverrides, 'EXIT.TRAILING_ACTIVATION_PCT': a },
    });
  }

  // Trailing distance
  for (const d of [0.3, 0.4, 0.6]) {
    configs.push({
      label: `TRAIL_DIST=${d}`,
      overrides: { ...bestAOverrides, 'EXIT.TRAILING_DISTANCE_PCT': d },
    });
  }

  // Stop loss
  for (const sl of [2.0, 3.0]) {
    configs.push({
      label: `SL=${sl}`,
      overrides: { ...bestAOverrides, 'EXIT.STOP_LOSS_PCT': sl },
    });
  }

  // Combo: best trailing + stagnant combos
  configs.push({
    label: 'TRAIL=0.5/0.3+STAG=30',
    overrides: {
      ...bestAOverrides,
      'EXIT.TRAILING_ACTIVATION_PCT': 0.5,
      'EXIT.TRAILING_DISTANCE_PCT': 0.3,
      'EXIT.STAGNANT_TRADE_TIME_MINUTES': 30,
    },
  });

  configs.push({
    label: 'TRAIL=1.0/0.4+STAG=60',
    overrides: {
      ...bestAOverrides,
      'EXIT.TRAILING_ACTIVATION_PCT': 1.0,
      'EXIT.TRAILING_DISTANCE_PCT': 0.4,
      'EXIT.STAGNANT_TRADE_TIME_MINUTES': 60,
    },
  });

  return configs;
}

function buildPhaseC(bestABOverrides: ConfigOverride): { label: string; overrides: ConfigOverride; symbols: string[] }[] {
  const noEth = ALL_SYMBOLS.filter(s => !s.startsWith('ETH'));
  const top4 = ['DOGE/USDT:USDT', 'IMX/USDT:USDT', 'SEI/USDT:USDT', 'SUI/USDT:USDT'];

  return [
    { label: 'ALL 6 symbols', overrides: { ...bestABOverrides }, symbols: ALL_SYMBOLS },
    { label: 'DROP ETH (5)', overrides: { ...bestABOverrides }, symbols: noEth },
    { label: 'TOP 4 only', overrides: { ...bestABOverrides }, symbols: top4 },
  ];
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('[Optimize] Preloading markets...');
  const ok = await preloadMarkets();
  if (!ok) throw new Error('Failed to preload markets');
  console.log('[Optimize] Markets loaded.\n');

  console.log(`[Optimize] Date range: ${START_DATE.toISOString()} → ${END_DATE.toISOString()}`);
  console.log(`[Optimize] Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log(`[Optimize] Symbols: ${ALL_SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);

  const phase = (process.env.PHASE || 'ALL').toUpperCase();

  // ── Phase A ──────────────────────────────────────────────────────────────
  let bestAOverrides: ConfigOverride = {};

  if (phase === 'ALL' || phase === 'A') {
    console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  PHASE A — ENTRY QUALITY (ROC_MIN, VOL_MULT, GREEN_RATIO)  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const phaseACfgs = buildPhaseA();
    const resultsA: RunResult[] = [];

    for (let i = 0; i < phaseACfgs.length; i++) {
      const cfg = phaseACfgs[i];
      console.log(`[Phase A] Run ${i + 1}/${phaseACfgs.length}: ${cfg.label}`);
      const r = await runOne(cfg.label, cfg.overrides, ALL_SYMBOLS);
      resultsA.push(r);
      console.log(`  → Trades=${r.trades}, WR=${r.winRate.toFixed(1)}%, PnL=$${r.netPnl.toFixed(0)}, DD=${r.maxDD.toFixed(1)}%, Sharpe=${r.sharpe.toFixed(2)} (${r.runtimeSec.toFixed(0)}s)\n`);
    }

    printTable(resultsA);

    // Pick best by PnL
    const bestA = [...resultsA].sort((a, b) => b.netPnl - a.netPnl)[0];
    bestAOverrides = bestA.overrides;
    console.log(`\n[Phase A] Winner: "${bestA.label}"`);
  }

  // Allow manual override of best-A for standalone Phase B runs
  if (process.env.BEST_A) {
    try {
      bestAOverrides = JSON.parse(process.env.BEST_A);
      console.log('[Optimize] Using BEST_A from env:', bestAOverrides);
    } catch {
      console.error('[Optimize] Invalid BEST_A JSON, using default');
    }
  }

  // ── Phase B ──────────────────────────────────────────────────────────────
  let bestABOverrides: ConfigOverride = { ...bestAOverrides };

  if (phase === 'ALL' || phase === 'B') {
    console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  PHASE B — EXIT TUNING (stagnant, trailing, SL)            ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const phaseBCfgs = buildPhaseB(bestAOverrides);
    const resultsB: RunResult[] = [];

    for (let i = 0; i < phaseBCfgs.length; i++) {
      const cfg = phaseBCfgs[i];
      console.log(`[Phase B] Run ${i + 1}/${phaseBCfgs.length}: ${cfg.label}`);
      const r = await runOne(cfg.label, cfg.overrides, ALL_SYMBOLS);
      resultsB.push(r);
      console.log(`  → Trades=${r.trades}, WR=${r.winRate.toFixed(1)}%, PnL=$${r.netPnl.toFixed(0)}, DD=${r.maxDD.toFixed(1)}%, Sharpe=${r.sharpe.toFixed(2)} (${r.runtimeSec.toFixed(0)}s)\n`);
    }

    printTable(resultsB);

    const bestB = [...resultsB].sort((a, b) => b.netPnl - a.netPnl)[0];
    bestABOverrides = bestB.overrides;
    console.log(`\n[Phase B] Winner: "${bestB.label}"`);
  }

  if (process.env.BEST_AB) {
    try {
      bestABOverrides = JSON.parse(process.env.BEST_AB);
      console.log('[Optimize] Using BEST_AB from env:', bestABOverrides);
    } catch {
      console.error('[Optimize] Invalid BEST_AB JSON, using default');
    }
  }

  // ── Phase C ──────────────────────────────────────────────────────────────
  if (phase === 'ALL' || phase === 'C') {
    console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  PHASE C — SYMBOL SELECTION                                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const phaseCCfgs = buildPhaseC(bestABOverrides);
    const resultsC: RunResult[] = [];

    for (let i = 0; i < phaseCCfgs.length; i++) {
      const cfg = phaseCCfgs[i];
      console.log(`[Phase C] Run ${i + 1}/${phaseCCfgs.length}: ${cfg.label}`);
      const r = await runOne(cfg.label, cfg.overrides, cfg.symbols);
      resultsC.push(r);
      console.log(`  → Trades=${r.trades}, WR=${r.winRate.toFixed(1)}%, PnL=$${r.netPnl.toFixed(0)}, DD=${r.maxDD.toFixed(1)}%, Sharpe=${r.sharpe.toFixed(2)} (${r.runtimeSec.toFixed(0)}s)\n`);
    }

    printTable(resultsC);

    const bestC = [...resultsC].sort((a, b) => b.netPnl - a.netPnl)[0];
    console.log(`\n[Phase C] Winner: "${bestC.label}"`);
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('  FINAL OPTIMAL CONFIGURATION');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('Overrides:', JSON.stringify(bestC.overrides, null, 2));
    console.log('Symbols:', bestC.symbols.map(s => s.split('/')[0]).join(', '));
    console.log(`PnL: $${bestC.netPnl.toFixed(0)} (${bestC.netPnlPct.toFixed(1)}%)`);
    console.log(`Win Rate: ${bestC.winRate.toFixed(1)}%`);
    console.log(`Max Drawdown: ${bestC.maxDD.toFixed(1)}%`);
    console.log(`Sharpe: ${bestC.sharpe.toFixed(2)}`);
    console.log(`Profit Factor: ${bestC.profitFactor.toFixed(2)}`);
    console.log(`Trades: ${bestC.trades}`);
    console.log('════════════════════════════════════════════════════════════════\n');
  }

  console.log('[Optimize] Done.');
}

main().catch((err) => {
  console.error('[Optimize] FATAL:', err);
  process.exitCode = 1;
});
