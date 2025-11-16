import fs from 'node:fs/promises';
import path from 'node:path';
import { setOhlcvOverride, setTickerOverride } from '../data/market.js';

export type Candle = [number, number, number, number, number, number];

export type HistoricalFeedInit = {
  symbol: string;
  baseTimeframe?: string;
  candles: Candle[];
  warmupBars?: number;
};

export type HistoricalFeedAdvance = {
  index: number;
  timestamp: number;
};

const DEFAULT_BASE_TF = '15m';
const MIN_CANDLES_REQUIRED = 600;

function timeframeToMs(tf: string): number {
  const match = /^\s*(\d+)\s*([mhd])\s*$/i.exec(tf);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 3_600_000;
  if (unit === 'd') return value * 86_400_000;
  return 0;
}

function alignTimestamp(ts: number, intervalMs: number): number {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function cloneSeries(slice: Candle[]): Candle[] {
  return slice.map((row) => [...row] as Candle);
}

function normalizeCandleRow(row: any): Candle | null {
  if (!row) return null;
  if (Array.isArray(row)) {
    if (row.length < 6) return null;
    const values = row.slice(0, 6).map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) return null;
    return values as Candle;
  }
  if (typeof row === 'object') {
    const ts = Number(row.ts ?? row.timestamp ?? row[0]);
    const open = Number(row.open ?? row.o ?? row[1]);
    const high = Number(row.high ?? row.h ?? row[2]);
    const low = Number(row.low ?? row.l ?? row[3]);
    const close = Number(row.close ?? row.c ?? row[4]);
    const volume = Number(row.volume ?? row.v ?? row[5] ?? 0);
    if ([ts, open, high, low, close].some((value) => !Number.isFinite(value))) {
      return null;
    }
    return [ts, open, high, low, close, Number.isFinite(volume) ? volume : 0];
  }
  return null;
}

export async function loadCandlesFromFile(filePath: string): Promise<Candle[]> {
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.candles)
      ? parsed.candles
      : null;
  if (!list) {
    throw new Error(`Historical dataset at ${resolved} must be an array or contain a top-level \"candles\" array.`);
  }
  const candles = list
    .map((row) => normalizeCandleRow(row))
    .filter((row): row is Candle => Array.isArray(row));
  candles.sort((a, b) => a[0] - b[0]);
  if (candles.length < MIN_CANDLES_REQUIRED) {
    throw new Error(`Historical dataset ${resolved} is too small (${candles.length} < ${MIN_CANDLES_REQUIRED}).`);
  }
  return candles;
}

function resampleCandles(base: Candle[], baseIntervalMs: number, targetIntervalMs: number): Candle[] {
  if (targetIntervalMs <= baseIntervalMs) {
    return cloneSeries(base);
  }
  const buckets: Record<number, Candle> = {};
  for (const candle of base) {
    const bucketTs = alignTimestamp(candle[0], targetIntervalMs);
    const existing = buckets[bucketTs];
    if (!existing) {
      buckets[bucketTs] = [
        bucketTs,
        candle[1],
        candle[2],
        candle[3],
        candle[4],
        candle[5],
      ];
      continue;
    }
    existing[2] = Math.max(existing[2], candle[2]);
    existing[3] = Math.min(existing[3], candle[3]);
    existing[4] = candle[4];
    existing[5] += candle[5];
  }
  return Object.values(buckets).sort((a, b) => a[0] - b[0]);
}

export class HistoricalFeed {
  readonly symbol: string;
  readonly baseTimeframe: string;
  readonly warmupBars: number;
  private readonly baseSeries: Candle[];
  private readonly baseIntervalMs: number;
  private readonly seriesByTf = new Map<string, Candle[]>();
  private cursor: number;
  private processed = 0;
  private installed = false;

