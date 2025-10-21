import { IntradayDualStrategy } from './strategy.js';
import type { Candle, TickInput, BacktestResult, EntrySignal, TradeLog } from './types.js';
import { PreciseDecimal } from '../strategy/metaAdaptiveAgent.js';

export type BacktestOptions = {
  symbol: string;
  equityUsd: number;
  slippageBps?: number;
};

type HigherTf = '5m' | '15m';

function aggregateCandles(candles: Candle[], minutes: number): Candle[] {
  if (!candles.length) return [];
  const grouped: Candle[] = [];
  let bucket: Candle[] = [];
  for (const candle of candles) {
    bucket.push(candle);
    if (bucket.length === minutes) {
      grouped.push({
        timestamp: bucket[bucket.length - 1].timestamp,
        open: bucket[0].open,
        high: Math.max(...bucket.map((c) => c.high)),
        low: Math.min(...bucket.map((c) => c.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((acc, c) => acc + c.volume, 0),
      });
      bucket = [];
    }
  }
  if (bucket.length) {
    grouped.push({
      timestamp: bucket[bucket.length - 1].timestamp,
      open: bucket[0].open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((acc, c) => acc + c.volume, 0),
    });
  }
  return grouped;
}

function filterByTime(candles: Candle[], timestamp: number): Candle[] {
  return candles.filter((c) => c.timestamp <= timestamp);
}

export function runIntradayBacktest(candles: Candle[], options: BacktestOptions): BacktestResult {
  if (!candles.length) throw new Error('No candles provided');
  const strategy = new IntradayDualStrategy();
  const candles5m = aggregateCandles(candles, 5);
  const candles15m = aggregateCandles(candles, 15);
  const startEquity = new PreciseDecimal(options.equityUsd);
  const entries: EntrySignal[] = [];
  let equity = startEquity;
  const pnlSeries: number[] = [];
  const tradeLogs: TradeLog[] = [];

  for (let i = 30; i < candles.length; i++) {
    const current = candles[i];
    const tick: TickInput = {
      symbol: options.symbol,
      timestamp: current.timestamp,
      price: current.close,
      candles: {
        '1m': candles.slice(0, i + 1),
        '5m': filterByTime(candles5m, current.timestamp),
        '15m': filterByTime(candles15m, current.timestamp),
      },
      orderBook: {
        timestamp: current.timestamp,
        bids: [
          { price: current.close * 0.9995, size: current.volume * 0.6 },
          { price: current.close * 0.999, size: current.volume * 0.4 },
        ],
        asks: [
          { price: current.close * 1.0005, size: current.volume * 0.5 },
          { price: current.close * 1.001, size: current.volume * 0.5 },
        ],
        takerBuyVolume: current.volume * 0.55,
        takerSellVolume: current.volume * 0.45,
      },
      aggression: {
        timestamp: current.timestamp,
        takerBuy: current.volume * 0.55,
        takerSell: current.volume * 0.45,
      },
      newsSpike: false,
    };

    const result = strategy.evaluateTick(tick, {
      equityUsd: equity,
      maxLevInstrument: 5,
      maxLevGlobal: 5,
      exposureBudget: 5,
      slippageBps: options.slippageBps ?? 3,
    });

    if (result.entries.length) {
      entries.push(...result.entries);
    }
    if (result.trades.length > tradeLogs.length) {
      const newTrades = result.trades.slice(tradeLogs.length);
      tradeLogs.push(...newTrades);
      for (const trade of newTrades) {
        equity = equity.plus(trade.cumulativePnl);
        pnlSeries.push(equity.toNumber());
      }
    }
  }

  const totalReturn = equity.minus(startEquity).dividedBy(startEquity).toNumber();
  const durationMs = candles[candles.length - 1].timestamp - candles[0].timestamp;
  const days = durationMs / (1000 * 60 * 60 * 24);
  const cagr = days > 0 ? (1 + totalReturn) ** (365 / days) - 1 : 0;

  const returns: number[] = [];
  let runningEquity = options.equityUsd;
  for (const log of tradeLogs.sort((a, b) => a.timestamp - b.timestamp)) {
    const pnl = log.cumulativePnl.toNumber();
    const ret = pnl / runningEquity;
    runningEquity += pnl;
    returns.push(ret);
  }

  const avgReturn = returns.length ? returns.reduce((acc, v) => acc + v, 0) / returns.length : 0;
  const variance = returns.length
    ? returns.reduce((acc, v) => acc + (v - avgReturn) ** 2, 0) / (returns.length || 1)
    : 0;
  const sharpe = variance > 0 ? (avgReturn / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  let peak = options.equityUsd;
  let maxDrawdown = 0;
  let equityPath = options.equityUsd;
  for (const log of tradeLogs) {
    equityPath += log.cumulativePnl.toNumber();
    if (equityPath > peak) peak = equityPath;
    const dd = peak > 0 ? (peak - equityPath) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const wins = tradeLogs.filter((t) => t.cumulativePnl.raw > 0).length;
  const losses = tradeLogs.filter((t) => t.cumulativePnl.raw < 0).length;
  const hitRate = tradeLogs.length ? wins / tradeLogs.length : 0;
  const totalWin = tradeLogs.filter((t) => t.cumulativePnl.raw > 0).reduce((acc, t) => acc + t.cumulativePnl.toNumber(), 0);
  const totalLoss = tradeLogs.filter((t) => t.cumulativePnl.raw < 0).reduce((acc, t) => acc + Math.abs(t.cumulativePnl.toNumber()), 0);
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;
  const avgWin = wins ? totalWin / wins : 0;
  const avgLoss = losses ? -(totalLoss / losses) : 0;

  if ([totalReturn, cagr, sharpe, maxDrawdown, hitRate, profitFactor, avgWin, avgLoss].some((v) => Number.isNaN(v))) {
    throw new Error('Backtest metrics contain NaN');
  }

  return {
    metrics: {
      totalReturnPct: totalReturn * 100,
      cagr,
      sharpe,
      maxDrawdownPct: maxDrawdown * 100,
      hitRate,
      profitFactor,
      avgWin,
      avgLoss,
      pnlSeries,
    },
    trades: tradeLogs,
    signals: entries,
  };
}
