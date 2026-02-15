import { resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';
import { ipWeightTracker } from '../services/ipWeightTracker.js';
import {
  getBinanceWebSocket,
  getTickerFromWebSocket,
  seedKlinesFromWebSocket,
  getKlinesOhlcvFromWebSocket,
  adaptBinanceTickerToCcxt,
  toBinanceSymbolId,
  scheduleBinanceRestFallback,
} from '../services/binanceWebSocket.js';
import { fetchBinanceOhlcv, isBinanceRestIpBanned } from '../services/binanceRest.js';
import { recordMarketFrame, recordRestFallback, setFallbackState } from '../monitor/marketMetrics.js';
import { evaluateTickerFrame } from './tickerValidation.js';

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

const SYNTHETIC_WARN_INTERVAL_MS = 60_000;
const syntheticWarnedAt = new Map<string, number>();

// V5.73: Global rate limiter for REST backfill to prevent IP bans
// When multiple agents start simultaneously, queue their backfills
// Increased from 3s to 5s to be more conservative with Binance rate limits
const REST_BACKFILL_MIN_DELAY_MS = 5000; // 5 seconds between backfills
let lastRestBackfillTime = 0;
const backfillQueue: Array<() => void> = [];
let backfillQueueProcessing = false;

async function queueRestBackfill<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const queuePosition = backfillQueue.length;
    
    backfillQueue.push(async () => {
      try {
        const now = Date.now();
        const timeSinceLastBackfill = now - lastRestBackfillTime;
        
        if (timeSinceLastBackfill < REST_BACKFILL_MIN_DELAY_MS) {
          const waitTime = REST_BACKFILL_MIN_DELAY_MS - timeSinceLastBackfill;
          if (queuePosition > 0) {
            console.log(`⏳ Backfill queued (position ${queuePosition}, wait ${Math.round(waitTime/1000)}s)`);
          }
          await new Promise(r => setTimeout(r, waitTime));
        }
        
        lastRestBackfillTime = Date.now();
        const result = await fn();
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        processBackfillQueue();
      }
    });
    
    if (!backfillQueueProcessing) {
      processBackfillQueue();
    }
  });
}

function processBackfillQueue(): void {
  if (backfillQueue.length === 0) {
    backfillQueueProcessing = false;
    return;
  }
  
  backfillQueueProcessing = true;
  const next = backfillQueue.shift();
  if (next) next();
}

function recordSyntheticWarning(tf: string, sample: number[][]): void {
  const now = Date.now();
  const lastWarn = syntheticWarnedAt.get(tf) || 0;
  if (now - lastWarn < SYNTHETIC_WARN_INTERVAL_MS) return;
  syntheticWarnedAt.set(tf, now);
  try {
    console.warn(`synthetic_ohlcv_detected:${tf}`, {
      sample: sample.slice(-3).map((row) => row?.[5]),
    });
  } catch {}
}

type OhlcvOverride = (
  symbol: string,
  tf: string,
  limit: number,
  userId?: string,
  options?: GetOhlcvOptions,
) => Promise<number[][]>;

let ohlcvOverride: OhlcvOverride | null = null;

export function setOhlcvOverride(fn: OhlcvOverride | null): void {
  ohlcvOverride = fn;
}

type TickerOverride = (
  symbol: string,
  options?: { forceRefresh?: boolean; userId?: string },
) => Promise<any>;

let tickerOverride: TickerOverride | null = null;

export function setTickerOverride(fn: TickerOverride | null): void {
  tickerOverride = fn;
}

// Simple cache to reduce API calls - OPTIMIZED for faster real-time response
const tickerCache = new Map<string, { data: any; timestamp: number }>();
const TICKER_CACHE_TTL = 4000; // 4 seconds cache to reduce network churn

// Create a temporary unauthenticated exchange for public market data
const exchangeCache = new Map<string, any>();
const binanceKlineSeeded = new Set<string>();
const binanceKlineSeedPromises = new Map<string, Promise<number[][]>>();

type WarmupState = {
  attempts: number;
  lastAttempt?: number;
  pending: boolean;
  lastError?: string;
  fulfilled?: boolean;
  nextRetryTs?: number;
  lastSuccess?: number;
  syntheticCount?: number;
  lastSyntheticAt?: number;
};

const ohlcvWarmupState = new Map<string, WarmupState>();
const backfillRetryTimers = new Map<string, NodeJS.Timeout>();

function warmupStateKey(symbol: string, tf: string): string {
  return `${symbol.toUpperCase()}__${tf}`;
}

function getWarmupState(key: string): WarmupState {
  return ohlcvWarmupState.get(key) || { attempts: 0, pending: false, syntheticCount: 0 };
}

function setWarmupState(key: string, patch: Partial<WarmupState> & { attempts?: number }): WarmupState {
  const current = getWarmupState(key);
  const attempts = patch.attempts != null ? patch.attempts : current.attempts;
  const syntheticCount = patch.syntheticCount != null ? patch.syntheticCount : current.syntheticCount ?? 0;
  const lastSyntheticAt = patch.lastSyntheticAt !== undefined ? patch.lastSyntheticAt : current.lastSyntheticAt;
  const updated: WarmupState = {
    attempts,
    lastAttempt: current.lastAttempt,
    pending: current.pending,
    lastError: current.lastError,
    fulfilled: current.fulfilled,
    nextRetryTs: current.nextRetryTs,
    lastSuccess: current.lastSuccess,
    syntheticCount,
    lastSyntheticAt,
    ...patch,
  };
  ohlcvWarmupState.set(key, updated);
  return updated;
}

function scheduleWarmupRetry(key: string, seedKey: string, delayMs: number): void {
  if (delayMs <= 0) {
    binanceKlineSeeded.delete(seedKey);
    setWarmupState(key, { pending: false, nextRetryTs: undefined });
    return;
  }
  if (backfillRetryTimers.has(key)) return;
  const timer = setTimeout(() => {
    backfillRetryTimers.delete(key);
    binanceKlineSeeded.delete(seedKey);
    setWarmupState(key, { pending: false, nextRetryTs: undefined });
  }, delayMs);
  backfillRetryTimers.set(key, timer);
}

