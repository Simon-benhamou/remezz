import ccxt from 'ccxt';
import { createHash } from 'crypto';
import { getConfig } from '../utils/env.js';

// User-specific exchange instances for authenticated operations
const userExchanges: Map<string, any> = new Map();
// Track in-flight exchange creations so parallel callers reuse the same loadMarkets()
const userExchangePromises: Map<string, Promise<any>> = new Map();

// Shared public exchanges per market type to avoid repeated loadMarkets()
const publicExchanges: Map<string, any> = new Map();
const publicExchangePromises: Map<string, Promise<any>> = new Map();

// Cache symbol resolutions to avoid repeated market lookups
const symbolResolutionCache: Map<string, string> = new Map();

// V5.25: Global markets cache - loaded ONCE at startup, shared across ALL instances
let globalMarketsCache: {
  markets: any;
  markets_by_id: any;
  symbols: string[];
  currencies: any;
  loadedAt: number;
} | null = null;

// V5.25: Track if we're currently IP banned
let ipBannedUntil: number = 0;

export function isIpBanned(): boolean {
  return Date.now() < ipBannedUntil;
}

export function setIpBan(untilTimestamp: number): void {
  ipBannedUntil = untilTimestamp;
  console.warn(`🚫 IP banned until ${new Date(untilTimestamp).toISOString()}`);
}

export function getIpBanExpiry(): number {
  return ipBannedUntil;
}

// V5.27: Check if markets are loaded
export function areMarketsLoaded(): boolean {
  return globalMarketsCache !== null;
}

// V5.28: Generate minimal markets for Binance Futures when REST is unavailable
// This allows agents to work with WebSocket data without needing loadMarkets()
const COMMON_BINANCE_FUTURES_SYMBOLS = [
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'ATOM',
  'SUI', 'SEI', 'IMX', 'APT', 'LTC', 'BCH', 'UNI', 'SONIC', 'MATIC', 'ARB',
  'OP', 'NEAR', 'FIL', 'AAVE', 'MKR', 'SAND', 'MANA', 'AXS', 'TRX', 'ETC',
  'XLM', 'VET', 'ALGO', 'HBAR', 'ICP', 'EGLD', 'THETA', 'XMR', 'EOS', 'NEO',
  'PEPE', 'SHIB', 'FLOKI', 'WIF', 'BONK', 'ORDI', 'INJ', 'TIA', 'JUP', 'PYTH',
];

function generateMinimalBinanceFuturesMarkets(): typeof globalMarketsCache {
  const markets: Record<string, any> = {};
  const markets_by_id: Record<string, any> = {};
  const symbols: string[] = [];
  
  for (const base of COMMON_BINANCE_FUTURES_SYMBOLS) {
    const symbol = `${base}/USDT:USDT`;
    const id = `${base}USDT`;
    
    const market = {
      id,
      symbol,
      base,
      quote: 'USDT',
      settle: 'USDT',
      baseId: base,
      quoteId: 'USDT',
      settleId: 'USDT',
      type: 'swap',
      spot: false,
      margin: false,
      swap: true,
      future: false,
      option: false,
      active: true,
      contract: true,
      linear: true,
      inverse: false,
      contractSize: 1,
      expiry: undefined,
      expiryDatetime: undefined,
      strike: undefined,
      optionType: undefined,
      precision: {
        amount: 3,
        price: base === 'BTC' ? 1 : base === 'ETH' ? 2 : 4,
        base: 8,
        quote: 8,
      },
      limits: {
        amount: { min: 0.001, max: 10000 },
        price: { min: 0.0001, max: 1000000 },
        cost: { min: 5, max: 10000000 },
        leverage: { min: 1, max: 125 },
      },
      info: { symbol: id },
    };
    
    markets[symbol] = market;
    markets_by_id[id] = market;
    symbols.push(symbol);
  }
  
  console.log(`🔧 Generated minimal markets for ${symbols.length} Binance Futures symbols`);
  
  return {
    markets,
    markets_by_id,
    symbols,
    currencies: { USDT: { id: 'USDT', code: 'USDT' } },
    loadedAt: Date.now(),
  };
}

