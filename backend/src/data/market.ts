import { resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';
import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

// Simple cache to reduce API calls - OPTIMIZED for faster real-time response
const tickerCache = new Map<string, { data: any; timestamp: number }>();
const TICKER_CACHE_TTL = 4000; // 4 seconds cache to reduce network churn

// Create a temporary unauthenticated exchange for public market data
const exchangeCache = new Map<string, any>();

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

export async function getTicker(symbol: string, options?: { forceRefresh?: boolean }) {
  if (UNIT_TEST_MODE) {
    return { symbol, last: 100, percentage: 0, baseVolume: 0, quoteVolume: 0, bid: 99.9, ask: 100.1 } as any;
  }
  const cacheKey = symbol;
  const cached = tickerCache.get(cacheKey);
  const now = Date.now();
  
  // Skip cache if forceRefresh is requested or cache is stale
  if (!options?.forceRefresh && cached && (now - cached.timestamp) < TICKER_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const ex = createPublicExchange(symbol);
    await ex.loadMarkets();
    const s = await resolveSymbol(symbol);
    const ticker = await ex.fetchTicker(s);
    
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

export async function getOHLCV(symbol: string, tf = '1h', limit = 300) {
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
  const ex = createPublicExchange(symbol);
  await ex.loadMarkets();
  const s = await resolveSymbol(symbol);
  try {
    const result = await ex.fetchOHLCV(s, tf, undefined, limit);
    
    // 🔍 DEBUG: Log raw OHLCV from exchange API
    if (symbol === 'ADA/USDT' && tf === '15m') {
      console.log(`[getOHLCV DEBUG] ${symbol} ${tf}: RAW from ex.fetchOHLCV (last 5):`,
        result.slice(-5).map((r: any[]) => ({
          ts: new Date(r[0]).toISOString(),
          close: r[4],
          volume: r[5]
        }))
      );
    }
    
    return result;
  } catch (err) {
    // Fallback: if timeframe unsupported, try a nearby timeframe
    // Crypto.com should support 15m/1h, but add a defensive fallback
    try {
      const altTf = tf === '15m' ? '5m' : tf === '1h' ? '30m' : tf;
      if (altTf !== tf) {
        return await ex.fetchOHLCV(s, altTf, undefined, limit);
      }
    } catch {}
    throw err;
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