export function getOhlcvWarmupState(symbol: string, tf: string): WarmupState | undefined {
  return ohlcvWarmupState.get(warmupStateKey(symbol, tf));
}

function toNumber(value: any): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function resolveTickerReceivedAt(
  ticker: { receivedAt?: number } | null | undefined,
  fallback: number,
): number {
  if (ticker && Number.isFinite(Number(ticker.receivedAt))) {
    return Number(ticker.receivedAt);
  }
  return fallback;
}

function pickFirstNumber(...values: any[]): number | undefined {
  for (const v of values) {
    const n = toNumber(v);
    if (n !== undefined) return n;
  }
  return undefined;
}

function timeframeToMs(tf: string): number {
  const match = /^\s*(\d+)([mhd])\s*$/i.exec(tf);
  if (!match) return 0;
  const value = Number(match[1] || 0);
  const unit = match[2]?.toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return 0;
  switch (unit) {
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    case 'd':
      return value * 86_400_000;
    default:
      return 0;
  }
}

function timeframeToMinutes(tf: string): number {
  const ms = timeframeToMs(tf);
  return ms > 0 ? ms / 60_000 : 0;
}

type AggregatedKline = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  count: number;
};

function aggregateFromBaseTimeframe(
  baseSeries: number[][],
  baseTf: string,
  targetTf: string,
): number[][] {
  const targetMs = timeframeToMs(targetTf);
  const baseMs = timeframeToMs(baseTf);
  if (!targetMs || !baseMs || targetMs <= baseMs || targetMs % baseMs !== 0) {
    return [];
  }

  const buckets = new Map<number, AggregatedKline>();
  for (const row of baseSeries) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const ts = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const vol = Number(row[5]);
    if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high)
      || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    const bucketStart = Math.floor(ts / targetMs) * targetMs;
    const existing = buckets.get(bucketStart);
    if (!existing) {
      buckets.set(bucketStart, {
        open,
        high,
        low,
        close,
        volume: Number.isFinite(vol) ? vol : 0,
        count: 1,
      });
    } else {
      existing.high = Number.isFinite(high) ? Math.max(existing.high, high) : existing.high;
      existing.low = Number.isFinite(low) ? Math.min(existing.low, low) : existing.low;
      existing.close = close;
      if (Number.isFinite(vol)) {
        existing.volume += vol;
      }
      existing.count += 1;
    }
  }

  const aggregated = Array.from(buckets.entries())
    .filter(([, state]) => state.count > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStart, state]) => [
      bucketStart,
      state.open,
      state.high,
      state.low,
      state.close,
      Number.isFinite(state.volume) ? Number(state.volume) : 0,
    ]);

  return aggregated;
}

function buildAggregatedSeriesFromFifteenMinuteWs(
  symbol: string,
  targetTf: string,
  limit: number,
): number[][] | null {
  const targetMinutes = timeframeToMinutes(targetTf);
  if (!targetMinutes || targetMinutes <= 15) {
    return null;
  }

  const ws = getBinanceWebSocket();
  try {
    ws.subscribeToKline(symbol, '15m');
  } catch {}

  const baseSeries = getKlinesOhlcvFromWebSocket(symbol, '15m');
  if (!baseSeries || baseSeries.length === 0) {
    return null;
  }

  const aggregated = aggregateFromBaseTimeframe(baseSeries, '15m', targetTf);
  if (!aggregated.length) {
    return null;
  }

  return aggregated.slice(-limit);
}

function shouldUseWebsocketForTimeframe(tf: string): boolean {
  const normalized = tf.trim().toLowerCase();
  switch (normalized) {
    case '1m':
    case '3m':
    case '5m':
    case '15m':
    case '30m':
    case '1h':
    case '2h':
    case '4h':
    case '6h':
    case '8h':
    case '12h':
    case '1d':
      return true;
    default:
      return false;
  }
}

async function populateBidAskFromOrderBook(ex: any, symbol: string, ticker: any) {
  if (!ex || typeof ex.fetchOrderBook !== 'function') return;
  if (!ipWeightTracker.canMakeCall(5)) return;
  try {
    const book = await ex.fetchOrderBook(symbol, 5);
    ipWeightTracker.record(5, `fetchOrderBook:bidAsk:${symbol}`);
    const bestBid = pickFirstNumber(book?.bids?.[0]?.[0]);
    const bestAsk = pickFirstNumber(book?.asks?.[0]?.[0]);
    if (bestBid !== undefined) ticker.bid = bestBid;
    if (bestAsk !== undefined) ticker.ask = bestAsk;
    if (toNumber(ticker?.last) === undefined && bestBid !== undefined && bestAsk !== undefined) {
      ticker.last = (bestBid + bestAsk) / 2;
    }
  } catch (error) {
    console.warn(`Failed order book fallback for ${symbol}:`, error);
  }
}

function isBinanceExchange(id?: string | null): boolean {
  if (!id) return false;
  const norm = id.toLowerCase();
  return norm.includes('binance');
}

async function fetchUserCredentialsSafe(userId?: string) {
  if (!userId) return { credentials: null, error: null } as const;
  try {
    const { getUserCredentials } = await import('../services/userCredentials.js');
    const credentials = await getUserCredentials(userId);
    return { credentials, error: null } as const;
  } catch (error) {
    console.warn(`Failed to load user credentials for ${userId}:`, error);
    return { credentials: null, error } as const;
  }
}

function binanceSeedKey(symbol: string, interval: string) {
  return `${toBinanceSymbolId(symbol)}__${interval}`;
}

function maybeLogOhlcvDebug(symbol: string, tf: string, data: number[][]) {
  if (symbol === 'ADA/USDT' && tf === '15m') {
    try {
      console.log(`[getOHLCV DEBUG] ${symbol} ${tf}: SOURCE (last 5):`,
        data.slice(-5).map((r: any[]) => ({
          ts: new Date(r[0]).toISOString(),
          close: r[4],
          volume: r[5]
        }))
      );
    } catch {}
  }
}

