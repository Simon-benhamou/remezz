/**
 * Global fetch interceptor for diagnosing untracked Binance REST calls.
 *
 * Wraps globalThis.fetch to intercept ALL HTTP requests to *.binance.com.
 * Logs URL path, method, and Binance's X-MBX-USED-WEIGHT-1M response header.
 * This reveals CCXT internal calls and any other untracked sources of API weight.
 *
 * Import this file EARLY in server.ts (before CCXT/exchange imports).
 */

import { createLogger } from './logger.js';

const logger = createLogger('fetch-interceptor');

interface InterceptedCall {
  timestamp: number;
  method: string;
  path: string;
  binanceWeight: number | null;
}

// Rolling buffer of intercepted calls (last 60s, capped at 500)
const recentCalls: InterceptedCall[] = [];
const MAX_BUFFER = 500;

function cleanupOldCalls(): void {
  const cutoff = Date.now() - 60_000;
  while (recentCalls.length > 0 && recentCalls[0].timestamp < cutoff) {
    recentCalls.shift();
  }
}

/** Get summary of all Binance REST calls intercepted in last 60s */
export function getInterceptedCallsSummary(): { path: string; method: string; count: number }[] {
  cleanupOldCalls();
  const map = new Map<string, { method: string; count: number }>();
  for (const call of recentCalls) {
    const key = `${call.method} ${call.path}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, { method: call.method, count: 1 });
    }
  }
  return [...map.entries()]
    .map(([path, data]) => ({ path: path.split(' ')[1], method: data.method, count: data.count }))
    .sort((a, b) => b.count - a.count);
}

/** Get the latest Binance-reported weight from intercepted responses */
let lastBinanceWeight: number | null = null;
let lastBinanceWeightTs = 0;

export function getLastBinanceWeight(): { weight: number | null; ageMs: number } {
  return { weight: lastBinanceWeight, ageMs: Date.now() - lastBinanceWeightTs };
}

// Install the interceptor
const originalFetch = globalThis.fetch;

globalThis.fetch = async function interceptedFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;

  // Only intercept Binance API calls
  if (!url.includes('binance.com')) {
    return originalFetch(input, init);
  }

  const method = init?.method?.toUpperCase() || 'GET';

  // Extract path from URL (strip query params for cleaner logging)
  let path: string;
  try {
    const parsed = new URL(url);
    path = parsed.pathname;
  } catch {
    path = url.split('?')[0];
  }

  // Call original fetch
  const response = await originalFetch(input, init);

  // Read Binance weight header from response
  const weightHeader = response.headers.get('x-mbx-used-weight-1m') || response.headers.get('X-MBX-USED-WEIGHT-1M');
  const binanceWeight = weightHeader ? parseInt(weightHeader, 10) : null;

  if (binanceWeight !== null && !isNaN(binanceWeight)) {
    lastBinanceWeight = binanceWeight;
    lastBinanceWeightTs = Date.now();
  }

  // Record the call
  const entry: InterceptedCall = {
    timestamp: Date.now(),
    method,
    path,
    binanceWeight,
  };

  recentCalls.push(entry);
  if (recentCalls.length > MAX_BUFFER) {
    recentCalls.shift();
  }

  // Log every intercepted call for diagnosis
  logger.debug(`${method} ${path} → ${response.status} [binanceWeight=${binanceWeight ?? '?'}]`);

  // Warn on non-trivial weight paths that might be untracked
  // listenKey calls are 0w, so skip those
  if (binanceWeight !== null && binanceWeight > 50 && !path.includes('listenKey')) {
    // Dynamic import to avoid circular dependency
    const { ipWeightTracker } = await import('../services/ipWeightTracker.js');
    const ourWeight = ipWeightTracker.getCurrentWeight();
    const gap = binanceWeight - ourWeight;
    if (gap > 20) {
      logger.warn(`🔍 WEIGHT GAP: Binance=${binanceWeight} vs ours=${ourWeight} (gap=${gap}w) after ${method} ${path}`);
    }
  }

  return response;
} as typeof globalThis.fetch;

logger.info('✅ Global fetch interceptor installed — monitoring all Binance REST calls');
