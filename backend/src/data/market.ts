import { resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';
import { getBinanceWebSocket, getTickerFromWebSocket, seedKlinesFromWebSocket, getKlinesOhlcvFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId } from '../services/binanceWebSocket.js';
import { fetchBinanceOhlcv } from '../services/binanceRest.js';
import { recordMarketFrame, recordRestFallback, setFallbackState } from '../monitor/marketMetrics.js';
import { evaluateTickerFrame } from './tickerValidation.js';

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

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
};

const ohlcvWarmupState = new Map<string, WarmupState>();
const backfillRetryTimers = new Map<string, NodeJS.Timeout>();

function warmupStateKey(symbol: string, tf: string): string {
  return `${symbol.toUpperCase()}__${tf}`;
}

function getWarmupState(key: string): WarmupState {
  return ohlcvWarmupState.get(key) || { attempts: 0, pending: false };
}

function setWarmupState(key: string, patch: Partial<WarmupState> & { attempts?: number }): WarmupState {
  const current = getWarmupState(key);
  const attempts = patch.attempts != null ? patch.attempts : current.attempts;
  const updated: WarmupState = {
    attempts,
    lastAttempt: current.lastAttempt,
    pending: current.pending,
    lastError: current.lastError,
    fulfilled: current.fulfilled,
    nextRetryTs: current.nextRetryTs,
    lastSuccess: current.lastSuccess,
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

function shouldUseWebsocketForTimeframe(tf: string): boolean {
  const normalized = tf.trim().toLowerCase();
  switch (normalized) {
    case '1m':
    case '3m':
    case '5m':
    case '15m':
      return true;
    default:
      return false;
  }
}

async function populateBidAskFromOrderBook(ex: any, symbol: string, ticker: any) {
  if (!ex || typeof ex.fetchOrderBook !== 'function') return;
  try {
    const book = await ex.fetchOrderBook(symbol, 5);
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
  let syntheticCount = 0;
  for (const row of tail) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    const flat = Number.isFinite(open) && open === high && high === low && low === close;
    const zeroVol = Number.isFinite(volume) && volume === 0;
    if (flat || zeroVol) {
      syntheticCount += 1;
    }
  }
  return syntheticCount / window >= 0.8;
}

function prepareOhlcvSeries(raw: number[][], tf: string, limit: number, allowPartial: boolean): number[][] {
  if (!Array.isArray(raw)) return [];
  const sorted = raw.slice().filter(Boolean).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!sorted.length) return [];
  const trimmed = dropPartialLastBar(sorted, tf, allowPartial);
  const clipped = trimmed.slice(-limit);
  if (isSyntheticSeries(clipped)) {
    try {
      console.warn(`synthetic_ohlcv_detected:${tf}`, {
        sample: clipped.slice(-3).map((row) => row?.[5]),
      });
    } catch {}
  }
  return clipped;
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
    return await ex.fetchOHLCV(resolvedSymbol, tf, undefined, limit);
  } catch (err) {
    try {
      const altTf = tf === '15m' ? '5m' : tf === '1h' ? '30m' : tf;
      if (altTf !== tf) {
        return await ex.fetchOHLCV(resolvedSymbol, altTf, undefined, limit);
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
            ticker = await ex.fetchTicker(s);
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
          ticker = await ex.fetchTicker(s);
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

  let wsData: number[][] | null = null;
  let subscribedToWs = false;
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
      subscribedToWs = ws.subscribeToKline(symbol, tf);
      wsData = getKlinesOhlcvFromWebSocket(symbol, tf);

      if (!subscribedToWs) {
        if (!wsData || wsData.length < normalizedLimit) {
          console.warn(`⚠️ Using REST fallback for ${symbol} ${tf} (WS kline limit reached).`);
        } else {
          const prepared = prepareOhlcvSeries(wsData, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
          if (prepared.length) {
            maybeLogOhlcvDebug(symbol, tf, prepared);
            if (prepared.length >= normalizedLimit) {
              setWarmupState(warmKey, {
                pending: false,
                fulfilled: true,
                lastError: undefined,
                nextRetryTs: undefined,
                lastSuccess: Date.now(),
              });
            }
            return prepared;
          }
        }
      } else {
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
                const backfillLimit = computeBackfillLimit(tf, normalizedLimit, Math.max(1, cfg.DIAGNOSTICS_BACKFILL_DAYS || 1));
                const rest = await fetchOhlcvRest(symbol, tf, backfillLimit, userId, userCredentials);
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
                  });
                  return rest;
                }
                throw new Error('rest_backfill_empty');
              } catch (error) {
                const retryDelay = computeRetryDelayMs(attempts);
                scheduleWarmupRetry(warmKey, seedKey, retryDelay);
                setWarmupState(warmKey, {
                  pending: false,
                  lastError: String((error as any)?.message || error),
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

        if (wsData && wsData.length) {
          const merged = seededViaRest && seededViaRest.length ? [...wsData, ...seededViaRest] : wsData;
          const prepared = prepareOhlcvSeries(merged, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
          if (prepared.length) {
            maybeLogOhlcvDebug(symbol, tf, prepared);
            if (prepared.length >= normalizedLimit) {
              setWarmupState(warmKey, {
                pending: false,
                fulfilled: true,
                lastError: undefined,
                nextRetryTs: undefined,
                lastSuccess: Date.now(),
              });
            }
            return prepared;
          }
        }
      }
    } catch (error) {
      console.warn(`Binance WebSocket OHLCV fallback for ${symbol} ${tf}:`, error);
      setWarmupState(warmKey, {
        pending: false,
        lastError: String((error as any)?.message || error),
      });
    }
  }
  // Final fallback for Binance: synthesize stable OHLCV using last known ticker
  let syntheticPrepared: number[][] | null = null;
  if (preferBinanceWs && allowSyntheticFallback) {
    try {
      // Use ticker from WS (may be null); fallback to 0
      const { getTickerFromWebSocket } = await import('../services/binanceWebSocket.js');
      const wsTicker = await getTickerFromWebSocket(symbol);
      const last = Number(wsTicker?.last || 0);
      const now = Date.now();
      const intervalMs = timeframeToMs(tf) || 900_000;
      const out: number[][] = [];
      for (let i = normalizedLimit; i > 0; i--) {
        const ts = now - i * intervalMs;
        out.push([ts, last, last, last, last, 0]);
      }
      syntheticPrepared = prepareOhlcvSeries(out, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
      maybeLogOhlcvDebug(symbol, tf, syntheticPrepared);
    } catch {}
  }
  // Non-Binance exchanges or forced REST path: safe to use REST
  try {
    const restData = await fetchOhlcvRest(symbol, tf, normalizedLimit, userId, userCredentials);
    const preparedRest = prepareOhlcvSeries(restData, tf, normalizedLimit, cfg.DIAGNOSTICS_ALLOW_PARTIAL_CANDLE);
    maybeLogOhlcvDebug(symbol, tf, preparedRest);
    return preparedRest;
  } catch (error) {
    if (syntheticPrepared && allowSyntheticFallback) {
      setWarmupState(warmKey, {
        pending: false,
        fulfilled: false,
        lastError: 'synthetic_warmup',
      });
      return syntheticPrepared;
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