function dropPartialLastBar(data: number[][], tf: string, allowPartial: boolean): number[][] {
  if (allowPartial || data.length === 0) return data;
  const intervalMs = timeframeToMs(tf);
  if (!intervalMs) return data;
  const last = data[data.length - 1];
  const lastTs = Number(last?.[0] || 0);
  if (!Number.isFinite(lastTs)) return data;
  const now = Date.now();
  if (now - lastTs < intervalMs) {
    return data.slice(0, -1);
  }
  return data;
}

export function isSyntheticSeries(data: number[][]): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const window = Math.min(20, data.length);
  if (window === 0) return false;
  const tail = data.slice(-window);
  let consecutive = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const row = tail[i];
    if (!Array.isArray(row) || row.length < 6) continue;
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    const flat = Number.isFinite(open) && open === high && high === low && low === close;
    const zeroVol = Number.isFinite(volume) && volume === 0;
    if (flat || zeroVol) {
      consecutive += 1;
      if (consecutive >= 3) {
        return true;
      }
    } else {
      break;
    }
  }
  return false;
}

export type PreparedOhlcvSeries = { series: number[][]; synthetic: boolean };

function prepareOhlcvSeries(
  raw: number[][],
  tf: string,
  limit: number,
  allowPartial: boolean,
): PreparedOhlcvSeries {
  if (!Array.isArray(raw)) return { series: [], synthetic: false };

  // 🛡️ SAFETY: Filter out invalid candles (price <= 0) to prevent indicator corruption
  const sorted = raw.slice()
    .filter(r => Array.isArray(r) && r.length >= 5 && Number(r[4]) > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]));

  if (!sorted.length) return { series: [], synthetic: false };

  // 🛡️ DEDUPLICATE: Remove candles with duplicate timestamps (keep last occurrence = freshest data)
  const deduped: number[][] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i + 1 < sorted.length && Number(sorted[i][0]) === Number(sorted[i + 1][0])) {
      continue; // skip duplicate, keep the later one
    }
    deduped.push(sorted[i]);
  }

  // 🛡️ GAP DETECTION: Find the longest contiguous series from the end.
  // When WS cache has gaps (e.g. REST historical + gap + WS live), the chart
  // would show misleading price jumps across missing candles.
  // Fix: only return the most recent contiguous block of candles.
  const intervalMs = timeframeToMs(tf);
  let contiguousStart = 0;
  if (intervalMs > 0 && deduped.length > 1) {
    // Allow up to 1.5x interval tolerance (for slight timestamp drift)
    const maxGap = intervalMs * 1.5;
    for (let i = deduped.length - 1; i > 0; i--) {
      const diff = Number(deduped[i][0]) - Number(deduped[i - 1][0]);
      if (diff > maxGap) {
        // Gap found - only keep candles from index i onward
        const gapMinutes = Math.round(diff / 60_000);
        const missingCandles = Math.round(diff / intervalMs) - 1;
        console.warn(
          `[OHLCV][GAP_DETECTED] ${tf}: ${missingCandles} candles missing ` +
          `(${gapMinutes}min gap) at ${new Date(Number(deduped[i - 1][0])).toISOString()} -> ` +
          `${new Date(Number(deduped[i][0])).toISOString()}, ` +
          `keeping ${deduped.length - i} contiguous candles from end`
        );
        contiguousStart = i;
        break;
      }
    }
  }
  const contiguous = contiguousStart > 0 ? deduped.slice(contiguousStart) : deduped;

  const trimmed = dropPartialLastBar(contiguous, tf, allowPartial);
  const clipped = trimmed.slice(-limit);
  const synthetic = isSyntheticSeries(clipped);
  if (synthetic) {
    recordSyntheticWarning(tf, clipped);
  }
  return { series: clipped, synthetic };
}

function computeBackfillLimit(tf: string, minBars: number, cfgBackfillDays: number): number {
  const minutesPerBar = timeframeToMinutes(tf) || 1;
  const requestedBars = Math.ceil(Math.max(minBars, cfgBackfillDays * 24 * 60 / minutesPerBar));
  return Math.max(minBars, Math.min(1500, requestedBars));
}

function computeRetryDelayMs(attempt: number): number {
  const base = 5_000;
  const max = 10 * 60_000;
  const factor = Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(max, base * factor);
}

// Heuristic: infer market type from unified symbol
// - Perpetual/swap symbols usually contain a colon suffix (e.g., BTC/USDT:USDT, SOL/USD:USD)
// - Also consider -PERP and USD/USDT with colon as swap
function inferMarketType(symbol?: string): 'spot' | 'swap' {
  const s = (symbol || '').toUpperCase();
  if (!s) return ((process.env.MARKET_TYPE || 'spot').toLowerCase() as any) || 'spot';
  if (s.includes(':USDT') || s.includes(':USD') || s.includes('-PERP') || /PERP$/.test(s)) return 'swap';
  return 'spot';
}

function createPublicExchange(forSymbol?: string) {
  const { EXCHANGE_ID } = getConfig();
  const desiredType = inferMarketType(forSymbol);
  const mappedId =
    EXCHANGE_ID === 'binance' && desiredType === 'swap'
      ? 'binanceusdm'
      : EXCHANGE_ID;
  const Klass: any = (ccxt as any)[mappedId];
  if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);
  
  // 🔧 FIX: Disable exchange cache to get fresh OHLCV data
  // The cached exchange instance was keeping stale candle data
  // const key = `${EXCHANGE_ID}:${desiredType}`;
  // if (exchangeCache.has(key)) return exchangeCache.get(key);
  
  const ex = new Klass({ enableRateLimit: true });
  // @ts-ignore
  ex.options = ex.options || {};
  // @ts-ignore
  ex.options.defaultType = desiredType;
  // @ts-ignore - Disable CCXT internal OHLCV cache
  ex.options.warnOnFetchOHLCVLimitArgument = false;
  // @ts-ignore - Force fresh data by disabling cache
  ex.options.fetchOHLCVWarning = false;
  // exchangeCache.set(key, ex); // Disabled cache
  return ex;
}

