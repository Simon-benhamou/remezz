import { IntradayDualStrategy } from './strategy.js';
import type { Candle, TickInput, BacktestResult, EntrySignal, TradeLog, BacktestMetrics } from './types.js';
import { PreciseDecimal } from '../strategy/metaAdaptiveAgent.js';

export type BacktestOptions = {
  symbol: string;
  equityUsd: number;
  slippageBps?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  fundingAnnualPct?: number;
  latencyMs?: number;
  impactBpsPerMillion?: number;
};

type SimulationArtifacts = {
  metrics: BacktestMetrics;
  trades: TradeLog[];
  signals: EntrySignal[];
};

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

function computeOrderBookMid(orderBook: TickInput['orderBook']): number {
  if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) return 0;
  const bid = orderBook.bids[0]?.price ?? 0;
  const ask = orderBook.asks[0]?.price ?? 0;
  if (!bid || !ask) return 0;
  return (bid + ask) / 2;
}

function decimalFromBps(bps: number): PreciseDecimal {
  return new PreciseDecimal((bps / 10_000).toFixed(8));
}

function simulateSegment(candles: Candle[], options: BacktestOptions): SimulationArtifacts {
  if (!candles.length) throw new Error('No candles provided');
  const strategy = new IntradayDualStrategy();
  const candles5m = aggregateCandles(candles, 5);
  const candles15m = aggregateCandles(candles, 15);
  const startEquity = new PreciseDecimal(options.equityUsd);
  let equity = startEquity;
  const entries: EntrySignal[] = [];
  const tradeLogs: TradeLog[] = [];
  const pnlSeries: number[] = [];

  const makerFeeBps = options.makerFeeBps ?? 1.8;
  const takerFeeBps = options.takerFeeBps ?? 5;
  const impactBpsPerMillion = options.impactBpsPerMillion ?? 0;
  const latencyMs = options.latencyMs ?? 0;
  const slippageFallback = options.slippageBps ?? 3;
  const makerFeeMultiplier = decimalFromBps(makerFeeBps);
  const takerFeeMultiplier = decimalFromBps(takerFeeBps);
  const impactMultiplier = impactBpsPerMillion > 0 ? decimalFromBps(impactBpsPerMillion) : null;
  const million = new PreciseDecimal(1_000_000);
  const fundingAnnualPct = options.fundingAnnualPct ?? 0;
  const fundingPerMs = fundingAnnualPct > 0
    ? (fundingAnnualPct / 100) / (365 * 24 * 60 * 60 * 1000)
    : 0;
  const fundingMultiplier = fundingPerMs > 0 ? new PreciseDecimal(fundingPerMs.toFixed(12)) : null;

  let attemptedEntries = 0;
  let filledEntries = 0;
  let runtimeSlippage = slippageFallback;

  const runtimeFillRate = (): number => (attemptedEntries ? filledEntries / attemptedEntries : 1);

  for (let i = 30; i < candles.length; i++) {
    const current = candles[i];
    const prior = candles[i - 1] ?? current;
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
      slippageBps: runtimeSlippage,
      runtimeMetrics: { fillRate: runtimeFillRate(), slippageBps: runtimeSlippage },
    });

    if (result.entries.length) {
      const mid = computeOrderBookMid(tick.orderBook);
      for (const entry of result.entries) {
        attemptedEntries += 1;
        const trigger = entry.triggerPrice.toNumber();
        const slip = mid > 0 ? Math.abs((trigger - mid) / mid) * 10_000 : slippageFallback;
        runtimeSlippage = slip;
        const successThreshold = entry.execution.maxSlippageBps ?? takerFeeBps;
        const success = entry.execution.mode !== 'maker' || slip <= successThreshold;
        if (success) {
          filledEntries += 1;
        }
        entries.push(entry);
        const size = entry.size;
        const feeMultiplier = entry.execution.mode === 'maker' ? makerFeeMultiplier : takerFeeMultiplier;
        const feeCost = size.times(feeMultiplier);
        equity = equity.minus(feeCost);
        if (impactMultiplier) {
          const ratio = size.dividedBy(million);
          const impactCost = size.times(impactMultiplier.times(ratio));
          equity = equity.minus(impactCost);
        }
        if (latencyMs > 0) {
          const latencyPct = Math.max(0, (current.close - prior.close) / Math.max(prior.close, 1e-9));
          if (latencyPct !== 0) {
            const latencyCost = size.times(new PreciseDecimal((latencyPct * (latencyMs / 60_000)).toFixed(8)));
            equity = equity.minus(latencyCost.abs());
          }
        }
      }
    }

    if (result.trades.length > tradeLogs.length) {
      const newTrades = result.trades.slice(tradeLogs.length);
      tradeLogs.push(...newTrades);
      for (const trade of newTrades) {
        equity = equity.plus(trade.cumulativePnl);
        const feeCost = trade.quantity.times(takerFeeMultiplier);
        equity = equity.minus(feeCost);
        if (impactMultiplier) {
          const ratio = trade.quantity.dividedBy(million);
          const impactCost = trade.quantity.times(impactMultiplier.times(ratio));
          equity = equity.minus(impactCost);
        }
        if (fundingMultiplier && trade.holdDurationMs > 0) {
          const fundingCost = trade.quantity.times(fundingMultiplier.times(new PreciseDecimal(trade.holdDurationMs.toString())));
          equity = equity.minus(fundingCost);
        }
        if (latencyMs > 0 && trade.exitAtrPct > 0) {
          const latencyPct = trade.exitAtrPct * (latencyMs / 60_000);
          const latencyCost = trade.quantity.times(new PreciseDecimal(latencyPct.toFixed(8)));
          equity = equity.minus(latencyCost.abs());
        }
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
    const ret = runningEquity !== 0 ? pnl / runningEquity : 0;
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
  const totalWin = tradeLogs
    .filter((t) => t.cumulativePnl.raw > 0)
    .reduce((acc, t) => acc + t.cumulativePnl.toNumber(), 0);
  const totalLoss = tradeLogs
    .filter((t) => t.cumulativePnl.raw < 0)
    .reduce((acc, t) => acc + Math.abs(t.cumulativePnl.toNumber()), 0);
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;
  const avgWin = wins ? totalWin / wins : 0;
  const avgLoss = losses ? -(totalLoss / losses) : 0;

  if ([totalReturn, cagr, sharpe, maxDrawdown, hitRate, profitFactor, avgWin, avgLoss].some((v) => Number.isNaN(v))) {
    throw new Error('Backtest metrics contain NaN');
  }

  const metrics: BacktestMetrics = {
    totalReturnPct: totalReturn * 100,
    cagr,
    sharpe,
    maxDrawdownPct: maxDrawdown * 100,
    hitRate,
    profitFactor,
    avgWin,
    avgLoss,
    pnlSeries,
  };

  return { metrics, trades: tradeLogs, signals: entries };
}

function buildWalkForward(candles: Candle[], options: BacktestOptions): { start: number; end: number; metrics: BacktestMetrics }[] {
  const groups = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = new Date(candle.timestamp);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(candle);
  }
  const segments = Array.from(groups.values()).filter((segment) => segment.length >= 60);
  segments.sort((a, b) => a[0].timestamp - b[0].timestamp);
  const walkForward: { start: number; end: number; metrics: BacktestMetrics }[] = [];
  for (const segment of segments) {
    const result = simulateSegment(segment, options);
    walkForward.push({ start: segment[0].timestamp, end: segment[segment.length - 1].timestamp, metrics: result.metrics });
  }
  return walkForward;
}

export function runIntradayBacktest(candles: Candle[], options: BacktestOptions): BacktestResult {
  const overall = simulateSegment(candles, options);
  const walkForward = buildWalkForward(candles, options);
  return { ...overall, walkForward };
}
