/**
 * Sweep exhaustion thresholds to find optimal placement.
 * Tests multiple threshold values to see the impact curve.
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = [
  'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
  'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
  'STX/USDT:USDT', 'BTC/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
};

async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btcLocal || !btc1hLocal) throw new Error('No local BTC data');

  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  const btcCandlesRegime = sliceCandlesByTime(btc1hLocal.candles, since, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) continue;
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

async function main() {
  console.log('Loading data...');
  const data = await loadData();
  console.log('Data loaded.\n');

  // Baseline: exhaustion OFF
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const baseline = await runBacktestComputation({ params: PARAMS, ...data });
  const b = baseline.summary;

  console.log(`BASELINE (no exhaustion): ${b.totalTrades} trades | PnL=$${b.totalPnlUsd.toFixed(0)} (${b.totalPnlPct.toFixed(1)}%) | WR=${b.winRate.toFixed(1)}% | DD=${b.maxDrawdownPct.toFixed(1)}% | PF=${b.profitFactor.toFixed(2)}\n`);

  // Sweep thresholds
  const thresholds = [35, 40, 45, 50, 55, 60, 65, 70, 75, 80];

  console.log('Threshold | Trades | Proactive | PnL ($)    | Delta ($) | WR%   | DD%   | PF   | Sharpe');
  console.log('-'.repeat(100));

  for (const thresh of thresholds) {
    (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = true;
    (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD = thresh;
    (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD = Math.max(20, thresh - 20);

    const result = await runBacktestComputation({ params: PARAMS, ...data });
    const s = result.summary;

    const proactiveCount = result.trades.filter((t: any) => t.exitReason === 'TRAIL_PROACTIVE').length;
    const proactivePnl = result.trades
      .filter((t: any) => t.exitReason === 'TRAIL_PROACTIVE')
      .reduce((sum: number, t: any) => sum + t.netPnlUsd, 0);
    const delta = s.totalPnlUsd - b.totalPnlUsd;

    console.log(
      `    ${String(thresh).padStart(2)}    |  ${String(s.totalTrades).padStart(4)}  |    ${String(proactiveCount).padStart(3)}    | ${('$' + s.totalPnlUsd.toFixed(0)).padStart(10)} | ${(delta >= 0 ? '+' : '') + '$' + delta.toFixed(0).padStart(6)} | ${s.winRate.toFixed(1)}% | ${s.maxDrawdownPct.toFixed(1)}% | ${s.profitFactor.toFixed(2)} | ${s.sharpeRatio.toFixed(2)}`
    );
  }

  // Restore defaults
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = true;
  (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD = 65;
  (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD = 45;
}

main().catch(e => { console.error(e); process.exit(1); });
