import ccxt from 'ccxt';
import { getConfig } from '../utils/env.js';

let cached: any = null;
let marketsLoaded = false;

export async function exchange() {
  if (cached) return cached;
  const { EXCHANGE_ID, API_KEY, API_SECRET, API_PASSWORD } = getConfig();
  const Klass: any = (ccxt as any)[EXCHANGE_ID];
  if (!Klass) throw new Error('Unknown exchange ' + EXCHANGE_ID);

  cached = new Klass({
    apiKey: API_KEY,
    secret: API_SECRET,
    password: API_PASSWORD || undefined,
    enableRateLimit: true,
  });

  // Optionnel : type par défaut (swap pour perp)
  const MARKET_TYPE = (process.env.MARKET_TYPE || 'spot').toLowerCase();
  // @ts-ignore
  cached.options = cached.options || {};
  // @ts-ignore
  cached.options.defaultType = MARKET_TYPE; // 'spot' | 'swap'

  await cached.loadMarkets();
  marketsLoaded = true;
  return cached;
}

/** Essaie de résoudre un symbole quelconque vers un symbole ccxt unifié supporté par l'exchange. */
export async function resolveSymbol(requested: string): Promise<string> {
  const ex = await exchange();
  if (!marketsLoaded) await ex.loadMarkets();

  const s = requested.toUpperCase();

  // 1) Si déjà valide, retourne-le
  if (ex.markets && ex.markets[s]) return s;

  const candidates: string[] = [];

  // 2) Essais courants (spot + perp)
  if (!s.includes('/')) {
    // ex: BTCUSDT -> BTC/USDT
    if (s.endsWith('USDT')) {
      const base = s.replace('USDT', '');
      candidates.push(`${base}/USDT`, `${base}/USDT:USDT`, `${base}-USDT`, `${base}USDT`);
    } else if (s.endsWith('USD')) {
      const base = s.replace('USD', '');
      candidates.push(`${base}/USD`, `${base}/USD:USD`, `${base}-USD`, `${base}USD`);
    }
  } else {
    // ex: BTC/USDT -> BTC/USDT:USDT
    const [base, quote] = s.split('/');
    candidates.push(`${base}/${quote}:USDT`, `${base}/${quote}:USD`);
  }

  // 3) Ajoute des fallback génériques sur base USDT
  const baseGuess = s.replace('/','').replace(':USDT','').replace('USDT','');
  candidates.push(`${baseGuess}/USDT`, `${baseGuess}/USDT:USDT`);

  // 4) Garde uniquement celles reconnues
  for (const c of candidates) {
    if (ex.markets && ex.markets[c]) return c;
  }

  // 5) Dernier recours : trouve la première market USDT du même base
  const marketKeys = Object.keys(ex.markets || {});
  const match = marketKeys.find((k) => {
    const m = ex.markets[k];
    return m?.base?.toUpperCase() === baseGuess && (m?.quote?.toUpperCase() === 'USDT' || k.includes(':USDT'));
  });
  if (match) return match;

  // 6) Rien trouvé
  throw new Error(`${ex.id} does not have market symbol matching "${requested}"`);
}