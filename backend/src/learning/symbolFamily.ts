const MAJOR_SET = new Set([
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'MATIC', 'DOT', 'LTC', 'BCH', 'LINK'
]);

const MEME_SET = new Set([
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME'
]);

const cache = new Map<string, string>();

export function classifySymbolFamily(symbol: string): string {
  const cached = cache.get(symbol);
  if (cached) return cached;
  const base = symbol.split('/')[0]?.toUpperCase() || symbol.toUpperCase();
  let family = 'alt';
  if (MAJOR_SET.has(base)) family = 'major';
  else if (MEME_SET.has(base)) family = 'meme';
  cache.set(symbol, family);
  return family;
}
