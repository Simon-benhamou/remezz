import { ema, rsi, adx as computeAdx, atr } from '../../data/indicators.js';

export type TrendBias = 'bull' | 'bear' | 'neutral';

export interface TimeframeOhlcv {
  timeframe: '4h' | '1h' | '15m' | '5m';
  ohlcv: number[][]; // [timestamp, open, high, low, close, volume]
}

export interface MicrostructureSnapshot {
  spreadBps: number;
  bidDepthUsd: number;
  askDepthUsd: number;
  passiveFillRate: number;
  ofi?: number;
  slipRecentBps?: number;
  volume24hUsd: number;
}

export interface DriverSnapshot {
  btcRet15m: number;
  btcRet1h: number;
  corrBtc1h: number;
}

export interface SessionSnapshot {
  timestamp: number;
  euUsOverlap: boolean;
  isWeekend: boolean;
  isNight: boolean;
}

export interface ContextFeatures {
  tf4h: {
    emaSlope20: number;
    emaSlope50: number;
    emaSlope200: number;
    adx14: number;
    bbWidth: number;
    distEma200Pct: number;
    trendBias: TrendBias;
  };
  tf1h: {
    roc12: number;
    roc24: number;
    rsi: number;
    bbp: number;
    emaSlope20: number;
    emaSlope50: number;
    volRatio: number;
  };
  tf15m: {
    roc12: number;
    rsi: number;
    bbp: number;
    emaSlope20: number;
    ofi?: number;
    volRatio: number;
  };
  micro: {
    spreadBps: number;
    bidDepthUsd: number;
    askDepthUsd: number;
    passiveFillRate: number;
    volume24hUsd: number;
  };
  driver: DriverSnapshot;
  session: {
    euUsOverlap: boolean;
    isWeekend: boolean;
    isNight: boolean;
  };
}

export interface FeatureBuilderInput {
  tf4h: TimeframeOhlcv;
  tf1h: TimeframeOhlcv;
  tf15m: TimeframeOhlcv;
  micro: MicrostructureSnapshot;
  driver: DriverSnapshot;
  session: SessionSnapshot;
}

function percentSlope(series: number[]): number {
  if (series.length < 2) return 0;
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  if (!Number.isFinite(last) || !Number.isFinite(prev)) return 0;
  if (prev === 0) return 0;
  return (last - prev) / Math.abs(prev);
}

function bollingerBands(values: number[], period = 20): { width: number; percentB: number } {
  if (values.length < period) {
    return { width: 0, percentB: 0.5 };
  }
  const slice = values.slice(-period);
  const mean = slice.reduce((acc, v) => acc + v, 0) / period;
  const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const last = slice[slice.length - 1];
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const width = upper - lower;
  const denom = upper - lower || 1;
  const percentB = (last - lower) / denom;
  return { width, percentB };
}

function rateOfChange(values: number[], period: number): number {
  if (values.length <= period) return 0;
  const last = values[values.length - 1];
  const prev = values[values.length - 1 - period];
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;
  return (last - prev) / Math.abs(prev);
}

function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period) return 1;
  const slice = volumes.slice(-period);
  const mean = slice.reduce((acc, v) => acc + v, 0) / period;
  const last = volumes[volumes.length - 1];
  const denom = mean || 1;
  return last / denom;
}

function determineTrendBias(close: number[], ema20: number[], ema50: number[], ema200: number[], adx14: number): TrendBias {
  const lastClose = close[close.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];
  const lastEma200 = ema200[ema200.length - 1];
  if ([lastClose, lastEma20, lastEma50, lastEma200].some(v => !Number.isFinite(v))) {
    return 'neutral';
  }
  if (lastClose > lastEma200 && lastEma20 > lastEma50 && adx14 >= 20) return 'bull';
  if (lastClose < lastEma200 && lastEma20 < lastEma50 && adx14 >= 20) return 'bear';
  return 'neutral';
}

function ensureFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Feature ${label} is not finite`);
  }
}

function computeEma(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [values[0]];
  const series = ema(values, period);
  return series;
}

function computeAdxSafe(ohlcv: number[][], period = 14): number {
  const arr = computeAdx(ohlcv, period);
  if (!arr.length) return 0;
  return arr[arr.length - 1];
}

export function computeAtrPct(ohlcv: number[][], period = 14): number {
  if (!ohlcv.length) return 0;
  const atrValues = atr(ohlcv, period);
  if (!atrValues.length) return 0;
  const lastAtr = atrValues[atrValues.length - 1];
  const lastClose = ohlcv[ohlcv.length - 1]?.[4] ?? 0;
  if (!Number.isFinite(lastAtr) || !Number.isFinite(lastClose) || lastClose === 0) return 0;
  return lastAtr / Math.abs(lastClose);
}

export function buildContextFeatures(input: FeatureBuilderInput): ContextFeatures {
  const tf4hCloses = input.tf4h.ohlcv.map(row => row[4]);
  const tf1hCloses = input.tf1h.ohlcv.map(row => row[4]);
  const tf15mCloses = input.tf15m.ohlcv.map(row => row[4]);
  const tf4hVolumes = input.tf4h.ohlcv.map(row => row[5]);
  const tf1hVolumes = input.tf1h.ohlcv.map(row => row[5]);
  const tf15mVolumes = input.tf15m.ohlcv.map(row => row[5]);

  const ema4h20 = computeEma(tf4hCloses, 20);
  const ema4h50 = computeEma(tf4hCloses, 50);
  const ema4h200 = computeEma(tf4hCloses, 200);
  const ema1h20 = computeEma(tf1hCloses, 20);
  const ema1h50 = computeEma(tf1hCloses, 50);
  const ema15m20 = computeEma(tf15mCloses, 20);

  const tf4hAdx = computeAdxSafe(input.tf4h.ohlcv, 14);
  const tf4hBb = bollingerBands(tf4hCloses, 20);
  const distEma200Pct = (() => {
    const lastClose = tf4hCloses[tf4hCloses.length - 1] ?? 0;
    const lastEma200 = ema4h200[ema4h200.length - 1] ?? 0;
    if (!Number.isFinite(lastClose) || !Number.isFinite(lastEma200) || lastEma200 === 0) return 0;
    return (lastClose - lastEma200) / Math.abs(lastEma200);
  })();

  const tf1hBb = bollingerBands(tf1hCloses, 20);
  const tf15mBb = bollingerBands(tf15mCloses, 20);

  const tf1hRsi = (() => {
    const series = rsi(tf1hCloses, 14);
    return series.length ? series[series.length - 1] : 50;
  })();
  const tf15mRsi = (() => {
    const series = rsi(tf15mCloses, 14);
    return series.length ? series[series.length - 1] : 50;
  })();

  const trendBias = determineTrendBias(tf4hCloses, ema4h20, ema4h50, ema4h200, tf4hAdx);

  const features: ContextFeatures = {
    tf4h: {
      emaSlope20: percentSlope(ema4h20),
      emaSlope50: percentSlope(ema4h50),
      emaSlope200: percentSlope(ema4h200),
      adx14: tf4hAdx,
      bbWidth: tf4hBb.width,
      distEma200Pct,
      trendBias,
    },
    tf1h: {
      roc12: rateOfChange(tf1hCloses, 12),
      roc24: rateOfChange(tf1hCloses, 24),
      rsi: tf1hRsi,
      bbp: tf1hBb.percentB,
      emaSlope20: percentSlope(ema1h20),
      emaSlope50: percentSlope(ema1h50),
      volRatio: volumeRatio(tf1hVolumes),
    },
    tf15m: {
      roc12: rateOfChange(tf15mCloses, 12),
      rsi: tf15mRsi,
      bbp: tf15mBb.percentB,
      emaSlope20: percentSlope(ema15m20),
      ofi: input.micro.ofi,
      volRatio: volumeRatio(tf15mVolumes),
    },
    micro: {
      spreadBps: input.micro.spreadBps,
      bidDepthUsd: input.micro.bidDepthUsd,
      askDepthUsd: input.micro.askDepthUsd,
      passiveFillRate: input.micro.passiveFillRate,
      volume24hUsd: input.micro.volume24hUsd,
    },
    driver: input.driver,
    session: {
      euUsOverlap: input.session.euUsOverlap,
      isWeekend: input.session.isWeekend,
      isNight: input.session.isNight,
    },
  };

  for (const [key, value] of Object.entries(features.tf4h)) {
    if (key === 'trendBias') continue;
    ensureFinite(`tf4h.${key}`, value as number);
  }
  for (const [key, value] of Object.entries(features.tf1h)) {
    ensureFinite(`tf1h.${key}`, value as number);
  }
  for (const [key, value] of Object.entries(features.tf15m)) {
    if (value !== undefined) ensureFinite(`tf15m.${key}`, value as number);
  }
  for (const [key, value] of Object.entries(features.micro)) {
    ensureFinite(`micro.${key}`, value as number);
  }
  for (const [key, value] of Object.entries(features.driver)) {
    ensureFinite(`driver.${key}`, value as number);
  }
  return features;
}

export function flattenFeatures(features: ContextFeatures): number[] {
  const biasEncoding: Record<TrendBias, number[]> = {
    bull: [1, 0, 0],
    bear: [0, 1, 0],
    neutral: [0, 0, 1],
  };
  const vector: number[] = [
    features.tf4h.emaSlope20,
    features.tf4h.emaSlope50,
    features.tf4h.emaSlope200,
    features.tf4h.adx14,
    features.tf4h.bbWidth,
    features.tf4h.distEma200Pct,
    ...biasEncoding[features.tf4h.trendBias],
    features.tf1h.roc12,
    features.tf1h.roc24,
    features.tf1h.rsi,
    features.tf1h.bbp,
    features.tf1h.emaSlope20,
    features.tf1h.emaSlope50,
    features.tf1h.volRatio,
    features.tf15m.roc12,
    features.tf15m.rsi,
    features.tf15m.bbp,
    features.tf15m.emaSlope20,
    features.tf15m.ofi ?? 0,
    features.tf15m.volRatio,
    features.micro.spreadBps,
    features.micro.bidDepthUsd,
    features.micro.askDepthUsd,
    features.micro.passiveFillRate,
    features.micro.volume24hUsd,
    features.driver.btcRet15m,
    features.driver.btcRet1h,
    features.driver.corrBtc1h,
    features.session.euUsOverlap ? 1 : 0,
    features.session.isWeekend ? 1 : 0,
    features.session.isNight ? 1 : 0,
  ];
  for (let i = 0; i < vector.length; i++) {
    ensureFinite(`vector[${i}]`, vector[i]);
  }
  return vector;
}

export function validateContextFeatures(features: ContextFeatures): void {
  flattenFeatures(features);
}
