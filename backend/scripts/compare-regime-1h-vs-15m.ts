/**
 * compare-regime-1h-vs-15m.ts — BTC Regime Timeframe Comparison
 *
 * Compares 3 configurations on the same data:
 *   Config A (15m — current prod): regimeTimeframeMinutes=15, LOOKBACK_CANDLES=40
 *   Config B (1h):                 regimeTimeframeMinutes=60, LOOKBACK_CANDLES=10
 *   Config C (hybrid):             SMA200 on 1h, MTF+Cash on 15m
 *
 * Matrix:
 *   - Full year: Jan 2025 → Dec 2025
 *   - H1: Jan → Jun 2025 (stable/bull)
 *   - H2: Jul → Dec 2025 (volatile/bear)
 *   - 10 symbols, $2000, 5x
 *
 * Usage:
 *   npx tsx scripts/compare-regime-1h-vs-15m.ts
 *   npx tsx scripts/compare-regime-1h-vs-15m.ts --full-only     # Skip H1/H2 split
 *   npx tsx scripts/compare-regime-1h-vs-15m.ts --no-hybrid     # Skip Config C
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// CONFIG
// ============================================================================
const SYMBOLS = [
  'DOGE/USDT:USDT', 'IMX/USDT:USDT', 'AVAX/USDT:USDT',
  'FET/USDT:USDT', 'WIF/USDT:USDT',
  'ADA/USDT:USDT', 'DOT/USDT:USDT', 'STX/USDT:USDT',
  'TIA/USDT:USDT', 'SUI/USDT:USDT',
];

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

const PERIODS = [
  { label: 'Full Year (Jan-Dec 2025)', start: '2025-01-01', end: '2025-12-31' },
  { label: 'H1 (Jan-Jun 2025)',        start: '2025-01-01', end: '2025-06-30' },
  { label: 'H2 (Jul-Dec 2025)',        start: '2025-07-01', end: '2025-12-31' },
];

type ConfigType = 'A_15m' | 'B_1h' | 'C_hybrid';

interface ConfigDef {
  label: string;
  type: ConfigType;
  regimeTfMin: number;
  lookbackCandles: number;
  useHybrid: boolean;
}

const CONFIGS: ConfigDef[] = [
  { label: 'A: 15m (prod)',  type: 'A_15m',    regimeTfMin: 15, lookbackCandles: 40, useHybrid: false },
  { label: 'B: 1h',         type: 'B_1h',     regimeTfMin: 60, lookbackCandles: 10, useHybrid: false },
  { label: 'C: Hybrid',     type: 'C_hybrid', regimeTfMin: 15, lookbackCandles: 40, useHybrid: true  },
];

// ============================================================================
// TYPES
// ============================================================================
interface RunResult {
  config: string;
  period: string;
  trades: number;
  longTrades: number;
  shortTrades: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  avgHoldMin: number;
  feesUsd: number;
  finalCapital: number;
}

// ============================================================================
// DATA LOADING (once, reused)
// ============================================================================
async function loadAllData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000; // warmup for SMA200
  const extra1hMs = 250 * 60 * 60 * 1000;   // warmup for 1h SMA200
  const since15m = startMs - extraBarsMs;
  const since1h = startMs - extra1hMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btcLocal || !btc1hLocal) throw new Error('No local BTC data — run candle cache update first');

  const btcCandles = sliceCandlesByTime(btcLocal.candles, since15m, endMs);
  const btcCandles15mRegime = sliceCandlesByTime(btcLocal.candles, since15m, endMs);
  const btcCandles1hRegime = sliceCandlesByTime(btc1hLocal.candles, since1h, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) {
      console.warn(`  No local data for ${symbol}, skipping`);
      continue;
    }
    allData[symbol] = sliceCandlesByTime(local.candles, since15m, endMs);
  }

  return { btcCandles, btcCandles15mRegime, btcCandles1hRegime, allData };
}

// ============================================================================
// SNAPSHOT / RESTORE CONFIG
// ============================================================================
function snapshotConfig() {
  return {
    BTC_REGIME_TIMEFRAME: MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME,
    LOOKBACK_CANDLES: MomentumConfig.MULTI_TIMEFRAME_FILTER.LOOKBACK_CANDLES,
    MTF_TIMEFRAME: MomentumConfig.MULTI_TIMEFRAME_FILTER.TIMEFRAME,
  };
}

function applyConfig(cfg: ConfigDef) {
  (MomentumConfig.ENTRY as any).BTC_REGIME_TIMEFRAME = cfg.regimeTfMin === 60 ? '1h' : '15m';
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = cfg.lookbackCandles;
  // MTF timeframe follows regime unless hybrid
  if (!cfg.useHybrid) {
    (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).TIMEFRAME = cfg.regimeTfMin === 60 ? '1h' : '15m';
  } else {
    // Hybrid: MTF stays 15m
    (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).TIMEFRAME = '15m';
  }
}

function restoreConfig(snap: ReturnType<typeof snapshotConfig>) {
  (MomentumConfig.ENTRY as any).BTC_REGIME_TIMEFRAME = snap.BTC_REGIME_TIMEFRAME;
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).LOOKBACK_CANDLES = snap.LOOKBACK_CANDLES;
  (MomentumConfig.MULTI_TIMEFRAME_FILTER as any).TIMEFRAME = snap.MTF_TIMEFRAME;
}

// ============================================================================
// RUN SINGLE BACKTEST
// ============================================================================
async function runSingle(
  cfg: ConfigDef,
  periodLabel: string,
  startDate: Date,
  endDate: Date,
  data: Awaited<ReturnType<typeof loadAllData>>,
): Promise<RunResult> {
  const snap = snapshotConfig();
  applyConfig(cfg);

  try {
    // Build input based on config type
    const params = {
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols: SYMBOLS.filter(s => s in data.allData),
      leverage: LEVERAGE,
    };

    let btcCandlesRegime: any[];
    let CANDLE_REGIME_INTERVAL_MS: number;
    let btcCandlesRegimeSma: any[] | undefined;
    let CANDLE_REGIME_SMA_INTERVAL_MS: number | undefined;

    if (cfg.type === 'B_1h') {
      // Config B: everything on 1h
      btcCandlesRegime = data.btcCandles1hRegime;
      CANDLE_REGIME_INTERVAL_MS = 60 * 60 * 1000;
    } else if (cfg.type === 'C_hybrid') {
      // Config C: MTF+Cash on 15m, SMA200 on 1h
      btcCandlesRegime = data.btcCandles15mRegime;
      CANDLE_REGIME_INTERVAL_MS = 15 * 60 * 1000;
      btcCandlesRegimeSma = data.btcCandles1hRegime;
      CANDLE_REGIME_SMA_INTERVAL_MS = 60 * 60 * 1000;
    } else {
      // Config A: everything on 15m (prod)
      btcCandlesRegime = data.btcCandles15mRegime;
      CANDLE_REGIME_INTERVAL_MS = 15 * 60 * 1000;
    }

    const input: BacktestComputationInput = {
      params,
      btcCandles: data.btcCandles,
      btcCandlesRegime,
      allData: data.allData,
      CANDLE_REGIME_INTERVAL_MS,
      btcCandlesRegimeSma,
      CANDLE_REGIME_SMA_INTERVAL_MS,
    };

    const result = await runBacktestComputation(input);
    const s = result.summary;

    return {
      config: cfg.label,
      period: periodLabel,
      trades: s.totalTrades,
      longTrades: s.longTrades,
      shortTrades: s.shortTrades,
      winRate: s.winRate,
      pnlUsd: s.totalPnlUsd,
      pnlPct: s.totalPnlPct,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
      avgHoldMin: s.avgHoldMinutes,
      feesUsd: s.totalFeesUsd,
      finalCapital: s.finalCapital,
    };
  } finally {
    restoreConfig(snap);
  }
}

// ============================================================================
// OUTPUT FORMATTING
// ============================================================================
function padR(s: string, n: number): string { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number): string { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

function printTable(results: RunResult[]) {
  const header = [
    padR('Config', 18),
    padR('Period', 28),
    padL('Trades', 7),
    padL('L/S', 9),
    padL('WR%', 7),
    padL('PnL $', 10),
    padL('PnL %', 9),
    padL('DD%', 7),
    padL('Sharpe', 7),
    padL('PF', 6),
    padL('AvgH', 6),
    padL('Fees$', 8),
  ].join(' | ');

  console.log('\n' + '='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));

  let lastPeriod = '';
  for (const r of results) {
    if (r.period !== lastPeriod && lastPeriod !== '') {
      console.log('-'.repeat(header.length));
    }
    lastPeriod = r.period;

    console.log([
      padR(r.config, 18),
      padR(r.period, 28),
      padL(String(r.trades), 7),
      padL(`${r.longTrades}/${r.shortTrades}`, 9),
      padL(r.winRate.toFixed(1), 7),
      padL(r.pnlUsd.toFixed(0), 10),
      padL(r.pnlPct.toFixed(0) + '%', 9),
      padL(r.maxDD.toFixed(1), 7),
      padL(r.sharpe.toFixed(2), 7),
      padL(r.profitFactor.toFixed(2), 6),
      padL(Math.round(r.avgHoldMin / 60) + 'h', 6),
      padL(r.feesUsd.toFixed(0), 8),
    ].join(' | '));
  }
  console.log('='.repeat(header.length));
}

function printDeltaAnalysis(results: RunResult[]) {
  console.log('\n--- Delta Analysis (vs Config A: 15m prod) ---\n');

  const periods = [...new Set(results.map(r => r.period))];
  for (const period of periods) {
    const periodResults = results.filter(r => r.period === period);
    const baseline = periodResults.find(r => r.config.includes('A:'));
    if (!baseline) continue;

    console.log(`  ${period}:`);
    for (const r of periodResults) {
      if (r === baseline) continue;
      const dPnl = r.pnlUsd - baseline.pnlUsd;
      const dWR = r.winRate - baseline.winRate;
      const dDD = r.maxDD - baseline.maxDD;
      const dSharpe = r.sharpe - baseline.sharpe;
      const dTrades = r.trades - baseline.trades;
      console.log(`    ${padR(r.config, 16)} | dPnL: ${dPnl >= 0 ? '+' : ''}$${dPnl.toFixed(0)} | dWR: ${dWR >= 0 ? '+' : ''}${dWR.toFixed(1)}pp | dDD: ${dDD >= 0 ? '+' : ''}${dDD.toFixed(1)}pp | dSharpe: ${dSharpe >= 0 ? '+' : ''}${dSharpe.toFixed(2)} | dTrades: ${dTrades >= 0 ? '+' : ''}${dTrades}`);
    }
    console.log('');
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const args = process.argv.slice(2);
  const fullOnly = args.includes('--full-only');
  const noHybrid = args.includes('--no-hybrid');

  const configs = noHybrid ? CONFIGS.filter(c => c.type !== 'C_hybrid') : CONFIGS;
  const periods = fullOnly ? [PERIODS[0]] : PERIODS;

  console.log('=== BTC Regime Timeframe Comparison ===');
  console.log(`Configs: ${configs.map(c => c.label).join(', ')}`);
  console.log(`Periods: ${periods.map(p => p.label).join(', ')}`);
  console.log(`Symbols: ${SYMBOLS.length}`);
  console.log(`Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log('');

  // Load all data once with max range
  const minStart = Math.min(...periods.map(p => new Date(p.start).getTime()));
  const maxEnd = Math.max(...periods.map(p => new Date(p.end + 'T23:59:59.999Z').getTime()));
  console.log('Loading candle data...');
  const data = await loadAllData(minStart, maxEnd);
  console.log(`  BTC 15m: ${data.btcCandles.length} candles`);
  console.log(`  BTC 1h:  ${data.btcCandles1hRegime.length} candles`);
  console.log(`  Symbols: ${Object.keys(data.allData).length} loaded`);
  console.log('');

  const allResults: RunResult[] = [];
  const totalRuns = configs.length * periods.length;
  let runIdx = 0;

  for (const period of periods) {
    for (const cfg of configs) {
      runIdx++;
      const startDate = new Date(period.start + 'T00:00:00.000Z');
      const endDate = new Date(period.end + 'T23:59:59.999Z');

      console.log(`[${runIdx}/${totalRuns}] Running ${cfg.label} on ${period.label}...`);
      const t0 = Date.now();
      const result = await runSingle(cfg, period.label, startDate, endDate, data);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  -> ${result.trades} trades, $${result.pnlUsd.toFixed(0)} PnL, ${result.winRate.toFixed(1)}% WR, ${elapsed}s`);

      allResults.push(result);
    }
  }

  // Print results
  printTable(allResults);
  printDeltaAnalysis(allResults);

  console.log('\nDone.');
}

main().catch(console.error);
