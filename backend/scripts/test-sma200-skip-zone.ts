/**
 * test-sma200-skip-zone.ts — Test BTC SMA200 skip zone filter + quality bypass
 *
 * Phase 1: Sweeps BTC_SMA200_SKIP_ZONE_PCT from 0% to 2.5%
 * Phase 2: Sweeps quality bypass thresholds at best skip zone (1.0%)
 *
 * Usage:
 *   npx tsx scripts/test-sma200-skip-zone.ts
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// CONFIG
// ============================================================================
const SYMBOLS = [
  'DOGE/USDT:USDT', 'IMX/USDT:USDT', 'AVAX/USDT:USDT',
  'FET/USDT:USDT', 'WIF/USDT:USDT',
  'ADA/USDT:USDT', 'DOT/USDT:USDT', 'STX/USDT:USDT',
  'TIA/USDT:USDT',
];

const SKIP_ZONE_VALUES = [0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.5];
const QUALITY_BYPASS_VALUES = [0, 40, 50, 55, 60, 65, 70];
const QUALITY_BYPASS_SKIP_ZONE = 1.0; // Test quality bypass at this skip zone

const PERIODS = [
  { label: '2025 (in-sample)',  start: '2025-01-01', end: '2025-12-31' },
  { label: '2024 (OOS)',        start: '2024-01-01', end: '2024-12-31' },
];

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// ============================================================================
// DATA LOADING (supports both data/ and data/2024/)
// ============================================================================
function loadJsonFile(filepath: string, since: number, endMs: number): BacktestCandle[] | null {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    const json = JSON.parse(raw);
    if (!Array.isArray(json) || json.length < 100) return null;
    const candles: BacktestCandle[] = json
      .filter((c: any) => c.openTime && c.open && c.close)
      .map((c: any) => ({
        timestamp: c.openTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume || 0),
      }))
      .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);
    return sliceCandlesByTime(candles, since, endMs);
  } catch { return null; }
}

function findSymbolFile(symbol: string): string | null {
  const base = symbol.replace('/USDT:USDT', '').replace('/', '_');
  const fname = `${base}_USDT_15m.json`;
  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');

  const mainPath = path.join(dataDir, fname);
  if (fs.existsSync(mainPath)) return mainPath;

  const path2024 = path.join(data2024Dir, fname);
  if (fs.existsSync(path2024)) return path2024;

  return null;
}

async function loadData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  let btcCandles: BacktestCandle[] | null = null;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (btcLocal) {
    btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  }
  if (!btcCandles || btcCandles.length < 300) {
    const btc2024 = findSymbolFile('BTC/USDT:USDT');
    if (btc2024) {
      const loaded = loadJsonFile(btc2024, since, endMs);
      if (loaded && loaded.length > (btcCandles?.length ?? 0)) {
        btcCandles = loaded;
        console.log(`  BTC loaded from ${btc2024} (${loaded.length} candles)`);
      }
    }
  }
  if (!btcCandles || btcCandles.length < 100) throw new Error('No BTC 15m data');

  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (local) {
      const sliced = sliceCandlesByTime(local.candles, since, endMs);
      if (sliced.length >= 300) { allData[symbol] = sliced; continue; }
    }
    const filepath = findSymbolFile(symbol);
    if (filepath) {
      const loaded = loadJsonFile(filepath, since, endMs);
      if (loaded && loaded.length >= 300) {
        allData[symbol] = loaded;
        console.log(`  ${symbol} loaded from ${filepath} (${loaded.length} candles)`);
        continue;
      }
    }
    console.warn(`  No sufficient data for ${symbol}, skipping`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// TYPES
// ============================================================================
interface RunResult {
  skipZone: number;
  qualityBypass: number;
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
  finalCapital: number;
}

// ============================================================================
// RUN SINGLE
// ============================================================================
async function runSingle(
  skipZonePct: number,
  qualityBypass: number,
  periodLabel: string,
  startDate: Date,
  endDate: Date,
  data: Awaited<ReturnType<typeof loadData>>,
): Promise<RunResult> {
  const origSkipZone = (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT;
  const origQualityBypass = (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS;
  (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT = skipZonePct;
  (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS = qualityBypass;

  try {
    const params = {
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols: SYMBOLS.filter(s => s in data.allData),
      leverage: LEVERAGE,
    };

    const input: BacktestComputationInput = {
      params,
      btcCandles: data.btcCandles,
      btcCandlesRegime: data.btcCandles,
      allData: data.allData,
      CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
    };

    const result = await runBacktestComputation(input);
    const s = result.summary;

    return {
      skipZone: skipZonePct,
      qualityBypass,
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
      finalCapital: s.finalCapital,
    };
  } finally {
    (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT = origSkipZone;
    (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS = origQualityBypass;
  }
}

// ============================================================================
// OUTPUT
// ============================================================================
function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

function printResults(results: RunResult[], title: string) {
  const header = [
    padR('Skip%', 7),
    padR('QBP', 4),
    padR('Period', 20),
    padL('Trades', 7),
    padL('L/S', 9),
    padL('WR%', 7),
    padL('PnL $', 10),
    padL('ROI%', 8),
    padL('DD%', 7),
    padL('Sharpe', 7),
    padL('PF', 6),
  ].join(' | ');

  console.log(`\n${title}`);
  console.log('='.repeat(header.length));
  console.log(header);
  console.log('-'.repeat(header.length));

  const periods = [...new Set(results.map(r => r.period))];
  for (const period of periods) {
    const periodResults = results.filter(r => r.period === period).sort((a, b) => {
      if (a.skipZone !== b.skipZone) return a.skipZone - b.skipZone;
      return a.qualityBypass - b.qualityBypass;
    });

    for (const r of periodResults) {
      const isBaseline = r.skipZone === 0;
      const prefix = isBaseline ? '*' : ' ';
      console.log(prefix + [
        padR(r.skipZone.toFixed(1) + '%', 6),
        padR(r.qualityBypass > 0 ? String(r.qualityBypass) : '-', 4),
        padR(r.period, 20),
        padL(String(r.trades), 7),
        padL(`${r.longTrades}/${r.shortTrades}`, 9),
        padL(r.winRate.toFixed(1), 7),
        padL(r.pnlUsd.toFixed(0), 10),
        padL(r.pnlPct.toFixed(0) + '%', 8),
        padL(r.maxDD.toFixed(1), 7),
        padL(r.sharpe.toFixed(2), 7),
        padL(r.profitFactor.toFixed(2), 6),
      ].join(' | '));
    }
    console.log('-'.repeat(header.length));
  }
  console.log('* = baseline (no filter)');
}

function printDeltaTable(results: RunResult[], baselineResults: RunResult[]) {
  console.log('\n--- Delta vs Baseline (skipZone=0%) ---\n');

  const periods = [...new Set(results.map(r => r.period))];

  for (const period of periods) {
    console.log(`  ${period}:`);
    const periodResults = results.filter(r => r.period === period);
    const baseline = baselineResults.find(r => r.period === period && r.skipZone === 0);
    if (!baseline) continue;

    console.log(`    ${padR('Config', 12)} | ${padL('dTrades', 8)} | ${padL('dWR', 7)} | ${padL('dPnL$', 10)} | ${padL('dDD', 7)} | ${padL('dSharpe', 8)} | ${padL('dPF', 6)}`);
    console.log('    ' + '-'.repeat(75));

    for (const r of periodResults) {
      if (r === baseline || (r.skipZone === 0 && r.qualityBypass === 0)) continue;
      const dTrades = r.trades - baseline.trades;
      const dWR = r.winRate - baseline.winRate;
      const dPnl = r.pnlUsd - baseline.pnlUsd;
      const dDD = r.maxDD - baseline.maxDD;
      const dSharpe = r.sharpe - baseline.sharpe;
      const dPF = r.profitFactor - baseline.profitFactor;

      const label = r.qualityBypass > 0
        ? `SZ${r.skipZone}+Q${r.qualityBypass}`
        : `SZ${r.skipZone}%`;

      console.log(`    ${padR(label, 12)} | ${padL((dTrades >= 0 ? '+' : '') + dTrades, 8)} | ${padL((dWR >= 0 ? '+' : '') + dWR.toFixed(1), 7)} | ${padL((dPnl >= 0 ? '+$' : '-$') + Math.abs(dPnl).toFixed(0), 10)} | ${padL((dDD >= 0 ? '+' : '') + dDD.toFixed(1), 7)} | ${padL((dSharpe >= 0 ? '+' : '') + dSharpe.toFixed(2), 8)} | ${padL((dPF >= 0 ? '+' : '') + dPF.toFixed(2), 6)}`);
    }
    console.log('');
  }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== SMA200 Skip Zone Filter Test (with Quality Bypass) ===\n');

  // ─── PHASE 1: Skip Zone Sweep ───
  console.log('╔══ PHASE 1: Skip Zone Sweep ══╗');
  console.log(`Skip zone values: ${SKIP_ZONE_VALUES.map(v => v + '%').join(', ')}`);
  console.log(`Symbols: ${SYMBOLS.length}, Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x\n`);

  const phase1Results: RunResult[] = [];
  let totalRuns = SKIP_ZONE_VALUES.length * PERIODS.length;
  let runIdx = 0;

  for (const period of PERIODS) {
    const startDate = new Date(period.start + 'T00:00:00.000Z');
    const endDate = new Date(period.end + 'T23:59:59.999Z');

    console.log(`\nLoading data for ${period.label}...`);
    const data = await loadData(startDate.getTime(), endDate.getTime());
    console.log(`  BTC 15m: ${data.btcCandles.length} candles, Symbols: ${Object.keys(data.allData).length}\n`);

    for (const skipZone of SKIP_ZONE_VALUES) {
      runIdx++;
      console.log(`[${runIdx}/${totalRuns}] SkipZone ${skipZone}% on ${period.label}...`);
      const t0 = Date.now();
      const result = await runSingle(skipZone, 0, period.label, startDate, endDate, data);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  -> ${result.trades} trades, $${result.pnlUsd.toFixed(0)} PnL, ${result.winRate.toFixed(1)}% WR, DD ${result.maxDD.toFixed(1)}%, ${elapsed}s`);
      phase1Results.push(result);
    }
  }

  printResults(phase1Results, 'PHASE 1: Skip Zone Sweep Results');

  // ─── PHASE 2: Quality Bypass Sweep at optimal skip zone ───
  console.log(`\n╔══ PHASE 2: Quality Bypass Sweep at SkipZone=${QUALITY_BYPASS_SKIP_ZONE}% ══╗`);
  console.log(`Quality bypass values: ${QUALITY_BYPASS_VALUES.map(v => v > 0 ? v.toString() : 'OFF').join(', ')}\n`);

  const phase2Results: RunResult[] = [];
  totalRuns = QUALITY_BYPASS_VALUES.length * PERIODS.length;
  runIdx = 0;

  for (const period of PERIODS) {
    const startDate = new Date(period.start + 'T00:00:00.000Z');
    const endDate = new Date(period.end + 'T23:59:59.999Z');

    console.log(`\nLoading data for ${period.label}...`);
    const data = await loadData(startDate.getTime(), endDate.getTime());
    console.log(`  BTC 15m: ${data.btcCandles.length} candles, Symbols: ${Object.keys(data.allData).length}\n`);

    for (const qbp of QUALITY_BYPASS_VALUES) {
      runIdx++;
      console.log(`[${runIdx}/${totalRuns}] SkipZone ${QUALITY_BYPASS_SKIP_ZONE}% + QualityBypass ${qbp || 'OFF'} on ${period.label}...`);
      const t0 = Date.now();
      const result = await runSingle(QUALITY_BYPASS_SKIP_ZONE, qbp, period.label, startDate, endDate, data);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  -> ${result.trades} trades, $${result.pnlUsd.toFixed(0)} PnL, ${result.winRate.toFixed(1)}% WR, DD ${result.maxDD.toFixed(1)}%, ${elapsed}s`);
      phase2Results.push(result);
    }
  }

  printResults(phase2Results, 'PHASE 2: Quality Bypass Sweep (SkipZone=' + QUALITY_BYPASS_SKIP_ZONE + '%)');

  // ─── Combined Delta Analysis ───
  const allResults = [...phase1Results, ...phase2Results];
  const baselineResults = phase1Results.filter(r => r.skipZone === 0);
  printDeltaTable(allResults, baselineResults);

  // ─── Best Config ───
  console.log('\n--- Best Config (highest Sharpe with DD improvement) ---\n');
  for (const period of PERIODS) {
    const baseline = baselineResults.find(r => r.period === period.label)!;
    const all = allResults.filter(r => r.period === period.label && !(r.skipZone === 0 && r.qualityBypass === 0));
    const improved = all
      .filter(r => r.maxDD <= baseline.maxDD)
      .sort((a, b) => b.sharpe - a.sharpe);
    if (improved.length > 0) {
      const best = improved[0];
      const label = best.qualityBypass > 0
        ? `SkipZone ${best.skipZone}% + Quality >= ${best.qualityBypass}`
        : `SkipZone ${best.skipZone}%`;
      console.log(`  ${period.label}: ${label}`);
      console.log(`    Sharpe ${best.sharpe.toFixed(2)} (${(best.sharpe - baseline.sharpe >= 0 ? '+' : '')}${(best.sharpe - baseline.sharpe).toFixed(2)}), DD ${best.maxDD.toFixed(1)}% (${(best.maxDD - baseline.maxDD).toFixed(1)}pp), PnL $${best.pnlUsd.toFixed(0)} (${(best.pnlUsd - baseline.pnlUsd >= 0 ? '+$' : '-$')}${Math.abs(best.pnlUsd - baseline.pnlUsd).toFixed(0)}), Trades ${best.trades}`);
    }
  }

  console.log('\nDone.');
}

main().catch(console.error);
