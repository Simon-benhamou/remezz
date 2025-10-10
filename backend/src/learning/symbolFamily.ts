const MAJOR_SET = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'MATIC', 'DOT', 'LTC', 'BCH', 'LINK', 'AVAX',
  'TRX', 'ATOM', 'FIL', 'NEAR', 'INJ', 'OP', 'ARB', 'APT', 'SUI', 'RNDR', 'TIA', 'SEI',
  'AAVE', 'UNI', 'ETC', 'ICP', 'XLM', 'HBAR', 'ALGO', 'TON', 'IMX', 'DYDX', 'JUP', 'PYTH',
  'MKR', 'GRT', 'FLOW', 'FTM', 'STX', 'SAND', 'MANA', 'AR', 'EGLD', 'ROSE', 'KAS'
]);

const MEME_SET = new Set([
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME', 'MEME', 'POPCAT', 'MEW',
  'TURBO', 'DOGS'
]);

const cache = new Map<string, string>();

function sanitizeBaseSymbol(base: string): string {
  const cleaned = base.replace(/[^A-Z]/g, '');
  return cleaned || base;
}

export function classifySymbolFamily(symbol: string): string {
  const cached = cache.get(symbol);
  if (cached) return cached;
  const rawBase = symbol.split('/')[0]?.toUpperCase() || symbol.toUpperCase();
  const sanitizedBase = sanitizeBaseSymbol(rawBase);
  let family = 'alt';
  if (MAJOR_SET.has(rawBase) || MAJOR_SET.has(sanitizedBase)) family = 'major';
  else if (MEME_SET.has(rawBase) || MEME_SET.has(sanitizedBase)) family = 'meme';
  cache.set(symbol, family);
  return family;
}
