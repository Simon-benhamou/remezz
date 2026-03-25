/**
 * sweep-bull-detector.ts — Test bull run detector on 2024 (bull) and 2025 (range)
 *
 * Tests multiple detector configs to find the sweet spot:
 * - Filter 2024 losses (bull run) without hurting 2025 gains (range)
 *
 * Run: npx tsx scripts/sweep-bull-detector.ts
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

const SYMBOLS = ['AVAX', 'FET', 'WIF', 'DOT', 'IMX', 'STX', 'ADA', 'RENDER', 'XRP'];
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;
const DATA_DIR = path.resolve(process.cwd(), 'data');

// ============================================================================
// BULL DETECTOR: Check if a given timestamp is in "bull run" mode
// Uses BTC 15m candles to compute regime indicators
// ============================================================================

interface BullDetectorConfig {
  name: string;
  btcDelta30dThreshold: number;   // BTC Δ30d > X% => bull (0 = disabled)
  btcAboveSma200Pct: number;      // BTC > SMA200 by X% => bull (0 = disabled)
  requireBoth: boolean;            // true = AND logic, false = OR logic
}

function isBullRun(
  btcCandles: BacktestCandle[],
  currentIdx: number,
  config: BullDetectorConfig
): boolean {
  const CANDLES_30D = 30 * 24 * 4; // 2880 candles = 30 days of 15m

  // Need enough history
  if (currentIdx < Math.max(CANDLES_30D, 200)) return false;

  const currentClose = btcCandles[currentIdx].close;

  // Criterion 1: BTC Δ30d
  let delta30dTriggered = false;
  if (config.btcDelta30dThreshold > 0) {
    const close30dAgo = btcCandles[currentIdx - CANDLES_30D].close;
    const delta30d = ((currentClose - close30dAgo) / close30dAgo) * 100;
    delta30dTriggered = delta30d > config.btcDelta30dThreshold;
  }

  // Criterion 2: BTC above SMA200 by X%
  let aboveSma200Triggered = false;
  if (config.btcAboveSma200Pct > 0) {
    let sum = 0;
    for (let i = currentIdx - 199; i <= currentIdx; i++) {
      sum += btcCandles[i].close;
    }
    const sma200 = sum / 200;
    const distPct = ((currentClose - sma200) / sma200) * 100;
    aboveSma200Triggered = distPct > config.btcAboveSma200Pct;
  }

  if (config.requireBoth) {
    return delta30dTriggered && aboveSma200Triggered;
  } else {
    // If only one criterion is configured, use it alone
    if (config.btcDelta30dThreshold > 0 && config.btcAboveSma200Pct > 0) {
      return delta30dTriggered || aboveSma200Triggered;
    }
    return delta30dTriggered || aboveSma200Triggered;
  }
}

// ============================================================================
// RUN BACKTEST WITH BULL DETECTOR
// ============================================================================

async function runBT(period: string, start: string, end: string) {
  const startDate = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const endMs = endDate.getTime();

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of SYMBOLS) {
    const fpath = path.join(DATA_DIR, sym + '_USDT_15m.json');
    if (!fs.existsSync(fpath)) continue;
    const raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    const candles: BacktestCandle[] = raw
      .filter((c: any) => c.openTime && c.open && c.close)
      .map((c: any) => ({
        timestamp: c.openTime, open: +c.open, high: +c.high,
        low: +c.low, close: +c.close, volume: +(c.volume || 0),
      }))
      .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);
    const sliced = sliceCandlesByTime(candles, since, endMs);
    if (sliced.length >= 300) allData[sym + '/USDT:USDT'] = sliced;
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: Object.keys(allData), leverage: LEVERAGE },
    btcCandles, btcCandlesRegime: btcCandles, allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  return { trades: result.trades, summary: result.summary, btcCandles, allData };
}

// ============================================================================
// FILTER TRADES BY BULL DETECTOR
// ============================================================================

function filterTrades(
  trades: any[],
  btcCandles: BacktestCandle[],
  config: BullDetectorConfig
) {
  // Build a quick timestamp→index map
  const tsToIdx = new Map<number, number>();
  for (let i = 0; i < btcCandles.length; i++) {
    tsToIdx.set(btcCandles[i].timestamp, i);
  }

  const kept: any[] = [];
  const filtered: any[] = [];

  for (const t of trades) {
    const entryTs = new Date(t.entryTime).getTime();
    // Find closest BTC candle index
    const flooredTs = Math.floor(entryTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    let idx = tsToIdx.get(flooredTs);
    if (idx === undefined) {
      // Find nearest
      let best = 0;
      let bestDist = Infinity;
      for (let i = 0; i < btcCandles.length; i++) {
        const dist = Math.abs(btcCandles[i].timestamp - entryTs);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      idx = best;
    }

    if (isBullRun(btcCandles, idx, config)) {
      filtered.push(t);
    } else {
      kept.push(t);
    }
  }

  return { kept, filtered };
}

function calcStats(trades: any[], initialCapital: number) {
  if (trades.length === 0) return { trades: 0, wr: 0, pnl: 0, dd: 0 };

  const wins = trades.filter(t => t.netPnlUsd > 0).length;
  const pnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);

  // Simplified DD calc
  let peak = initialCapital;
  let equity = initialCapital;
  let maxDd = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());
  for (const t of sorted) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  return { trades: trades.length, wr: (wins / trades.length) * 100, pnl, dd: maxDd };
}

// ============================================================================
// MAIN SWEEP
// ============================================================================

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  BULL RUN DETECTOR SWEEP — 2024 vs 2025');
  console.log('════════════════════════════════════════════════════════════\n');

  // Run backtests
  console.log('Running 2024 backtest (bull year)...');
  const bt2024 = await runBT('2024', '2024-01-01', '2024-12-31');
  console.log(`  2024: ${bt2024.summary.totalTrades} trades, $${bt2024.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  console.log('Running 2025 backtest (range year)...');
  const bt2025 = await runBT('2025', '2025-01-01', '2025-12-31');
  console.log(`  2025: ${bt2025.summary.totalTrades} trades, $${bt2025.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  // Detector configs to test
  const configs: BullDetectorConfig[] = [
    { name: 'BASELINE (no filter)', btcDelta30dThreshold: 0, btcAboveSma200Pct: 0, requireBoth: false },

    // Single criterion: BTC Δ30d
    { name: 'Δ30d > 10%', btcDelta30dThreshold: 10, btcAboveSma200Pct: 0, requireBoth: false },
    { name: 'Δ30d > 15%', btcDelta30dThreshold: 15, btcAboveSma200Pct: 0, requireBoth: false },
    { name: 'Δ30d > 20%', btcDelta30dThreshold: 20, btcAboveSma200Pct: 0, requireBoth: false },
    { name: 'Δ30d > 25%', btcDelta30dThreshold: 25, btcAboveSma200Pct: 0, requireBoth: false },

    // Single criterion: BTC above SMA200
    { name: 'SMA200 > 3%', btcDelta30dThreshold: 0, btcAboveSma200Pct: 3, requireBoth: false },
    { name: 'SMA200 > 5%', btcDelta30dThreshold: 0, btcAboveSma200Pct: 5, requireBoth: false },
    { name: 'SMA200 > 8%', btcDelta30dThreshold: 0, btcAboveSma200Pct: 8, requireBoth: false },
    { name: 'SMA200 > 10%', btcDelta30dThreshold: 0, btcAboveSma200Pct: 10, requireBoth: false },

    // Combined AND (conservative — need both to stop trading)
    { name: 'Δ30d>15% AND SMA>5%', btcDelta30dThreshold: 15, btcAboveSma200Pct: 5, requireBoth: true },
    { name: 'Δ30d>20% AND SMA>5%', btcDelta30dThreshold: 20, btcAboveSma200Pct: 5, requireBoth: true },
    { name: 'Δ30d>10% AND SMA>8%', btcDelta30dThreshold: 10, btcAboveSma200Pct: 8, requireBoth: true },
    { name: 'Δ30d>15% AND SMA>8%', btcDelta30dThreshold: 15, btcAboveSma200Pct: 8, requireBoth: true },
    { name: 'Δ30d>20% AND SMA>10%', btcDelta30dThreshold: 20, btcAboveSma200Pct: 10, requireBoth: true },

    // Combined OR (aggressive — stop trading if either triggers)
    { name: 'Δ30d>20% OR SMA>8%', btcDelta30dThreshold: 20, btcAboveSma200Pct: 8, requireBoth: false },
    { name: 'Δ30d>15% OR SMA>5%', btcDelta30dThreshold: 15, btcAboveSma200Pct: 5, requireBoth: false },
  ];

  // Results table
  console.log('════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════════════════════════\n');

  const header = 'Config'.padEnd(28) + '| 2024 Trades | 2024 PnL  | 2024 DD  | 2025 Trades | 2025 PnL  | 2025 DD  | COMBINED';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const config of configs) {
    let s2024, s2025;

    if (config.btcDelta30dThreshold === 0 && config.btcAboveSma200Pct === 0) {
      // Baseline — no filtering
      s2024 = calcStats(bt2024.trades, INITIAL_CAPITAL);
      s2025 = calcStats(bt2025.trades, INITIAL_CAPITAL);
    } else {
      const f2024 = filterTrades(bt2024.trades, bt2024.btcCandles, config);
      const f2025 = filterTrades(bt2025.trades, bt2025.btcCandles, config);
      s2024 = calcStats(f2024.kept, INITIAL_CAPITAL);
      s2025 = calcStats(f2025.kept, INITIAL_CAPITAL);
    }

    const combined = s2024.pnl + s2025.pnl;
    const line = config.name.padEnd(28) + '| '
      + String(s2024.trades).padStart(6) + '      | '
      + ('$' + s2024.pnl.toFixed(0)).padStart(8) + '  | '
      + (s2024.dd.toFixed(1) + '%').padStart(6) + '  | '
      + String(s2025.trades).padStart(6) + '      | '
      + ('$' + s2025.pnl.toFixed(0)).padStart(8) + '  | '
      + (s2025.dd.toFixed(1) + '%').padStart(6) + '  | '
      + ('$' + combined.toFixed(0)).padStart(8);
    console.log(line);
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