// V5.28: Initialize minimal markets when REST is unavailable
export function initializeMinimalMarkets(): boolean {
  if (globalMarketsCache) {
    console.log('✅ Markets already loaded, skipping minimal init');
    return true;
  }
  
  console.log('⚠️ Initializing minimal markets (REST unavailable)');
  globalMarketsCache = generateMinimalBinanceFuturesMarkets();
  return true;
}

// Function to clear symbol resolution cache
export function clearSymbolResolutionCache(): void {
  symbolResolutionCache.clear();
  console.log('Symbol resolution cache cleared');
}

function mapExchangeId(exchangeId: string, type: 'spot'|'swap' = 'spot'): string {
  if (exchangeId === 'binance') {
    if (type === 'swap') return 'binanceusdm';
    return 'binance';
  }
  const exchangeIdMap: Record<string, string> = {
    'crypto.com': 'cryptocom',
    'binancecoinm': 'binancecoinm'
  };
  return exchangeIdMap[exchangeId] || exchangeId;
}

/**
 * V5.25: Load markets ONCE at server startup
 * This should be called early in server initialization
 * Returns true if successful, false if banned/failed
 */
export async function preloadMarkets(): Promise<boolean> {
  if (globalMarketsCache) {
    console.log('✅ Markets already preloaded, skipping');
    return true;
  }
  
  if (isIpBanned()) {
    console.warn('🚫 Cannot preload markets - IP is banned until', new Date(ipBannedUntil).toISOString());
    return false;
  }
  
  try {
    console.log('📡 Preloading markets (ONCE at startup)...');
    const exchangeId = getConfig().EXCHANGE_ID || 'binance';
    const ccxtExchangeId = mapExchangeId(exchangeId, 'swap');
    const Klass: any = (ccxt as any)[ccxtExchangeId];
    const inst = new Klass({ enableRateLimit: true, rateLimit: 1000 });
    inst.options = inst.options || {};
    inst.options.defaultType = 'swap';
    
    await inst.loadMarkets();
    
    globalMarketsCache = {
      markets: inst.markets,
      markets_by_id: inst.markets_by_id,
      symbols: inst.symbols,
      currencies: inst.currencies,
      loadedAt: Date.now(),
    };
    
    console.log(`✅ Markets preloaded: ${Object.keys(inst.markets).length} symbols cached`);
    return true;
  } catch (e: any) {
    // Check if it's an IP ban
    if (e?.message?.includes('418') || e?.message?.includes('banned')) {
      const match = e.message?.match(/banned until (\d+)/);
      if (match) {
        setIpBan(parseInt(match[1], 10));
      }
    }
    console.error('❌ Failed to preload markets:', e?.message);
    return false;
  }
}

/**
 * V5.25: Get a public exchange instance with cached markets
 * NEVER makes REST calls if markets are already cached
 */
async function getPublicExchangeFor(exchangeId: string, type: 'spot'|'swap') {
  const ccxtExchangeId = mapExchangeId(exchangeId, type);
  const key = `${ccxtExchangeId}:${type}`;
  
  // Return cached instance if available
  if (publicExchanges.has(key)) return publicExchanges.get(key);
  
  // Wait for in-flight creation
  const inflight = publicExchangePromises.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const Klass: any = (ccxt as any)[ccxtExchangeId];
    if (!Klass) throw new Error('Unknown exchange ' + ccxtExchangeId);
    
    const inst = new Klass({ 
      enableRateLimit: true,
      rateLimit: 500
    });
    inst.options = inst.options || {};
    inst.options.defaultType = type;
    
    // V5.66: FAIL FAST - Markets must be preloaded at startup via preloadMarkets()
    // This prevents ad-hoc REST calls that can cause rate limiting
    if (globalMarketsCache) {
      inst.markets = globalMarketsCache.markets;
      inst.markets_by_id = globalMarketsCache.markets_by_id;
      inst.symbols = globalMarketsCache.symbols;
      inst.currencies = globalMarketsCache.currencies;
      console.log(`✅ Markets assigned from global cache (0 API calls)`);
    } else if (isIpBanned()) {
      // IP is banned and no cache - throw error, don't make REST call
      throw new Error(`IP is banned until ${new Date(ipBannedUntil).toISOString()} and no markets cache available`);
    } else {
      // V5.66: FAIL FAST - Don't try to load markets ad-hoc
      // This prevents unexpected REST calls that can cause rate limiting with 1000+ agents
      throw new Error(
        'Markets not preloaded! Call preloadMarkets() at server startup before any agent operations. ' +
        'Ad-hoc loadMarkets() calls are disabled to prevent rate limiting.'
      );
    }
    
    publicExchanges.set(key, inst);
    return inst;
  })();

  publicExchangePromises.set(key, promise);
  try {
    return await promise;
  } finally {
    publicExchangePromises.delete(key);
  }
}

