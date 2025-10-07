import { performance } from 'node:perf_hooks';

type SymbolMetrics = {
  wsFrames: number;
  invalidFrames: number;
  restFallbacks: number;
  lastWsMessageTs: number;
  lastValidMessageTs: number;
  reconnects: number;
};

const metricsBySymbol: Map<string, SymbolMetrics> = new Map();

function ensure(symbol: string): SymbolMetrics {
  let entry = metricsBySymbol.get(symbol);
  if (!entry) {
    entry = {
      wsFrames: 0,
      invalidFrames: 0,
      restFallbacks: 0,
      lastWsMessageTs: 0,
      lastValidMessageTs: 0,
      reconnects: 0,
    };
    metricsBySymbol.set(symbol, entry);
  }
  return entry;
}

export function recordWsFrame(symbol: string, isValid: boolean): void {
  const entry = ensure(symbol);
  entry.wsFrames += 1;
  entry.lastWsMessageTs = performance.now();
  if (isValid) {
    entry.lastValidMessageTs = entry.lastWsMessageTs;
  } else {
    entry.invalidFrames += 1;
  }
}

export function recordRestFallback(symbol: string, reason?: string): void {
  const entry = ensure(symbol);
  entry.restFallbacks += 1;
  console.warn(JSON.stringify({
    event: 'rest_fallback',
    symbol,
    reason: reason || 'unknown',
    ts: Date.now()
  }));
}

export function recordWsReconnect(symbol: string): void {
  const entry = ensure(symbol);
  entry.reconnects += 1;
}

export function recordInvalidTicker(symbol: string, details: Record<string, unknown>): void {
  const entry = ensure(symbol);
  entry.invalidFrames += 1;
  console.warn(JSON.stringify({
    event: 'invalid_ticker',
    symbol,
    ...details,
    ts: Date.now()
  }));
}

export function getMarketMetrics(): Record<string, SymbolMetrics> {
  return Array.from(metricsBySymbol.entries())
    .reduce<Record<string, SymbolMetrics>>((acc, [symbol, data]) => {
      acc[symbol] = { ...data };
      return acc;
    }, {});
}
