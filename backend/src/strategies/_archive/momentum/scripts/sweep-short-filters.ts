/**
 * V5.144: Comprehensive SHORT filter sweep
 *
 * Tests different SHORT filter combinations to improve SHORT performance:
 * 1. ADX minimum threshold for SHORT (0, 15, 20, 25, 30)
 * 2. Volume multiplier for SHORT (1.0, 1.3, 1.5, 2.0)
 * 3. ROC5 threshold for SHORT (-1.0%, -1.5%, -2.0%, -2.5%, -3.0%)
 * 4. Wick rejection filter for SHORT (OFF, 0.3, 0.4, 0.5, 0.6)
 * 5. Combo test: best of each dimension + manual hypotheses
 *
 * Each config runs a FULL compounded backtest via runBacktestComputation().
 * Includes H1/H2 walk-forward for top 3 configs.
 *
 * Usage: cd backend && npx tsx scripts/sweep-short-filters.ts
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
const START = new Date('2025-01-01T00:00:00.000Z');
const END = new Date('2025-12-31T00:00:00.000Z');
const H1_START = new Date('2025-01-01T00:00:00.000Z');
const H1_END = new Date('2025-06-30T23:59:59.000Z');
const H2_START = new Date('2025-07-01T00:00:00.000Z');
const H2_END = new Date('2025-12-31T00:00:00.000Z');

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  const since = START.getTime() - 400 * CANDLE_15M_MS; // Extra warmup for SMA200 + ADX
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, END.getTime());
  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) continue;
    allData[symbol] = sliceCandlesByTime(local.candles, since, END.getTime());
  }
  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  return { btcCandles, btcCandlesRegime: btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// CONFIG SAVE / RESTORE
// ============================================================================
function saveShortConfig() {
  return {
    ROC_DROP_MIN: MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN,
    VOL_SPIKE: MomentumConfig.ENTRY_SHORT.VOL_SPIKE,
    ADX_MIN_SHORT: (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT ?? 0,
    WICK_REJECTION_SHORT_ENABLED: (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED ?? false,
    WICK_REJECTION_SHORT_THRESHOLD: (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD ?? 0.4,
  };
}

function restoreShortConfig(saved: ReturnType<typeof saveShortConfig>) {
  MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = saved.ROC_DROP_MIN;
  MomentumConfig.ENTRY_SHORT.VOL_SPIKE = saved.VOL_SPIKE;
  (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = saved.ADX_MIN_SHORT;
  (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = saved.WICK_REJECTION_SHORT_ENABLED;
  (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = saved.WICK_REJECTION_SHORT_THRESHOLD;
}

function resetToBaseline(saved: ReturnType<typeof saveShortConfig>) {
  restoreShortConfig(saved);
}

// ============================================================================
// METRICS HELPERS
// ============================================================================

/** Compute SHORT-only metrics from trades */
function shortMetrics(trades: BacktestTrade[]) {
  const shorts = trades.filter(t => t.side === 'short');
  const wins = shorts.filter(t => t.netPnlUsd > 0).length;
  const losses = shorts.filter(t => t.netPnlUsd <= 0).length;
  const slTrades = shorts.filter(t => t.exitReason.includes('STOP_LOSS'));
  const pnl = shorts.reduce((s, t) => s + t.netPnlUsd, 0);
  const grossWins = shorts.filter(t => t.netPnlUsd > 0).reduce((s, t) => s + t.netPnlUsd, 0);
  const grossLosses = Math.abs(shorts.filter(t => t.netPnlUsd <= 0).reduce((s, t) => s + t.netPnlUsd, 0));
  const pf = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 999 : 0;

  // Per-symbol SHORT PnL
  const symbolPnl: Record<string, number> = {};
  for (const t of shorts) {
    symbolPnl[t.symbol] = (symbolPnl[t.symbol] ?? 0) + t.netPnlUsd;
  }

  return {
    count: shorts.length,
    wins,
    losses,
    wr: shorts.length > 0 ? (wins / shorts.length) * 100 : 0,
    pnl,
    pf,
    slRate: shorts.length > 0 ? (slTrades.length / shorts.length) * 100 : 0,
    symbolPnl,
  };
}

