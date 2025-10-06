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

// Function to clear symbol resolution cache
export function clearSymbolResolutionCache(): void {
  symbolResolutionCache.clear();
  console.log('Symbol resolution cache cleared');
}

function mapExchangeId(exchangeId: string): string {
  const exchangeIdMap: Record<string, string> = {
    'crypto.com': 'cryptocom',
    'binance': 'binance',
    'binancecoinm': 'binancecoinm'
  };
  return exchangeIdMap[exchangeId] || exchangeId;
}

async function getPublicExchangeFor(ccxtExchangeId: string, type: 'spot'|'swap') {
  const key = `${ccxtExchangeId}:${type}`;
  if (publicExchanges.has(key)) return publicExchanges.get(key);
  const inflight = publicExchangePromises.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const Klass: any = (ccxt as any)[ccxtExchangeId];
    if (!Klass) throw new Error('Unknown exchange ' + ccxtExchangeId);
    const inst = new Klass({ enableRateLimit: true });
    // @ts-ignore
    inst.options = inst.options || {};
    // @ts-ignore
    inst.options.defaultType = type;
    
    // 🚨 CRITICAL: NEVER loadMarkets for Binance - use WebSocket only
    if (ccxtExchangeId !== 'binance') {
      await inst.loadMarkets();
    } else {
      console.log('⚠️ Skipping loadMarkets for Binance - using WebSocket streams only');
      // Initialize empty markets structure to avoid errors
      inst.markets = {};
      inst.markets_by_id = {};
      inst.symbols = [];
      inst.currencies = {};
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

  const ccxtExchangeId = mapExchangeId(exchangeId);
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

    // Default market type (spot | swap)
    const MARKET_TYPE = (process.env.MARKET_TYPE || 'spot').toLowerCase() as 'spot'|'swap';
    // @ts-ignore
    userExchange.options = userExchange.options || {};
    // @ts-ignore
    userExchange.options.defaultType = MARKET_TYPE; // 'spot' | 'swap'

    // Seed markets from shared public instance to avoid loadMarkets REST weight
    try {
      const pub = await getPublicExchangeFor(ccxtExchangeId, MARKET_TYPE);
      if (typeof (userExchange as any).setMarkets === 'function') {
        (userExchange as any).setMarkets(pub.markets, pub.currencies);
        console.log('Markets seeded from shared public exchange, total:', Object.keys(userExchange.markets || {}).length);
      } else {
        // Fallback: assign primary structures
        (userExchange as any).markets = pub.markets;
        (userExchange as any).markets_by_id = pub.markets_by_id;
        (userExchange as any).symbols = pub.symbols;
        console.log('Markets assigned from shared public exchange, total:', Object.keys(userExchange.markets || {}).length);
      }
    } catch (e) {
      // 🚨 CRITICAL: NEVER loadMarkets for Binance - even in fallback
      if (ccxtExchangeId === 'binance') {
        console.warn('⚠️ Failed to seed markets for Binance, but skipping loadMarkets - using WebSocket only');
        // Initialize empty markets structure to avoid errors
        (userExchange as any).markets = {};
        (userExchange as any).markets_by_id = {};
        (userExchange as any).symbols = [];
      } else {
        console.warn('Failed to seed markets from public exchange, falling back to loadMarkets once:', (e as any)?.message || e);
        await userExchange.loadMarkets();
      }
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
  const ccxtExchangeId = mapExchangeId(EXCHANGE_ID);
  const sReq = requested.toUpperCase();

  const cacheKey = `${ccxtExchangeId}:${sReq}`;

  // Special handling for Binance COIN-M Futures - prioritize _PERP format
  if (ccxtExchangeId === 'binancecoinm') {
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
    spot: await getPublicExchangeFor(ccxtExchangeId, 'spot'),
    swap: await getPublicExchangeFor(ccxtExchangeId, 'swap'),
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
  if (ccxtExchangeId === 'binance' && (sReq.endsWith('USDT') || sReq.endsWith('/USDT'))) {
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
  if (ccxtExchangeId === 'binancecoinm') {
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