async function fetchOhlcvRest(symbol: string, tf: string, limit: number, userId?: string, userCredentials?: any): Promise<number[][]> {
  const cfg = getConfig();
  const exchangeHint = userCredentials?.exchange || cfg.EXCHANGE_ID;
  if (isBinanceExchange(exchangeHint)) {
    return fetchBinanceOhlcv(symbol, tf, limit);
  }

  let ex: any;
  let resolvedSymbol: string;

  if (userId) {
    try {
      const { getUserExchange } = await import('../exchange/ccxtClient.js');
      if (userCredentials) {
        ex = await getUserExchange(userId, userCredentials);
        resolvedSymbol = await resolveSymbol(symbol);
      } else {
        ex = createPublicExchange(symbol);
        const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
        if (!isBinanceExchange) {
          await ex.loadMarkets();
        }
        resolvedSymbol = await resolveSymbol(symbol);
      }
    } catch (error) {
      console.warn(`Failed to get user exchange for ${userId}, using public:`, error);
      ex = createPublicExchange(symbol);
      const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
      if (!isBinanceExchange) {
        await ex.loadMarkets();
      }
      resolvedSymbol = await resolveSymbol(symbol);
    }
  } else {
    ex = createPublicExchange(symbol);
    const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
    if (!isBinanceExchange) {
      await ex.loadMarkets();
    }
    resolvedSymbol = await resolveSymbol(symbol);
  }

  try {
    if (!ipWeightTracker.canMakeCall(10)) {
      const ok = await ipWeightTracker.waitForBudget(10, `market:fetchOHLCV:${resolvedSymbol}`, 30_000);
      if (!ok) throw new Error('IP_WEIGHT_BUDGET_EXHAUSTED');
    }
    const result = await ex.fetchOHLCV(resolvedSymbol, tf, undefined, limit);
    ipWeightTracker.record(10, `market:fetchOHLCV:${resolvedSymbol}:${tf}`);
    return result;
  } catch (err) {
    try {
      const altTf = tf === '15m' ? '5m' : tf === '1h' ? '30m' : tf;
      if (altTf !== tf) {
        const result = await ex.fetchOHLCV(resolvedSymbol, altTf, undefined, limit);
        ipWeightTracker.record(10, `market:fetchOHLCV:${resolvedSymbol}:${altTf}`);
        return result;
      }
    } catch {}
    throw err;
  }
}

