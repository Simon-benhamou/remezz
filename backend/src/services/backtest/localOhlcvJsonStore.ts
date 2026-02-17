import fs from 'node:fs/promises';
import path from 'node:path';

export type BacktestCandle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type LocalJsonCandle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime?: number;
};

type CacheEntry = {
  key: string;
  candles: BacktestCandle[];
  startTs: number;
  endTs: number;
  lastAccessMs: number;
};

const cache = new Map<string, CacheEntry>();

function lowerBoundByTs(candles: BacktestCandle[], ts: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].timestamp < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundByTs(candles: BacktestCandle[], ts: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].timestamp <= ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalDataDir(): Promise<string | null> {
  // Most common when running backend workspace: <cwd>/data
  const candidates = [
    path.resolve(process.cwd(), 'data'),
    // When running from monorepo root: <cwd>/backend/data
    path.resolve(process.cwd(), 'backend', 'data'),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function normalizeSymbolToFilename(symbol: string): string {
  // Accept: BTC/USDT, BTC/USDT:USDT, btc/usdt
  const upper = symbol.toUpperCase();
  const cleaned = upper.replace(':USDT', '').replace(':USD', '');
  return cleaned.replace(/\//g, '_');
}

function pruneCacheIfNeeded(): void {
  const maxEntries = Number.parseInt(process.env.BACKTEST_LOCAL_OHLCV_CACHE_MAX_ENTRIES || '2', 10);
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    cache.clear();
    return;
  }
  if (cache.size <= maxEntries) return;

  const entries = Array.from(cache.values()).sort((a, b) => a.lastAccessMs - b.lastAccessMs);
  while (cache.size > maxEntries && entries.length) {
    const victim = entries.shift();
    if (!victim) break;
    cache.delete(victim.key);
  }
}

export async function loadLocalJsonCandles(
  symbol: string,
  timeframe: '15m' | '1h',
): Promise<{ candles: BacktestCandle[]; startTs: number; endTs: number } | null> {
  const dataDir = await resolveLocalDataDir();
  if (!dataDir) return null;

  const base = normalizeSymbolToFilename(symbol);
  const file = path.join(dataDir, `${base}_${timeframe}.json`);

  const cacheKey = `${file}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    cached.lastAccessMs = Date.now();
    return { candles: cached.candles, startTs: cached.startTs, endTs: cached.endTs };
  }

  if (!(await exists(file))) return null;

  // NOTE: files are large JSON arrays. We parse once and keep in-memory (LRU).
  const raw = await fs.readFile(file, 'utf8');
  const json = JSON.parse(raw);
  
  // Support two formats:
  // 1. Array of objects: [{ openTime, open, high, low, close, volume }, ...]
  // 2. Object with candles array: { symbol, timeframe, candles: [[ts, o, h, l, c, v], ...] }
  let parsed: (LocalJsonCandle | number[])[];
  if (Array.isArray(json)) {
    parsed = json as LocalJsonCandle[];
  } else if (json && typeof json === 'object' && Array.isArray(json.candles)) {
    parsed = json.candles as number[][];
  } else {
    return null;
  }
  if (parsed.length === 0) return null;

  const candles: BacktestCandle[] = [];
  let lastTs = -Infinity;
  for (const item of parsed) {
    let ts: number, open: number, high: number, low: number, close: number, volume: number;
    
    if (Array.isArray(item)) {
      // Format: [timestamp, open, high, low, close, volume]
      [ts, open, high, low, close, volume] = item as number[];
    } else {
      // Format: { openTime, open, high, low, close, volume }
      ts = Number((item as LocalJsonCandle)?.openTime);
      open = Number((item as LocalJsonCandle).open);
      high = Number((item as LocalJsonCandle).high);
      low = Number((item as LocalJsonCandle).low);
      close = Number((item as LocalJsonCandle).close);
      volume = Number((item as LocalJsonCandle).volume ?? 0);
    }
    
    if (!Number.isFinite(ts)) continue;
    if (ts <= lastTs) continue;
    if (![open, high, low, close, volume].every((v) => Number.isFinite(v))) continue;
    candles.push({ timestamp: ts, open, high, low, close, volume });
    lastTs = ts;
  }

  if (!candles.length) return null;

  const startTs = candles[0].timestamp;
  const endTs = candles[candles.length - 1].timestamp;

  cache.set(cacheKey, {
    key: cacheKey,
    candles,
    startTs,
    endTs,
    lastAccessMs: Date.now(),
  });
  pruneCacheIfNeeded();

  return { candles, startTs, endTs };
}

export function sliceCandlesByTime(
  candles: BacktestCandle[],
  startTsInclusive: number,
  endTsInclusive: number,
): BacktestCandle[] {
  if (!candles.length) return [];
  const startIdx = lowerBoundByTs(candles, startTsInclusive);
  const endIdxExclusive = upperBoundByTs(candles, endTsInclusive);
  return candles.slice(startIdx, endIdxExclusive);
}

export const CANDLE_15M_MS = 15 * 60 * 1000;
export const CANDLE_1H_MS = 60 * 60 * 1000;

export type CandleGap = { fromTs: number; toTs: number; missingCount: number };

export function detectAndWarnGaps(
  candles: BacktestCandle[],
  symbol: string,
  intervalMs: number = CANDLE_15M_MS,
): CandleGap[] {
  if (candles.length < 2) return [];
  const gaps: CandleGap[] = [];
  const threshold = intervalMs * 1.5;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp;
    if (delta > threshold) {
      const missing = Math.round(delta / intervalMs) - 1;
      gaps.push({ fromTs: candles[i - 1].timestamp, toTs: candles[i].timestamp, missingCount: missing });
    }
  }
  if (gaps.length > 0) {
    const tf = intervalMs >= 3_600_000 ? `${intervalMs / 3_600_000}h` : `${intervalMs / 60_000}m`;
    const totalMissing = gaps.reduce((s, g) => s + g.missingCount, 0);
    console.warn(
      `[Backtest] ⚠️ ${symbol} ${tf}: ${gaps.length} gap(s) detected (${totalMissing} missing candles). ` +
      `Indicators computed over non-contiguous data.`
    );
    for (const g of gaps) {
      console.warn(
        `  gap: ${new Date(g.fromTs).toISOString()} → ${new Date(g.toTs).toISOString()} (${g.missingCount} missing)`
      );
    }
  }
  return gaps;
}

export function mergeDedupCandles(parts: BacktestCandle[][]): BacktestCandle[] {
  const map = new Map<number, BacktestCandle>();
  for (const arr of parts) {
    for (const c of arr) {
      if (!c || !Number.isFinite(c.timestamp)) continue;
      map.set(c.timestamp, c);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}
