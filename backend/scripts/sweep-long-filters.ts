/**
 * sweep-long-filters.ts — Parameter sweep for LONG entry filters
 *
 * Same methodology as sweep-short-filters.ts but for BULL regime LONG entries.
 *
 * LONG filter chain:
 *   1. Bullish candle (close > open)
 *   2. ConsecUp <= 5
 *   3. Close > BB Upper (breakout)
 *   4. ROC10 >= 1.75%
 *   5. Volume >= 1.15x
 *   6. BTC Volatility (ATR)
 *   7. MTF alignment (BTC ROC > 0)
 *   8. Green ratio < 70%
 *   9. Alternation5 <= 2
 *   10. BB touches >= 1
 *
 * PHASE 1: ROC10 × Volume × BB Upper (breakout on/off)
 * PHASE 2: Top 5 × Green Ratio × BB Touches × Alternation5
 *
 * Usage:
 *   npx tsx scripts/sweep-long-filters.ts
 *   npx tsx scripts/sweep-long-filters.ts --phase2
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

// Phase 1: Main LONG filters
const ROC10_VALUES = [0.005, 0.0075, 0.01, 0.0125, 0.015, 0.0175]; // 0.5% to 1.75%
const VOL_VALUES   = [1.0, 1.05, 1.10, 1.15];                       // 1.0x to 1.15x
const BB_UPPER_VALUES = [true, false]; // require close > BB upper or not

// Phase 2: Pattern filters (tested on top configs from Phase 1)
const GREEN_RATIO_VALUES = [0.60, 0.70, 0.80, 1.0];     // 60% to 100% (1.0 = disabled)
const BB_TOUCHES_VALUES  = [0, 1];                         // min BB touches (0 = disabled)
const ALT5_VALUES         = [2, 3, 5];                     // max alternation5 (5 = very permissive)

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
  roc10: number;
  vol: number;
  bbUpper: boolean;
  greenRatio: number;
  bbTouches: number;
  alt5: number;
}

interface RunResult {
  config: ConfigOverride;
  trades: number;
  longTrades: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  inSampleTrades: number;
  inSamplePnl: number;
  inSampleWR: number;
  oosTrades: number;
  oosPnl: number;
  oosWR: number;
}

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btcLocal || !btc1hLocal) throw new Error('No local BTC data');

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
function snapshotLongConfig() {
  return {
    ROC_MIN: MomentumConfig.ENTRY_LONG.ROC_MIN,
    VOL_MULTIPLIER: MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER,
    REQUIRE_BB_BREAKOUT: (MomentumConfig.ENTRY_LONG as any).REQUIRE_BB_BREAKOUT,
    LONG_MAX_GREEN_RATIO: MomentumConfig.CANDLE_PATTERN_FILTER.LONG_MAX_GREEN_RATIO,
    LONG_MIN_BB_TOUCHES: MomentumConfig.CANDLE_PATTERN_FILTER.LONG_MIN_BB_TOUCHES,
    LONG_MAX_ALT5: MomentumConfig.CANDLE_PATTERN_FILTER.LONG_MAX_ALT5,
  };
}

function applyConfig(cfg: ConfigOverride) {
  (MomentumConfig.ENTRY_LONG as any).ROC_MIN = cfg.roc10;
  (MomentumConfig.ENTRY_LONG as any).VOL_MULTIPLIER = cfg.vol;
  (MomentumConfig.ENTRY_LONG as any).REQUIRE_BB_BREAKOUT = cfg.bbUpper;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MAX_GREEN_RATIO = cfg.greenRatio;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MIN_BB_TOUCHES = cfg.bbTouches;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MAX_ALT5 = cfg.alt5;
}

function restoreConfig(snap: ReturnType<typeof snapshotLongConfig>) {
  (MomentumConfig.ENTRY_LONG as any).ROC_MIN = snap.ROC_MIN;
  (MomentumConfig.ENTRY_LONG as any).VOL_MULTIPLIER = snap.VOL_MULTIPLIER;
  (MomentumConfig.ENTRY_LONG as any).REQUIRE_BB_BREAKOUT = snap.REQUIRE_BB_BREAKOUT;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MAX_GREEN_RATIO = snap.LONG_MAX_GREEN_RATIO;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MIN_BB_TOUCHES = snap.LONG_MIN_BB_TOUCHES;
  (MomentumConfig.CANDLE_PATTERN_FILTER as any).LONG_MAX_ALT5 = snap.LONG_MAX_ALT5;
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

  const inSampleTrades = result.trades.filter(t => IN_SAMPLE_SYMBOLS.includes(t.symbol));
  const oosTrades = result.trades.filter(t => OOS_SYMBOLS.includes(t.symbol));
  const inSampleWins = inSampleTrades.filter(t => t.netPnlUsd > 0).length;
  const oosWins = oosTrades.filter(t => t.netPnlUsd > 0).length;

  return {
    config: cfg,
    trades: s.totalTrades,
    longTrades: s.longTrades,
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
  const sorted = [...results].sort((a, b) => b.sharpe - a.sharpe);

  const W = 185;
  console.log(`\n${'═'.repeat(W)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(W)}`);
  console.log(
    padR('#', 4) +
    padR('ROC10%', 8) +
    padR('Vol', 5) +
    padR('BB', 4) +
    padR('GR%', 5) +
    padR('BBt', 4) +
    padR('Alt', 4) +
    padR('│ Trades', 9) +
    padR('LONG', 6) +
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
    const bc = baseline.config;
    const isBaseline = c.roc10 === bc.roc10 && c.vol === bc.vol &&
                       c.bbUpper === bc.bbUpper && c.greenRatio === bc.greenRatio &&
                       c.bbTouches === bc.bbTouches && c.alt5 === bc.alt5;
    const rank = isBaseline ? '★BL' : `  ${i + 1}`;
    const deltaSharpe = r.sharpe - baseline.sharpe;
    const deltaPnl = r.pnlUsd - baseline.pnlUsd;

    console.log(
      padR(rank, 4) +
      padL((c.roc10 * 100).toFixed(2), 6) + '  ' +
      padL(c.vol.toFixed(2), 4) + ' ' +
      padR(c.bbUpper ? 'Y' : 'N', 4) +
      padL((c.greenRatio * 100).toFixed(0), 4) + ' ' +
      padL(String(c.bbTouches), 3) + ' ' +
      padL(String(c.alt5), 3) + ' ' +
      '│' + padL(String(r.trades), 6) + '  ' +
      padL(String(r.longTrades), 4) + '  ' +
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

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const runPhase2 = process.argv.includes('--phase2');

  console.log('🔬 LONG Filter Parameter Sweep');
  console.log(`Period: ${PARAMS.startDate.toISOString().split('T')[0]} → ${PARAMS.endDate.toISOString().split('T')[0]}`);
  console.log(`In-sample: ${IN_SAMPLE_SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);
  console.log(`OOS: ${OOS_SYMBOLS.map(s => s.split('/')[0]).join(', ')}`);
  console.log();

  console.log('📥 Loading candle data...');
  const data = await loadData();
  console.log('✅ Data loaded.\n');

  const snap = snapshotLongConfig();

  try {
    // ════════════════════════════════════════════════════════════
    // BASELINE
    // ════════════════════════════════════════════════════════════
    const baselineConfig: ConfigOverride = {
      label: 'BASELINE',
      roc10: snap.ROC_MIN,
      vol: snap.VOL_MULTIPLIER,
      bbUpper: true,
      greenRatio: snap.LONG_MAX_GREEN_RATIO,
      bbTouches: snap.LONG_MIN_BB_TOUCHES,
      alt5: snap.LONG_MAX_ALT5,
    };
    console.log('▶ Running BASELINE...');
    const baseline = await runConfig(baselineConfig, data);
    console.log(`  BASELINE: ${baseline.trades} trades (${baseline.longTrades} LONG) | WR=${baseline.winRate.toFixed(1)}% | PnL=$${baseline.pnlUsd.toFixed(0)} | Sharpe=${baseline.sharpe.toFixed(2)}`);
    console.log(`    IS: ${baseline.inSampleTrades} trades, WR=${baseline.inSampleWR.toFixed(1)}%, PnL=$${baseline.inSamplePnl.toFixed(0)}`);
    console.log(`    OOS: ${baseline.oosTrades} trades, WR=${baseline.oosWR.toFixed(1)}%, PnL=$${baseline.oosPnl.toFixed(0)}`);

    // ════════════════════════════════════════════════════════════
    // PHASE 1: ROC10 × Volume × BB Upper
    // ════════════════════════════════════════════════════════════
    const total1 = ROC10_VALUES.length * VOL_VALUES.length * BB_UPPER_VALUES.length;
    console.log(`\n═══ PHASE 1: ROC10 × Volume × BB Upper (${total1} configs) ═══\n`);

    const phase1Results: RunResult[] = [baseline];
    let count = 0;

    for (const roc10 of ROC10_VALUES) {
      for (const vol of VOL_VALUES) {
        for (const bb of BB_UPPER_VALUES) {
          count++;
          if (roc10 === snap.ROC_MIN && vol === snap.VOL_MULTIPLIER && bb === true) continue;

          const cfg: ConfigOverride = {
            label: `ROC10=${(roc10*100).toFixed(2)} Vol=${vol} BB=${bb?'Y':'N'}`,
            roc10,
            vol,
            bbUpper: bb,
            greenRatio: snap.LONG_MAX_GREEN_RATIO,
            bbTouches: snap.LONG_MIN_BB_TOUCHES,
            alt5: snap.LONG_MAX_ALT5,
          };

          process.stdout.write(`  [${count}/${total1}] ${cfg.label}...`);
          const result = await runConfig(cfg, data);
          phase1Results.push(result);

          const deltaPnl = result.pnlUsd - baseline.pnlUsd;
          console.log(` ${result.trades}t (${result.longTrades}L) | WR=${result.winRate.toFixed(1)}% | $${result.pnlUsd.toFixed(0)} (${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)}) | Sh=${result.sharpe.toFixed(2)}`);
        }
      }
    }

    printTable(phase1Results, baseline, 'PHASE 1: ROC10 × Volume × BB Upper');

    // ════════════════════════════════════════════════════════════
    // PHASE 2: Top 5 × Green Ratio × BB Touches × Alt5
    // ════════════════════════════════════════════════════════════
    if (runPhase2) {
      const top5 = [...phase1Results]
        .sort((a, b) => b.sharpe - a.sharpe)
        .slice(0, 5);

      const total2 = top5.length * GREEN_RATIO_VALUES.length * BB_TOUCHES_VALUES.length * ALT5_VALUES.length;
      console.log(`\n═══ PHASE 2: Top 5 × GreenRatio × BBTouches × Alt5 (${total2} configs) ═══\n`);
      console.log('Top 5 from Phase 1:');
      for (const r of top5) {
        const c = r.config;
        console.log(`  ROC10=${(c.roc10*100).toFixed(2)}% Vol=${c.vol}x BB=${c.bbUpper?'Y':'N'} → Sharpe=${r.sharpe.toFixed(2)}, PnL=$${r.pnlUsd.toFixed(0)}`);
      }
      console.log();

      const phase2Results: RunResult[] = [];
      count = 0;

      for (const base of top5) {
        for (const gr of GREEN_RATIO_VALUES) {
          for (const bbt of BB_TOUCHES_VALUES) {
            for (const alt of ALT5_VALUES) {
              count++;
              if (gr === snap.LONG_MAX_GREEN_RATIO && bbt === snap.LONG_MIN_BB_TOUCHES && alt === snap.LONG_MAX_ALT5) continue;

              const cfg: ConfigOverride = {
                label: `${base.config.label} GR=${(gr*100).toFixed(0)} BBt=${bbt} Alt=${alt}`,
                roc10: base.config.roc10,
                vol: base.config.vol,
                bbUpper: base.config.bbUpper,
                greenRatio: gr,
                bbTouches: bbt,
                alt5: alt,
              };

              process.stdout.write(`  [${count}/${total2}] ${cfg.label}...`);
              const result = await runConfig(cfg, data);
              phase2Results.push(result);

              const deltaPnl = result.pnlUsd - baseline.pnlUsd;
              console.log(` ${result.trades}t (${result.longTrades}L) | WR=${result.winRate.toFixed(1)}% | $${result.pnlUsd.toFixed(0)} (${deltaPnl >= 0 ? '+' : ''}$${deltaPnl.toFixed(0)}) | Sh=${result.sharpe.toFixed(2)}`);
            }
          }
        }
      }

      printTable([...phase1Results, ...phase2Results], baseline, 'ALL RESULTS: Phase 1 + Phase 2');
    }

    console.log('\n🔍 CRITICAL SKEPTICISM CHECKLIST:');
    console.log('  □ Best config has enough LONG trades? (min 30)');
    console.log('  □ OOS Sharpe doesn\'t drop > 0.5 vs in-sample?');
    console.log('  □ Trade count increase is < 2x baseline?');
    console.log('  □ MaxDD doesn\'t increase > 5pp vs baseline?');
    console.log('  □ WR doesn\'t drop > 3pp vs baseline?');
    console.log('  □ Walk-forward H1/H2 split needed before deploying');

  } finally {
    restoreConfig(snap);
    console.log('\n✅ Config restored to baseline.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