export async function getTicker(symbol: string, options?: { forceRefresh?: boolean; userId?: string }) {
  if (tickerOverride) {
    return tickerOverride(symbol, options);
  }
  if (UNIT_TEST_MODE) {
    return { symbol, last: 100, percentage: 0, baseVolume: 0, quoteVolume: 0, bid: 99.9, ask: 100.1 } as any;
  }
  const cacheKey = options?.userId ? `${symbol}_${options.userId}` : symbol;
  const cached = tickerCache.get(cacheKey);
  const now = Date.now();
  
  // Skip cache if forceRefresh is requested or cache is stale
  if (!options?.forceRefresh && cached && (now - cached.timestamp) < TICKER_CACHE_TTL) {
    return cached.data;
  }

  const cfg = getConfig();
  const { credentials: userCredentials } = await fetchUserCredentialsSafe(options?.userId);
  const exchangeHint = userCredentials?.exchange || cfg.EXCHANGE_ID;
  const preferBinanceWs = isBinanceExchange(exchangeHint);

  if (preferBinanceWs) {
    try {
      const wsTicker = await getTickerFromWebSocket(symbol);
      if (wsTicker) {
        const adapted = adaptBinanceTickerToCcxt(symbol, wsTicker);
        const receivedAt = resolveTickerReceivedAt(wsTicker, now);
        const validation = evaluateTickerFrame({
          symbol,
          frame: adapted,
          source: 'WS',
          receivedAt,
          expectedSymbolId: toBinanceSymbolId(symbol),
        });
        if (validation.status === 'accepted') {
          tickerCache.set(cacheKey, { data: adapted, timestamp: now });
          return adapted;
        }
        setFallbackState(symbol, true, `ws_validation_${validation.ruleId || 'failed'}`, { increment: false });
        console.warn(`⚠️ WS ticker rejected post-adaptation for ${symbol}: ${validation.ruleId}`);
      }
    } catch (error) {
      console.warn(`Binance WebSocket ticker fallback for ${symbol}:`, error);
    }
  }
  
  try {
    // 🔧 If userId provided, use user's exchange (Binance or Crypto.com)
    let ex: any;
    let s: string;
    
    if (options?.userId) {
      try {
        const { getUserExchange } = await import('../exchange/ccxtClient.js');
        if (userCredentials) {
          ex = await getUserExchange(options.userId, userCredentials);
          s = await resolveSymbol(symbol);
        } else {
          ex = createPublicExchange(symbol);
          const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
          if (!isBinanceExchange) {
            await ex.loadMarkets();
          }
          s = await resolveSymbol(symbol);
        }
      } catch (error) {
        console.warn(`Failed to get user exchange for ${options.userId}, using public:`, error);
        ex = createPublicExchange(symbol);
        const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
        if (!isBinanceExchange) {
          await ex.loadMarkets();
        }
        s = await resolveSymbol(symbol);
      }
    } else {
      ex = createPublicExchange(symbol);
      const isBinanceExchange = String((ex as any)?.id || '').toLowerCase().includes('binance');
      if (!isBinanceExchange) {
        await ex.loadMarkets();
      }
      s = await resolveSymbol(symbol);
    }
    
    // 🚀 WebSocket for Binance (0 weight)
    let ticker: any;
    const exchangeId = String((ex as any)?.id || '').toLowerCase();
    if (exchangeId.includes('binance')) {
      try {
        const { getTickerFromWebSocket, waitForWsHealthy } = await import('../services/binanceWebSocket.js');
        let wsReady = false;
        try {
          wsReady = await waitForWsHealthy(2000);
        } catch (err) {
          console.warn(`⚠️ [WebSocket] waitForWsHealthy failed for ${s}:`, err);
        }

        let wsTicker = wsReady ? await getTickerFromWebSocket(s) : null;
        if (!wsTicker && wsReady) {
          for (let i = 0; i < 6; i++) {
            await new Promise(r => setTimeout(r, 200));
            wsTicker = await getTickerFromWebSocket(s);
            if (wsTicker) break;
          }
        }

        if (wsTicker) {
          ticker = {
            symbol: s,
            last: wsTicker.last,
            bid: wsTicker.bid,
            ask: wsTicker.ask,
            percentage: wsTicker.percentage,
            baseVolume: wsTicker.baseVolume,
            quoteVolume: wsTicker.quoteVolume,
            high: wsTicker.high,
            low: wsTicker.low,
            open: wsTicker.open,
            timestamp: wsTicker.timestamp,
            info: wsTicker
          };
          console.log(`✅ [WebSocket] getTicker(${s}) - 0 weight`);
        } else {
          console.warn(`⚠️ [WebSocket] getTicker(${s}) miss${wsReady ? '' : ' (WS not healthy)' } - falling back to REST`);
          try {
            const fallback = await scheduleBinanceRestFallback(s, () => ex.fetchTicker(s), {
              reason: wsReady ? 'ws_cache_miss' : 'ws_unhealthy',
            });
            if (!fallback) {
              console.warn(`🚫 [REST] getTicker(${s}) fallback suppressed by cooldown/quota`);
              if (cached?.data) {
                setFallbackState(s, true, 'rest_throttled', { increment: false });
                return cached.data;
              }
              setFallbackState(s, true, 'rest_throttled', { increment: false });
              throw new Error(`rest_fallback_throttled_${s}`);
            }
            ticker = fallback;
            recordRestFallback(s, 'ws_cache_miss');
            console.log(`✅ [REST] getTicker(${s}) fallback used`);
          } catch (restError) {
            console.error(`❌ [REST] getTicker(${s}) fallback failed:`, restError);
            ticker = { symbol: s, last: 0, bid: 0, ask: 0, percentage: 0, baseVolume: 0, quoteVolume: 0 } as any;
          }
        }
      } catch (error) {
        console.warn(`⚠️ [WebSocket] getTicker error for ${s} - attempting REST fallback`, error);
        try {
          const fallback = await scheduleBinanceRestFallback(s, () => ex.fetchTicker(s), {
            reason: 'ws_error',
          });
          if (!fallback) {
            console.warn(`🚫 [REST] getTicker(${s}) fallback suppressed after WS error`);
            if (cached?.data) {
              setFallbackState(s, true, 'rest_throttled', { increment: false });
              return cached.data;
            }
            setFallbackState(s, true, 'rest_throttled', { increment: false });
            throw new Error(`rest_fallback_throttled_${s}`);
          }
          ticker = fallback;
          recordRestFallback(s, 'ws_error');
          console.log(`✅ [REST] getTicker(${s}) fallback used after WS error`);
        } catch (restError) {
          console.error(`❌ [REST] getTicker(${s}) fallback failed after WS error:`, restError);
          ticker = { symbol: s, last: 0, bid: 0, ask: 0, percentage: 0, baseVolume: 0, quoteVolume: 0 } as any;
        }
      }
    } else {
      ticker = await ex.fetchTicker(s);
    }
    
    if (ticker) {
      const bidFromInfo = pickFirstNumber(ticker.bid, ticker.info?.bid, ticker.info?.bestBid, ticker.info?.bidPrice, ticker.info?.bestBidPrice);
      const askFromInfo = pickFirstNumber(ticker.ask, ticker.info?.ask, ticker.info?.bestAsk, ticker.info?.askPrice, ticker.info?.bestAskPrice);
      const lastFromInfo = pickFirstNumber(ticker.last, ticker.close, ticker.info?.last, ticker.info?.lastPrice);
      if (bidFromInfo !== undefined) ticker.bid = bidFromInfo;
      if (askFromInfo !== undefined) ticker.ask = askFromInfo;
      if (lastFromInfo !== undefined) ticker.last = lastFromInfo;
      if ((toNumber(ticker.bid) === undefined || ticker.bid === 0) || (toNumber(ticker.ask) === undefined || ticker.ask === 0)) {
        await populateBidAskFromOrderBook(ex, s, ticker);
      }
      ticker.bid = toNumber(ticker.bid) ?? 0;
      ticker.ask = toNumber(ticker.ask) ?? 0;
      ticker.last = toNumber(ticker.last) ?? 0;
      ticker.baseVolume = toNumber(ticker.baseVolume) ?? pickFirstNumber(ticker.info?.baseVolume, ticker.info?.volume) ?? 0;
      ticker.quoteVolume = toNumber(ticker.quoteVolume) ?? pickFirstNumber(ticker.info?.quoteVolume) ?? 0;
      ticker.high = toNumber(ticker.high) ?? pickFirstNumber(ticker.info?.high, ticker.info?.highPrice) ?? ticker.high;
      ticker.low = toNumber(ticker.low) ?? pickFirstNumber(ticker.info?.low, ticker.info?.lowPrice) ?? ticker.low;
      ticker.open = toNumber(ticker.open) ?? pickFirstNumber(ticker.info?.open, ticker.info?.openPrice) ?? ticker.open;
      ticker.percentage = toNumber(ticker.percentage) ?? pickFirstNumber(ticker.info?.percentage, ticker.info?.priceChangePercent) ?? ticker.percentage;

      const validation = evaluateTickerFrame({
        symbol: s,
        frame: ticker,
        source: 'REST',
        receivedAt: now,
        expectedSymbolId: toBinanceSymbolId(s),
      });

      recordMarketFrame({
        symbol: s,
        displaySymbol: s,
        source: 'REST',
        status: validation.status,
        ruleId: validation.ruleId,
        receivedTs: now,
        eventTs: validation.timestamp,
        dataAgeMs: validation.dataAgeMs,
        expectedSymbolId: validation.expectedSymbolId,
        rawFrame: ticker,
      });

      if (validation.status !== 'accepted') {
        if (cached?.data) {
          const cachedValidation = evaluateTickerFrame({
            symbol: symbol,
            frame: cached.data,
            source: 'REST',
            receivedAt: now,
            expectedSymbolId: toBinanceSymbolId(symbol),
          });
          if (cachedValidation.status === 'accepted') {
            console.warn(`⚠️ Returning cached ticker for ${symbol} due to invalid REST frame (${validation.ruleId})`);
            return cached.data;
          }
        }
        throw new Error(`invalid_ticker_${symbol}_${validation.ruleId || 'unknown'}`);
      }
    }

    // Cache the result
    tickerCache.set(cacheKey, { data: ticker, timestamp: now });
    
    // Clean old cache entries periodically
    if (tickerCache.size > 20) {
      for (const [key, entry] of tickerCache.entries()) {
        if ((now - entry.timestamp) > TICKER_CACHE_TTL * 2) {
          tickerCache.delete(key);
        }
      }
    }
    
    return ticker;
  } catch (error) {
    // If we have stale cached data, return it as fallback
    if (cached) {
      console.warn(`getTicker(${symbol}) failed, using stale cache:`, error);
      return cached.data;
    }
    throw error;
  }
}

