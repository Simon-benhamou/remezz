import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type IncoherenceSeverity = 'info' | 'low' | 'moderate' | 'high' | 'critical';
export type IncoherenceCategory = 'predictor' | 'strategy' | 'execution' | 'state' | 'data' | 'ops';

export type IncoherenceEvent = {
  id: string;
  ts: number;
  severity: IncoherenceSeverity;
  category: IncoherenceCategory;
  code: string;
  message: string;
  sessionId?: string | null;
  symbol?: string | null;
  source?: string | null;
  requiresAction?: boolean;
  details?: Record<string, unknown> | null;
  tags?: string[];
};

export type IncoherenceEventInput = {
  severity?: IncoherenceSeverity;
  category: IncoherenceCategory;
  code: string;
  message: string;
  sessionId?: string | null;
  symbol?: string | null;
  source?: string | null;
  requiresAction?: boolean;
  details?: Record<string, unknown> | null;
  tags?: string[];
};

export type IncoherenceSummary = {
  total: number;
  windowMs: number | null;
  bySeverity: Record<IncoherenceSeverity, number>;
  byCategory: Record<IncoherenceCategory, number>;
  topSessions: Array<{
    sessionId: string | null;
    symbol: string | null;
    count: number;
    lastEventTs: number;
  }>;
  topCodes: Array<{ code: string; count: number }>;
  newest?: IncoherenceEvent | null;
};

export type IncoherenceBundle = {
  formatVersion: 1;
  generatedAt: number;
  count: number;
  summary: IncoherenceSummary;
  events: IncoherenceEvent[];
};

const FEED_LIMIT = Math.max(50, Number(process.env.INCOHERENCE_FEED_LIMIT ?? '400'));
const DEDUPE_MS = Math.max(2_000, Number(process.env.INCOHERENCE_DEDUPE_MS ?? '15000'));

const feed: IncoherenceEvent[] = [];
const emitter = new EventEmitter();
const dedupe = new Map<string, number>();

function buildSignature(input: IncoherenceEventInput): string {
  const session = input.sessionId || 'global';
  const symbol = input.symbol || 'nosym';
  return `${session}|${symbol}|${input.category}|${input.code}|${input.message}`;
}

function shouldDeduplicate(input: IncoherenceEventInput, now: number): boolean {
  const signature = buildSignature(input);
  const lastTs = dedupe.get(signature);
  if (lastTs != null && now - lastTs < DEDUPE_MS) {
    return true;
  }
  dedupe.set(signature, now);
  if (dedupe.size > FEED_LIMIT * 4) {
    for (const [key, ts] of dedupe.entries()) {
      if (now - ts > DEDUPE_MS) {
        dedupe.delete(key);
      }
    }
  }
  return false;
}

export function recordIncoherenceEvent(input: IncoherenceEventInput): IncoherenceEvent | null {
  const now = Date.now();
  if (shouldDeduplicate(input, now)) {
    return null;
  }
  const event: IncoherenceEvent = {
    id: `inc_${now}_${Math.random().toString(36).slice(2, 8)}`,
    ts: now,
    severity: input.severity ?? 'moderate',
    category: input.category,
    code: input.code,
    message: input.message,
    sessionId: input.sessionId ?? null,
    symbol: input.symbol ?? null,
    source: input.source ?? null,
    requiresAction: input.requiresAction ?? false,
    details: input.details ?? null,
    tags: input.tags?.length ? Array.from(new Set(input.tags)) : undefined,
  };
  feed.push(event);
  if (feed.length > FEED_LIMIT) {
    feed.splice(0, feed.length - FEED_LIMIT);
  }
  emitter.emit('event', event);
  return event;
}

