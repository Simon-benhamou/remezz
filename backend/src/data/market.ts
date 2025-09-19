import { exchange, resolveSymbol } from '../exchange/ccxtClient.js';
import { ema, rsi, atr } from './indicators.js';

// Simple cache to reduce API calls
const tickerCache = new Map<string, { data: any; timestamp: number }>();
const TICKER_CACHE_TTL = 10000; // 10 seconds cache

export async function getTicker(symbol: string) {
  const cacheKey = symbol;
  const cached = tickerCache.get(cacheKey);
  const now = Date.now();
  
  // Return cached data if still fresh
  if (cached && (now - cached.timestamp) < TICKER_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const ex = await exchange();
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
  const ex = await exchange();
  const s = await resolveSymbol(symbol);
  return ex.fetchOHLCV(s, tf, undefined, limit);
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