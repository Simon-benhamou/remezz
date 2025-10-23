import { ema, atr, rsi } from '../../../data/indicators.js';
import { RollingAggression } from './rolling.js';
import { loadIntradayConfig } from './config/index.js';
import type {
  Candle,
  TickFeatures,
  Timeframe,
  OrderBookSnapshot,
  TickInput,
} from './types.js';

function computeTrueRange(current: Candle, prev: Candle | undefined): number {
  if (!prev) return current.high - current.low;
  const tr = Math.max(
    current.high - current.low,
    Math.abs(current.high - prev.close),
    Math.abs(current.low - prev.close),
  );
  return tr;
}

function computeBollinger(candles: Candle[], period: number): {
  widthPct: number;
  percentB: number;
  upper: number;
  lower: number;
  middle: number;
  std: number;
} {
  if (candles.length < period) {
    return {
      widthPct: 0,
      percentB: 0.5,
      upper: candles[candles.length - 1]?.close ?? 0,
      lower: candles[candles.length - 1]?.close ?? 0,
      middle: candles[candles.length - 1]?.close ?? 0,
      std: 0,
    };
  }
  const slice = candles.slice(-period);
  const closes = slice.map((c) => c.close);
  const mean = closes.reduce((acc, val) => acc + val, 0) / period;
  const variance = closes.reduce((acc, val) => acc + (val - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0 || !Number.isFinite(mean) || mean === 0) {
    return { widthPct: 0, percentB: 0.5, upper: mean, lower: mean, middle: mean, std: 0 };
  }
  const width = 2 * std * 2; // upper-lower = 4*std
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const last = closes[closes.length - 1];
  const percentB = (last - lower) / (upper - lower || 1);
  return { widthPct: width / Math.abs(mean), percentB, upper, lower, middle: mean, std };
}

function computeKeltnerWidthPct(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-(period + 1));
  const closes = slice.map((c) => c.close);
  const emaSeries = ema(closes, period);
  const lastEma = emaSeries[emaSeries.length - 1] ?? closes[closes.length - 1];
  const atrSeries = atr(slice.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]), period);
  const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
  if (!Number.isFinite(lastAtr) || !Number.isFinite(lastEma) || lastEma === 0) return 0;
  const width = (lastAtr * 2 * 2);
  return width / Math.abs(lastEma);
}

function computeVolumeStats(candles: Candle[], lookback: number): {
  zScore: number;
  spike95: boolean;
  spike99: boolean;
} {
  const slice = candles.slice(-Math.max(lookback, 1));
  if (!slice.length) {
    return { zScore: 0, spike95: false, spike99: false };
  }
  const volumes = slice.map((c) => c.volume ?? 0);
  const lastVolume = volumes[volumes.length - 1] ?? 0;
  const mean = volumes.reduce((acc, val) => acc + val, 0) / volumes.length;
  const variance = volumes.reduce((acc, val) => acc + (val - mean) ** 2, 0) / Math.max(volumes.length, 1);
  const std = Math.sqrt(variance);
  const sorted = [...volumes].sort((a, b) => a - b);
  const percentile = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
    return sorted[idx];
  };
  const spike95 = sorted.length >= 5 && lastVolume >= percentile(0.95);
  const spike99 = sorted.length >= 5 && lastVolume >= percentile(0.99);
  const zScore = std === 0 ? 0 : (lastVolume - mean) / std;
  return { zScore, spike95, spike99 };
}

function computeObvDelta(candles: Candle[], lookback: number): number {
  if (candles.length < 2) return 0;
  const slice = candles.slice(-(lookback + 1));
  let obv = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const curr = slice[i];
    const direction = curr.close > prev.close ? 1 : curr.close < prev.close ? -1 : 0;
    obv += direction * (curr.volume ?? 0);
  }
  return obv;
}

function computeEmaSlope(series: number[], period: number): number {
  if (series.length < period + 1) return 0;
  const emaSeries = ema(series, period);
  const last = emaSeries[emaSeries.length - 1];
  const prev = emaSeries[emaSeries.length - 2] ?? last;
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;
  return (last - prev) / Math.abs(prev);
}

