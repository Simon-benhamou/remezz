import fs from 'node:fs/promises';
import path from 'node:path';
import ccxt from 'ccxt';
import { binanceRestQueue, BINANCE_WEIGHTS } from '../../services/binanceRestQueue.js';

export type HistoricalCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type LoadHistoricalOhlcvParams = {
  symbol: string;
  timeframe: string;
  days: number;
  exchangeId?: string;
};

export type LoadHistoricalOhlcvResult = {
  candles: HistoricalCandle[];
  metadata: {
    datasource: 'ccxt' | 'csv';
    exchange: string | null;
    maxGapMinutes: number;
    startTimestamp: number | null;
    endTimestamp: number | null;
  };
};

const TIMEFRAME_TO_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

const FALLBACK_FORWARD_FILL_LIMIT = 3;
const MAX_CCXT_BATCH = 1_500;
const CSV_FALLBACK_DIR = path.resolve(process.cwd(), 'data', 'ohlcv');

function timeframeToMs(timeframe: string): number {
  const value = TIMEFRAME_TO_MS[timeframe];
  if (!value) {
    throw new Error(`Unsupported timeframe "${timeframe}"`);
  }
  return value;
}

async function ensureExchange(exchangeId: string) {
  const mappedId = mapExchangeId(exchangeId);
  const ExchangeCls = (ccxt as any)[mappedId];
  if (!ExchangeCls) {
    throw new Error(`Unknown exchange "${exchangeId}" (mapped: ${mappedId})`);
  }
  const exchange = new ExchangeCls({ enableRateLimit: true });
  if (exchange.has?.fetchOHLCV) {
    return exchange;
  }
  throw new Error(`Exchange "${exchangeId}" does not support fetchOHLCV`);
}

function mapExchangeId(exchangeId: string): string {
  if (exchangeId === 'binance' || exchangeId === 'binanceusdm' || exchangeId === 'binanceusdsm') {
    return exchangeId === 'binance' ? 'binance' : 'binanceusdm';
  }
  if (exchangeId === 'bybit') return 'bybit';
  if (exchangeId === 'okx') return 'okx';
  return exchangeId;
}

function buildSymbolCandidates(symbol: string): string[] {
  const upper = symbol.toUpperCase();
  const variants = new Set<string>();
  variants.add(symbol);
  variants.add(upper);
  if (!upper.includes(':USDT') && upper.endsWith('/USDT')) {
    variants.add(`${upper}:USDT`);
  }
  if (!upper.includes(':USD') && upper.endsWith('/USD')) {
    variants.add(`${upper}:USD`);
  }
  if (!upper.includes('USDT')) {
    variants.add(`${upper.replace(/\//g, '')}USDT`);
  }
  return Array.from(variants);
}

async function loadFromCcxtPaginated(
  params: LoadHistoricalOhlcvParams,
  timeframeMs: number,
  totalWindowMs: number,
  limit: number,
): Promise<{ candles: HistoricalCandle[]; exchange: string } | null> {
  const exchangeId = params.exchangeId ?? process.env.SMOKE_EXCHANGE ?? 'binanceusdm';
  const exchange = await ensureExchange(exchangeId);
  const candidates = buildSymbolCandidates(params.symbol);

  for (const candidate of candidates) {
    const sinceStart = Date.now() - totalWindowMs - timeframeMs;
    let cursor = sinceStart;
    let batches = 0;
    const collected: HistoricalCandle[] = [];

    while (collected.length < limit && batches < 24) {
      const remaining = limit - collected.length;
      const batchLimit = Math.min(
        MAX_CCXT_BATCH,
        Math.max(100, remaining + 50),
      );
      try {
        // Route through binanceRestQueue — single gateway for ALL Binance REST calls
        const ohlcv = await binanceRestQueue.enqueue(
          () => exchange.fetchOHLCV(candidate, params.timeframe, cursor, batchLimit),
          {
            weight: BINANCE_WEIGHTS.FETCH_OHLCV,
            priority: 'low',
            tag: `loadHistoricalOhlcv:${candidate}:${params.timeframe}`,
          },
        );
        if (!Array.isArray(ohlcv) || !ohlcv.length) {
          break;
        }
        let progressed = false;
        for (const [timestamp, open, high, low, close, volume] of ohlcv) {
          if (!Number.isFinite(timestamp)) continue;
          if (collected.length && timestamp <= collected[collected.length - 1].timestamp) {
            continue;
          }
          collected.push({
            timestamp,
            open: Number(open),
            high: Number(high),
            low: Number(low),
            close: Number(close),
            volume: Number(volume ?? 0),
          });
          progressed = true;
          if (collected.length >= limit) break;
        }
        if (!progressed) {
          break;
        }
        cursor = collected[collected.length - 1].timestamp + timeframeMs;
        batches += 1;
        if (ohlcv.length < batchLimit) {
          break;
        }
      } catch (error) {
        console.warn(`[loadHistoricalOhlcv] ccxt fetch failed for ${candidate} on ${exchangeId}:`, error);
        break;
      }
    }

    if (collected.length > 0) {
      return { candles: collected, exchange: exchangeId };
    }
  }

  return null;
}

