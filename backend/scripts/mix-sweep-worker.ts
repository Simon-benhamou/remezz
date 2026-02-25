/**
 * mix-sweep-worker.ts — Worker thread that runs a single backtest combo
 *
 * Receives: { symbols, btcCandlesPath, allDataPaths, regimeMs, initialCapital, leverage, period }
 * Returns: { name, result }
 */
import { parentPort, workerData } from 'worker_threads';
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import type { BacktestCandle } from '../src/services/backtest/localOhlcvJsonStore.js';
import fs from 'node:fs';

interface WorkerInput {
  name: string;
  symbols: string[];  // full format like 'FET/USDT:USDT'
  btcCandlesFile: string;
  dataCacheFile: string;
  regimeMs: number;
  initialCapital: number;
  leverage: number;
  period: { start: string; end: string };
}

const input = workerData as WorkerInput;

async function run() {
  const startDate = new Date(input.period.start + 'T00:00:00.000Z');
  const endDate = new Date(input.period.end + 'T23:59:59.999Z');

  // Load shared data from temp files
  const btcCandles: BacktestCandle[] = JSON.parse(fs.readFileSync(input.btcCandlesFile, 'utf8'));
  const fullDataCache: Record<string, BacktestCandle[]> = JSON.parse(fs.readFileSync(input.dataCacheFile, 'utf8'));

  // Pick only needed symbols
  const allData: Record<string, BacktestCandle[]> = {};
  for (const sym of input.symbols) {
    if (fullDataCache[sym]) allData[sym] = fullDataCache[sym];
  }

  const actualSyms = Object.keys(allData);
  if (actualSyms.length === 0) {
    parentPort?.postMessage({ name: input.name, result: null });
    return;
  }

  const btInput: BacktestComputationInput = {
    params: { startDate, endDate, initialCapital: input.initialCapital, symbols: actualSyms, leverage: input.leverage },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: input.regimeMs,
  };

  const result = await runBacktestComputation(btInput);
  const s = result.summary;

  const perSymbol: Record<string, { trades: number; wins: number; pnl: number }> = {};
  for (const t of result.trades) {
    const sym = t.symbol.replace('/USDT:USDT', '');
    if (!perSymbol[sym]) perSymbol[sym] = { trades: 0, wins: 0, pnl: 0 };
    perSymbol[sym].trades++;
    if (t.netPnlUsd > 0) perSymbol[sym].wins++;
    perSymbol[sym].pnl += t.netPnlUsd;
  }

  parentPort?.postMessage({
    name: input.name,
    result: {
      symbols: actualSyms.map((s: string) => s.replace('/USDT:USDT', '')),
      trades: s.totalTrades,
      winRate: s.winRate,
      pnl: s.totalPnlUsd,
      roi: s.totalPnlUsd / input.initialCapital * 100,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      pf: s.profitFactor,
      perSymbol,
    },
  });
}

run().catch(err => {
  parentPort?.postMessage({ name: input.name, result: null, error: String(err) });
});