function computeRsiSlope(series: number[], period: number): number {
  const rsiSeries = rsi(series, period);
  if (rsiSeries.length < 2) return 0;
  const last = rsiSeries[rsiSeries.length - 1];
  const prev = rsiSeries[rsiSeries.length - 2];
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return 0;
  return last - prev;
}

function computeRsiValue(series: number[], period: number): number {
  const rsiSeries = rsi(series, period);
  if (!rsiSeries.length) return 50;
  return rsiSeries[rsiSeries.length - 1];
}

function computeRoc(series: number[], period: number): number {
  if (series.length <= period) return 0;
  const last = series[series.length - 1];
  const prev = series[series.length - 1 - period];
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;
  return (last - prev) / Math.abs(prev);
}

function computeMacdHistogram(series: number[], fast: number, slow: number, signal: number): number {
  if (!series.length) return 0;
  const emaFast = ema(series, fast);
  const emaSlow = ema(series, slow);
  const len = Math.min(emaFast.length, emaSlow.length);
  if (!len) return 0;
  const macdLine = emaFast.slice(-len).map((val, idx) => val - emaSlow[emaSlow.length - len + idx]);
  const signalLine = ema(macdLine, signal);
  if (!signalLine.length) return 0;
  const hist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];
  return hist;
}

function computeOrderBookImbalance(orderBook: OrderBookSnapshot | null, topLevels: number): number {
  if (!orderBook) return 0;
  const bids = orderBook.bids.slice(0, topLevels).reduce((acc, level) => acc + level.size, 0);
  const asks = orderBook.asks.slice(0, topLevels).reduce((acc, level) => acc + level.size, 0);
  const denom = bids + asks;
  if (denom === 0) return 0;
  return (bids - asks) / denom;
}

export class FeaturePipeline {
  private readonly config = loadIntradayConfig();
  private readonly aggression = new RollingAggression(this.config.orderBook.aggressionLookbackMs);
  private lastSqueezeRatio = 1;
  private readonly lastImbalance: Record<Timeframe, number> = {
    '1m': 0,
    '5m': 0,
    '15m': 0,
  };
  private readonly fallbackLogged = new Set<string>();

  updateAggression(sample: { timestamp: number; takerBuy: number; takerSell: number } | null | undefined): void {
    if (!sample) return;
    this.aggression.push(sample);
  }

