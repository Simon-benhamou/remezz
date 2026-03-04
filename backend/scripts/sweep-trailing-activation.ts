/**
 * Sweep Trailing Activation & Breakeven Thresholds
 * =================================================
 * Problem: 57 SL trades reached +0.5% favorable then reversed to SL (-$7,068 lost).
 * Current config: trailing activates at 1.0%, breakeven at 1.0%.
 * Hypothesis: lowering activation/breakeven catches these trades earlier.
 *
 * Tests:
 * 1. Lower trailing activation: 0.4%, 0.5%, 0.6%, 0.7%, 0.8% (keep same distance)
 * 2. Earlier breakeven only: 0.3%, 0.5%, 0.7% trigger (keep trailing at 1.0%)
 * 3. Combo: lower activation + earlier breakeven together
 *
 * Usage: cd /Users/simon-davidbenhamou/Desktop/remezz/backend && npx tsx scripts/sweep-trailing-activation.ts
 */
import { runBacktestComputation, type BacktestResult } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles, sliceCandlesByTime, CANDLE_15M_MS, type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;
const START = new Date('2025-01-01T00:00:00.000Z');
const END   = new Date('2025-12-31T00:00:00.000Z');

// Walk-forward halves
const H1_START = new Date('2025-01-01T00:00:00.000Z');
const H1_END   = new Date('2025-06-30T23:59:59.000Z');
const H2_START = new Date('2025-07-01T00:00:00.000Z');
const H2_END   = new Date('2025-12-31T00:00:00.000Z');

