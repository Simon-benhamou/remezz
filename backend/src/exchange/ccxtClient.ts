import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

// User-specific exchange instances for authenticated operations
const userExchanges: Map<string, any> = new Map();

// Function to clear user exchange cache (useful when API keys are updated)
export function clearUserExchangeCache(userId: string): void {
  const cacheKey = `${userId}`;
  userExchanges.delete(cacheKey);
  console.log(`Cleared exchange cache for user: ${userId}`);
}

// New function for user-specific authenticated exchange
export async function getUserExchange(userId: string, credentials: { apiKey: string; apiSecret: string; passphrase?: string }) {
  // Include credentials hash in cache key to handle key updates
  const credentialsHash = require('crypto')
    .createHash('md5')
    .update(credentials.apiKey + credentials.apiSecret)
    .digest('hex')
    .substring(0, 8);
  const cacheKey = `${userId}_${credentialsHash}`;
  
  if (userExchanges.has(cacheKey)) {
    return userExchanges.get(cacheKey);
  }

  // Clear any old cache entries for this user
  for (const [key] of userExchanges) {
    if (key.startsWith(`${userId}_`)) {
      userExchanges.delete(key);
    }
  }

  const { EXCHANGE_ID } = getConfig();
  const Klass: any = (ccxt as any)[EXCHANGE_ID];
  if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);

  // Check exchange required credentials
  const tempExchange = new Klass();
  const requiredCreds = tempExchange.requiredCredentials || {};

  console.log('Creating exchange instance for user:', userId);
  console.log('Exchange ID:', EXCHANGE_ID);
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

  const userExchange = new Klass(config);

  // Default market type (spot | swap)
  const MARKET_TYPE = (process.env.MARKET_TYPE || 'spot').toLowerCase();
  // @ts-ignore
  userExchange.options = userExchange.options || {};
  // @ts-ignore
  userExchange.options.defaultType = MARKET_TYPE; // 'spot' | 'swap'

  console.log('Loading markets for exchange...');
  await userExchange.loadMarkets();
  console.log('Markets loaded successfully, total:', Object.keys(userExchange.markets || {}).length);
  
  userExchanges.set(cacheKey, userExchange);
  
  return userExchange;
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

    // Test by fetching balance (minimal API call that requires authentication)
    const balance = await testExchange.fetchBalance();
    console.log('Credential validation successful, balance keys:', Object.keys(balance || {}));
    return true;
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
  // For symbol resolution, we create a temporary unauthenticated exchange since it's just market data
  const { EXCHANGE_ID } = getConfig();
  const Klass: any = (ccxt as any)[EXCHANGE_ID];
  if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);
  
  const ex = new Klass({ enableRateLimit: true });
  const MARKET_TYPE = (process.env.MARKET_TYPE || 'spot').toLowerCase();
  // @ts-ignore
  ex.options = ex.options || {};
  // @ts-ignore
  ex.options.defaultType = MARKET_TYPE; // 'spot' | 'swap'
  
  await ex.loadMarkets();

  const s = requested.toUpperCase();

  // Helper: ensure market is perpetual/swap
  const isPerp = (m:any) => !!(m && (m.swap === true || m.type === 'swap' || m.perpetual === true || (m.contract === true && m.future !== true)));

  // 1) If already valid and a perp/swap, return it
  if (ex.markets && ex.markets[s] && isPerp(ex.markets[s])) return s;

  const candidates: string[] = [];

  // 2) Try common forms (spot + perp)
  if (!s.includes('/')) {
    // ex: BTCUSDT -> BTC/USDT
    if (s.endsWith('USDT')) {
      const base = s.replace('USDT', '');
      candidates.push(`${base}/USDT`, `${base}/USDT:USDT`, `${base}-USDT`, `${base}USDT`);
      // Also try USD perp variants
      candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}USD-PERP`, `${base}USD`);
    } else if (s.endsWith('USD')) {
      const base = s.replace('USD', '');
      candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}-USD`, `${base}USD`);
      candidates.push(`${base}USD-PERP`);
    }
  } else {
    // ex: BTC/USDT -> BTC/USDT:USDT
    const [base, quote] = s.split('/');
    candidates.push(`${base}/${quote}:USDT`, `${base}/${quote}:USD`);
    // Also try USD-margined perp for same base regardless of quote
    candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}USD-PERP`, `${base}USD`);
  }

  // 3) Add generic USDT fallbacks
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
    return isPerp(m) && m?.base?.toUpperCase() === baseGuess && (q === 'USDT' || q === 'USD' || k.includes(':USDT') || k.includes(':USD') || k.includes('-PERP'));
  });
  if (match) return match;

  // 6) Not found
  throw new Error(`${ex.id} does not have market symbol matching "${requested}"`);
}
