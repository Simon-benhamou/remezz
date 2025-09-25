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

const exchangeCache = new Map<string, any>();
let cachedSpreads: { expires: number; data: ArbitrageSpread[] } | null = null;

async function getExchange(id: string) {
  if (exchangeCache.has(id)) return exchangeCache.get(id);
  const ExchangeClass = (ccxt as any)[id];
  if (!ExchangeClass) throw new Error(`Exchange ${id} not supported by ccxt`);
  const instance = new ExchangeClass({ enableRateLimit: true });
  await instance.loadMarkets();
  exchangeCache.set(id, instance);
  return instance;
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
      } catch (error) {
        console.warn(`Arbitrage fetch failed for ${exchangeId} ${symbol}:`, error);
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