export function onIncoherenceEvent(listener: (event: IncoherenceEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export function getIncoherenceFeed(options: {
  limit?: number;
  sessionId?: string;
  symbol?: string;
  category?: IncoherenceCategory;
  severity?: IncoherenceSeverity;
  since?: number;
} = {}): IncoherenceEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, FEED_LIMIT));
  const slice = feed.slice(-FEED_LIMIT);
  const filtered = slice.filter((event) => {
    if (options.sessionId && event.sessionId !== options.sessionId) return false;
    if (options.symbol && event.symbol !== options.symbol) return false;
    if (options.category && event.category !== options.category) return false;
    if (options.severity && event.severity !== options.severity) return false;
    if (options.since && event.ts < options.since) return false;
    return true;
  });
  return filtered.slice(-limit).reverse();
}

function buildSummary(events: IncoherenceEvent[], windowMs: number | null): IncoherenceSummary {
  const bySeverity = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
  } satisfies Record<IncoherenceSeverity, number>;
  const byCategory = {
    predictor: 0,
    strategy: 0,
    execution: 0,
    state: 0,
    data: 0,
    ops: 0,
  } satisfies Record<IncoherenceCategory, number>;

  const sessions = new Map<string, { count: number; symbol: string | null; lastEventTs: number }>();
  const codes = new Map<string, number>();
  let newest: IncoherenceEvent | null = null;

  for (const event of events) {
    bySeverity[event.severity] += 1;
    byCategory[event.category] += 1;
    const sessionKey = event.sessionId || 'global';
    const entry = sessions.get(sessionKey) ?? { count: 0, symbol: event.symbol ?? null, lastEventTs: 0 };
    entry.count += 1;
    if (event.ts > entry.lastEventTs) {
      entry.lastEventTs = event.ts;
      entry.symbol = event.symbol ?? entry.symbol ?? null;
    }
    sessions.set(sessionKey, entry);
    codes.set(event.code, (codes.get(event.code) ?? 0) + 1);
    if (!newest || event.ts > newest.ts) {
      newest = event;
    }
  }

  const topSessions = Array.from(sessions.entries())
    .map(([sessionId, data]) => ({ sessionId: sessionId === 'global' ? null : sessionId, symbol: data.symbol ?? null, count: data.count, lastEventTs: data.lastEventTs }))
    .sort((a, b) => (b.count - a.count) || (b.lastEventTs - a.lastEventTs))
    .slice(0, 10);

  const topCodes = Array.from(codes.entries())
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total: events.length,
    windowMs,
    bySeverity,
    byCategory,
    topSessions,
    topCodes,
    newest,
  };
}

export function getIncoherenceSummary(options: { windowMs?: number } = {}): IncoherenceSummary {
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : null;
  const now = Date.now();
  const events = windowMs
    ? feed.filter((event) => event.ts >= now - windowMs)
    : feed.slice(-FEED_LIMIT);
  return buildSummary(events, windowMs);
}

export function exportIncoherenceBundle(options: {
  limit?: number;
  windowMs?: number;
  sessionId?: string;
} = {}): IncoherenceBundle {
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : null;
  const now = Date.now();
  const filtered = getIncoherenceFeed({
    limit: options.limit ?? FEED_LIMIT,
    sessionId: options.sessionId,
    since: windowMs ? now - windowMs : undefined,
  }).reverse();
  return {
    formatVersion: 1,
    generatedAt: now,
    count: filtered.length,
    summary: buildSummary(filtered, windowMs),
    events: filtered,
  };
}

export async function persistIncoherenceBundleToFile(options: {
  filePath?: string;
  limit?: number;
  windowMs?: number;
} = {}): Promise<IncoherenceBundle> {
  const bundle = exportIncoherenceBundle({ limit: options.limit, windowMs: options.windowMs });
  const targetPath = options.filePath
    ? path.resolve(options.filePath)
    : path.resolve(process.cwd(), 'logs', 'incoherence-feed.json');
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(bundle, null, 2), 'utf8');
  return bundle;
}

export function clearIncoherenceFeed() {
  feed.splice(0, feed.length);
  dedupe.clear();
}
