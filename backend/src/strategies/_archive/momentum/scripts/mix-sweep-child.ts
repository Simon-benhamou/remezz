/**
 * mix-sweep-child.ts — Single combo backtest, called as child process
 *
 * Usage: npx tsx scripts/mix-sweep-child.ts <btcFile> <dataFile> <name> <sym1,sym2,...> <regimeMs> <capital> <leverage>
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import type { BacktestCandle } from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';

const [,, btcFile, dataFile, name, symsStr, regimeMsStr, capitalStr, leverageStr, periodStart, periodEnd] = process.argv;

async function run() {
  const startDate = new Date(periodStart + 'T00:00:00.000Z');
  const endDate = new Date(periodEnd + 'T23:59:59.999Z');
  const symbols = symsStr.split(',').map(s => `${s}/USDT:USDT`);
  const regimeMs = Number(regimeMsStr);
  const capital = Number(capitalStr);
  const leverage = Number(leverageStr);

  const btcCandles: BacktestCandle[] = JSON.parse(fs.readFileSync(btcFile, 'utf8'));
  const fullData: Record<string, BacktestCandle[]> = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of symbols) {
    if (fullData[sym]) allData[sym] = fullData[sym];
  }

  if (Object.keys(allData).length === 0) {
    console.log(JSON.stringify({ name, result: null }));
    return;
  }

  const input: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: capital, symbols: Object.keys(allData), leverage },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: regimeMs,
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

  console.log(JSON.stringify({
    name,
    result: {
      symbols: Object.keys(allData).map(s => s.replace('/USDT:USDT', '')),
      trades: s.totalTrades,
      winRate: s.winRate,
      pnl: s.totalPnlUsd,
      roi: s.totalPnlUsd / capital * 100,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      pf: s.profitFactor,
      perSymbol,
    },
  }));
}

run().catch(err => {
  console.log(JSON.stringify({ name, result: null, error: String(err) }));
});