async function loadFromCsv(params: LoadHistoricalOhlcvParams): Promise<HistoricalCandle[] | null> {
  const safeSymbol = params.symbol.replace(/[:/]/g, '-').toUpperCase();
  const filename = `${safeSymbol}-${params.timeframe}.csv`;
  const fullPath = path.join(CSV_FALLBACK_DIR, filename);
  try {
    const content = await fs.readFile(fullPath, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const candles: HistoricalCandle[] = [];
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length < 6) continue;
      const [timestamp, open, high, low, close, volume] = parts.map((value) => Number.parseFloat(value.trim()));
      if ([timestamp, open, high, low, close, volume].every((value) => Number.isFinite(value))) {
        candles.push({ timestamp, open, high, low, close, volume });
      }
    }
    return candles.length ? candles : null;
  } catch (error) {
    console.warn(`[loadHistoricalOhlcv] CSV fallback failed for ${fullPath}:`, error);
    return null;
  }
}

function normalizeCandles(raw: HistoricalCandle[], timeframeMs: number) {
  const dedup = new Map<number, HistoricalCandle>();
  for (const item of raw) {
    if (!item) continue;
    if (!Number.isFinite(item.timestamp)) continue;
    dedup.set(item.timestamp, {
      timestamp: Number(item.timestamp),
      open: Number(item.open),
      high: Number(item.high),
      low: Number(item.low),
      close: Number(item.close),
      volume: Number(item.volume ?? 0),
    });
  }
  const sorted = Array.from(dedup.values()).sort((a, b) => a.timestamp - b.timestamp);
  if (!sorted.length) {
    return { candles: [], maxGapMinutes: 0 };
  }
  const normalized: HistoricalCandle[] = [sorted[0]];
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = normalized[normalized.length - 1];
    const current = sorted[i];
    const delta = current.timestamp - prev.timestamp;
    if (delta > timeframeMs) {
      const missing = Math.floor(delta / timeframeMs) - 1;
      if (missing > 0) {
        maxGap = Math.max(maxGap, missing);
        if (missing <= FALLBACK_FORWARD_FILL_LIMIT) {
          for (let j = 1; j <= missing; j += 1) {
            const ts = prev.timestamp + timeframeMs * j;
            normalized.push({
              timestamp: ts,
              open: prev.close,
              high: prev.close,
              low: prev.close,
              close: prev.close,
              volume: 0,
            });
          }
        }
      }
    }
    normalized.push(current);
  }
  return { candles: normalized, maxGapMinutes: (maxGap * timeframeMs) / 60_000 };
}

export async function loadHistoricalOhlcv(params: LoadHistoricalOhlcvParams): Promise<LoadHistoricalOhlcvResult> {
  const timeframeMs = timeframeToMs(params.timeframe);
  const totalWindowMs = params.days * 24 * 60 * 60 * 1000;
  const limit = Math.ceil(totalWindowMs / timeframeMs) + 10;

  const ccxtResult = await loadFromCcxtPaginated(params, timeframeMs, totalWindowMs, limit);
  if (ccxtResult) {
    const { candles, maxGapMinutes } = normalizeCandles(ccxtResult.candles, timeframeMs);
    const coverage = candles.length / limit;
    if (coverage < 0.6) {
      console.warn(`[loadHistoricalOhlcv] ccxt coverage low (${candles.length}/${limit} bars, ${(coverage * 100).toFixed(1)}%)`);
    }
    const startTimestamp = candles.length ? candles[0].timestamp : null;
    const endTimestamp = candles.length ? candles[candles.length - 1].timestamp : null;
    if (candles.length === 0) {
      throw new Error(`Insufficient OHLCV data for ${params.symbol}`);
    }
    return {
      candles,
      metadata: {
        datasource: 'ccxt',
        exchange: ccxtResult.exchange,
        maxGapMinutes,
        startTimestamp,
        endTimestamp,
      },
    };
  }

  const csvCandles = await loadFromCsv(params);
  if (csvCandles && csvCandles.length) {
    const { candles, maxGapMinutes } = normalizeCandles(csvCandles, timeframeMs);
    const startTimestamp = candles.length ? candles[0].timestamp : null;
    const endTimestamp = candles.length ? candles[candles.length - 1].timestamp : null;
    return {
      candles,
      metadata: {
        datasource: 'csv',
        exchange: null,
        maxGapMinutes,
        startTimestamp,
        endTimestamp,
      },
    };
  }

  throw new Error(`Unable to load OHLCV data for ${params.symbol}`);
}