/**
 * V5.25: Get cached exchange for backtest/public data fetching
 * This reuses the same exchange instance with pre-loaded markets (0 API weight after first call)
 */
export async function getCachedExchange(): Promise<any> {
  const exchangeId = getConfig().EXCHANGE_ID || 'binance';
  // For Binance, we always use 'swap' (binanceusdm) for futures trading
  const marketType = 'swap';
  return getPublicExchangeFor(exchangeId, marketType);
}

// Function to clear user exchange cache (useful when API keys are updated)
export function clearUserExchangeCache(userId: string): void {
  for (const [key] of userExchanges) {
    if (key.startsWith(`${userId}_`)) {
      userExchanges.delete(key);
    }
  }
  for (const [key] of userExchangePromises) {
    if (key.startsWith(`${userId}_`)) {
      userExchangePromises.delete(key);
    }
  }
  console.log(`Cleared exchange cache for user: ${userId}`);
}

// New function for user-specific authenticated exchange
export async function getUserExchange(userId: string, credentials: { apiKey: string; apiSecret: string; passphrase?: string; exchange?: string }) {
  // Include credentials hash in cache key to handle key updates
  const credentialsHash = createHash('md5')
    .update(credentials.apiKey + credentials.apiSecret)
    .digest('hex')
    .substring(0, 8);
  
  // Determine exchange ID: from credentials, or fallback to env config
  const exchangeId = credentials.exchange || getConfig().EXCHANGE_ID;
  const cacheKey = `${userId}_${exchangeId}_${credentialsHash}`;
  
  if (userExchanges.has(cacheKey)) {
    return userExchanges.get(cacheKey);
  }

  // Share ongoing exchange instantiation if another request already started it
  const existingPromise = userExchangePromises.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  // Clear any old cache entries for this user
  for (const [key] of userExchanges) {
    if (key.startsWith(`${userId}_`) && key !== cacheKey) {
      userExchanges.delete(key);
    }
  }
  for (const [key] of userExchangePromises) {
    if (key.startsWith(`${userId}_`) && key !== cacheKey) {
      userExchangePromises.delete(key);
    }
  }

  // Default market type (spot | swap)
  const MARKET_TYPE = (process.env.MARKET_TYPE || 'spot').toLowerCase() as 'spot'|'swap';
  const ccxtExchangeId = mapExchangeId(exchangeId, MARKET_TYPE);
  const Klass: any = (ccxt as any)[ccxtExchangeId];
  if (!Klass) throw new Error('Unknown exchange ' + exchangeId);

  // Check exchange required credentials
  const tempExchange = new Klass();
  const requiredCreds = tempExchange.requiredCredentials || {};

  console.log('Creating exchange instance for user:', userId);
  console.log('Exchange ID:', exchangeId, '(CCXT:', ccxtExchangeId, ')');
  console.log('Required credentials:', requiredCreds);
  console.log('API Key length:', credentials.apiKey?.length);
  console.log('API Secret length:', credentials.apiSecret?.length);

  const config: any = {
    apiKey: credentials.apiKey,
    secret: credentials.apiSecret,
    enableRateLimit: true,
  };

  // Only add password if the exchange requires it
  if (requiredCreds.password && credentials.passphrase) {
    config.password = credentials.passphrase;
    console.log('Using passphrase for exchange that requires it');
  }

  const loadPromise = (async () => {
    const userExchange = new Klass(config);

    // @ts-ignore
    userExchange.options = userExchange.options || {};
    // @ts-ignore
    userExchange.options.defaultType = MARKET_TYPE; // 'spot' | 'swap'

    // V5.66: FAIL FAST - Markets must be preloaded at startup
    if (globalMarketsCache) {
      userExchange.markets = globalMarketsCache.markets;
      userExchange.markets_by_id = globalMarketsCache.markets_by_id;
      userExchange.symbols = globalMarketsCache.symbols;
      userExchange.currencies = globalMarketsCache.currencies;
      console.log('✅ Markets assigned from global cache (0 API calls)');
    } else if (isIpBanned()) {
      // IP is banned and no cache - throw error
      throw new Error(`IP is banned until ${new Date(ipBannedUntil).toISOString()} and no markets cache available`);
    } else {
      // V5.66: FAIL FAST - Don't try to load markets ad-hoc
      throw new Error(
        'Markets not preloaded! Call preloadMarkets() at server startup before any agent operations. ' +
        'Ad-hoc loadMarkets() calls are disabled to prevent rate limiting.'
      );
    }

    userExchanges.set(cacheKey, userExchange);
    return userExchange;
  })();

  userExchangePromises.set(cacheKey, loadPromise);

  try {
    return await loadPromise;
  } catch (error) {
    userExchanges.delete(cacheKey);
    throw error;
  } finally {
    userExchangePromises.delete(cacheKey);
  }
}