  compute(
    timeframe: Timeframe,
    candles: Candle[],
    orderBook: OrderBookSnapshot | null,
    price: number,
    symbol?: string,
  ): TickFeatures {
    if (orderBook?.source === 'fallback_ticker' && symbol && !this.fallbackLogged.has(symbol)) {
      console.warn('intraday.orderbook.using_fallback', { symbol, source: orderBook.source });
      this.fallbackLogged.add(symbol);
    }
    const cfg = this.config;
    const closes = candles.map((c) => c.close);
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const atrSeries = atr(candles.map((c) => [c.timestamp, c.open, c.high, c.low, c.close, c.volume]), cfg.volatility.atrPeriod);
    const lastAtr = atrSeries[atrSeries.length - 1] ?? 0;
    const atrPct = current && current.close ? (lastAtr / Math.abs(current.close)) : 0;
    const tr = current ? computeTrueRange(current, prev) : 0;
    const trPct = current && current.close ? tr / Math.abs(current.close) : 0;
    const boll = computeBollinger(candles, cfg.volatility.bollingerPeriod);
    const bbWidthPct = boll.widthPct;
    const keltnerWidthPct = computeKeltnerWidthPct(candles, cfg.volatility.keltnerPeriod);
    const squeezeRatio = keltnerWidthPct === 0 ? 0 : bbWidthPct / keltnerWidthPct;
    const squeezeState = squeezeRatio < cfg.volatility.squeezeLow
      ? 'range'
      : squeezeRatio > cfg.volatility.squeezeHigh
        ? 'expansion'
        : 'neutral';
    const bandZScore = boll.std === 0 ? 0 : (current.close - boll.middle) / boll.std;

    const roc: Record<string, number> = {};
    for (const period of cfg.momentum.rocPeriods) {
      roc[period.toString()] = computeRoc(closes, period);
    }

    const emaSlope: Record<string, number> = {};
    const emaValues: Record<string, number> = {};
    for (const period of cfg.momentum.emaSlopes) {
      const emaSeries = ema(closes, period);
      const lastEma = emaSeries[emaSeries.length - 1] ?? closes[closes.length - 1] ?? 0;
      emaValues[period.toString()] = lastEma;
      emaSlope[period.toString()] = computeEmaSlope(closes, period);
    }

    const rsiVals: Record<string, number> = {};
    const rsiSlope: Record<string, number> = {};
    for (const period of cfg.momentum.rsiPeriods) {
      rsiVals[period.toString()] = computeRsiValue(closes, period);
      rsiSlope[period.toString()] = computeRsiSlope(closes, period);
    }

    const macdHistogram = computeMacdHistogram(
      closes,
      cfg.momentum.macd.fast,
      cfg.momentum.macd.slow,
      cfg.momentum.macd.signal,
    );

    const volumeStats = computeVolumeStats(candles, cfg.volume.zScoreLookback);
    const obv = computeObvDelta(candles, cfg.volume.obvLookback);

    const imbalance = computeOrderBookImbalance(orderBook, cfg.orderBook.topDepthLevels);
    const prevImbalance = this.lastImbalance[timeframe] ?? 0;
    const imbalanceDelta = imbalance - prevImbalance;
    this.lastImbalance[timeframe] = imbalance;
    const aggressionRatio = this.aggression.ratio();

    this.lastSqueezeRatio = squeezeRatio;

    return {
      timeframe,
      timestamp: current?.timestamp ?? Date.now(),
      price,
      volatility: {
        atrPct: atrPct || 0,
        trueRangePct: trPct || 0,
        bollingerWidthPct: bbWidthPct || 0,
        bollingerPercentB: Number.isFinite(boll.percentB) ? boll.percentB : 0.5,
        bollingerUpper: boll.upper ?? current?.close ?? 0,
        bollingerLower: boll.lower ?? current?.close ?? 0,
        bollingerMiddle: boll.middle ?? current?.close ?? 0,
        bandZScore: Number.isFinite(bandZScore) ? bandZScore : 0,
        keltnerWidthPct: keltnerWidthPct || 0,
        squeezeRatio: squeezeRatio || 0,
        squeezeState,
      },
      momentum: {
        roc,
        emaSlope,
        emaValue: emaValues,
        rsi: rsiVals,
        rsiSlope,
        macdHistogram: macdHistogram || 0,
      },
      volume: {
        zScore: Number.isFinite(volumeStats.zScore) ? volumeStats.zScore : 0,
        obvDelta: obv,
        spike95: volumeStats.spike95,
        spike99: volumeStats.spike99,
      },
      orderBook: {
        imbalance: Number.isFinite(imbalance) ? imbalance : 0,
        imbalanceDelta: Number.isFinite(imbalanceDelta) ? imbalanceDelta : 0,
        aggressionRatio: Number.isFinite(aggressionRatio) ? aggressionRatio : 0.5,
      },
    };
  }

  getLastSqueezeRatio(): number {
    return this.lastSqueezeRatio;
  }
}

export function buildTickFeatures(input: TickInput): Record<Timeframe, TickFeatures> {
  const pipeline = new FeaturePipeline();
  if (input.aggression) {
    pipeline.updateAggression({
      timestamp: input.aggression.timestamp,
      takerBuy: input.aggression.takerBuy,
      takerSell: input.aggression.takerSell,
    });
  }
  const result: Partial<Record<Timeframe, TickFeatures>> = {};
  for (const timeframe of Object.keys(input.candles) as Timeframe[]) {
    const candles = input.candles[timeframe];
    if (!candles?.length) {
      continue;
    }
    result[timeframe] = pipeline.compute(timeframe, candles, input.orderBook, input.price, input.symbol);
  }
  return result as Record<Timeframe, TickFeatures>;
}
