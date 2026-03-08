/**
 * sweep-sl-predictors.ts — Backtest SL predictor filters from feature analysis
 *
 * Tests the top 3 features that separate SL from WIN trades:
 * 1. consecSameDir >= N (momentum confirmation before breakout)
 * 2. btcCandleBody alignment (BTC candle opposite to signal direction)
 * 3. volSurge >= X (volume confirmation on signal candle)
 *
 * Run: npx tsx scripts/sweep-sl-predictors.ts
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
// FEATURE EXTRACTION (same as sl-predictor-analysis.ts)
// ============================================================================

function extractTradeFeatures(
  trade: any,
  symCandles: BacktestCandle[],
  btcCandles: BacktestCandle[],
  symTsMap: Map<number, number>,
  btcTsMap: Map<number, number>,
) {
  const entryTs = new Date(trade.entryTime).getTime();
  const grid = 15 * 60 * 1000;
  // V5.150 FIX: trade.entryTime = candle CLOSE (candle.timestamp + 15min).
  // Subtract 15min to recover the signal candle's OPEN timestamp for feature extraction.
  const gridTs = Math.floor((entryTs - grid) / grid) * grid;

  let symIdx = symTsMap.get(gridTs);
  if (symIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of symTsMap) {
      if (Math.abs(ts - entryTs) < bestDist) { bestDist = Math.abs(ts - entryTs); best = idx; }
    }
    symIdx = best;
  }
  if (symIdx < 20) return null;

  const c = symCandles[symIdx];
  const isLong = trade.side === 'long';

  // 1. consecSameDir
  let consecSameDir = 0;
  for (let i = symIdx; i >= Math.max(0, symIdx - 10); i--) {
    const cc = symCandles[i];
    if ((isLong && cc.close > cc.open) || (!isLong && cc.close < cc.open)) {
      consecSameDir++;
    } else break;
  }

  // 2. btcCandleBody
  let btcIdx = btcTsMap.get(gridTs);
  if (btcIdx === undefined) {
    let best = 0, bestDist = Infinity;
    for (const [ts, idx] of btcTsMap) {
      if (Math.abs(ts - entryTs) < bestDist) { bestDist = Math.abs(ts - entryTs); best = idx; }
    }
    btcIdx = best;
  }
  const btcGreen = btcIdx >= 0 ? btcCandles[btcIdx].close > btcCandles[btcIdx].open : false;

  // 3. volSurge (signal candle vol / avg of 5 prior)
  const pre5 = symCandles.slice(symIdx - 5, symIdx);
  const avgPre5Vol = pre5.reduce((s, x) => s + x.volume, 0) / 5;
  const volSurge = avgPre5Vol > 0 ? c.volume / avgPre5Vol : 0;

  // 4. closeSlopeAngle (bonus)
  const pre5Closes = pre5.map(x => x.close);
  let closeSlopeAngle = 0;
  if (pre5Closes.length === 5) {
    const yMean = pre5Closes.reduce((a, b) => a + b, 0) / 5;
    let num = 0, den = 0;
    for (let i = 0; i < 5; i++) { num += (i - 2) * (pre5Closes[i] - yMean); den += (i - 2) ** 2; }
    closeSlopeAngle = den > 0 && yMean > 0 ? ((num / den) / yMean) * 100 : 0;
  }

  return { consecSameDir, btcGreen, volSurge, closeSlopeAngle, isLong };
}

// ============================================================================
// FILTER CONFIGS
// ============================================================================

interface FilterConfig {
  name: string;
  minConsecSameDir: number;     // 0 = disabled
  requireBtcOpposite: boolean;  // true = LONG needs BTC red, SHORT needs BTC green
  minVolSurge: number;          // 0 = disabled
  minCloseSlopeAbs: number;     // 0 = disabled — abs(slope) must be >= this
}

function shouldFilter(f: ReturnType<typeof extractTradeFeatures>, config: FilterConfig): boolean {
  if (!f) return false;
  if (config.minConsecSameDir > 0 && f.consecSameDir < config.minConsecSameDir) return true;
  if (config.requireBtcOpposite) {
    // LONG signal: want BTC red (not green). SHORT signal: want BTC green.
    if (f.isLong && f.btcGreen) return true;
    if (!f.isLong && !f.btcGreen) return true;
  }
  if (config.minVolSurge > 0 && f.volSurge < config.minVolSurge) return true;
  if (config.minCloseSlopeAbs > 0 && Math.abs(f.closeSlopeAngle) < config.minCloseSlopeAbs) return true;
  return false;
}

// ============================================================================
// BACKTEST
// ============================================================================

async function runBT(start: string, end: string) {
  const startDate = new Date(start + 'T00:00:00.000Z');
  const endDate = new Date(end + 'T23:59:59.999Z');
  const extraBarsMs = 3200 * 15 * 60 * 1000;
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

function calcStats(trades: any[], initialCapital: number) {
  if (trades.length === 0) return { trades: 0, wr: 0, pnl: 0, dd: 0, slCount: 0, slPnl: 0 };
  const wins = trades.filter(t => t.netPnlUsd > 0).length;
  const pnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const slTrades = trades.filter(t => (t.exitReason || '').includes('SL'));
  let peak = initialCapital, equity = initialCapital, maxDd = 0;
  const sorted = [...trades].sort((a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime());
  for (const t of sorted) {
    equity += t.netPnlUsd;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    trades: trades.length, wr: (wins / trades.length) * 100, pnl, dd: maxDd,
    slCount: slTrades.length, slPnl: slTrades.reduce((s, t) => s + t.netPnlUsd, 0),
  };
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  SL PREDICTOR FILTER SWEEP — 2024 vs 2025');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Running 2024 backtest...');
  const bt2024 = await runBT('2024-01-01', '2024-12-31');
  console.log(`  2024: ${bt2024.summary.totalTrades} trades, $${bt2024.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  console.log('Running 2025 backtest...');
  const bt2025 = await runBT('2025-01-01', '2025-12-31');
  console.log(`  2025: ${bt2025.summary.totalTrades} trades, $${bt2025.summary.totalPnlUsd.toFixed(0)} PnL\n`);

  const grid = 15 * 60 * 1000;
  function buildTsMaps(candles: BacktestCandle[]) {
    const m = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) m.set(Math.floor(candles[i].timestamp / grid) * grid, i);
    return m;
  }

  const btcMap2024 = buildTsMaps(bt2024.btcCandles);
  const btcMap2025 = buildTsMaps(bt2025.btcCandles);
  const symMaps2024 = new Map<string, Map<number, number>>();
  const symMaps2025 = new Map<string, Map<number, number>>();
  for (const [sym, c] of Object.entries(bt2024.allData)) symMaps2024.set(sym, buildTsMaps(c));
  for (const [sym, c] of Object.entries(bt2025.allData)) symMaps2025.set(sym, buildTsMaps(c));

  const configs: FilterConfig[] = [
    { name: 'BASELINE', minConsecSameDir: 0, requireBtcOpposite: false, minVolSurge: 0, minCloseSlopeAbs: 0 },

    // Single: consecSameDir (the #1 predictor)
    { name: 'consec >= 1', minConsecSameDir: 1, requireBtcOpposite: false, minVolSurge: 0, minCloseSlopeAbs: 0 },
    { name: 'consec >= 2', minConsecSameDir: 2, requireBtcOpposite: false, minVolSurge: 0, minCloseSlopeAbs: 0 },
    { name: 'consec >= 3', minConsecSameDir: 3, requireBtcOpposite: false, minVolSurge: 0, minCloseSlopeAbs: 0 },

    // Single: BTC opposite candle
    { name: 'BTC opposite', minConsecSameDir: 0, requireBtcOpposite: true, minVolSurge: 0, minCloseSlopeAbs: 0 },

    // Single: volSurge
    { name: 'volSurge >= 1.2', minConsecSameDir: 0, requireBtcOpposite: false, minVolSurge: 1.2, minCloseSlopeAbs: 0 },
    { name: 'volSurge >= 1.3', minConsecSameDir: 0, requireBtcOpposite: false, minVolSurge: 1.3, minCloseSlopeAbs: 0 },
    { name: 'volSurge >= 1.5', minConsecSameDir: 0, requireBtcOpposite: false, minVolSurge: 1.5, minCloseSlopeAbs: 0 },

    // Combined: consec + BTC opposite
    { name: 'consec>=1 + BTC opp', minConsecSameDir: 1, requireBtcOpposite: true, minVolSurge: 0, minCloseSlopeAbs: 0 },
    { name: 'consec>=2 + BTC opp', minConsecSameDir: 2, requireBtcOpposite: true, minVolSurge: 0, minCloseSlopeAbs: 0 },

    // Combined: consec + volSurge
    { name: 'consec>=1 + vol>=1.2', minConsecSameDir: 1, requireBtcOpposite: false, minVolSurge: 1.2, minCloseSlopeAbs: 0 },
    { name: 'consec>=1 + vol>=1.3', minConsecSameDir: 1, requireBtcOpposite: false, minVolSurge: 1.3, minCloseSlopeAbs: 0 },

    // Triple combo
    { name: 'c>=1+BTC+vol>=1.2', minConsecSameDir: 1, requireBtcOpposite: true, minVolSurge: 1.2, minCloseSlopeAbs: 0 },
  ];

  console.log('════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════════════════════════\n');

  const header = 'Config'.padEnd(24) + '| 2024 Tr | 2024 PnL | 2024 SL$ | 2025 Tr | 2025 PnL | 2025 SL$ | COMBINED';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const config of configs) {
    let s2024, s2025;

    if (config.minConsecSameDir === 0 && !config.requireBtcOpposite && config.minVolSurge === 0 && config.minCloseSlopeAbs === 0) {
      s2024 = calcStats(bt2024.trades, INITIAL_CAPITAL);
      s2025 = calcStats(bt2025.trades, INITIAL_CAPITAL);
    } else {
      const kept2024 = bt2024.trades.filter(t => {
        const f = extractTradeFeatures(t, bt2024.allData[t.symbol], bt2024.btcCandles, symMaps2024.get(t.symbol)!, btcMap2024);
        return !shouldFilter(f, config);
      });
      const kept2025 = bt2025.trades.filter(t => {
        const f = extractTradeFeatures(t, bt2025.allData[t.symbol], bt2025.btcCandles, symMaps2025.get(t.symbol)!, btcMap2025);
        return !shouldFilter(f, config);
      });
      s2024 = calcStats(kept2024, INITIAL_CAPITAL);
      s2025 = calcStats(kept2025, INITIAL_CAPITAL);
    }

    const combined = s2024.pnl + s2025.pnl;
    console.log(
      config.name.padEnd(24) + '| ' +
      String(s2024.trades).padStart(4) + '    | ' +
      ('$' + s2024.pnl.toFixed(0)).padStart(7) + '  | ' +
      ('$' + s2024.slPnl.toFixed(0)).padStart(7) + '  | ' +
      String(s2025.trades).padStart(4) + '    | ' +
      ('$' + s2025.pnl.toFixed(0)).padStart(7) + '  | ' +
      ('$' + s2025.slPnl.toFixed(0)).padStart(7) + '  | ' +
      ('$' + combined.toFixed(0)).padStart(8)
    );
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