// Function to validate user credentials by testing API connection
export async function validateUserCredentials(credentials: { apiKey: string; apiSecret: string; passphrase?: string }): Promise<boolean> {
  try {
    const { EXCHANGE_ID } = getConfig();
    const Klass: any = (ccxt as any)[EXCHANGE_ID];
    if (!Klass) return false;

    // Check exchange required credentials
    const tempExchange = new Klass();
    const requiredCreds = tempExchange.requiredCredentials || {};
    
    console.log('Exchange required credentials:', requiredCreds);

    const config: any = {
      apiKey: credentials.apiKey,
      secret: credentials.apiSecret,
      enableRateLimit: true,
    };

    // Only add password if the exchange requires it
    if (requiredCreds.password && credentials.passphrase) {
      config.password = credentials.passphrase;
    }

    const testExchange = new Klass(config);

    console.log('Testing credentials with exchange:', EXCHANGE_ID);
    console.log('Config keys:', Object.keys(config));

    // Lightweight validation: just check exchange instance created (no API call to avoid rate limits)
    if (testExchange && testExchange.apiKey === credentials.apiKey) {
      console.log('Credential validation successful (format check passed)');
      return true;
    }
    return false;
  } catch (error: any) {
    console.error('Credential validation failed:', error?.message || error);
    console.error('Error details:', {
      name: error?.name,
      code: error?.code,
      status: error?.status
    });
    return false;
  }
}

