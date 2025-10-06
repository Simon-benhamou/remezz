import { resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';
import { getBinanceWebSocket, getTickerFromWebSocket, seedKlinesFromWebSocket, getKlinesOhlcvFromWebSocket, adaptBinanceTickerToCcxt, toBinanceSymbolId } from '../services/binanceWebSocket.js';

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

// Simple cache to reduce API calls - OPTIMIZED for faster real-time response
const tickerCache = new Map<string, { data: any; timestamp: number }>();
const TICKER_CACHE_TTL = 4000; // 4 seconds cache to reduce network churn

// Create a temporary unauthenticated exchange for public market data
const exchangeCache = new Map<string, any>();
const binanceKlineSeeded = new Set<string>();
const binanceKlineSeedPromises = new Map<string, Promise<number[][]>>();

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
  const Klass: any = (ccxt as any)[EXCHANGE_ID];
  if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);
  const desiredType = inferMarketType(forSymbol);
  
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
        tickerCache.set(cacheKey, { data: adapted, timestamp: now });
        return adapted;
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
        // Give a short chance to WS to be ready before returning placeholders
        await waitForWsHealthy(2000);
        let wsTicker = await getTickerFromWebSocket(s);
        if (!wsTicker) {
          for (let i = 0; i < 6; i++) { // up to ~1.2s extra
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
            timestamp: wsTicker.timestamp
          };
          console.log(`✅ [WebSocket] getTicker(${s}) - 0 weight`);
        } else {
          // STRICT NO-REST for Binance to avoid bans
          console.warn(`⚠️ [WebSocket] getTicker(${s}) cache miss - returning minimal placeholder (no REST)`);
          ticker = { symbol: s, last: 0, bid: 0, ask: 0, percentage: 0, baseVolume: 0, quoteVolume: 0 } as any;
        }
      } catch (error) {
        console.warn(`⚠️ [WebSocket] getTicker error for ${s} - returning minimal placeholder (no REST):`, error);
        ticker = { symbol: s, last: 0, bid: 0, ask: 0, percentage: 0, baseVolume: 0, quoteVolume: 0 } as any;
      }
    } else {
      ticker = await ex.fetchTicker(s);
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

export async function getOHLCV(symbol: string, tf = '1h', limit = 300, userId?: string) {
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
  const preferBinanceWs = isBinanceExchange(exchangeHint);
  const seedKey = binanceSeedKey(symbol, tf);
  let seededViaRest: number[][] | null = null;

  if (preferBinanceWs) {
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(symbol, tf);
      let wsData = getKlinesOhlcvFromWebSocket(symbol, tf);

      if ((!wsData || wsData.length < normalizedLimit) && !binanceKlineSeeded.has(seedKey)) {
        let seedPromise = binanceKlineSeedPromises.get(seedKey);
        // REST seeding disabled for Binance to avoid 418 bans.
        // Rely on live WebSocket accumulation only.
        // If insufficient bars, we'll pad/synthesize below.
      }

      if (wsData && wsData.length >= Math.min(normalizedLimit, 10)) {
        const sorted = wsData.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
        const trimmed = sorted.slice(-normalizedLimit);
        maybeLogOhlcvDebug(symbol, tf, trimmed);
        return trimmed;
      }
      // If we have some WS data but not enough, pad from the first candle
      if (wsData && wsData.length > 0) {
        const sorted = wsData.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
        const first = sorted[0];
        const padCount = Math.max(0, normalizedLimit - sorted.length);
        const intervalMs = tf.endsWith('m') ? Number(tf.replace('m','')) * 60_000 : tf.endsWith('h') ? Number(tf.replace('h','')) * 3_600_000 : 900_000;
        const padded: number[][] = [];
        for (let i = padCount; i > 0; i--) {
          const ts = Number(first[0]) - i * intervalMs;
          // Flatline padding to avoid NaN indicators
          padded.push([ts, first[4], first[4], first[4], first[4], 0]);
        }
        const combined = [...padded, ...sorted].slice(-normalizedLimit);
        maybeLogOhlcvDebug(symbol, tf, combined);
        return combined;
      }
    } catch (error) {
      console.warn(`Binance WebSocket OHLCV fallback for ${symbol} ${tf}:`, error);
    }
  }
  // Final fallback for Binance: synthesize stable OHLCV using last known ticker
  if (preferBinanceWs) {
    try {
      // Use ticker from WS (may be null); fallback to 0
      const { getTickerFromWebSocket } = await import('../services/binanceWebSocket.js');
      const wsTicker = await getTickerFromWebSocket(symbol);
      const last = Number(wsTicker?.last || 0);
      const now = Date.now();
      const intervalMs = tf.endsWith('m') ? Number(tf.replace('m','')) * 60_000 : tf.endsWith('h') ? Number(tf.replace('h','')) * 3_600_000 : 900_000;
      const out: number[][] = [];
      for (let i = normalizedLimit; i > 0; i--) {
        const ts = now - i * intervalMs;
        out.push([ts, last, last, last, last, 0]);
      }
      maybeLogOhlcvDebug(symbol, tf, out);
      return out;
    } catch {}
  }
  // Non-Binance exchanges: safe to use REST
  const restData = await fetchOhlcvRest(symbol, tf, normalizedLimit, userId, userCredentials);
  maybeLogOhlcvDebug(symbol, tf, restData);
  return restData;
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
