export function formatDisplaySymbol(symbol?: string | null): string {
  if (!symbol) return 'Unknown';
  const upper = symbol.toUpperCase();
  const slashIndex = upper.indexOf('/');
  if (slashIndex > 0) {
    return upper.slice(0, slashIndex);
  }
  const colonIndex = upper.indexOf(':');
  if (colonIndex > 0) {
    return upper.slice(0, colonIndex);
  }
  return upper;
}

export function formatDisplaySymbolWithFallback(symbol?: string | null, fallback = 'Unknown') {
  const formatted = formatDisplaySymbol(symbol);
  return formatted || fallback;
}