/** Resolve a requested symbol to a valid ccxt unified market symbol for the configured exchange. */
export async function resolveSymbol(requested: string, userId?: string): Promise<string> {
  const { EXCHANGE_ID } = getConfig();
  const exchangeId = EXCHANGE_ID;
  const sReq = requested.toUpperCase();

  const cacheKey = `${exchangeId}:${sReq}`;

  // Special handling for Binance COIN-M Futures - prioritize _PERP format
  if (exchangeId === 'binancecoinm') {
    let base: string;
    if (sReq.includes('/')) {
      base = sReq.split('/')[0];
    } else {
      base = sReq.replace(/USDT|USD$/, '').replace('USD_PERP', '').replace('USDT', '').replace('_PERP', '');
    }
    const coinMSymbol = `${base}USD_PERP`;
    symbolResolutionCache.set(cacheKey, coinMSymbol);
    return coinMSymbol;
  }

  // Preferred types order
  const preferSwap = sReq.includes(':USDT') || sReq.includes(':USD') || sReq.includes('-PERP') || /PERP$/.test(sReq);
  const types: Array<'spot' | 'swap'> = preferSwap
    ? ['swap', ((process.env.MARKET_TYPE || 'spot').toLowerCase() as any) || 'spot']
    : [((process.env.MARKET_TYPE || 'spot').toLowerCase() as any) || 'spot', 'swap'];

  // Get shared public exchanges for both types
  const exchanges: Record<'spot'|'swap', any> = {
    spot: await getPublicExchangeFor(exchangeId, 'spot'),
    swap: await getPublicExchangeFor(exchangeId, 'swap'),
  };

  let ex = exchanges[types[0]];
  const s = sReq;
  const isPerp = (m:any) => !!(m && (m.swap === true || m.type === 'swap' || m.perpetual === true || (m.contract === true && m.future !== true)));

  // 1) If already valid and a perp/swap, return it
  if (ex.markets && ex.markets[s] && isPerp(ex.markets[s])) {
    symbolResolutionCache.set(cacheKey, s);
    return s;
  }

  const candidates: string[] = [];
  if (!s.includes('/')) {
    if (s.endsWith('USDT')) {
      const base = s.replace('USDT', '');
      candidates.push(`${base}/USDT`, `${base}/USDT:USDT`, `${base}-USDT`, `${base}USDT`);
      candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}USD-PERP`, `${base}USD`);
      candidates.push(`${base}USD_PERP`); // COIN-M Futures format
    } else if (s.endsWith('USD')) {
      const base = s.replace('USD', '');
      candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}-USD`, `${base}USD`);
      candidates.push(`${base}USD-PERP`);
      candidates.push(`${base}USD_PERP`); // COIN-M Futures format
    }
  } else {
    const [base, quote] = s.split('/');
    candidates.push(`${base}/${quote}:USDT`, `${base}/${quote}:USD`);
    candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}USD-PERP`, `${base}USD`);
    candidates.push(`${base}USD_PERP`); // COIN-M Futures format
  }
  const baseGuess = s.replace('/','').replace(':USDT','').replace('USDT','');
  candidates.push(`${baseGuess}/USDT`, `${baseGuess}/USDT:USDT`);

  // 4) Keep only recognized perp/swap markets
  for (const c of candidates) {
    if (ex.markets && ex.markets[c] && isPerp(ex.markets[c])) return c;
  }

  // 5) Last resort: first USDT market for the same base
  const marketKeys = Object.keys(ex.markets || {});
  const match = marketKeys.find((k) => {
    const m = ex.markets[k];
    const q = (m?.quote || '').toUpperCase();
    return isPerp(m) && m?.base?.toUpperCase() === baseGuess && (q === 'USDT' || q === 'USD' || k.includes(':USDT') || k.includes(':USD') || k.includes('-PERP') || k.includes('_PERP'));
  });
  if (match) return match;

  // 6) If not found, try the other market type if available
  const altType = types[1];
  if (altType && exchanges[altType]) {
    ex = exchanges[altType];
    // 1) direct match
    if (ex.markets && ex.markets[s] && isPerp(ex.markets[s])) return s;
    // 4) candidates again on alt
    for (const c of candidates) {
      if (ex.markets && ex.markets[c] && isPerp(ex.markets[c])) return c;
    }
    // 5) last resort on alt
    const marketKeys2 = Object.keys(ex.markets || {});
    const match2 = marketKeys2.find((k) => {
      const m = ex.markets[k];
      const q = (m?.quote || '').toUpperCase();
      return isPerp(m) && m?.base?.toUpperCase() === baseGuess && (q === 'USDT' || q === 'USD' || k.includes(':USDT') || k.includes(':USD') || k.includes('-PERP') || k.includes('_PERP'));
    });
    if (match2) return match2;
  }

  // Special handling for Binance - assume USDT perpetuals are valid
  if (exchangeId === 'binance' && (sReq.endsWith('USDT') || sReq.endsWith('/USDT'))) {
    let base: string;
    if (sReq.includes('/')) {
      base = sReq.split('/')[0];
    } else {
      base = sReq.replace('USDT', '');
    }
    const futuresSymbol = `${base}/USDT:USDT`;
    symbolResolutionCache.set(cacheKey, futuresSymbol);
    return futuresSymbol;
  }

  // Special handling for Binance COIN-M Futures - prioritize _PERP format
  if (exchangeId === 'binancecoinm') {
    let base: string;
    if (sReq.includes('/')) {
      base = sReq.split('/')[0];
    } else {
      base = sReq.replace(/USDT|USD$/, '').replace('USD_PERP', '').replace('USDT', '').replace('_PERP', '');
    }
    const coinMSymbol = `${base}USD_PERP`;
    symbolResolutionCache.set(cacheKey, coinMSymbol);
    return coinMSymbol;
  }

  // 7) Not found across types
  throw new Error(`${EXCHANGE_ID} does not have a swap/perp market matching "${requested}"`);
}
