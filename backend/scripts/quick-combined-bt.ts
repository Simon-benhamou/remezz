/**
 * quick-combined-bt.ts — Run a combined multi-symbol backtest
 *
 * Usage: npx tsx scripts/quick-combined-bt.ts
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
  'AVAX/USDT:USDT',
  'FET/USDT:USDT',
  'WIF/USDT:USDT',
  'DOT/USDT:USDT',
  'IMX/USDT:USDT',
  'STX/USDT:USDT',
  'ADA/USDT:USDT',
  'RENDER/USDT:USDT',
  'XRP/USDT:USDT',
];

const PERIOD = { start: '2025-01-01', end: '2025-12-31' };
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// ============================================================================
// LOAD DATA
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol.replace('/USDT:USDT', '_USDT');
  const file15m = `${base}_15m.json`;

  // Try main data/ first, then data/2024/
  const dataDir = path.resolve(process.cwd(), 'data');
  const data2024Dir = path.resolve(process.cwd(), 'data', '2024');

  let filepath = path.join(dataDir, file15m);
  if (!fs.existsSync(filepath)) {
    filepath = path.join(data2024Dir, file15m);
    if (!fs.existsSync(filepath)) return null;
  }

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

  return sliceCandlesByTime(candles, since, end);
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const end = endDate.getTime();

  console.log(`=== Combined Backtest: ${SYMBOLS.length} symbols ===`);
  console.log(`Period: ${PERIOD.start} → ${PERIOD.end}`);
  console.log(`Capital: $${INITIAL_CAPITAL}, Leverage: ${LEVERAGE}x`);
  console.log(`Symbols: ${SYMBOLS.map(s => s.replace('/USDT:USDT', '')).join(', ')}\n`);

  // Load BTC
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  // Load all symbols
  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of SYMBOLS) {
    const candles = loadSymbolCandles(sym, since, end);
    if (!candles || candles.length < 300) {
      console.warn(`  ${sym}: insufficient data (${candles?.length ?? 0} candles), skipping`);
      continue;
    }
    allData[sym] = candles;
    console.log(`  ${sym.replace('/USDT:USDT', '')}: ${candles.length} candles`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  console.log(`\nRunning combined backtest...\n`);

  const input: BacktestComputationInput = {
    params: {
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols: Object.keys(allData),
      leverage: LEVERAGE,
    },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  const s = result.summary;

  // Results
  console.log('='.repeat(70));
  console.log('COMBINED BACKTEST RESULTS');
  console.log('='.repeat(70));
  const f = (v: any, d = 1) => v != null ? Number(v).toFixed(d) : 'N/A';
  console.log(`  Total Trades:    ${s.totalTrades}`);
  console.log(`  Win Rate:        ${f(s.winRate)}%`);
  console.log(`  Total PnL:       $${f(s.totalPnlUsd, 2)}`);
  console.log(`  ROI:             ${f((s as any).roi ?? (s.totalPnlUsd / INITIAL_CAPITAL * 100))}%`);
  console.log(`  Max Drawdown:    ${f(s.maxDrawdownPct)}%`);
  console.log(`  Sharpe Ratio:    ${f(s.sharpeRatio, 2)}`);
  console.log(`  Profit Factor:   ${f(s.profitFactor, 2)}`);
  console.log(`  Avg Hold (min):  ${f(s.avgHoldMinutes, 0)}`);
  console.log(`  LONG trades:     ${s.longTrades} (${f(s.longWinRate)}% WR)`);
  console.log(`  SHORT trades:    ${s.shortTrades} (${f(s.shortWinRate)}% WR)`);

  // Per-symbol breakdown
  console.log(`\n--- Per-Symbol Breakdown ---\n`);
  const bySymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const t of result.trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    if (!bySymbol[sym]) bySymbol[sym] = { trades: 0, wins: 0, pnl: 0 };
    bySymbol[sym].trades++;
    if (t.netPnlUsd > 0) bySymbol[sym].wins++;
    bySymbol[sym].pnl += t.netPnlUsd;
  }

  const sorted = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  console.log(`  ${'Symbol'.padEnd(10)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'PnL $'.padStart(10)}`);
  console.log(`  ${'-'.repeat(36)}`);
  for (const [sym, d] of sorted) {
    const wr = d.trades > 0 ? (d.wins / d.trades * 100).toFixed(1) : '0.0';
    console.log(`  ${sym.padEnd(10)} ${String(d.trades).padStart(7)} ${wr.padStart(7)} ${('$' + d.pnl.toFixed(0)).padStart(10)}`);
  }

  console.log(`\nDone.`);
}

main().catch(console.error);