  constructor(init: HistoricalFeedInit) {
    this.symbol = init.symbol.toUpperCase();
    this.baseTimeframe = (init.baseTimeframe || DEFAULT_BASE_TF).toLowerCase();
    this.baseSeries = cloneSeries(init.candles);
    this.baseIntervalMs = timeframeToMs(this.baseTimeframe) || this.inferIntervalMs();
    if (!(this.baseIntervalMs > 0)) {
      throw new Error(`Unable to infer interval for timeframe ${this.baseTimeframe}`);
    }
    this.seriesByTf.set(this.baseTimeframe, this.baseSeries);
    if (this.baseSeries.length < MIN_CANDLES_REQUIRED) {
      throw new Error(`Historical feed for ${this.symbol} requires at least ${MIN_CANDLES_REQUIRED} candles.`);
    }
    const requestedWarmup = Math.max(50, init.warmupBars ?? 400);
    const maxIndex = this.baseSeries.length - 1;
    const safeCursor = Math.min(Math.max(1, requestedWarmup), Math.max(1, maxIndex));
    this.warmupBars = safeCursor;
    this.cursor = safeCursor - 1;
  }

  install(): void {
    if (this.installed) {
      return;
    }
    setOhlcvOverride(this.ohlcvHandler);
    setTickerOverride(this.tickerHandler);
    this.installed = true;
  }

  dispose(): void {
    if (!this.installed) {
      return;
    }
    setOhlcvOverride(null);
    setTickerOverride(null);
    this.installed = false;
  }

  hasNext(step = 1): boolean {
    return this.cursor + step < this.baseSeries.length;
  }

  advance(step = 1): HistoricalFeedAdvance {
    if (!this.hasNext(step)) {
      return { index: this.cursor, timestamp: this.currentTimestamp };
    }
    this.cursor = Math.min(this.baseSeries.length - 1, this.cursor + step);
    this.processed += step;
    return { index: this.cursor, timestamp: this.currentTimestamp };
  }

  get currentTimestamp(): number {
    return this.baseSeries[this.cursor]?.[0] ?? 0;
  }

  get processedBars(): number {
    return this.processed;
  }

  get totalBars(): number {
    return this.baseSeries.length;
  }

  private inferIntervalMs(): number {
    for (let i = 1; i < this.baseSeries.length; i += 1) {
      const delta = this.baseSeries[i][0] - this.baseSeries[i - 1][0];
      if (delta > 0) {
        return delta;
      }
    }
    return 0;
  }

  private latestIndexFor(series: Candle[], ts: number): number {
    if (!series.length) return -1;
    let hi = series.length - 1;
    while (hi >= 0 && series[hi][0] > ts) {
      hi -= 1;
    }
    return hi;
  }

  private getSeries(tf: string): Candle[] {
    const normalized = (tf || this.baseTimeframe).toLowerCase();
    if (this.seriesByTf.has(normalized)) {
      return this.seriesByTf.get(normalized)!;
    }
    const intervalMs = timeframeToMs(normalized);
    if (!(intervalMs > 0)) {
      throw new Error(`Historical feed does not support timeframe ${tf}`);
    }
    const resampled = resampleCandles(this.baseSeries, this.baseIntervalMs, intervalMs);
    this.seriesByTf.set(normalized, resampled);
    return resampled;
  }

  private ohlcvHandler = async (
    symbol: string,
    tf: string,
    limit: number,
    _userId?: string,
    _options?: Record<string, unknown>,
  ): Promise<Candle[]> => {
    if (symbol.toUpperCase() !== this.symbol) {
      throw new Error(`Historical feed mounted for ${this.symbol} cannot serve symbol ${symbol}`);
    }
    const series = this.getSeries(tf);
    const latestIdx = this.latestIndexFor(series, this.currentTimestamp);
    if (latestIdx < 0) {
      throw new Error(`Historical feed has no data for timeframe ${tf} before ${new Date(this.currentTimestamp).toISOString()}`);
    }
    const start = Math.max(0, latestIdx - Math.max(0, limit || 0) + 1);
    return cloneSeries(series.slice(start, latestIdx + 1));
  };

  private tickerHandler = async (
    symbol: string,
    _options?: { forceRefresh?: boolean; userId?: string },
  ): Promise<any> => {
    if (symbol.toUpperCase() !== this.symbol) {
      throw new Error(`Historical feed mounted for ${this.symbol} cannot serve ticker for ${symbol}`);
    }
    const candle = this.baseSeries[this.cursor];
    if (!candle) {
      throw new Error('Historical feed cursor is out of range');
    }
    const [ts, _o, _h, _l, close] = candle;
    return {
      symbol: this.symbol,
      last: close,
      bid: close,
      ask: close,
      close,
      receivedAt: ts,
      timestamp: ts,
    };
  };
}