// ---- Save original config for reset ----
const ORIG = {
  TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
  TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
  LOW_VOL_ACTIVATION: MomentumConfig.EXIT.LOW_VOL_ACTIVATION,
  LOW_VOL_DISTANCE: MomentumConfig.EXIT.LOW_VOL_DISTANCE,
  HIGH_VOL_ACTIVATION: MomentumConfig.EXIT.HIGH_VOL_ACTIVATION,
  HIGH_VOL_DISTANCE: MomentumConfig.EXIT.HIGH_VOL_DISTANCE,
  BREAKEVEN_ENABLED: (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED,
  BREAKEVEN_TRIGGER_PCT: (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT,
  BREAKEVEN_OFFSET_PCT: (MomentumConfig.EXIT as any).BREAKEVEN_OFFSET_PCT,
};

function resetConfig() {
  MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT = ORIG.TRAILING_ACTIVATION_PCT;
  MomentumConfig.EXIT.TRAILING_DISTANCE_PCT = ORIG.TRAILING_DISTANCE_PCT;
  MomentumConfig.EXIT.LOW_VOL_ACTIVATION = ORIG.LOW_VOL_ACTIVATION;
  MomentumConfig.EXIT.LOW_VOL_DISTANCE = ORIG.LOW_VOL_DISTANCE;
  MomentumConfig.EXIT.HIGH_VOL_ACTIVATION = ORIG.HIGH_VOL_ACTIVATION;
  MomentumConfig.EXIT.HIGH_VOL_DISTANCE = ORIG.HIGH_VOL_DISTANCE;
  (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED = ORIG.BREAKEVEN_ENABLED;
  (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT = ORIG.BREAKEVEN_TRIGGER_PCT;
  (MomentumConfig.EXIT as any).BREAKEVEN_OFFSET_PCT = ORIG.BREAKEVEN_OFFSET_PCT;
}

async function loadData(startDate: Date, endDate: Date) {
  const since = startDate.getTime() - 250 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endDate.getTime());

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) continue;
    allData[sym] = sliceCandlesByTime(local.candles, since, endDate.getTime());
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return {
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };
}

// ---- Analyze exit reasons ----
interface ExitBreakdown {
  slCount: number; slPnl: number;
  trailCount: number; trailPnl: number;
  stagnantCount: number; stagnantPnl: number;
  otherCount: number; otherPnl: number;
}

function analyzeExits(result: BacktestResult): ExitBreakdown {
  const bd: ExitBreakdown = { slCount: 0, slPnl: 0, trailCount: 0, trailPnl: 0, stagnantCount: 0, stagnantPnl: 0, otherCount: 0, otherPnl: 0 };
  for (const t of result.trades) {
    const r = t.exitReason.toUpperCase();
    if (r.includes('STOPLOSS') || r === 'EXIT_SL' || r === 'SL') {
      bd.slCount++; bd.slPnl += t.netPnlUsd;
    } else if (r.includes('TRAIL') || r.includes('NFS')) {
      bd.trailCount++; bd.trailPnl += t.netPnlUsd;
    } else if (r.includes('STAGNANT')) {
      bd.stagnantCount++; bd.stagnantPnl += t.netPnlUsd;
    } else {
      bd.otherCount++; bd.otherPnl += t.netPnlUsd;
    }
  }
  return bd;
}

// ---- Formatting ----
function fmtRow(
  label: string,
  result: BacktestResult,
  baseline?: BacktestResult,
) {
  const s = result.summary;
  const bd = analyzeExits(result);
  const bS = baseline ? baseline.summary : null;

  const dPnl = bS ? s.totalPnlUsd - bS.totalPnlUsd : 0;
  const dDD  = bS ? s.maxDrawdownPct - bS.maxDrawdownPct : 0;
  const dSh  = bS ? s.sharpeRatio - bS.sharpeRatio : 0;
  const dWR  = bS ? s.winRate - bS.winRate : 0;

  return (
    `${label.padEnd(28)} ` +
    `${String(s.totalTrades).padStart(5)} ` +
    `${s.winRate.toFixed(1).padStart(5)}% ` +
    `$${s.totalPnlUsd.toFixed(0).padStart(8)} ` +
    `${s.maxDrawdownPct.toFixed(1).padStart(5)}% ` +
    `${s.sharpeRatio.toFixed(2).padStart(6)} ` +
    `${s.profitFactor.toFixed(2).padStart(5)} ` +
    `| SL:${String(bd.slCount).padStart(4)} $${bd.slPnl.toFixed(0).padStart(7)} ` +
    `| TR:${String(bd.trailCount).padStart(4)} $${bd.trailPnl.toFixed(0).padStart(7)} ` +
    `| ST:${String(bd.stagnantCount).padStart(4)} $${bd.stagnantPnl.toFixed(0).padStart(7)} ` +
    (bS ? `|| d$${dPnl >= 0 ? '+' : ''}${dPnl.toFixed(0).padStart(7)} dDD${dDD >= 0 ? '+' : ''}${dDD.toFixed(1).padStart(5)}pp dSh${dSh >= 0 ? '+' : ''}${dSh.toFixed(2).padStart(6)} dWR${dWR >= 0 ? '+' : ''}${dWR.toFixed(1).padStart(5)}pp` : '')
  );
}

function printHeader() {
  console.log(
    `${'Config'.padEnd(28)} ` +
    `${'Trd'.padStart(5)} ` +
    `${'WR%'.padStart(6)} ` +
    `${'PnL$'.padStart(9)} ` +
    `${'DD%'.padStart(6)} ` +
    `${'Sharpe'.padStart(6)} ` +
    `${'PF'.padStart(5)} ` +
    `| ${'SL #'.padStart(6)} ${'SL $'.padStart(8)} ` +
    `| ${'TR #'.padStart(6)} ${'TR $'.padStart(8)} ` +
    `| ${'ST #'.padStart(6)} ${'ST $'.padStart(8)} ` +
    `|| Delta vs baseline`
  );
  console.log('-'.repeat(200));
}

// ---- Main ----
async function main() {
  console.log('Loading candle data...');
  const fullData = await loadData(START, END);
  const fullParams = { startDate: START, endDate: END, initialCapital: 2000, symbols: SYMBOLS, leverage: 5, postProcess1m: false };

  // ============================================================================
  // PART 1: BASELINE
  // ============================================================================
  console.log('\n' + '='.repeat(200));
  console.log('PART 0: BASELINE (current config)');
  console.log('='.repeat(200));
  console.log(`  TRAILING_ACTIVATION_PCT = ${ORIG.TRAILING_ACTIVATION_PCT}`);
  console.log(`  TRAILING_DISTANCE_PCT   = ${ORIG.TRAILING_DISTANCE_PCT}`);
  console.log(`  BREAKEVEN_ENABLED       = ${ORIG.BREAKEVEN_ENABLED}`);
  console.log(`  BREAKEVEN_TRIGGER_PCT   = ${ORIG.BREAKEVEN_TRIGGER_PCT}`);
  console.log(`  BREAKEVEN_OFFSET_PCT    = ${ORIG.BREAKEVEN_OFFSET_PCT}`);
  console.log(`  LOW_VOL_ACTIVATION      = ${ORIG.LOW_VOL_ACTIVATION}`);
  console.log(`  HIGH_VOL_ACTIVATION     = ${ORIG.HIGH_VOL_ACTIVATION}`);
  console.log();

  resetConfig();
  const baseline = await runBacktestComputation({ params: fullParams, ...fullData });
  printHeader();
  console.log(fmtRow('BASELINE (current)', baseline));
  console.log();

  // ============================================================================
  // PART 1: TRAILING ACTIVATION SWEEP (keep same distance)
  // ============================================================================
  console.log('\n' + '='.repeat(200));
  console.log('PART 1: TRAILING ACTIVATION SWEEP (keep same trailing distance, lower activation only)');
  console.log('  Hypothesis: trades that reach activation get "protected" by trailing.');
  console.log('  If they reverse, they exit at activation - distance instead of full SL.');
  console.log('='.repeat(200));

  const activationLevels = [0.4, 0.5, 0.6, 0.7, 0.8];
  const part1Results: { label: string; result: BacktestResult; activation: number }[] = [];

  printHeader();
  console.log(fmtRow('BASELINE (act=1.0)', baseline));

  for (const act of activationLevels) {
    resetConfig();
    // Lower activation proportionally for all vol regimes
    const ratio = act / ORIG.TRAILING_ACTIVATION_PCT;
    MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT = act;
    MomentumConfig.EXIT.LOW_VOL_ACTIVATION = ORIG.LOW_VOL_ACTIVATION * ratio;
    MomentumConfig.EXIT.HIGH_VOL_ACTIVATION = ORIG.HIGH_VOL_ACTIVATION * ratio;
    // Keep distances UNCHANGED
    MomentumConfig.EXIT.TRAILING_DISTANCE_PCT = ORIG.TRAILING_DISTANCE_PCT;
    MomentumConfig.EXIT.LOW_VOL_DISTANCE = ORIG.LOW_VOL_DISTANCE;
    MomentumConfig.EXIT.HIGH_VOL_DISTANCE = ORIG.HIGH_VOL_DISTANCE;

    const label = `Act=${act.toFixed(1)}% (LV=${(ORIG.LOW_VOL_ACTIVATION * ratio).toFixed(2)})`;
    const result = await runBacktestComputation({ params: fullParams, ...fullData });
    part1Results.push({ label, result, activation: act });
    console.log(fmtRow(label, result, baseline));
  }
  console.log();

  // ============================================================================
  // PART 2: BREAKEVEN-ONLY SWEEP (trailing stays at 1.0%)
  // ============================================================================
  console.log('\n' + '='.repeat(200));
  console.log('PART 2: BREAKEVEN-ONLY SWEEP (trailing activation stays at 1.0%, only move breakeven trigger)');
  console.log('  Hypothesis: safer approach - just protect against full SL loss at lower profit.');
  console.log('  SL moves to entry+0.1% when maxPnl reaches breakeven trigger.');
  console.log('='.repeat(200));

  const bevenLevels = [0.3, 0.5, 0.7];
  const part2Results: { label: string; result: BacktestResult; be: number }[] = [];

  printHeader();
  console.log(fmtRow('BASELINE (BE=1.0)', baseline));

  for (const be of bevenLevels) {
    resetConfig();
    // Only change breakeven trigger — trailing stays at default
    (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED = true;
    (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT = be;
    (MomentumConfig.EXIT as any).BREAKEVEN_OFFSET_PCT = ORIG.BREAKEVEN_OFFSET_PCT; // keep 0.1%

    const label = `BE=${be.toFixed(1)}%`;
    const result = await runBacktestComputation({ params: fullParams, ...fullData });
    part2Results.push({ label, result, be });
    console.log(fmtRow(label, result, baseline));
  }
  console.log();

  // ============================================================================
  // PART 3: COMBO SWEEP (lower activation + earlier breakeven)
  // ============================================================================
  console.log('\n' + '='.repeat(200));
  console.log('PART 3: COMBO (lower trailing activation + earlier breakeven together)');
  console.log('='.repeat(200));

  const combos = [
    { act: 0.5, be: 0.3 },
    { act: 0.5, be: 0.5 },
    { act: 0.6, be: 0.3 },
    { act: 0.6, be: 0.5 },
    { act: 0.7, be: 0.5 },
    { act: 0.8, be: 0.5 },
  ];
  const part3Results: { label: string; result: BacktestResult; act: number; be: number }[] = [];

  printHeader();
  console.log(fmtRow('BASELINE (1.0/1.0)', baseline));

  for (const c of combos) {
    resetConfig();
    const ratio = c.act / ORIG.TRAILING_ACTIVATION_PCT;
    MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT = c.act;
    MomentumConfig.EXIT.LOW_VOL_ACTIVATION = ORIG.LOW_VOL_ACTIVATION * ratio;
    MomentumConfig.EXIT.HIGH_VOL_ACTIVATION = ORIG.HIGH_VOL_ACTIVATION * ratio;
    MomentumConfig.EXIT.TRAILING_DISTANCE_PCT = ORIG.TRAILING_DISTANCE_PCT;
    MomentumConfig.EXIT.LOW_VOL_DISTANCE = ORIG.LOW_VOL_DISTANCE;
    MomentumConfig.EXIT.HIGH_VOL_DISTANCE = ORIG.HIGH_VOL_DISTANCE;
    (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED = true;
    (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT = c.be;

    const label = `Act=${c.act.toFixed(1)}+BE=${c.be.toFixed(1)}`;
    const result = await runBacktestComputation({ params: fullParams, ...fullData });
    part3Results.push({ label, result, act: c.act, be: c.be });
    console.log(fmtRow(label, result, baseline));
  }
  console.log();

  // ============================================================================
  // PART 4: TOP 3 WALK-FORWARD (H1 vs H2)
  // ============================================================================

  // Rank all configs by Sharpe, take top 3
  const allConfigs: { label: string; setup: () => void; sharpe: number }[] = [];

  for (const p of part1Results) {
    allConfigs.push({
      label: `P1: ${p.label}`,
      setup: () => {
        resetConfig();
        const ratio = p.activation / ORIG.TRAILING_ACTIVATION_PCT;
        MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT = p.activation;
        MomentumConfig.EXIT.LOW_VOL_ACTIVATION = ORIG.LOW_VOL_ACTIVATION * ratio;
        MomentumConfig.EXIT.HIGH_VOL_ACTIVATION = ORIG.HIGH_VOL_ACTIVATION * ratio;
      },
      sharpe: p.result.summary.sharpeRatio,
    });
  }
  for (const p of part2Results) {
    allConfigs.push({
      label: `P2: ${p.label}`,
      setup: () => {
        resetConfig();
        (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT = p.be;
      },
      sharpe: p.result.summary.sharpeRatio,
    });
  }
  for (const p of part3Results) {
    allConfigs.push({
      label: `P3: ${p.label}`,
      setup: () => {
        resetConfig();
        const ratio = p.act / ORIG.TRAILING_ACTIVATION_PCT;
        MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT = p.act;
        MomentumConfig.EXIT.LOW_VOL_ACTIVATION = ORIG.LOW_VOL_ACTIVATION * ratio;
        MomentumConfig.EXIT.HIGH_VOL_ACTIVATION = ORIG.HIGH_VOL_ACTIVATION * ratio;
        (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED = true;
        (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT = p.be;
      },
      sharpe: p.result.summary.sharpeRatio,
    });
  }

  // Sort by Sharpe descending, take top 3
  allConfigs.sort((a, b) => b.sharpe - a.sharpe);
  const top3 = allConfigs.slice(0, 3);

  console.log('\n' + '='.repeat(200));
  console.log('PART 4: WALK-FORWARD VALIDATION (top 3 configs by Sharpe)');
  console.log('  H1 = Jan-Jun 2025 (in-sample)');
  console.log('  H2 = Jul-Dec 2025 (out-of-sample)');
  console.log('  Stable config: H2 Sharpe >= 50% of H1 Sharpe');
  console.log('='.repeat(200));

  // Load H1 and H2 data
  const h1Data = await loadData(H1_START, H1_END);
  const h2Data = await loadData(H2_START, H2_END);
  const h1Params = { startDate: H1_START, endDate: H1_END, initialCapital: 2000, symbols: SYMBOLS, leverage: 5, postProcess1m: false };
  const h2Params = { startDate: H2_START, endDate: H2_END, initialCapital: 2000, symbols: SYMBOLS, leverage: 5, postProcess1m: false };

  // Baseline WF
  resetConfig();
  const baseH1 = await runBacktestComputation({ params: h1Params, ...h1Data });
  const baseH2 = await runBacktestComputation({ params: h2Params, ...h2Data });

  console.log(`\n${'Config'.padEnd(28)} | ${'--- H1 (Jan-Jun) ---'.padEnd(55)} | ${'--- H2 (Jul-Dec) ---'.padEnd(55)} | Stability`);
  console.log('-'.repeat(170));

  const fmtHalf = (r: BacktestResult) => {
    const s = r.summary;
    return `${String(s.totalTrades).padStart(4)}tr ${s.winRate.toFixed(1).padStart(5)}% $${s.totalPnlUsd.toFixed(0).padStart(7)} ${s.maxDrawdownPct.toFixed(1).padStart(5)}%DD Sh=${s.sharpeRatio.toFixed(2).padStart(5)} PF=${s.profitFactor.toFixed(2).padStart(4)}`;
  };

  const stabilityLabel = (sh1: number, sh2: number) => {
    if (sh1 <= 0) return sh2 > 0 ? 'H2>0 (OK)' : 'BOTH_NEG';
    const ratio = sh2 / sh1;
    if (ratio >= 0.8) return `STABLE (${(ratio * 100).toFixed(0)}%)`;
    if (ratio >= 0.5) return `OK (${(ratio * 100).toFixed(0)}%)`;
    return `UNSTABLE (${(ratio * 100).toFixed(0)}%)`;
  };

  console.log(
    `${'BASELINE'.padEnd(28)} | ${fmtHalf(baseH1).padEnd(55)} | ${fmtHalf(baseH2).padEnd(55)} | ${stabilityLabel(baseH1.summary.sharpeRatio, baseH2.summary.sharpeRatio)}`
  );

  for (const cfg of top3) {
    cfg.setup();
    const h1 = await runBacktestComputation({ params: h1Params, ...h1Data });
    const h2 = await runBacktestComputation({ params: h2Params, ...h2Data });

    console.log(
      `${cfg.label.padEnd(28)} | ${fmtHalf(h1).padEnd(55)} | ${fmtHalf(h2).padEnd(55)} | ${stabilityLabel(h1.summary.sharpeRatio, h2.summary.sharpeRatio)}`
    );
  }

  // ============================================================================
  // SUMMARY
  // ============================================================================
  console.log('\n' + '='.repeat(200));
  console.log('SUMMARY: Top configs ranked by Sharpe');
  console.log('='.repeat(200));
  for (let i = 0; i < Math.min(5, allConfigs.length); i++) {
    const c = allConfigs[i];
    console.log(`  #${i + 1}: ${c.label} (Sharpe ${c.sharpe.toFixed(2)})`);
  }

  resetConfig();
  console.log('\nConfig reset to original values.');
}

main().catch(e => { console.error(e); process.exit(1); });
