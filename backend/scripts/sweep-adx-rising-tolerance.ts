/**
 * V5.152: ADX Rising Tolerance Sweep
 *
 * Problem: ADX Rising filter blocks valid re-entries after consolidation.
 * ADA 2026-03-16: ADX=39.1 (very strong) but declined from 40.8 → rejected.
 * Price then ran +8% without us.
 *
 * Tests 3 tolerance mechanisms:
 * A) MIN_DECLINE: Only reject if ADX dropped by more than X points
 * B) HIGH_BYPASS: Skip check entirely if ADX >= threshold (strong trend)
 * C) LOOKBACK: Reduce from 3 to 2 candles (more responsive)
 * + Combos: A+B, A+B+C
 *
 * Each config runs a FULL compounded backtest via runBacktestComputation().
 * Tests on both 2024 and 2025 to check robustness.
 *
 * Usage: cd backend && npx tsx scripts/sweep-adx-rising-tolerance.ts
 */
import { runBacktestComputation, type BacktestResult, type BacktestTrade } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles, sliceCandlesByTime, CANDLE_15M_MS, type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// CONSTANTS
// ============================================================================
const SYMBOLS = MomentumConfig.SYMBOLS;
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// Periods
const Y2025_START = new Date('2025-01-01T00:00:00.000Z');
const Y2025_END = new Date('2025-12-31T00:00:00.000Z');
const Y2024_START = new Date('2024-06-01T00:00:00.000Z');
const Y2024_END = new Date('2024-12-31T00:00:00.000Z');
const H1_START = new Date('2025-01-01T00:00:00.000Z');
const H1_END = new Date('2025-06-30T23:59:59.000Z');
const H2_START = new Date('2025-07-01T00:00:00.000Z');
const H2_END = new Date('2025-12-31T00:00:00.000Z');

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData(start: Date, end: Date) {
  const since = start.getTime() - 400 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end.getTime());
  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) continue;
    allData[symbol] = sliceCandlesByTime(local.candles, since, end.getTime());
  }
  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  return { btcCandles, btcCandlesRegime: btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// CONFIG SAVE / RESTORE
// ============================================================================
function saveConfig() {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  return {
    ADX_RISING_ENABLED: eq.ADX_RISING_ENABLED,
    ADX_RISING_LOOKBACK: eq.ADX_RISING_LOOKBACK,
    ADX_RISING_MIN_DECLINE: eq.ADX_RISING_MIN_DECLINE,
    ADX_RISING_HIGH_BYPASS: eq.ADX_RISING_HIGH_BYPASS,
  };
}

function restoreConfig(saved: ReturnType<typeof saveConfig>) {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  eq.ADX_RISING_ENABLED = saved.ADX_RISING_ENABLED;
  eq.ADX_RISING_LOOKBACK = saved.ADX_RISING_LOOKBACK;
  eq.ADX_RISING_MIN_DECLINE = saved.ADX_RISING_MIN_DECLINE;
  eq.ADX_RISING_HIGH_BYPASS = saved.ADX_RISING_HIGH_BYPASS;
}

function applyConfig(opts: { lookback?: number; minDecline?: number; highBypass?: number }) {
  const eq = MomentumConfig.ENTRY_QUALITY as any;
  eq.ADX_RISING_LOOKBACK = opts.lookback ?? 3;
  eq.ADX_RISING_MIN_DECLINE = opts.minDecline ?? 0;
  eq.ADX_RISING_HIGH_BYPASS = opts.highBypass ?? 0;
}

// ============================================================================
// METRICS
// ============================================================================
function metrics(r: BacktestResult) {
  const s = r.summary;
  return {
    trades: s.totalTrades, wr: s.winRate, pnl: s.totalPnlUsd,
    dd: s.maxDrawdownPct, sharpe: s.sharpeRatio, pf: s.profitFactor,
  };
}

type M = ReturnType<typeof metrics>;

function fmtRow(label: string, m25: M, m24: M, base25?: M, base24?: M) {
  const dPnl25 = base25 ? m25.pnl - base25.pnl : 0;
  const dSh25 = base25 ? m25.sharpe - base25.sharpe : 0;
  const dDD25 = base25 ? m25.dd - base25.dd : 0;

  return (
    label.padEnd(28) +
    // 2025
    `${String(m25.trades).padStart(5)} ` +
    `${m25.wr.toFixed(1).padStart(5)}% ` +
    `$${m25.pnl.toFixed(0).padStart(7)} ` +
    `${m25.dd.toFixed(1).padStart(5)}% ` +
    `${m25.sharpe.toFixed(2).padStart(6)} ` +
    `${m25.pf.toFixed(2).padStart(5)}` +
    ` | ` +
    // 2024
    `${String(m24.trades).padStart(5)} ` +
    `$${m24.pnl.toFixed(0).padStart(7)} ` +
    `${m24.sharpe.toFixed(2).padStart(6)}` +
    // Deltas
    (base25 ? (
      ` | ` +
      `$${dPnl25 >= 0 ? '+' : ''}${dPnl25.toFixed(0).padStart(6)} ` +
      `Shp${dSh25 >= 0 ? '+' : ''}${dSh25.toFixed(2).padStart(5)} ` +
      `DD${dDD25 >= 0 ? '+' : ''}${dDD25.toFixed(1).padStart(5)}pp`
    ) : '')
  );
}

// ============================================================================
// SWEEP CONFIGS
// ============================================================================
interface SweepConfig {
  label: string;
  lookback: number;
  minDecline: number;
  highBypass: number;
}

const configs: SweepConfig[] = [
  // Baseline
  { label: 'BASELINE (strict)', lookback: 3, minDecline: 0, highBypass: 0 },

  // A) Min decline threshold — only reject if ADX dropped by more than X
  { label: 'A: minDecline=2', lookback: 3, minDecline: 2, highBypass: 0 },
  { label: 'A: minDecline=3', lookback: 3, minDecline: 3, highBypass: 0 },
  { label: 'A: minDecline=5', lookback: 3, minDecline: 5, highBypass: 0 },

  // B) High ADX bypass — skip check if ADX is already strong
  { label: 'B: highBypass=25', lookback: 3, minDecline: 0, highBypass: 25 },
  { label: 'B: highBypass=30', lookback: 3, minDecline: 0, highBypass: 30 },
  { label: 'B: highBypass=35', lookback: 3, minDecline: 0, highBypass: 35 },

  // C) Shorter lookback
  { label: 'C: lookback=2', lookback: 2, minDecline: 0, highBypass: 0 },

  // A+B combos
  { label: 'A+B: dec=2 byp=25', lookback: 3, minDecline: 2, highBypass: 25 },
  { label: 'A+B: dec=3 byp=30', lookback: 3, minDecline: 3, highBypass: 30 },
  { label: 'A+B: dec=3 byp=25', lookback: 3, minDecline: 3, highBypass: 25 },
  { label: 'A+B: dec=2 byp=30', lookback: 3, minDecline: 2, highBypass: 30 },

  // A+B+C combos
  { label: 'A+B+C: d=3 b=30 l=2', lookback: 2, minDecline: 3, highBypass: 30 },
  { label: 'A+B+C: d=2 b=25 l=2', lookback: 2, minDecline: 2, highBypass: 25 },

  // ADX Rising OFF (reference — what if we disable it entirely?)
  { label: 'ADX_RISING=OFF', lookback: 3, minDecline: 999, highBypass: 0 },
];

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' V5.152 — ADX Rising Tolerance Sweep');
  console.log(` Symbols: ${SYMBOLS.join(', ')}`);
  console.log(` Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('Loading data...');
  const data25 = await loadData(Y2025_START, Y2025_END);
  const data24 = await loadData(Y2024_START, Y2024_END);
  console.log(`Loaded: ${Object.keys(data25.allData).length} symbols\n`);

  const original = saveConfig();

  const params25 = { startDate: Y2025_START, endDate: Y2025_END, initialCapital: INITIAL_CAPITAL, symbols: SYMBOLS, leverage: LEVERAGE, postProcess1m: false };
  const params24 = { startDate: Y2024_START, endDate: Y2024_END, initialCapital: INITIAL_CAPITAL, symbols: SYMBOLS, leverage: LEVERAGE, postProcess1m: false };

  // Header
  console.log(
    'Config'.padEnd(28) +
    // 2025
    'Trd'.padStart(5) + ' ' + 'WR%'.padStart(6) + ' ' + 'PnL$'.padStart(8) + ' ' +
    'DD%'.padStart(6) + ' ' + 'Shp'.padStart(6) + ' ' + 'PF'.padStart(5) +
    ' | ' +
    // 2024
    'Trd'.padStart(5) + ' ' + 'PnL$'.padStart(8) + ' ' + 'Shp'.padStart(6) +
    ' | ' +
    'dPnl$'.padStart(7) + ' ' + 'dSharpe'.padStart(9) + ' ' + 'dDD'.padStart(9)
  );
  console.log('-'.repeat(130));

  let base25: M | undefined;
  let base24: M | undefined;
  const results: { label: string; m25: M; m24: M; cfg: SweepConfig }[] = [];

  for (const cfg of configs) {
    restoreConfig(original);
    if (cfg.label === 'ADX_RISING=OFF') {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_RISING_ENABLED = false;
    } else {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_RISING_ENABLED = true;
      applyConfig(cfg);
    }

    const r25 = await runBacktestComputation({ params: params25, ...data25 });
    const r24 = await runBacktestComputation({ params: params24, ...data24 });
    const m25 = metrics(r25);
    const m24 = metrics(r24);

    if (!base25) { base25 = m25; base24 = m24; }
    console.log(fmtRow(cfg.label, m25, m24, cfg === configs[0] ? undefined : base25, cfg === configs[0] ? undefined : base24));

    results.push({ label: cfg.label, m25, m24, cfg });
  }

  // ============================================================================
  // RANKING
  // ============================================================================
  console.log('\n\n═══════════════════════ RANKING (by 2025 Sharpe) ═══════════════════════\n');
  const ranked = [...results].sort((a, b) => b.m25.sharpe - a.m25.sharpe);
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    const tag = i === 0 ? ' ✅ BEST' : '';
    console.log(
      `#${i + 1} ${r.label.padEnd(28)} ` +
      `Sharpe ${r.m25.sharpe.toFixed(2)} | PnL $${r.m25.pnl.toFixed(0)} | DD ${r.m25.dd.toFixed(1)}% | ` +
      `2024: $${r.m24.pnl.toFixed(0)}${tag}`
    );
  }

  // ============================================================================
  // WALK-FORWARD on top 3
  // ============================================================================
  const top3 = ranked.filter(r => r.label !== 'BASELINE (strict)').slice(0, 3);
  console.log('\n\n═══════════════════════ WALK-FORWARD (Top 3) ═══════════════════════\n');

  const dataH1 = await loadData(H1_START, H1_END);
  const dataH2 = await loadData(H2_START, H2_END);
  const paramsH1 = { ...params25, startDate: H1_START, endDate: H1_END };
  const paramsH2 = { ...params25, startDate: H2_START, endDate: H2_END };

  // Walk-forward baseline
  restoreConfig(original);
  const baseH1 = metrics(await runBacktestComputation({ params: paramsH1, ...dataH1 }));
  const baseH2 = metrics(await runBacktestComputation({ params: paramsH2, ...dataH2 }));
  console.log(`BASELINE           H1: ${baseH1.trades}t, $${baseH1.pnl.toFixed(0)}, Shp ${baseH1.sharpe.toFixed(2)}, DD ${baseH1.dd.toFixed(1)}%  |  H2: ${baseH2.trades}t, $${baseH2.pnl.toFixed(0)}, Shp ${baseH2.sharpe.toFixed(2)}, DD ${baseH2.dd.toFixed(1)}%`);

  for (const r of top3) {
    restoreConfig(original);
    if (r.label === 'ADX_RISING=OFF') {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_RISING_ENABLED = false;
    } else {
      applyConfig(r.cfg);
    }

    const h1 = metrics(await runBacktestComputation({ params: paramsH1, ...dataH1 }));
    const h2 = metrics(await runBacktestComputation({ params: paramsH2, ...dataH2 }));

    const h1Pass = h1.sharpe >= baseH1.sharpe * 0.9 && h1.pnl >= baseH1.pnl * 0.8;
    const h2Pass = h2.sharpe >= baseH2.sharpe * 0.9 && h2.pnl >= baseH2.pnl * 0.8;
    const verdict = h1Pass && h2Pass ? '✅ PASS' : h1Pass || h2Pass ? '⚠️ PARTIAL' : '❌ FAIL';

    console.log(
      `${r.label.padEnd(28)} ` +
      `H1: ${h1.trades}t, $${h1.pnl.toFixed(0)}, Shp ${h1.sharpe.toFixed(2)}, DD ${h1.dd.toFixed(1)}%  |  ` +
      `H2: ${h2.trades}t, $${h2.pnl.toFixed(0)}, Shp ${h2.sharpe.toFixed(2)}, DD ${h2.dd.toFixed(1)}%  ` +
      verdict
    );
  }

  // Restore original config
  restoreConfig(original);
  (MomentumConfig.ENTRY_QUALITY as any).ADX_RISING_ENABLED = true;

  console.log('\nDone!');
}

main().catch(console.error);
