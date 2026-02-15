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

interface WeightSnapshot {
  timestamp: number;
  binanceWeight: number;
  ourWeight: number;
  gap: number;
  afterPath: string;
}

// Rolling buffer of intercepted calls (last 5 min, capped at 500)
const recentCalls: InterceptedCall[] = [];
const MAX_BUFFER = 500;

// Rolling buffer of weight snapshots (last 10 min, capped at 100)
const weightTimeline: WeightSnapshot[] = [];
const MAX_TIMELINE = 100;

// Total intercepted calls by path since startup
const lifetimeCallCounts = new Map<string, number>();

function cleanupOldCalls(): void {
  const cutoff = Date.now() - 5 * 60_000;
  while (recentCalls.length > 0 && recentCalls[0].timestamp < cutoff) {
    recentCalls.shift();
  }
  const timelineCutoff = Date.now() - 10 * 60_000;
  while (weightTimeline.length > 0 && weightTimeline[0].timestamp < timelineCutoff) {
    weightTimeline.shift();
  }
}

/** Get summary of all Binance REST calls intercepted in last 60s */
export function getInterceptedCallsSummary(): { path: string; method: string; count: number }[] {
  cleanupOldCalls();
  const cutoff = Date.now() - 60_000;
  const map = new Map<string, { method: string; count: number }>();
  for (const call of recentCalls) {
    if (call.timestamp < cutoff) continue;
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

/** Get weight timeline (Binance vs ours over time) */
export function getWeightTimeline(): WeightSnapshot[] {
  cleanupOldCalls();
  return [...weightTimeline];
}

/** Get lifetime call counts (since server startup) */
export function getLifetimeCallCounts(): { path: string; count: number }[] {
  return [...lifetimeCallCounts.entries()]
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count);
}

/** Get full diagnosis report */
export function getFullDiagnosis(): {
  conclusion: string;
  pid: number;
  uptimeSeconds: number;
  interceptedLast60s: { path: string; method: string; count: number }[];
  interceptedLast5min: { path: string; method: string; count: number }[];
  lifetimeCalls: { path: string; count: number }[];
  weightTimeline: WeightSnapshot[];
  lastBinanceWeight: { weight: number | null; ageMs: number };
  totalInterceptedCallsSinceStartup: number;
} {
  cleanupOldCalls();

  const last60s = getInterceptedCallsSummary();

  // 5 min summary
  const map5 = new Map<string, { method: string; count: number }>();
  for (const call of recentCalls) {
    const key = `${call.method} ${call.path}`;
    const existing = map5.get(key);
    if (existing) existing.count++;
    else map5.set(key, { method: call.method, count: 1 });
  }
  const last5min = [...map5.entries()]
    .map(([path, data]) => ({ path: path.split(' ')[1], method: data.method, count: data.count }))
    .sort((a, b) => b.count - a.count);

  let totalLifetime = 0;
  for (const count of lifetimeCallCounts.values()) totalLifetime += count;

  // Build conclusion
  const recentTimeline = weightTimeline.slice(-5);
  const avgGap = recentTimeline.length > 0
    ? Math.round(recentTimeline.reduce((s, t) => s + t.gap, 0) / recentTimeline.length)
    : 0;
  const avgOurs = recentTimeline.length > 0
    ? Math.round(recentTimeline.reduce((s, t) => s + t.ourWeight, 0) / recentTimeline.length)
    : 0;
  const avgBinance = recentTimeline.length > 0
    ? Math.round(recentTimeline.reduce((s, t) => s + t.binanceWeight, 0) / recentTimeline.length)
    : 0;

  let conclusion: string;
  if (avgGap > 20) {
    conclusion = `EXTERNAL TRAFFIC DETECTED: Our process uses ~${avgOurs}w/min but Binance reports ~${avgBinance}w/min. `
      + `~${avgGap}w/min is consumed by ANOTHER source sharing this IP. `
      + `Check for: (1) other backend instances (pm2 list), (2) other bots/scripts, `
      + `(3) shared outbound IP (NAT/proxy), (4) VPS provider IP pooling.`;
  } else if (avgGap > 0) {
    conclusion = `Minor weight gap (~${avgGap}w). Likely timing differences between Binance's 1-min window and ours.`;
  } else {
    conclusion = `No weight gap detected. All Binance REST weight is accounted for by this process.`;
  }

  return {
    conclusion,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    interceptedLast60s: last60s,
    interceptedLast5min: last5min,
    lifetimeCalls: getLifetimeCallCounts(),
    weightTimeline: recentTimeline,
    lastBinanceWeight: getLastBinanceWeight(),
    totalInterceptedCallsSinceStartup: totalLifetime,
  };
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

  // Track lifetime counts
  const pathKey = `${method} ${path}`;
  lifetimeCallCounts.set(pathKey, (lifetimeCallCounts.get(pathKey) || 0) + 1);

  // Call original fetch
  const response = await originalFetch(input, init);

  // Read Binance weight header from response
  const weightHeader = response.headers.get('x-mbx-used-weight-1m') || response.headers.get('X-MBX-USED-WEIGHT-1M');
  const binanceWeight = weightHeader ? parseInt(weightHeader, 10) : null;

  if (binanceWeight !== null && !isNaN(binanceWeight)) {
    lastBinanceWeight = binanceWeight;
    lastBinanceWeightTs = Date.now();

    // Record weight snapshot (async import to avoid circular dep)
    try {
      const { ipWeightTracker } = await import('../services/ipWeightTracker.js');
      const ourWeight = ipWeightTracker.getCurrentWeight();
      const gap = binanceWeight - ourWeight;

      weightTimeline.push({ timestamp: Date.now(), binanceWeight, ourWeight, gap, afterPath: path });
      if (weightTimeline.length > MAX_TIMELINE) weightTimeline.shift();

      // Log gap analysis
      if (gap > 20) {
        logger.warn(`🔍 WEIGHT GAP: Binance=${binanceWeight} vs ours=${ourWeight} (gap=${gap}w) after ${method} ${path} — EXTERNAL TRAFFIC on this IP`);
      }
    } catch {}
  }

  // Record the call
  recentCalls.push({ timestamp: Date.now(), method, path, binanceWeight });
  if (recentCalls.length > MAX_BUFFER) recentCalls.shift();

  // Log every intercepted call for diagnosis
  logger.debug(`${method} ${path} → ${response.status} [binanceWeight=${binanceWeight ?? '?'}]`);

  return response;
} as typeof globalThis.fetch;

/** Detect external IP at startup */
export async function detectExternalIp(): Promise<string | null> {
  try {
    const response = await originalFetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json() as { ip: string };
      return data.ip;
    }
  } catch {}
  try {
    const response = await originalFetch('https://ifconfig.me/ip', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      return (await response.text()).trim();
    }
  } catch {}
  return null;
}

logger.info(`✅ Global fetch interceptor installed — PID=${process.pid} — monitoring ALL Binance REST calls`);
