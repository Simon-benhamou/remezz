/**
 * quick-single-bt.ts — Run a single combined backtest from CLI args
 *
 * Usage: npx tsx scripts/quick-single-bt.ts "NAME" "SYM1,SYM2,..."
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

const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

const name = process.argv[2] || 'test';
const symsArg = process.argv[3] || '';
const symbols = symsArg.split(',').filter(Boolean);
// Optional 4th arg: period override (e.g. "2024-01-01,2024-12-31")
const periodArg = process.argv[4] || '';
const PERIOD = periodArg.includes(',')
  ? { start: periodArg.split(',')[0], end: periodArg.split(',')[1] }
  : { start: '2025-01-01', end: '2025-12-31' };

function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol + '_USDT';
  const file15m = `${base}_15m.json`;
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
      timestamp: c.openTime, open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close), volume: Number(c.volume || 0),
    }))
    .sort((a: BacktestCandle, b: BacktestCandle) => a.timestamp - b.timestamp);

  return sliceCandlesByTime(candles, since, end);
}

async function main() {
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  // V5.148: Need 2880 candles (30d) lookback for bull run detector + 250 for indicators
  const extraBarsMs = 3200 * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const end = endDate.getTime();

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, end);

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of symbols) {
    const fullSym = `${sym}/USDT:USDT`;
    const candles = loadSymbolCandles(sym, since, end);
    if (candles && candles.length >= 300) allData[fullSym] = candles;
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: INITIAL_CAPITAL, symbols: Object.keys(allData), leverage: LEVERAGE },
    btcCandles, btcCandlesRegime: btcCandles, allData,
    CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  const s = result.summary;

  const perSymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const t of result.trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    if (!perSymbol[sym]) perSymbol[sym] = { trades: 0, wins: 0, pnl: 0 };
    perSymbol[sym].trades++;
    if (t.netPnlUsd > 0) perSymbol[sym].wins++;
    perSymbol[sym].pnl += t.netPnlUsd;
  }

  const sorted = Object.entries(perSymbol).sort((a, b) => b[1].pnl - a[1].pnl);

  // Single-line output for easy parsing
  console.log(`RESULT|${name}|${Object.keys(allData).length}|${s.totalTrades}|${s.winRate.toFixed(1)}|${s.totalPnlUsd.toFixed(0)}|${(s.totalPnlUsd / INITIAL_CAPITAL * 100).toFixed(0)}|${s.maxDrawdownPct.toFixed(1)}|${s.sharpeRatio.toFixed(2)}|${s.profitFactor.toFixed(2)}|${sorted.map(([sym, d]) => `${sym}=$${d.pnl.toFixed(0)}`).join(',')}`);
}

main().catch(err => console.error('ERROR|' + name + '|' + String(err)));
