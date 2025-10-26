import ccxt from 'ccxt';
import { resolveSymbol, getUserExchange } from '../exchange/ccxtClient.js';
import { getConfig } from '../utils/env.js';

export interface BookLevel { price: number; size: number }
export interface DepthSnapshot { timestamp: number; bids: BookLevel[]; asks: BookLevel[] }

const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

const exchangeCache = new Map<string, any>();

function inferMarketType(symbol?: string): 'spot' | 'swap' {
  const s = (symbol || '').toUpperCase();
  if (!s) return ((process.env.MARKET_TYPE || 'spot').toLowerCase() as 'spot' | 'swap');
  if (s.includes(':USDT') || s.includes(':USD') || s.includes('-PERP') || /PERP$/.test(s)) {
    return 'swap';
  }
  return 'spot';
}

function mapExchangeId(exchangeId: string, type: 'spot' | 'swap'): string {
  if (exchangeId === 'binance' && type === 'swap') return 'binanceusdm';
  const map: Record<string, string> = {
    'crypto.com': 'cryptocom',
    binancecoinm: 'binancecoinm',
  };
  return map[exchangeId] || exchangeId;
}

async function fetchUserCredentialsSafe(userId?: string) {
  if (!userId) return { credentials: null, error: null } as const;
  try {
    const { getUserCredentials } = await import('../services/userCredentials.js');
    const credentials = await getUserCredentials(userId);
    return { credentials, error: null } as const;
  } catch (error) {
    console.warn(`depth.credentials_failed:${userId}`, error);
    return { credentials: null, error } as const;
  }
}

async function getPublicExchange(exchangeId: string, symbol: string) {
  const type = inferMarketType(symbol);
  const mapped = mapExchangeId(exchangeId, type);
  const cacheKey = `${mapped}:${type}`;
  if (exchangeCache.has(cacheKey)) {
    return exchangeCache.get(cacheKey);
  }
  const Klass: any = (ccxt as any)[mapped];
  if (!Klass) {
    throw new Error(`Unknown exchange ${exchangeId}`);
  }
  const instance = new Klass({ enableRateLimit: true });
  instance.options = instance.options || {};
  instance.options.defaultType = type;
  const isBinance = String(instance.id || mapped).toLowerCase().includes('binance');
  if (!isBinance) {
    try {
      await instance.loadMarkets();
    } catch (error) {
      console.warn('depth.load_markets_failed', { exchangeId: mapped, error: String((error as Error).message || error) });
    }
  }
  exchangeCache.set(cacheKey, instance);
  return instance;
}

function normalizeLevels(levels: any[], limit: number): BookLevel[] {
  return (Array.isArray(levels) ? levels : [])
    .slice(0, limit)
    .map((entry) => {
      const price = Number(entry?.[0] ?? entry?.price ?? 0);
      const size = Number(entry?.[1] ?? entry?.amount ?? entry?.size ?? 0);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
        return null;
      }
      return { price, size };
    })
    .filter((level): level is BookLevel => Boolean(level));
}

function buildUnitTestDepth(levels: number): DepthSnapshot {
  const depthLevels = Math.max(1, Math.min(levels, 10));
  const mid = 100;
  const bids: BookLevel[] = Array.from({ length: depthLevels }, (_, i) => ({ price: mid - i * 0.1, size: 5 + i }));
  const asks: BookLevel[] = Array.from({ length: depthLevels }, (_, i) => ({ price: mid + i * 0.1, size: 5 + i }));
  return { timestamp: Date.now(), bids, asks };
}

export async function fetchDepth(symbol: string, levels: number, userId?: string): Promise<DepthSnapshot | null> {
  if (UNIT_TEST_MODE) {
    return buildUnitTestDepth(levels);
  }
  const cfg = getConfig();
  const depthLevels = Math.max(1, Number(levels || cfg.INTRADAY_DEPTH_LEVELS || 10));
  const { credentials } = await fetchUserCredentialsSafe(userId);
  const exchangeHint = credentials?.exchange || cfg.EXCHANGE_ID;

  let exchange: any;
  let resolvedSymbol: string;
  try {
    if (userId && credentials) {
      exchange = await getUserExchange(userId, credentials);
    } else {
      exchange = await getPublicExchange(exchangeHint, symbol);
    }
    resolvedSymbol = await resolveSymbol(symbol);
  } catch (error) {
    console.warn('depth.exchange_unavailable', { symbol, error: String((error as Error).message || error) });
    return null;
  }

  try {
    const book = await exchange.fetchOrderBook(resolvedSymbol, depthLevels);
    const bids = normalizeLevels(book?.bids || [], depthLevels);
    const asks = normalizeLevels(book?.asks || [], depthLevels);
    if (!bids.length || !asks.length) {
      return null;
    }
    const timestamp = Number(book?.timestamp || Date.now());
    return {
      timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
      bids,
      asks,
    };
  } catch (error) {
    console.warn('depth.fetch_failed', { symbol, error: String((error as Error).message || error) });
    return null;
  }
}
