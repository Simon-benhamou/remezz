/**
 * analyze-exits.ts — Analyze backtest trades by exit reason
 *
 * Shows PnL breakdown by exit type (NFS_HIGH, NFS_MED, NFS_LOW, SL, etc.)
 * Run: npx tsx scripts/analyze-exits.ts
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

  return await runBacktestComputation(input);
}

function analyzeExits(trades: any[], label: string) {
  const byReason: Record<string, { count: number; wins: number; pnl: number; avgPnl: number }> = {};

  for (const t of trades) {
    const reason = t.exitReason || 'UNKNOWN';
    if (!byReason[reason]) byReason[reason] = { count: 0, wins: 0, pnl: 0, avgPnl: 0 };
    byReason[reason].count++;
    if (t.netPnlUsd > 0) byReason[reason].wins++;
    byReason[reason].pnl += t.netPnlUsd;
  }

  // Compute avg
  for (const r of Object.values(byReason)) {
    r.avgPnl = r.count > 0 ? r.pnl / r.count : 0;
  }

  console.log(`\n═══ ${label} — ${trades.length} trades, $${trades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(0)} total PnL ═══`);
  console.log('Exit Reason'.padEnd(25) + '| Count | WR     | Total PnL  | Avg PnL');
  console.log('-'.repeat(80));

  const sorted = Object.entries(byReason).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [reason, stats] of sorted) {
    const wr = stats.count > 0 ? (stats.wins / stats.count * 100).toFixed(1) : '0.0';
    console.log(
      reason.padEnd(25) + '| ' +
      String(stats.count).padStart(5) + ' | ' +
      (wr + '%').padStart(6) + ' | ' +
      ('$' + stats.pnl.toFixed(0)).padStart(10) + ' | ' +
      ('$' + stats.avgPnl.toFixed(1)).padStart(8)
    );
  }

  // Also show: what if we removed HIGH exits (use MED trail instead)?
  const highTrades = trades.filter(t => t.exitReason?.includes('NFS_HIGH'));
  const medTrades = trades.filter(t => t.exitReason?.includes('NFS_MED'));
  const lowTrades = trades.filter(t => t.exitReason?.includes('NFS_LOW'));
  const slTrades = trades.filter(t => t.exitReason?.includes('STOP_LOSS') || t.exitReason?.includes('SL'));

  console.log('\n--- Summary by NFS tier ---');
  console.log(`NFS HIGH: ${highTrades.length} trades, $${highTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(0)} PnL, ${highTrades.length > 0 ? (highTrades.filter(t => t.netPnlUsd > 0).length / highTrades.length * 100).toFixed(1) : 0}% WR`);
  console.log(`NFS MED:  ${medTrades.length} trades, $${medTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(0)} PnL, ${medTrades.length > 0 ? (medTrades.filter(t => t.netPnlUsd > 0).length / medTrades.length * 100).toFixed(1) : 0}% WR`);
  console.log(`NFS LOW:  ${lowTrades.length} trades, $${lowTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(0)} PnL, ${lowTrades.length > 0 ? (lowTrades.filter(t => t.netPnlUsd > 0).length / lowTrades.length * 100).toFixed(1) : 0}% WR`);
  console.log(`SL:       ${slTrades.length} trades, $${slTrades.reduce((s, t) => s + t.netPnlUsd, 0).toFixed(0)} PnL`);
}

async function main() {
  console.log('Running 2024 backtest...');
  const bt2024 = await runBT('2024-01-01', '2024-12-31');
  analyzeExits(bt2024.trades, '2024 (BULL)');

  console.log('\nRunning 2025 backtest...');
  const bt2025 = await runBT('2025-01-01', '2025-12-31');
  analyzeExits(bt2025.trades, '2025 (RANGE)');
}

main().catch(err => { console.error(err); process.exit(1); });