export type GetOhlcvOptions = {
  preferWebSocket?: boolean;
  allowSyntheticFallback?: boolean;
};

export async function getOHLCV(
  symbol: string,
  tf = '1h',
  limit = 300,
  userId?: string,
  options?: GetOhlcvOptions,
) {
  if (ohlcvOverride) {
    return ohlcvOverride(symbol, tf, limit, userId, options);
  }
  if (UNIT_TEST_MODE) {
    const now = Date.now();
    const out: number[][] = [];
    let price = 100;
    for (let i = limit; i > 0; i--) {
      const ts = now - i * 60 * 60 * 1000; // 1h bars
      const open = price;
      const high = open * (1 + 0.001);
      const low = open * (1 - 0.001);
      const close = open * (1 + (Math.random()-0.5) * 0.001);
      const vol = 100;
      out.push([ts, open, high, low, close, vol]);
      price = close;
    }
    return out;
  }
  const normalizedLimit = Math.max(1, limit);
  const cfg = getConfig();
  const { credentials: userCredentials } = await fetchUserCredentialsSafe(userId);
  const exchangeHint = userCredentials?.exchange || cfg.EXCHANGE_ID;
  const preferWs = options?.preferWebSocket ?? true;
  const preferBinanceWs = preferWs && isBinanceExchange(exchangeHint);
  const seedKey = binanceSeedKey(symbol, tf);
  const warmKey = warmupStateKey(symbol, tf);
  let seededViaRest: number[][] | null = null;
  let fallbackActivated = false;
  let fallbackReason: string | undefined;

  const activateFallback = (reason: string, increment = false) => {
    fallbackReason = reason;
    const syntheticReason = reason.startsWith('synthetic_');
    const shouldRecord = !syntheticReason;
    if (!fallbackActivated) {
      fallbackActivated = true;
      setFallbackState(symbol, true, reason, { increment: shouldRecord });
      if (shouldRecord) {
        recordRestFallback(symbol, reason);
      }
    } else {
      setFallbackState(symbol, true, reason, { increment: shouldRecord && increment });
      if (shouldRecord && increment) {
        recordRestFallback(symbol, reason);
      }
    }
  };

  let wsData: number[][] | null = null;
  const normalizedTf = tf.trim().toLowerCase();
  let allowSyntheticFallback = options?.allowSyntheticFallback ?? true;
  if (
    (cfg as any)?.INTRADAY_DISALLOW_SYNTHETIC === true &&
    ['1m', '5m', '15m'].includes(normalizedTf)
  ) {
    allowSyntheticFallback = false;
  }

  if (preferBinanceWs && shouldUseWebsocketForTimeframe(tf)) {
    try {
      const ws = getBinanceWebSocket();
      const subscription = ws.subscribeToKline(symbol, tf);

      if (!subscription.ok) {
        const reasonText =
          subscription.reason === 'invalid_symbol_format'
            ? 'invalid symbol format'
            : subscription.reason === 'unknown_symbol'
              ? 'symbol not listed in Binance exchangeInfo'
              : 'symbol previously rejected by Binance';
        const rejectionError: any = new Error(
          `Binance WebSocket rejected ${symbol} ${tf} subscription: ${reasonText}`,
        );
        rejectionError.code = 'BINANCE_WS_SUBSCRIPTION_REJECTED';
        rejectionError.reason = subscription.reason;
        throw rejectionError;
      }

      wsData = getKlinesOhlcvFromWebSocket(symbol, tf);

      if ((!wsData || wsData.length < normalizedLimit) && !binanceKlineSeeded.has(seedKey)) {
        let seedPromise = binanceKlineSeedPromises.get(seedKey);
        if (!seedPromise) {
          const attempts = getWarmupState(warmKey).attempts + 1;
          seedPromise = (async () => {
            setWarmupState(warmKey, {
              attempts,
              pending: true,
              lastAttempt: Date.now(),
              fulfilled: false,
            });
            try {
              const backfillLimit = computeBackfillLimit(
                tf,
                normalizedLimit,
                Math.max(1, cfg.DIAGNOSTICS_BACKFILL_DAYS || 1),
              );
              
              // Skip REST backfill if IP is currently banned
              if (isBinanceRestIpBanned()) {
                console.warn(`🚫 Binance REST backfill blocked due to IP ban for ${symbol} ${tf}, retry in 10 minutes`);
                throw Object.assign(
                  new Error('binance_rest_ip_banned_skip_backfill'),
                  { skipBackfill: true }
                );
              }
              
              // Queue REST backfill to prevent multiple simultaneous requests causing IP ban
              const rest = await queueRestBackfill(async () => {
                console.log(`📥 Backfilling ${symbol} ${tf} (queued, limit: ${backfillLimit})`);
                return await fetchOhlcvRest(symbol, tf, backfillLimit, userId, userCredentials);
              });
              if (rest && rest.length) {
                seedKlinesFromWebSocket(symbol, tf, rest);
                binanceKlineSeeded.add(seedKey);
                const retryTimer = backfillRetryTimers.get(warmKey);
                if (retryTimer) {
                  clearTimeout(retryTimer);
                  backfillRetryTimers.delete(warmKey);
                }
                setWarmupState(warmKey, {
                  pending: false,
                  fulfilled: true,
                  lastError: undefined,
                  nextRetryTs: undefined,
                  lastSuccess: Date.now(),
                  syntheticCount: 0,
                  lastSyntheticAt: undefined,
                });
                return rest;
              }
              throw new Error('rest_backfill_empty');
            } catch (error) {
              const errorMsg = String((error as any)?.message || error);
              
              // If IP is banned, use much longer retry delay
              const isBanned = errorMsg.includes('binance_rest_ip_banned') || 
                               errorMsg.includes('banned until') ||
                               (error as any)?.bannedUntil;
              
              const retryDelay = isBanned 
                ? 10 * 60 * 1000 // 10 minutes for IP ban
                : computeRetryDelayMs(attempts);
              
              if (isBanned) {
                console.warn(`🚫 Binance REST backfill blocked due to IP ban for ${symbol} ${tf}, retry in ${Math.ceil(retryDelay/1000/60)} minutes`);
              }
              
              scheduleWarmupRetry(warmKey, seedKey, retryDelay);
              setWarmupState(warmKey, {
                pending: false,
                lastError: errorMsg,
                nextRetryTs: Date.now() + retryDelay,
                fulfilled: false,
              });
              throw error;
            } finally {
              binanceKlineSeedPromises.delete(seedKey);
            }
          })();
          binanceKlineSeedPromises.set(seedKey, seedPromise);
        }
        try {
          seededViaRest = await seedPromise;
        } catch (error) {
          console.warn(`Binance REST backfill failed for ${symbol} ${tf}:`, error);
        }
        if ((!wsData || wsData.length < normalizedLimit) && seededViaRest && seededViaRest.length) {
          wsData = seededViaRest;
        }
      } else if (!wsData || wsData.length < normalizedLimit) {
        setWarmupState(warmKey, {
          pending: true,
          lastAttempt: Date.now(),
          attempts: getWarmupState(warmKey).attempts,
        });
      }

      if ((!wsData || wsData.length < normalizedLimit)) {
        const aggregated = buildAggregatedSeriesFromFifteenMinuteWs(symbol, tf, normalizedLimit);
        if (aggregated && aggregated.length) {
          wsData = aggregated;
          seededViaRest = null;
        }
      }

      if (wsData && wsData.length) {
        const merged = seededViaRest && seededViaRest.length ? [...wsData, ...seededViaRest] : wsData;
        const prepared = prepareOhlcvSeries(merged, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
        if (prepared.series.length) {
          maybeLogOhlcvDebug(symbol, tf, prepared.series);
          if (!prepared.synthetic && prepared.series.length >= normalizedLimit) {
            setWarmupState(warmKey, {
              pending: false,
              fulfilled: true,
              lastError: undefined,
              nextRetryTs: undefined,
              lastSuccess: Date.now(),
              syntheticCount: 0,
              lastSyntheticAt: undefined,
            });
          }
          if (!prepared.synthetic) {
            setFallbackState(symbol, false);
            return prepared.series;
          }
          setWarmupState(warmKey, {
            syntheticCount: (getWarmupState(warmKey).syntheticCount ?? 0) + 1,
            lastSyntheticAt: Date.now(),
          });
          activateFallback('ws_synthetic_series');
        }
      }
    } catch (error) {
      if ((error as any)?.code === 'BINANCE_WS_SUBSCRIPTION_REJECTED') {
        throw error;
      }
      console.warn(`Binance WebSocket OHLCV fallback for ${symbol} ${tf}:`, error);
      setWarmupState(warmKey, {
        pending: false,
        lastError: String((error as any)?.message || error),
      });
    }
  }
  // Final fallback for Binance: synthesize stable OHLCV using last known ticker
  let syntheticPrepared: PreparedOhlcvSeries | null = null;
  if (preferBinanceWs && allowSyntheticFallback) {
    try {
      // Use ticker from WS (may be null); fallback to 0
      const { getTickerFromWebSocket } = await import('../services/binanceWebSocket.js');
      const wsTicker = await getTickerFromWebSocket(symbol);
      const last = Number(wsTicker?.last || 0);
      
      // 🛡️ SAFETY: Don't generate synthetic data with zero price
      // This prevents "ATR: 49%" spikes caused by 0-price candles
      if (last > 0) {
        const now = Date.now();
        const intervalMs = timeframeToMs(tf) || 900_000;
        const out: number[][] = [];
        for (let i = normalizedLimit; i > 0; i--) {
          const ts = now - i * intervalMs;
          out.push([ts, last, last, last, last, 0]);
        }
        syntheticPrepared = prepareOhlcvSeries(out, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
        if (syntheticPrepared.series.length) {
          maybeLogOhlcvDebug(symbol, tf, syntheticPrepared.series);
        }
      } else {
        // If we can't get a valid price, we can't synthesize data
        // Better to throw warmup_pending than return corrupt 0-price data
        if (wsTicker) {
           console.warn(`[getOHLCV] Cannot generate synthetic data for ${symbol}: invalid price ${last}`);
        }
      }
    } catch {}
  }
  // Non-Binance exchanges or forced REST path: safe to use REST
  // Prefer Binance WS, but allow controlled REST fallback when WS feed stays synthetic
  if (preferBinanceWs) {
    const warmState = getWarmupState(warmKey);
    const now = Date.now();
    const syntheticCount = warmState.syntheticCount ?? 0;
    const lastSyntheticAt = warmState.lastSyntheticAt ?? 0;
    const allowWsRestBridge = String((cfg as any)?.BINANCE_WS_ALLOW_REST_BRIDGE ?? '').toLowerCase() === 'true';
    const configuredAttempts = Number((cfg as any)?.BINANCE_SYNTHETIC_REST_THRESHOLD);
    // FIX: Increase threshold to 2 to avoid twitchy fallbacks, but keep it low enough to be responsive
    const maxSyntheticAttempts = Number.isFinite(configuredAttempts) && configuredAttempts >= 0
      ? configuredAttempts
      : 2;
    const configuredCooldown = Number((cfg as any)?.BINANCE_SYNTHETIC_REST_COOLDOWN_MS);
    const syntheticRestCooldownMs = Number.isFinite(configuredCooldown) && configuredCooldown >= 0
      ? configuredCooldown
      : 45_000;
    const hasSyntheticSeries = Boolean(syntheticPrepared?.series?.length);
    const isSyntheticSeries = Boolean(syntheticPrepared?.synthetic);
    const wsInsufficient = !wsData || wsData.length < normalizedLimit;
    
    // If we failed to generate synthetic data (e.g. price=0), we treat it as "stuck" and force REST
    const syntheticGenerationFailed = preferBinanceWs && allowSyntheticFallback && !hasSyntheticSeries && wsInsufficient;

    const restDueToPolicy = !allowSyntheticFallback && (wsInsufficient || !hasSyntheticSeries);
    const syntheticStuck = wsInsufficient || !hasSyntheticSeries || isSyntheticSeries;
    const syntheticCooldownReached =
      syntheticCount > 0 && syntheticRestCooldownMs > 0 && now - lastSyntheticAt >= syntheticRestCooldownMs;

    const shouldForceRest = allowWsRestBridge && (
      restDueToPolicy ||
      syntheticGenerationFailed || // Force REST if we can't even make synthetic data
      (syntheticStuck && (syntheticCount >= maxSyntheticAttempts || syntheticCooldownReached))
    );

    if (shouldForceRest) {
      const restReason = restDueToPolicy
        ? 'no_synthetic_allowed'
        : `synthetic_frames=${syntheticCount}`;
      console.warn(`[getOHLCV] Forcing REST warmup for ${symbol} ${tf} (${restReason})`);
      const forcedRest = await scheduleBinanceRestFallback(
        symbol,
        () => fetchOhlcvRest(symbol, tf, normalizedLimit, userId, userCredentials),
        {
          reason: 'ws_synthetic_warmup',
          // 🛡️ SAFETY: Only force if strictly required by policy.
          // For normal "stuck" warmup or failed synthesis, we MUST respect the global rate limiter
          // to avoid IP bans when multiple agents fail simultaneously.
          force: restDueToPolicy,
          weight: 0, // fetchBinanceOhlcv records its own weight internally
        },
      );
      if (!forcedRest) {
        console.warn(`[getOHLCV] REST warmup request suppressed for ${symbol} ${tf}`);
      } else {
        console.warn(`[getOHLCV] REST warmup fetched ${forcedRest.length} rows for ${symbol} ${tf}`);
      }
      if (forcedRest && forcedRest.length) {
        const preparedRest = prepareOhlcvSeries(forcedRest, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
        console.warn(`[getOHLCV] REST warmup prepared synthetic=${preparedRest.synthetic} len=${preparedRest.series.length} for ${symbol} ${tf}`);
        if (preparedRest.series.length) {
          maybeLogOhlcvDebug(symbol, tf, preparedRest.series);
          if (!preparedRest.synthetic) {
            setFallbackState(symbol, false);
            setWarmupState(warmKey, {
              pending: false,
              fulfilled: true,
              lastError: undefined,
              nextRetryTs: undefined,
              lastSuccess: Date.now(),
              syntheticCount: 0,
              lastSyntheticAt: undefined,
            });
            return preparedRest.series;
          }
          syntheticPrepared = preparedRest;
        }
      }
    } else if (syntheticStuck && (syntheticCount >= maxSyntheticAttempts || syntheticCooldownReached)) {
      const retryDelay = computeRetryDelayMs(Math.min(syntheticCount + 1, 6));
      console.warn(`[getOHLCV] Binance WS still synthetic for ${symbol} ${tf} after ${syntheticCount} frame(s); waiting ${Math.round(retryDelay / 1000)}s for live data`);
      scheduleWarmupRetry(warmKey, seedKey, retryDelay);
      setWarmupState(warmKey, {
        pending: false,
        lastError: 'ws_synthetic_pending',
        nextRetryTs: Date.now() + retryDelay,
        fulfilled: false,
      });
    }

    if (syntheticPrepared && syntheticPrepared.series.length && allowSyntheticFallback) {
      console.log(`[getOHLCV] Using synthetic data for ${symbol} ${tf} to avoid REST IP ban`);
      activateFallback('synthetic_warmup_avoid_ban', false);
      setWarmupState(warmKey, {
        pending: false,
        fulfilled: false,
        lastError: 'synthetic_warmup_avoid_ban',
        syntheticCount: (warmState.syntheticCount ?? 0) + 1,
        lastSyntheticAt: now,
      });
      return syntheticPrepared.series;
    }

    console.warn(`[getOHLCV] No data available for ${symbol} ${tf}, waiting for WebSocket warmup`);
    throw new Error(`websocket_warmup_pending: ${symbol} ${tf}`);
  }
  
  // Non-Binance exchanges can safely use REST
  try {
    const restData = await fetchOhlcvRest(symbol, tf, normalizedLimit, userId, userCredentials);
    const preparedRest = prepareOhlcvSeries(restData, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
    if (preparedRest.series.length) {
      maybeLogOhlcvDebug(symbol, tf, preparedRest.series);
    }
    if (!preparedRest.synthetic && fallbackActivated) {
      setFallbackState(symbol, false);
    }
    return preparedRest.series;
  } catch (error) {
    if (syntheticPrepared && syntheticPrepared.series.length && allowSyntheticFallback) {
      activateFallback('synthetic_warmup', false);
      setWarmupState(warmKey, {
        pending: false,
        fulfilled: false,
        lastError: 'synthetic_warmup',
      });
      return syntheticPrepared.series;
    }
    throw error;
  }
}

export async function computeCoreIndicators(symbol: string) {
  const o = await getOHLCV(symbol, '1h', 200);
  const c = o.map((r: any) => r[4]);
  return {
    ema20: ema(c, 20).at(-1),
    ema50: ema(c, 50).at(-1),
    rsi14: rsi(c, 14).at(-1),
    atr14: atr(o, 14).at(-1),
  };
}

export function __test_resetSyntheticWarningThrottle(): void {
  syntheticWarnedAt.clear();
}

export { prepareOhlcvSeries as __test_prepareOhlcvSeries };