/** Compute overall metrics from BacktestResult */
function overallMetrics(r: BacktestResult) {
  const s = r.summary;
  return {
    trades: s.totalTrades,
    wr: s.winRate,
    pnl: s.totalPnlUsd,
    dd: s.maxDrawdownPct,
    sharpe: s.sharpeRatio,
    pf: s.profitFactor,
    longs: s.longTrades,
    shorts: s.shortTrades,
  };
}

// ============================================================================
// FORMATTERS
// ============================================================================

type OMetrics = ReturnType<typeof overallMetrics>;
type SMetrics = ReturnType<typeof shortMetrics>;

function fmtRow(label: string, o: OMetrics, sh: SMetrics,
  baseline?: { o: OMetrics; sh: SMetrics }) {
  const dPnl = baseline ? o.pnl - baseline.o.pnl : 0;
  const dSh = baseline ? o.sharpe - baseline.o.sharpe : 0;
  const dDD = baseline ? o.dd - baseline.o.dd : 0;
  const dShortPnl = baseline ? sh.pnl - baseline.sh.pnl : 0;
  const dShortWr = baseline ? sh.wr - baseline.sh.wr : 0;

  const tag = !baseline ? '  BASE' :
    (sh.pnl > baseline.sh.pnl && o.sharpe >= baseline.o.sharpe) ? '  +++' :
    (sh.pnl > baseline.sh.pnl) ? '  ++' :
    (o.sharpe > baseline.o.sharpe) ? '  +' : '';

  return (
    label.padEnd(24) +
    `${String(o.trades).padStart(5)} ` +
    `${o.wr.toFixed(1).padStart(5)}% ` +
    `$${o.pnl.toFixed(0).padStart(7)} ` +
    `${o.dd.toFixed(1).padStart(5)}% ` +
    `${o.sharpe.toFixed(2).padStart(6)} ` +
    `${o.pf.toFixed(2).padStart(5)} ` +
    ` | ` +
    `${String(sh.count).padStart(4)} ` +
    `${sh.wr.toFixed(1).padStart(5)}% ` +
    `$${sh.pnl.toFixed(0).padStart(7)} ` +
    `${sh.pf.toFixed(2).padStart(5)} ` +
    `${sh.slRate.toFixed(1).padStart(5)}% ` +
    (baseline ? (
      ` | ` +
      `$${dPnl >= 0 ? '+' : ''}${dPnl.toFixed(0).padStart(6)} ` +
      `${dSh >= 0 ? '+' : ''}${dSh.toFixed(2).padStart(5)} ` +
      `${dDD >= 0 ? '+' : ''}${dDD.toFixed(1).padStart(5)}pp ` +
      `$SH${dShortPnl >= 0 ? '+' : ''}${dShortPnl.toFixed(0).padStart(6)} ` +
      `WR${dShortWr >= 0 ? '+' : ''}${dShortWr.toFixed(1).padStart(5)}pp` +
      tag
    ) : '')
  );
}

function printHeader(title: string) {
  console.log(`\n${'='.repeat(170)}`);
  console.log(`  ${title}`);
  console.log(`${'='.repeat(170)}`);
  console.log(
    'Config'.padEnd(24) +
    'Trd'.padStart(5) + ' ' +
    'WR%'.padStart(6) + ' ' +
    'PnL$'.padStart(8) + ' ' +
    'DD%'.padStart(6) + ' ' +
    'Shp'.padStart(6) + ' ' +
    'PF'.padStart(5) +
    ' | ' +
    'ShTr'.padStart(4) + ' ' +
    'ShWR%'.padStart(6) + ' ' +
    'ShPnl$'.padStart(8) + ' ' +
    'ShPF'.padStart(5) + ' ' +
    'ShSL%'.padStart(6) +
    ' | ' +
    'dPnl$'.padStart(7) + ' ' +
    'dShp'.padStart(6) + ' ' +
    'dDD'.padStart(7) + ' ' +
    'dShPnl'.padStart(9) + ' ' +
    'dShWR'.padStart(9)
  );
  console.log('-'.repeat(170));
}

// ============================================================================
// MAIN
// ============================================================================

interface SweepResult {
  label: string;
  o: OMetrics;
  sh: SMetrics;
  config: ReturnType<typeof saveShortConfig>;
}

