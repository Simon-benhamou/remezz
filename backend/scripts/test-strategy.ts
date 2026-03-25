/**
 * Universal strategy tester.
 * Usage: npx tsx scripts/test-strategy.ts --strategy grid --period 2025
 *        npx tsx scripts/test-strategy.ts --strategy meanReversion --period 2025
 *        npx tsx scripts/test-strategy.ts --strategy grid --period 2024,2025
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import { registerStrategy, getStrategy, clearStrategies } from '../src/strategies/registry.js';
import { GridStrategy } from '../src/strategies/grid/strategy.js';
import { MeanReversionStrategy } from '../src/strategies/meanReversion/strategy.js';
import type { IStrategy } from '../src/strategies/types.js';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// PARSE CLI ARGS
// ============================================================================
function parseArgs(): { strategyName: string; periods: string[]; capital: number; leverage: number } {
  const args = process.argv.slice(2);
  let strategyName = 'grid';
  let periodStr = '2025';
  let capital = 2000;
  let leverage = 0; // 0 = use strategy default

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--strategy' && args[i + 1]) {
      strategyName = args[++i];
    } else if (args[i] === '--period' && args[i + 1]) {
      periodStr = args[++i];
    } else if (args[i] === '--capital' && args[i + 1]) {
      capital = Number(args[++i]);
    } else if (args[i] === '--leverage' && args[i + 1]) {
      leverage = Number(args[++i]);
    }
  }

  const periods = periodStr.split(',').map(p => p.trim());
  return { strategyName, periods, capital, leverage };
}

// ============================================================================
// REGISTER STRATEGIES
// ============================================================================
function registerAllStrategies(): void {
  clearStrategies();
  registerStrategy(new GridStrategy());
  registerStrategy(new MeanReversionStrategy());
}

// ============================================================================
// LOAD CANDLE DATA
// ============================================================================
function loadSymbolCandles(symbol: string, since: number, end: number): BacktestCandle[] | null {
  const base = symbol.replace('/USDT:USDT', '_USDT');
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
  const { strategyName, periods, capital: INITIAL_CAPITAL, leverage: cliLeverage } = parseArgs();

  // Register and get strategy
  registerAllStrategies();
  let strategy: IStrategy;
  try {
    strategy = getStrategy(strategyName);
  } catch (e: any) {
    console.error(e.message);
    process.exit(1);
  }

  const config = strategy.getConfig();
  const LEVERAGE = cliLeverage || config.leverage || 2;
  const SYMBOLS = config.symbols;

  // Build period range
  const startYear = Math.min(...periods.map(p => parseInt(p)));
  const endYear = Math.max(...periods.map(p => parseInt(p)));
  const PERIOD = {
    start: `${startYear}-01-01`,
    end: `${endYear}-12-31`,
  };

  console.log('='.repeat(70));
  console.log(`STRATEGY BACKTEST: ${strategy.name} (v${config.version})`);
  console.log('='.repeat(70));
  console.log(`Period:   ${PERIOD.start} -> ${PERIOD.end}`);
  console.log(`Capital:  $${INITIAL_CAPITAL}`);
  console.log(`Leverage: ${LEVERAGE}x`);
  console.log(`Symbols:  ${SYMBOLS.map(s => s.replace('/USDT:USDT', '')).join(', ')}`);
  console.log(`Max Pos:  ${config.maxPositions}`);
  console.log('');

  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');
  const extraBarsMs = Math.max(config.minCandlesRequired, 250) * 15 * 60 * 1000;
  const since = startDate.getTime() - extraBarsMs;
  const end = endDate.getTime();

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

  if (Object.keys(allData).length === 0) {
    console.error('\nNo symbol data loaded. Ensure data/*.json files exist.');
    process.exit(1);
  }

  console.log(`\nRunning backtest...\n`);

  const input: BacktestComputationInput = {
    params: {
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols: Object.keys(allData),
      leverage: LEVERAGE,
      strategy, // IStrategy adapter
    },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: 15 * 60 * 1000,
  };

  const result = await runBacktestComputation(input);
  const s = result.summary;

  // Results
  console.log('='.repeat(70));
  console.log(`RESULTS: ${strategy.name}`);
  console.log('='.repeat(70));
  const f = (v: any, d = 1) => v != null ? Number(v).toFixed(d) : 'N/A';
  console.log(`  Total Trades:    ${s.totalTrades}`);
  console.log(`  Win Rate:        ${f(s.winRate)}%`);
  console.log(`  Total PnL:       $${f(s.totalPnlUsd, 2)}`);
  console.log(`  ROI:             ${f(s.totalPnlUsd / INITIAL_CAPITAL * 100)}%`);
  console.log(`  Max Drawdown:    ${f(s.maxDrawdownPct)}%`);
  console.log(`  Sharpe Ratio:    ${f(s.sharpeRatio, 2)}`);
  console.log(`  Profit Factor:   ${f(s.profitFactor, 2)}`);
  console.log(`  Avg Hold (min):  ${f(s.avgHoldMinutes, 0)}`);
  console.log(`  Final Capital:   $${f(s.finalCapital, 2)}`);

  const longWins = result.trades.filter(t => t.side === 'long' && t.netPnlUsd > 0).length;
  const longTotal = result.trades.filter(t => t.side === 'long').length;
  const shortWins = result.trades.filter(t => t.side === 'short' && t.netPnlUsd > 0).length;
  const shortTotal = result.trades.filter(t => t.side === 'short').length;
  console.log(`  LONG trades:     ${longTotal} (${f(longTotal > 0 ? longWins / longTotal * 100 : 0)}% WR)`);
  console.log(`  SHORT trades:    ${shortTotal} (${f(shortTotal > 0 ? shortWins / shortTotal * 100 : 0)}% WR)`);

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

  // Monthly breakdown
  console.log(`\n--- Monthly Breakdown ---\n`);
  const byMonth: Record<string, { trades: number; pnl: number }> = {};
  for (const t of result.trades) {
    if (!byMonth[t.month]) byMonth[t.month] = { trades: 0, pnl: 0 };
    byMonth[t.month].trades++;
    byMonth[t.month].pnl += t.netPnlUsd;
  }

  const monthsSorted = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`  ${'Month'.padEnd(10)} ${'Trades'.padStart(7)} ${'PnL $'.padStart(10)}`);
  console.log(`  ${'-'.repeat(29)}`);
  for (const [month, d] of monthsSorted) {
    console.log(`  ${month.padEnd(10)} ${String(d.trades).padStart(7)} ${('$' + d.pnl.toFixed(0)).padStart(10)}`);
  }

  console.log(`\nDone.`);
}

main().catch(console.error);
