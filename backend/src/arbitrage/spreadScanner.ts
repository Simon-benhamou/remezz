import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

export type ArbitrageSpread = {
  symbol: string;
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  spreadBps: number;
  spreadPct: number;
  estNotional?: number;
  timestamp: string;
};

const exchangeCache = new Map<string, { instance: any; loadedAt: number; marketsLoaded: boolean; rateLimitedUntil?: number }>();
let cachedSpreads: { expires: number; data: ArbitrageSpread[] } | null = null;

async function getExchange(id: string) {
  const cached = exchangeCache.get(id);
  const now = Date.now();

  // Check if exchange is rate limited
  if (cached?.rateLimitedUntil && now < cached.rateLimitedUntil) {
    throw new Error(`${id} is rate limited until ${new Date(cached.rateLimitedUntil).toISOString()}`);
  }

  // Return cached instance if markets are already loaded and not too old (24h)
  if (cached && cached.marketsLoaded && (now - cached.loadedAt) < 24 * 60 * 60 * 1000) {
    return cached.instance;
  }

  const ExchangeClass = (ccxt as any)[id];
  if (!ExchangeClass) throw new Error(`Exchange ${id} not supported by ccxt`);

  const instance = new ExchangeClass({ enableRateLimit: true });

  // Only load markets if not already loaded or cache expired
  if (!cached || !cached.marketsLoaded || (now - cached.loadedAt) > 24 * 60 * 60 * 1000) {
    console.log(`🔄 Loading markets for ${id}...`);
    await instance.loadMarkets();
    exchangeCache.set(id, { instance, loadedAt: now, marketsLoaded: true });
  } else {
    // Reuse existing instance
    exchangeCache.set(id, { ...cached, loadedAt: now });
  }

  return instance;
}

// Preload exchanges to avoid repeated loadMarkets calls
export async function preloadArbitrageExchanges() {
  const cfg = getConfig();
  if (!cfg.ARBITRAGE_ENABLED) return;

  const exchanges = cfg.ARBITRAGE_EXCHANGES;
  console.log(`🔄 Preloading ${exchanges.length} arbitrage exchanges...`);

  for (const exchangeId of exchanges) {
    try {
      await getExchange(exchangeId);
      console.log(`✅ Preloaded ${exchangeId}`);
    } catch (error) {
      console.warn(`❌ Failed to preload ${exchangeId}:`, error);
    }
  }
}

function calcSpread(buy: any, sell: any) {
  const ask = Number(buy?.ask ?? NaN);
  const bid = Number(sell?.bid ?? NaN);
  if (!isFinite(ask) || !isFinite(bid) || ask <= 0 || bid <= 0) return null;
  const mid = (ask + bid) / 2;
  if (!isFinite(mid) || mid <= 0) return null;
  const spread = bid - ask;
  const spreadPct = (spread / mid) * 100;
  const spreadBps = spreadPct * 100;
  return { ask, bid, spreadPct, spreadBps };
}

export async function getArbitrageSpreads(options?: { forceRefresh?: boolean }): Promise<ArbitrageSpread[]> {
  const cfg = getConfig();
  if (!cfg.ARBITRAGE_ENABLED) return [];

  const now = Date.now();
  if (!options?.forceRefresh && cachedSpreads && cachedSpreads.expires > now) {
    return cachedSpreads.data;
  }

  const exchanges = cfg.ARBITRAGE_EXCHANGES;
  if (!exchanges.length) return [];
  const symbols = cfg.ARBITRAGE_SYMBOLS;
  if (!symbols.length) return [];

  const results: ArbitrageSpread[] = [];

  for (const symbol of symbols) {
    const tickers: { exchange: string; ticker: any }[] = [];

    for (const exchangeId of exchanges) {
      try {
        const exchange = await getExchange(exchangeId);
        if (!exchange.markets?.[symbol]) continue;
        const ticker = await exchange.fetchTicker(symbol);
        tickers.push({ exchange: exchangeId, ticker });
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        console.warn(`Arbitrage fetch failed for ${exchangeId} ${symbol}:`, errorMessage);

        // Handle rate limiting (418 = DDoS protection, 429 = too many requests)
        if (errorMessage.includes('418') || errorMessage.includes('429') || errorMessage.includes('rate limited')) {
          const banDuration = errorMessage.includes('1759307635076') ? 24 * 60 * 60 * 1000 : 15 * 60 * 1000; // 24h for long ban, 15min for others
          const cached = exchangeCache.get(exchangeId);
          if (cached) {
            cached.rateLimitedUntil = Date.now() + banDuration;
            exchangeCache.set(exchangeId, cached);
            console.warn(`🚫 ${exchangeId} rate limited until ${new Date(cached.rateLimitedUntil).toISOString()}`);
          }
        }
      }
    }

    if (tickers.length < 2) continue;

    for (let i = 0; i < tickers.length; i++) {
      for (let j = 0; j < tickers.length; j++) {
        if (i === j) continue;
        const buy = tickers[i];
        const sell = tickers[j];
        const spread = calcSpread(buy.ticker, sell.ticker);
        if (!spread) continue;
        if (spread.spreadBps < cfg.ARBITRAGE_MIN_SPREAD_BPS) continue;
        const quoteVol = Number(sell.ticker?.quoteVolume ?? 0);
        const estNotional = isFinite(quoteVol) && quoteVol > 0 ? Number((quoteVol / 24).toFixed(2)) : undefined;

        results.push({
          symbol,
          buyExchange: buy.exchange,
          sellExchange: sell.exchange,
          buyPrice: Number(spread.ask.toFixed(6)),
          sellPrice: Number(spread.bid.toFixed(6)),
          spreadBps: Number(spread.spreadBps.toFixed(2)),
          spreadPct: Number(spread.spreadPct.toFixed(4)),
          estNotional,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  results.sort((a, b) => b.spreadBps - a.spreadBps);
  const limited = results.slice(0, Math.max(1, cfg.ARBITRAGE_MAX_RESULTS));
  cachedSpreads = {
    data: limited,
    expires: now + Math.max(10, cfg.ARBITRAGE_CACHE_TTL_SEC) * 1000,
  };
  return limited;
}

export function clearArbitrageCache() {
  cachedSpreads = null;
}

export function clearExchangeCache() {
  exchangeCache.clear();
}

export function getExchangeStatus() {
  const now = Date.now();
  const status: Record<string, { available: boolean; rateLimitedUntil?: number; loadedAt?: number }> = {};

  for (const [id, cached] of exchangeCache.entries()) {
    status[id] = {
      available: !cached.rateLimitedUntil || now >= cached.rateLimitedUntil,
      rateLimitedUntil: cached.rateLimitedUntil,
      loadedAt: cached.loadedAt,
    };
  }

  return status;
}
