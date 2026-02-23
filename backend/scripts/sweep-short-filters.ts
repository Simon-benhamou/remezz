/**
 * sweep-short-filters.ts — Parameter sweep for SHORT entry filters
 *
 * HYPOTHESIS: SHORT filters (ROC5, Volume, BB Lower) are too strict,
 * causing late entries when the breakout is already exhausted.
 *
 * PHASE 1: Sweep ROC5 × Volume × BB Lower (40 configs)
 * PHASE 2: Take top 5 from Phase 1, add ROC_ACCEL × MA20 (30 configs)
 *
 * In-sample: DOGE, IMX, AVAX, FET, WIF
 * OOS: ADA, DOT, STX, TIA
 *
 * Usage:
 *   npx tsx scripts/sweep-short-filters.ts
 *   npx tsx scripts/sweep-short-filters.ts --phase2       # Run both phases
 *   npx tsx scripts/sweep-short-filters.ts --oos-only     # Skip in-sample, run OOS on top configs
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// SYMBOL SETS
// ============================================================================
const IN_SAMPLE_SYMBOLS = [
  'DOGE/USDT:USDT', 'IMX/USDT:USDT', 'AVAX/USDT:USDT',
  'FET/USDT:USDT', 'WIF/USDT:USDT',
];
const OOS_SYMBOLS = [
  'ADA/USDT:USDT', 'DOT/USDT:USDT', 'STX/USDT:USDT', 'TIA/USDT:USDT',
];
const ALL_SYMBOLS = [...IN_SAMPLE_SYMBOLS, ...OOS_SYMBOLS];

// ============================================================================
// PARAMETER GRID
// ============================================================================

// Phase 1: The 3 main suspects
const ROC5_VALUES = [-0.005, -0.0075, -0.01, -0.0125, -0.015]; // -0.5% to -1.5%
const VOL_VALUES  = [1.0, 1.25, 1.5, 2.0];                      // 1x to 2x
const BB_VALUES   = [true, false];                                // BB lower on/off

// Phase 2: Additional params (tested on top configs from phase 1)
const ROC_ACCEL_VALUES = [0.0, 0.005, 0.01];   // max ROC acceleration allowed
const MA20_VALUES      = [true, false];          // price < MA20 on/off

// ============================================================================
// BACKTEST PARAMS
// ============================================================================
const PARAMS = {
  startDate: new Date('2024-06-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: ALL_SYMBOLS,
  leverage: 5,
};

// ============================================================================
// TYPES
// ============================================================================
interface ConfigOverride {
  label: string;
  roc5: number;
  vol: number;
  bbLower: boolean;
  rocAccel: number;
  ma20: boolean;
}

interface RunResult {
  config: ConfigOverride;
  trades: number;
  shortTrades: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  // Per-set breakdown
  inSampleTrades: number;
  inSamplePnl: number;
  inSampleWR: number;
  oosTrades: number;
  oosPnl: number;
  oosWR: number;
}

// ============================================================================
// DATA LOADING (once, reused for all configs)
// ============================================================================
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * 15 * 60 * 1000; // warmup for SMA200

  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btcLocal || !btc1hLocal) throw new Error('No local BTC data — run candle cache update first');

  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandlesRegime = sliceCandlesByTime(btc1hLocal.candles, since, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of ALL_SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) {
      console.warn(`⚠️  No local data for ${symbol}, skipping`);
      continue;
    }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// CONFIG SNAPSHOT / RESTORE
// ============================================================================
function snapshotShortConfig() {
  return {
    ROC_DROP_MIN: MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN,
    VOL_SPIKE: MomentumConfig.ENTRY_SHORT.VOL_SPIKE,
    PRICE_BELOW_BB_LOWER: false, // V5.125: BB Lower permanently removed
    PRICE_BELOW_MA20: MomentumConfig.ENTRY_SHORT.PRICE_BELOW_MA20,
    SHORT_MAX_ROC_ACCEL: MomentumConfig.CANDLE_PATTERN_FILTER.SHORT_MAX_ROC_ACCEL,
  };
}

function applyConfig(cfg: ConfigOverride) {
  (MomentumConfig.ENTRY_SHORT as any).ROC_DROP_MIN = cfg.roc5;
  (MomentumConfig.ENTRY_SHORT as any).VOL_SPIKE = cfg.vol;
  // BB Lower permanently removed in V5.125 (no config field to set)
  (MomentumConfig.ENTRY_SHORT as any).PRICE_BELOW_MA20 = cfg.ma20;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).SHORT_MAX_ROC_ACCEL = cfg.rocAccel;
}

function restoreConfig(snap: ReturnType<typeof snapshotShortConfig>) {
  (MomentumConfig.ENTRY_SHORT as any).ROC_DROP_MIN = snap.ROC_DROP_MIN;
  (MomentumConfig.ENTRY_SHORT as any).VOL_SPIKE = snap.VOL_SPIKE;
  // BB Lower permanently removed in V5.125 (no config field to restore)
  (MomentumConfig.ENTRY_SHORT as any).PRICE_BELOW_MA20 = snap.PRICE_BELOW_MA20;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).SHORT_MAX_ROC_ACCEL = snap.SHORT_MAX_ROC_ACCEL;
}

// ============================================================================
// RUN SINGLE CONFIG
// ============================================================================
async function runConfig(
  cfg: ConfigOverride,
  data: Awaited<ReturnType<typeof loadData>>,
): Promise<RunResult> {
  applyConfig(cfg);

  const result = await runBacktestComputation({ params: PARAMS, ...data });
  const s = result.summary;

  // Split trades by symbol set
  const inSampleTrades = result.trades.filter(t => IN_SAMPLE_SYMBOLS.includes(t.symbol));
  const oosTrades = result.trades.filter(t => OOS_SYMBOLS.includes(t.symbol));

  const inSampleWins = inSampleTrades.filter(t => t.netPnlUsd > 0).length;
  const oosWins = oosTrades.filter(t => t.netPnlUsd > 0).length;

  return {
    config: cfg,
    trades: s.totalTrades,
    shortTrades: s.shortTrades,
    winRate: s.winRate,
    pnlUsd: s.totalPnlUsd,
    pnlPct: s.totalPnlPct,
    maxDD: s.maxDrawdownPct,
    sharpe: s.sharpeRatio,
    profitFactor: s.profitFactor,
    inSampleTrades: inSampleTrades.length,
    inSamplePnl: inSampleTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
    inSampleWR: inSampleTrades.length > 0 ? (inSampleWins / inSampleTrades.length) * 100 : 0,
    oosTrades: oosTrades.length,
    oosPnl: oosTrades.reduce((sum, t) => sum + t.netPnlUsd, 0),
    oosWR: oosTrades.length > 0 ? (oosWins / oosTrades.length) * 100 : 0,
  };
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================
function padR(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s;
}

function printTable(results: RunResult[], baseline: RunResult, title: string) {
  // Sort by OOS Sharpe descending, fallback to total Sharpe
  const sorted = [...results].sort((a, b) => {
    // Primary: OOS Sharpe
    if (a.oosTrades >= 10 && b.oosTrades >= 10) return b.sharpe - a.sharpe;
    // If not enough OOS trades, use total Sharpe
    return b.sharpe - a.sharpe;
  });

  const bS = baseline;
  const W = 175;

  console.log(`\n${'═'.repeat(W)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(W)}`);
  console.log(
    padR('#', 4) +
    padR('ROC5%', 7) +
    padR('Vol', 5) +
    padR('BB', 4) +
    padR('Accel', 6) +
    padR('MA20', 5) +
    padR('│ Trades', 9) +
    padR('SHORT', 7) +
    padR('WR%', 7) +
    padR('PnL$', 10) +
    padR('DD%', 7) +
    padR('Sharpe', 8) +
    padR('PF', 6) +
    padR('│ IS_Tr', 8) +
    padR('IS_WR%', 8) +
    padR('IS_PnL$', 10) +
    padR('│ OOS_Tr', 9) +
    padR('OOS_WR%', 9) +
    padR('OOS_PnL$', 10) +
    padR('│ ΔSharpe', 10) +
    padR('ΔPnL$', 9)
  );
  console.log('─'.repeat(W));

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const c = r.config;
    const isBaseline = c.roc5 === bS.config.roc5 && c.vol === bS.config.vol &&
                       c.bbLower === bS.config.bbLower && c.rocAccel === bS.config.rocAccel &&
                       c.ma20 === bS.config.ma20;
    const rank = isBaseline ? '★BL' : `  ${i + 1}`;
    const deltaSharpe = r.sharpe - bS.sharpe;
    const deltaPnl = r.pnlUsd - bS.pnlUsd;

    console.log(
      padR(rank, 4) +
      padL((c.roc5 * 100).toFixed(2), 6) + ' ' +
      padL(c.vol.toFixed(2), 4) + ' ' +
      padR(c.bbLower ? 'Y' : 'N', 4) +
      padL(c.rocAccel.toFixed(3), 5) + ' ' +
      padR(c.ma20 ? 'Y' : 'N', 5) +
      '│' + padL(String(r.trades), 6) + '  ' +
      padL(String(r.shortTrades), 5) + '  ' +
      padL(r.winRate.toFixed(1), 5) + '  ' +
      padL('$' + r.pnlUsd.toFixed(0), 8) + '  ' +
      padL(r.maxDD.toFixed(1), 5) + '  ' +
      padL(r.sharpe.toFixed(2), 6) + '  ' +
      padL(r.profitFactor.toFixed(2), 4) + '  ' +
      '│' + padL(String(r.inSampleTrades), 5) + '   ' +
      padL(r.inSampleWR.toFixed(1), 5) + '   ' +
      padL('$' + r.inSamplePnl.toFixed(0), 8) + ' ' +
      '│' + padL(String(r.oosTrades), 6) + '   ' +
      padL(r.oosWR.toFixed(1), 5) + '    ' +
      padL('$' + r.oosPnl.toFixed(0), 8) + ' ' +
      '│' + padL((deltaSharpe >= 0 ? '+' : '') + deltaSharpe.toFixed(2), 7) + '   ' +
      padL((deltaPnl >= 0 ? '+' : '') + '$' + deltaPnl.toFixed(0), 7)
    );
  }
  console.log('═'.repeat(W));
}

function printShortBreakdown(results: RunResult[], baseline: RunResult) {
  console.log('\n📊 SHORT-ONLY ANALYSIS (sorted by short trade count):');
  const sorted = [...results].sort((a, b) => b.shortTrades - a.shortTrades);
  console.log(
    padR('Config', 35) +
    padR('SHORT Trades', 13) +
    padR('Δ vs BL', 10) +
    padR('Total Trades', 13) +
    padR('Δ vs BL', 10)
  );
  console.log('─'.repeat(80));
  for (const r of sorted.slice(0, 15)) {
    const c = r.config;
    const label = `ROC5=${(c.roc5*100).toFixed(1)}% Vol=${c.vol}x BB=${c.bbLower?'Y':'N'}`;
    const deltaShort = r.shortTrades - baseline.shortTrades;
    const deltaTotal = r.trades - baseline.trades;
    console.log(
      padR(label, 35) +
      padL(String(r.shortTrades), 8) + '     ' +
      padL((deltaShort >= 0 ? '+' : '') + String(deltaShort), 6) + '    ' +
      padL(String(r.trades), 8) + '     ' +
      padL((deltaTotal >= 0 ? '+' : '') + String(deltaTotal), 6)
    );
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const runPhase2 = process.argv.includes('--phase2');

  console.log('🔬 SHORT Filter Parameter Sweep');
  console.log(`Period: ${PARAMS.startDate.toISOString().split('T')[0]} → ${PARAMS.endDate.toISOString().split('T')[0]}`);
  console.log(`In-sample: ${IN_SAMPLE_SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);
  console.log(`OOS: ${OOS_SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);
  console.log();

  // Load data once
  console.log('📥 Loading candle data...');
  const data = await loadData();
  console.log('✅ Data loaded.\n');

  const snap = snapshotShortConfig();

  try {
    // ════════════════════════════════════════════════════════════
    // BASELINE (current config)
    // ════════════════════════════════════════════════════════════
    const baselineConfig: ConfigOverride = {
      label: 'BASELINE',
      roc5: snap.ROC_DROP_MIN,
      vol: snap.VOL_SPIKE,
      bbLower: snap.PRICE_BELOW_BB_LOWER,
      rocAccel: snap.SHORT_MAX_ROC_ACCEL,
      ma20: snap.PRICE_BELOW_MA20,
    };
    console.log('▶ Running BASELINE...');
    const baseline = await runConfig(baselineConfig, data);
    console.log(`  BASELINE: ${baseline.trades} trades (${baseline.shortTrades} SHORT) | WR=${baseline.winRate.toFixed(1)}% | PnL=$${baseline.pnlUsd.toFixed(0)} | Sharpe=${baseline.sharpe.toFixed(2)}`);
    console.log(`    IS: ${baseline.inSampleTrades} trades, WR=${baseline.inSampleWR.toFixed(1)}%, PnL=$${baseline.inSamplePnl.toFixed(0)}`);
    console.log(`    OOS: ${baseline.oosTrades} trades, WR=${baseline.oosWR.toFixed(1)}%, PnL=$${baseline.oosPnl.toFixed(0)}`);

    // ════════════════════════════════════════════════════════════
    // PHASE 1: ROC5 × Volume × BB Lower
    // ════════════════════════════════════════════════════════════
    console.log(`\n═══ PHASE 1: ROC5 × Volume × BB Lower (${ROC5_VALUES.length * VOL_VALUES.length * BB_VALUES.length} configs) ═══\n`);

    const phase1Results: RunResult[] = [baseline];
    let count = 0;
    const total1 = ROC5_VALUES.length * VOL_VALUES.length * BB_VALUES.length;

    for (const roc5 of ROC5_VALUES) {
      for (const vol of VOL_VALUES) {
        for (const bb of BB_VALUES) {
          count++;
          // Skip if it's exactly the baseline
          if (roc5 === snap.ROC_DROP_MIN && vol === snap.VOL_SPIKE && bb === snap.PRICE_BELOW_BB_LOWER) continue;

          const cfg: ConfigOverride = {
            label: `ROC5=${(roc5*100).toFixed(1)} Vol=${vol} BB=${bb?'Y':'N'}`,
            roc5,
            vol,
            bbLower: bb,
            rocAccel: snap.SHORT_MAX_ROC_ACCEL,  // keep baseline
            ma20: snap.PRICE_BELOW_MA20,          // keep baseline
          };

          process.stdout.write(`  [${count}/${total1}] ${cfg.label}...`);
          const result = await runConfig(cfg, data);
          phase1Results.push(result);

          const deltaPnl = result.pnlUsd - baseline.pnlUsd;
          console.log(` ${result.trades}t | WR=${result.winRate.toFixed(1)}% | $${result.pnlUsd.toFixed(0)} (${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)}) | Sh=${result.sharpe.toFixed(2)}`);
        }
      }
    }

    printTable(phase1Results, baseline, 'PHASE 1: ROC5 × Volume × BB Lower');
    printShortBreakdown(phase1Results, baseline);

    // ════════════════════════════════════════════════════════════
    // PHASE 2: Top 5 × ROC_ACCEL × MA20
    // ════════════════════════════════════════════════════════════
    if (runPhase2) {
      // Sort Phase 1 by Sharpe, take top 5
      const top5 = [...phase1Results]
        .sort((a, b) => b.sharpe - a.sharpe)
        .slice(0, 5);

      console.log(`\n═══ PHASE 2: Top 5 × ROC_ACCEL × MA20 (${top5.length * ROC_ACCEL_VALUES.length * MA20_VALUES.length} configs) ═══\n`);
      console.log('Top 5 from Phase 1:');
      for (const r of top5) {
        const c = r.config;
        console.log(`  ROC5=${(c.roc5*100).toFixed(1)}% Vol=${c.vol}x BB=${c.bbLower?'Y':'N'} → Sharpe=${r.sharpe.toFixed(2)}, PnL=$${r.pnlUsd.toFixed(0)}`);
      }
      console.log();

      const phase2Results: RunResult[] = [];
      count = 0;
      const total2 = top5.length * ROC_ACCEL_VALUES.length * MA20_VALUES.length;

      for (const base of top5) {
        for (const rocAccel of ROC_ACCEL_VALUES) {
          for (const ma20 of MA20_VALUES) {
            count++;
            // Skip if identical to phase 1 result
            if (rocAccel === snap.SHORT_MAX_ROC_ACCEL && ma20 === snap.PRICE_BELOW_MA20) continue;

            const cfg: ConfigOverride = {
              label: `${base.config.label} Accel=${rocAccel} MA20=${ma20?'Y':'N'}`,
              roc5: base.config.roc5,
              vol: base.config.vol,
              bbLower: base.config.bbLower,
              rocAccel,
              ma20,
            };

            process.stdout.write(`  [${count}/${total2}] ${cfg.label}...`);
            const result = await runConfig(cfg, data);
            phase2Results.push(result);

            const deltaPnl = result.pnlUsd - baseline.pnlUsd;
            console.log(` ${result.trades}t | WR=${result.winRate.toFixed(1)}% | $${result.pnlUsd.toFixed(0)} (${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)}) | Sh=${result.sharpe.toFixed(2)}`);
          }
        }
      }

      printTable([...phase1Results, ...phase2Results], baseline, 'ALL RESULTS: Phase 1 + Phase 2');
    }

    // ════════════════════════════════════════════════════════════
    // CRITICAL SKEPTICISM CHECKLIST
    // ════════════════════════════════════════════════════════════
    console.log('\n🔍 CRITICAL SKEPTICISM CHECKLIST:');
    console.log('  □ Best config has enough trades? (min 30 SHORT trades)');
    console.log('  □ OOS Sharpe doesn\'t drop > 0.5 vs in-sample?');
    console.log('  □ Trade count increase is < 2x baseline?');
    console.log('  □ MaxDD doesn\'t increase > 5pp vs baseline?');
    console.log('  □ WR doesn\'t drop > 3pp vs baseline?');
    console.log('  □ Results make LOGICAL sense (not just curve-fitting)?');
    console.log('  □ Walk-forward H1/H2 split needed before deploying');

  } finally {
    restoreConfig(snap);
    console.log('\n✅ Config restored to baseline.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
