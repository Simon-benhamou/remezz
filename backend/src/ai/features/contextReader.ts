import { getOHLCV, getTicker } from '../../data/market.js';
import { buildContextFeatures, type ContextFeatures, type FeatureBuilderInput, type MicrostructureSnapshot, type DriverSnapshot, type SessionSnapshot } from './featureBuilder.js';

export interface MarketDataProvider {
  fetchOhlcv(symbol: string, timeframe: '4h' | '1h' | '15m', limit: number): Promise<number[][]>;
  fetchMicro(symbol: string): Promise<MicrostructureSnapshot>;
  fetchDriver(symbol: string): Promise<DriverSnapshot>;
  resolveSession(timestamp: number): SessionSnapshot;
}

const BTC_SYMBOL = 'BTC/USDT';

export class DefaultMarketDataProvider implements MarketDataProvider {
  async fetchOhlcv(symbol: string, timeframe: '4h' | '1h' | '15m', limit: number): Promise<number[][]> {
    const data = await getOHLCV(symbol, timeframe, limit);
    if (!Array.isArray(data) || !data.length) {
      throw new Error(`Missing OHLCV for ${symbol} ${timeframe}`);
    }
    return data as number[][];
  }

  async fetchMicro(symbol: string): Promise<MicrostructureSnapshot> {
    const ticker = await getTicker(symbol);
    if (!ticker) {
      throw new Error(`Missing ticker for ${symbol}`);
    }
    const bid = Number(ticker.bid ?? ticker.info?.bid ?? 0);
    const ask = Number(ticker.ask ?? ticker.info?.ask ?? 0);
    const last = Number(ticker.last ?? ticker.info?.last ?? (bid && ask ? (bid + ask) / 2 : 0));
    const spread = ask && bid ? Math.max(ask - bid, 0) : 0;
    const spreadBps = last ? (spread / last) * 10_000 : 0;
    const bidDepthUsd = Number(ticker.info?.bidVolume ?? ticker.baseVolume ?? 0);
    const askDepthUsd = Number(ticker.info?.askVolume ?? ticker.baseVolume ?? 0);
    const passiveFillRate = Number(ticker.info?.fillRate ?? 0.5);
    const volume24hUsd = Number(ticker.quoteVolume ?? ticker.info?.quoteVolume ?? ticker.baseVolume ?? 0);
    const ofi = Number(ticker.info?.ofi ?? 0);
    const slipRecentBps = Number(ticker.info?.slipRecentBps ?? spreadBps);
    return {
      spreadBps: Number.isFinite(spreadBps) ? spreadBps : 0,
      bidDepthUsd: Number.isFinite(bidDepthUsd) ? bidDepthUsd : 0,
      askDepthUsd: Number.isFinite(askDepthUsd) ? askDepthUsd : 0,
      passiveFillRate: Number.isFinite(passiveFillRate) ? passiveFillRate : 0.5,
      volume24hUsd: Number.isFinite(volume24hUsd) ? volume24hUsd : 0,
      ofi: Number.isFinite(ofi) ? ofi : undefined,
      slipRecentBps: Number.isFinite(slipRecentBps) ? slipRecentBps : undefined,
    };
  }

  async fetchDriver(symbol: string): Promise<DriverSnapshot> {
    const [btc15m, btc1h, sym1h] = await Promise.all([
      this.fetchOhlcv(BTC_SYMBOL, '15m', 64),
      this.fetchOhlcv(BTC_SYMBOL, '1h', 64),
      this.fetchOhlcv(symbol, '1h', 64),
    ]);
    const btcRet15m = computeReturn(btc15m.map(row => row[4]), 1);
    const btcRet1h = computeReturn(btc1h.map(row => row[4]), 1);
    const corrBtc1h = computeCorrelation(sym1h.map(row => row[4]), btc1h.map(row => row[4]));
    return {
      btcRet15m,
      btcRet1h,
      corrBtc1h,
    };
  }

  resolveSession(timestamp: number): SessionSnapshot {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();
    const day = date.getUTCDay();
    const euUsOverlap = hour >= 12 && hour < 16;
    const isWeekend = day === 0 || day === 6;
    const isNight = hour < 7 || hour >= 21;
    return {
      timestamp,
      euUsOverlap,
      isWeekend,
      isNight,
    };
  }
}

function computeReturn(series: number[], period: number): number {
  if (series.length <= period) return 0;
  const last = series[series.length - 1];
  const prev = series[series.length - 1 - period];
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return 0;
  return (last - prev) / Math.abs(prev);
}

function computeCorrelation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const sliceA = a.slice(-n);
  const sliceB = b.slice(-n);
  const meanA = sliceA.reduce((acc, v) => acc + v, 0) / n;
  const meanB = sliceB.reduce((acc, v) => acc + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = sliceA[i] - meanA;
    const db = sliceB[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

export interface BuildContextOptions {
  provider?: MarketDataProvider;
  now?: number;
  microOverride?: Partial<MicrostructureSnapshot>;
  driverOverride?: Partial<DriverSnapshot>;
}

export async function buildContext(symbol: string, options: BuildContextOptions = {}): Promise<ContextFeatures> {
  const provider = options.provider ?? new DefaultMarketDataProvider();
  const now = options.now ?? Date.now();
  const [tf4h, tf1h, tf15m, micro, driver] = await Promise.all([
    provider.fetchOhlcv(symbol, '4h', 256),
    provider.fetchOhlcv(symbol, '1h', 256),
    provider.fetchOhlcv(symbol, '15m', 256),
    provider.fetchMicro(symbol),
    provider.fetchDriver(symbol),
  ]);
  const session = provider.resolveSession(now);
  const featureInput: FeatureBuilderInput = {
    tf4h: { timeframe: '4h', ohlcv: tf4h },
    tf1h: { timeframe: '1h', ohlcv: tf1h },
    tf15m: { timeframe: '15m', ohlcv: tf15m },
    micro: { ...micro, ...options.microOverride },
    driver: { ...driver, ...options.driverOverride },
    session,
  };
  return buildContextFeatures(featureInput);
}

export { ContextFeatures };