async function main() {
  console.log('============================================================');
  console.log('  V5.144 SHORT FILTER SWEEP');
  console.log(`  Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`  Period: ${START.toISOString().slice(0,10)} to ${END.toISOString().slice(0,10)}`);
  console.log(`  Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log('============================================================\n');

  console.log('Loading data...');
  const data = await loadData();
  console.log(`Loaded BTC: ${data.btcCandles.length} candles, Symbols: ${Object.keys(data.allData).length}`);

  const baseParams = {
    startDate: START,
    endDate: END,
    initialCapital: INITIAL_CAPITAL,
    symbols: SYMBOLS,
    leverage: LEVERAGE,
    postProcess1m: false,
  };

  // Save original config
  const originalConfig = saveShortConfig();

  // ============================================================================
  // BASELINE
  // ============================================================================
  console.log('\nRunning BASELINE...');
  const baselineResult = await runBacktestComputation({ params: baseParams, ...data });
  const bO = overallMetrics(baselineResult);
  const bSh = shortMetrics(baselineResult.trades);
  const baseRef = { o: bO, sh: bSh };

  printHeader('BASELINE');
  console.log(fmtRow('BASELINE (current)', bO, bSh));

  // Per-symbol SHORT breakdown
  console.log('\n  Per-symbol SHORT PnL:');
  const sortedSymbols = Object.entries(bSh.symbolPnl).sort((a, b) => b[1] - a[1]);
  for (const [sym, pnl] of sortedSymbols) {
    const symShorts = baselineResult.trades.filter(t => t.side === 'short' && t.symbol === sym);
    const symWins = symShorts.filter(t => t.netPnlUsd > 0).length;
    const symWR = symShorts.length > 0 ? (symWins / symShorts.length) * 100 : 0;
    const symSL = symShorts.filter(t => t.exitReason.includes('STOP_LOSS')).length;
    console.log(`    ${sym.padEnd(20)} ${String(symShorts.length).padStart(3)} trades, WR ${symWR.toFixed(0).padStart(2)}%, SL ${symSL}, PnL $${pnl.toFixed(0).padStart(6)} ${pnl > 0 ? '+' : '-'}`);
  }

  // Collect all results for ranking
  const allResults: SweepResult[] = [];

  // ============================================================================
  // SWEEP 1: ADX MINIMUM THRESHOLD FOR SHORT
  // ============================================================================
  printHeader('SWEEP 1: ADX Minimum for SHORT');
  const adxThresholds = [0, 15, 20, 25, 30];
  for (const adxMin of adxThresholds) {
    resetToBaseline(originalConfig);
    (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = adxMin;

    const label = adxMin === 0 ? 'ADX_MIN=OFF (base)' : `ADX_MIN=${adxMin}`;
    const result = await runBacktestComputation({ params: baseParams, ...data });
    const o = overallMetrics(result);
    const sh = shortMetrics(result.trades);
    console.log(fmtRow(label, o, sh, adxMin === 0 ? undefined : baseRef));

    if (adxMin > 0) {
      allResults.push({ label, o, sh, config: { ...originalConfig, ADX_MIN_SHORT: adxMin } });
    }
  }

  // ============================================================================
  // SWEEP 2: VOLUME MULTIPLIER FOR SHORT
  // ============================================================================
  printHeader('SWEEP 2: Volume Multiplier for SHORT');
  const volMultipliers = [1.0, 1.3, 1.5, 2.0];
  for (const vol of volMultipliers) {
    resetToBaseline(originalConfig);
    MomentumConfig.ENTRY_SHORT.VOL_SPIKE = vol;

    const isBase = vol === originalConfig.VOL_SPIKE;
    const label = isBase ? `VOL=${vol.toFixed(1)}x (base)` : `VOL=${vol.toFixed(1)}x`;
    const result = await runBacktestComputation({ params: baseParams, ...data });
    const o = overallMetrics(result);
    const sh = shortMetrics(result.trades);
    console.log(fmtRow(label, o, sh, isBase ? undefined : baseRef));

    if (!isBase) {
      allResults.push({ label, o, sh, config: { ...originalConfig, VOL_SPIKE: vol } });
    }
  }

  // ============================================================================
  // SWEEP 3: ROC5 THRESHOLD FOR SHORT
  // ============================================================================
  printHeader('SWEEP 3: ROC5 Threshold for SHORT');
  const roc5Thresholds = [-0.010, -0.015, -0.020, -0.025, -0.030];
  for (const roc of roc5Thresholds) {
    resetToBaseline(originalConfig);
    MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = roc;

    const isBase = roc === originalConfig.ROC_DROP_MIN;
    const label = isBase ? `ROC5<=${(roc * 100).toFixed(1)}% (base)` : `ROC5<=${(roc * 100).toFixed(1)}%`;
    const result = await runBacktestComputation({ params: baseParams, ...data });
    const o = overallMetrics(result);
    const sh = shortMetrics(result.trades);
    console.log(fmtRow(label, o, sh, isBase ? undefined : baseRef));

    if (!isBase) {
      allResults.push({ label, o, sh, config: { ...originalConfig, ROC_DROP_MIN: roc } });
    }
  }

  // ============================================================================
  // SWEEP 4: WICK REJECTION FILTER FOR SHORT
  // ============================================================================
  printHeader('SWEEP 4: Wick Rejection Filter for SHORT');
  const wickThresholds = [0, 0.3, 0.4, 0.5, 0.6];
  for (const wick of wickThresholds) {
    resetToBaseline(originalConfig);
    if (wick > 0) {
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = wick;
    } else {
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = false;
    }

    const label = wick === 0 ? 'WICK_REJ=OFF (base)' : `WICK_REJ>${(wick * 100).toFixed(0)}%`;
    const result = await runBacktestComputation({ params: baseParams, ...data });
    const o = overallMetrics(result);
    const sh = shortMetrics(result.trades);
    console.log(fmtRow(label, o, sh, wick === 0 ? undefined : baseRef));

    if (wick > 0) {
      allResults.push({
        label, o, sh,
        config: { ...originalConfig, WICK_REJECTION_SHORT_ENABLED: true, WICK_REJECTION_SHORT_THRESHOLD: wick },
      });
    }
  }

  // ============================================================================
  // SWEEP 5: COMBO — best of each dimension + manual hypotheses
  // ============================================================================
  printHeader('SWEEP 5: Combo Tests');

  // Find best single-dimension winners by SHORT PnL improvement
  const bestAdx = allResults
    .filter(r => r.label.startsWith('ADX_MIN'))
    .sort((a, b) => b.sh.pnl - a.sh.pnl)[0];
  const bestVol = allResults
    .filter(r => r.label.startsWith('VOL'))
    .sort((a, b) => b.sh.pnl - a.sh.pnl)[0];
  const bestRoc = allResults
    .filter(r => r.label.startsWith('ROC5'))
    .sort((a, b) => b.sh.pnl - a.sh.pnl)[0];
  const bestWick = allResults
    .filter(r => r.label.startsWith('WICK'))
    .sort((a, b) => b.sh.pnl - a.sh.pnl)[0];

  console.log(`\n  Best single-dimension winners (by SHORT PnL):`);
  if (bestAdx) console.log(`    ADX:  ${bestAdx.label} -> SHORT PnL $${bestAdx.sh.pnl.toFixed(0)} (delta $${(bestAdx.sh.pnl - bSh.pnl).toFixed(0)})`);
  if (bestVol) console.log(`    VOL:  ${bestVol.label} -> SHORT PnL $${bestVol.sh.pnl.toFixed(0)} (delta $${(bestVol.sh.pnl - bSh.pnl).toFixed(0)})`);
  if (bestRoc) console.log(`    ROC:  ${bestRoc.label} -> SHORT PnL $${bestRoc.sh.pnl.toFixed(0)} (delta $${(bestRoc.sh.pnl - bSh.pnl).toFixed(0)})`);
  if (bestWick) console.log(`    WICK: ${bestWick.label} -> SHORT PnL $${bestWick.sh.pnl.toFixed(0)} (delta $${(bestWick.sh.pnl - bSh.pnl).toFixed(0)})`);
  console.log('');

  // Build combo configs
  const combos: { label: string; setup: () => void }[] = [];

  // Combo 1: Best ADX + Best Vol
  if (bestAdx && bestVol) {
    combos.push({
      label: `${bestAdx.label}+${bestVol.label}`.slice(0, 23),
      setup: () => {
        (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = bestAdx.config.ADX_MIN_SHORT;
        MomentumConfig.ENTRY_SHORT.VOL_SPIKE = bestVol.config.VOL_SPIKE;
      },
    });
  }

  // Combo 2: Best ADX + Best ROC
  if (bestAdx && bestRoc) {
    combos.push({
      label: `${bestAdx.label}+${bestRoc.label}`.slice(0, 23),
      setup: () => {
        (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = bestAdx.config.ADX_MIN_SHORT;
        MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = bestRoc.config.ROC_DROP_MIN;
      },
    });
  }

  // Combo 3: Best ADX + Best Wick
  if (bestAdx && bestWick) {
    combos.push({
      label: `${bestAdx.label}+${bestWick.label}`.slice(0, 23),
      setup: () => {
        (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = bestAdx.config.ADX_MIN_SHORT;
        (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
        (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = bestWick.config.WICK_REJECTION_SHORT_THRESHOLD;
      },
    });
  }

  // Combo 4: Best ROC + Best Vol
  if (bestRoc && bestVol) {
    combos.push({
      label: `${bestRoc.label}+${bestVol.label}`.slice(0, 23),
      setup: () => {
        MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = bestRoc.config.ROC_DROP_MIN;
        MomentumConfig.ENTRY_SHORT.VOL_SPIKE = bestVol.config.VOL_SPIKE;
      },
    });
  }

  // Combo 5: Best ADX + Best Vol + Best ROC
  if (bestAdx && bestVol && bestRoc) {
    combos.push({
      label: `ADX+VOL+ROC best`,
      setup: () => {
        (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = bestAdx.config.ADX_MIN_SHORT;
        MomentumConfig.ENTRY_SHORT.VOL_SPIKE = bestVol.config.VOL_SPIKE;
        MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = bestRoc.config.ROC_DROP_MIN;
      },
    });
  }

  // Combo 6: ALL four best
  if (bestAdx && bestVol && bestRoc && bestWick) {
    combos.push({
      label: `ALL_BEST`,
      setup: () => {
        (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = bestAdx.config.ADX_MIN_SHORT;
        MomentumConfig.ENTRY_SHORT.VOL_SPIKE = bestVol.config.VOL_SPIKE;
        MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = bestRoc.config.ROC_DROP_MIN;
        (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
        (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = bestWick.config.WICK_REJECTION_SHORT_THRESHOLD;
      },
    });
  }

  // Combo 7: Manual — AGGRESSIVE (ADX>=25, ROC<=-2%, Vol>=1.3)
  combos.push({
    label: `AGGRESSIVE`,
    setup: () => {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = 25;
      MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = -0.020;
      MomentumConfig.ENTRY_SHORT.VOL_SPIKE = 1.3;
    },
  });

  // Combo 8: CONSERVATIVE (ADX>=20, ROC<=-2%, Wick>40%)
  combos.push({
    label: `CONSERVATIVE`,
    setup: () => {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = 20;
      MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN = -0.020;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = 0.4;
    },
  });

  // Combo 9: QUALITY_GATE (ADX>=20, Vol>=1.3, Wick>30%)
  combos.push({
    label: `QUALITY_GATE`,
    setup: () => {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = 20;
      MomentumConfig.ENTRY_SHORT.VOL_SPIKE = 1.3;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = 0.3;
    },
  });

  // Combo 10: MINIMAL (just ADX>=20 + Wick>30%)
  combos.push({
    label: `MINIMAL_ADX20+WICK30`,
    setup: () => {
      (MomentumConfig.ENTRY_QUALITY as any).ADX_MIN_SHORT = 20;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_ENABLED = true;
      (MomentumConfig.ENTRY_QUALITY as any).WICK_REJECTION_SHORT_THRESHOLD = 0.3;
    },
  });

  for (const combo of combos) {
    resetToBaseline(originalConfig);
    combo.setup();

    const result = await runBacktestComputation({ params: baseParams, ...data });
    const o = overallMetrics(result);
    const sh = shortMetrics(result.trades);
    console.log(fmtRow(combo.label, o, sh, baseRef));

    allResults.push({ label: combo.label, o, sh, config: saveShortConfig() });
  }

  // ============================================================================
  // RANKING
  // ============================================================================
  console.log(`\n${'='.repeat(170)}`);
  console.log('  RANKING: Top 10 by SHORT PnL improvement');
  console.log(`${'='.repeat(170)}`);

  const ranked = [...allResults].sort((a, b) => b.sh.pnl - a.sh.pnl);
  printHeader('TOP 10 BY SHORT PNL');
  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i];
    console.log(fmtRow(`#${i + 1} ${r.label}`, r.o, r.sh, baseRef));
  }

  // Also rank by overall Sharpe
  console.log('');
  printHeader('TOP 10 BY OVERALL SHARPE');
  const rankedSharpe = [...allResults].sort((a, b) => b.o.sharpe - a.o.sharpe);
  for (let i = 0; i < Math.min(10, rankedSharpe.length); i++) {
    const r = rankedSharpe[i];
    console.log(fmtRow(`#${i + 1} ${r.label}`, r.o, r.sh, baseRef));
  }

  // Rank by SHORT WR
  console.log('');
  printHeader('TOP 10 BY SHORT WIN RATE');
  const rankedShWR = [...allResults].sort((a, b) => b.sh.wr - a.sh.wr);
  for (let i = 0; i < Math.min(10, rankedShWR.length); i++) {
    const r = rankedShWR[i];
    console.log(fmtRow(`#${i + 1} ${r.label}`, r.o, r.sh, baseRef));
  }

  // ============================================================================
  // WALK-FORWARD: H1/H2 for top 3 configs (by SHORT PnL)
  // ============================================================================
  console.log(`\n${'='.repeat(170)}`);
  console.log('  WALK-FORWARD: H1 (Jan-Jun) / H2 (Jul-Dec) for top 3 by SHORT PnL');
  console.log(`${'='.repeat(170)}`);

  const top3 = ranked.slice(0, 3);

  // Run baseline H1/H2
  resetToBaseline(originalConfig);
  const baseH1Params = { ...baseParams, startDate: H1_START, endDate: H1_END };
  const baseH2Params = { ...baseParams, startDate: H2_START, endDate: H2_END };

  console.log('\nRunning BASELINE H1/H2...');
  const baseH1 = await runBacktestComputation({ params: baseH1Params, ...data });
  const baseH2 = await runBacktestComputation({ params: baseH2Params, ...data });
  const baseH1O = overallMetrics(baseH1);
  const baseH1Sh = shortMetrics(baseH1.trades);
  const baseH2O = overallMetrics(baseH2);
  const baseH2Sh = shortMetrics(baseH2.trades);

  for (const top of top3) {
    console.log(`\n--- ${top.label} ---`);

    // Apply this config
    resetToBaseline(originalConfig);
    restoreShortConfig(top.config);

    const h1 = await runBacktestComputation({ params: baseH1Params, ...data });
    const h2 = await runBacktestComputation({ params: baseH2Params, ...data });
    const h1O = overallMetrics(h1);
    const h1Sh = shortMetrics(h1.trades);
    const h2O = overallMetrics(h2);
    const h2Sh = shortMetrics(h2.trades);

    console.log(`  H1 BASELINE:  ${baseH1O.trades} trd, WR ${baseH1O.wr.toFixed(1)}%, $${baseH1O.pnl.toFixed(0)} PnL, ${baseH1O.dd.toFixed(1)}% DD, Sh ${baseH1O.sharpe.toFixed(2)} | SHORT: ${baseH1Sh.count} trd, ${baseH1Sh.wr.toFixed(1)}% WR, $${baseH1Sh.pnl.toFixed(0)}`);
    console.log(`  H1 FILTERED:  ${h1O.trades} trd, WR ${h1O.wr.toFixed(1)}%, $${h1O.pnl.toFixed(0)} PnL, ${h1O.dd.toFixed(1)}% DD, Sh ${h1O.sharpe.toFixed(2)} | SHORT: ${h1Sh.count} trd, ${h1Sh.wr.toFixed(1)}% WR, $${h1Sh.pnl.toFixed(0)}`);
    console.log(`  H1 Delta: PnL $${(h1O.pnl - baseH1O.pnl).toFixed(0)}, Sharpe ${(h1O.sharpe - baseH1O.sharpe) >= 0 ? '+' : ''}${(h1O.sharpe - baseH1O.sharpe).toFixed(2)}, SHORT PnL $${(h1Sh.pnl - baseH1Sh.pnl).toFixed(0)}, SHORT WR ${(h1Sh.wr - baseH1Sh.wr) >= 0 ? '+' : ''}${(h1Sh.wr - baseH1Sh.wr).toFixed(1)}pp`);
    console.log('');
    console.log(`  H2 BASELINE:  ${baseH2O.trades} trd, WR ${baseH2O.wr.toFixed(1)}%, $${baseH2O.pnl.toFixed(0)} PnL, ${baseH2O.dd.toFixed(1)}% DD, Sh ${baseH2O.sharpe.toFixed(2)} | SHORT: ${baseH2Sh.count} trd, ${baseH2Sh.wr.toFixed(1)}% WR, $${baseH2Sh.pnl.toFixed(0)}`);
    console.log(`  H2 FILTERED:  ${h2O.trades} trd, WR ${h2O.wr.toFixed(1)}%, $${h2O.pnl.toFixed(0)} PnL, ${h2O.dd.toFixed(1)}% DD, Sh ${h2O.sharpe.toFixed(2)} | SHORT: ${h2Sh.count} trd, ${h2Sh.wr.toFixed(1)}% WR, $${h2Sh.pnl.toFixed(0)}`);
    console.log(`  H2 Delta: PnL $${(h2O.pnl - baseH2O.pnl).toFixed(0)}, Sharpe ${(h2O.sharpe - baseH2O.sharpe) >= 0 ? '+' : ''}${(h2O.sharpe - baseH2O.sharpe).toFixed(2)}, SHORT PnL $${(h2Sh.pnl - baseH2Sh.pnl).toFixed(0)}, SHORT WR ${(h2Sh.wr - baseH2Sh.wr) >= 0 ? '+' : ''}${(h2Sh.wr - baseH2Sh.wr).toFixed(1)}pp`);

    // Stability check
    const h1ShortBetter = h1Sh.pnl > baseH1Sh.pnl;
    const h2ShortBetter = h2Sh.pnl > baseH2Sh.pnl;
    const verdict = h1ShortBetter && h2ShortBetter ? 'PASS (SHORT better in BOTH halves)'
      : h1ShortBetter || h2ShortBetter ? 'PARTIAL (SHORT better in one half only)'
      : 'FAIL (SHORT worse in both halves)';
    console.log(`  => ${verdict}`);
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log(`\n${'='.repeat(80)}`);
  console.log('  SUMMARY');
  console.log(`${'='.repeat(80)}`);
  console.log(`\n  Baseline SHORT: ${bSh.count} trades, ${bSh.wr.toFixed(1)}% WR, $${bSh.pnl.toFixed(0)} PnL, ${bSh.pf.toFixed(2)} PF, ${bSh.slRate.toFixed(1)}% SL rate`);
  console.log(`  Baseline LONG:  ${bO.longs} trades`);
  console.log(`  Baseline COMBINED: ${bO.trades} trades, $${bO.pnl.toFixed(0)} PnL, Sharpe ${bO.sharpe.toFixed(2)}, DD ${bO.dd.toFixed(1)}%\n`);

  if (ranked.length > 0 && ranked[0].sh.pnl > bSh.pnl) {
    const best = ranked[0];
    console.log(`  BEST SHORT PnL:  ${best.label}`);
    console.log(`    SHORT: ${best.sh.count} trades (${bSh.count - best.sh.count} filtered), ${best.sh.wr.toFixed(1)}% WR, $${best.sh.pnl.toFixed(0)} PnL, ${best.sh.pf.toFixed(2)} PF, ${best.sh.slRate.toFixed(1)}% SL`);
    console.log(`    OVERALL: ${best.o.trades} trades, $${best.o.pnl.toFixed(0)} PnL, Sharpe ${best.o.sharpe.toFixed(2)}, DD ${best.o.dd.toFixed(1)}%`);
    console.log(`    Delta vs baseline: SHORT PnL $${(best.sh.pnl - bSh.pnl).toFixed(0)}, SHORT WR ${(best.sh.wr - bSh.wr).toFixed(1)}pp, Overall PnL $${(best.o.pnl - bO.pnl).toFixed(0)}, Sharpe ${(best.o.sharpe - bO.sharpe).toFixed(2)}`);
  } else {
    console.log('  No config improved SHORT PnL vs baseline.');
  }

  if (rankedSharpe.length > 0 && rankedSharpe[0].o.sharpe > bO.sharpe) {
    const bestSh = rankedSharpe[0];
    console.log(`\n  BEST SHARPE:  ${bestSh.label}`);
    console.log(`    OVERALL: ${bestSh.o.trades} trades, $${bestSh.o.pnl.toFixed(0)} PnL, Sharpe ${bestSh.o.sharpe.toFixed(2)}, DD ${bestSh.o.dd.toFixed(1)}%`);
    console.log(`    SHORT: ${bestSh.sh.count} trades, ${bestSh.sh.wr.toFixed(1)}% WR, $${bestSh.sh.pnl.toFixed(0)} PnL`);
  }

  // Reset config
  restoreShortConfig(originalConfig);
  console.log('\nConfig restored to original values. Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
