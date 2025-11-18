import { useCallback, useEffect } from 'react';
import { api, getApiKey } from '../api';
import { useSelectorInsightsStore } from '../store';
import type { SelectorDecision, SelectorSnapshot, SelectorSnapshotResponse } from '../types/selector';
import { openWS } from '../ws';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

let selectorWsRef: ReturnType<typeof openWS> | null = null;
let selectorWsSubscribers = 0;

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  const num = toNumber(value, Number.NaN);
  return Number.isNaN(num) ? null : num;
}

function sanitizeDecision(raw: any): SelectorDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const sampleWindows = Array.isArray(raw.sampleWindows)
    ? raw.sampleWindows
        .map((val: any) => toNumber(val, Number.NaN))
        .filter((val: number) => Number.isFinite(val))
        .sort((a: number, b: number) => a - b)
    : [];
  return {
    sessionId: String(raw.sessionId || ''),
    symbol: String(raw.symbol || ''),
    mode: String(raw.mode || ''),
    agentName: String(raw.agentName || raw.agent || 'Agent'),
    agentFamily: raw.agentFamily ?? null,
    regime: raw.regime ?? null,
    totalTrades: toNumber(raw.totalTrades, 0),
    netPnlUsd: toNumber(raw.netPnlUsd, 0),
    winRate: toNumber(raw.winRate, 0),
    avgLatencyMs: toNullableNumber(raw.avgLatencyMs),
    avgSlippageBps: toNullableNumber(raw.avgSlippageBps),
    normalizedScore: toNumber(raw.normalizedScore, 0),
    rawScore: toNullableNumber(raw.rawScore),
    sampleWindows,
    latestBucketStart: toNumber(raw.latestBucketStart, Date.now()),
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    decision: raw.decision ?? 'hold',
  };
}

function sanitizeSnapshot(raw: SelectorSnapshot | SelectorSnapshotResponse['snapshot'] | any): SelectorSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const promotions = Array.isArray(raw.promotions)
    ? raw.promotions.map(sanitizeDecision).filter(Boolean) as SelectorDecision[]
    : [];
  const demotions = Array.isArray(raw.demotions)
    ? raw.demotions.map(sanitizeDecision).filter(Boolean) as SelectorDecision[]
    : [];
  const watchlist = Array.isArray(raw.watchlist)
    ? raw.watchlist.map(sanitizeDecision).filter(Boolean) as SelectorDecision[]
    : [];
  const suppressed = Array.isArray(raw.suppressed)
    ? raw.suppressed.map(sanitizeDecision).filter(Boolean) as SelectorDecision[]
    : [];
  return {
    generatedAt: toNumber(raw.generatedAt, Date.now()),
    source: 'selector_agent',
    combosEvaluated: toNumber(raw.combosEvaluated, promotions.length + demotions.length + watchlist.length + suppressed.length),
    promotions,
    demotions,
    watchlist,
    suppressed,
    stats: {
      lookbackMinutes: toNumber(raw.stats?.lookbackMinutes, 0),
      minTrades: toNumber(raw.stats?.minTrades, 0),
      promoteThreshold: toNumber(raw.stats?.promoteThreshold, 0),
      demoteThreshold: toNumber(raw.stats?.demoteThreshold, 0),
    },
  };
}

function handleSelectorMessage(msg: any) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type !== 'selector.snapshot') return;
  const snapshot = sanitizeSnapshot(msg);
  if (!snapshot) return;
  useSelectorInsightsStore.getState().setSnapshot(snapshot, {
    reason: typeof msg.reason === 'string' ? msg.reason : undefined,
    updatedAt: Date.now(),
  });
}

function ensureSelectorWs() {
  if (selectorWsRef) return;
  const token = getApiKey();
  selectorWsRef = openWS(API_BASE, token, undefined, handleSelectorMessage);
}

function releaseSelectorWs() {
  if (selectorWsSubscribers > 0) return;
  if (!selectorWsRef) return;
  try { selectorWsRef.close(); } catch {}
  selectorWsRef = null;
}

export function useSelectorInsights(options?: { refreshIntervalMs?: number; enableLive?: boolean }) {
  const { snapshot, loading, error, lastUpdated, lastReason } = useSelectorInsightsStore((state) => ({
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    lastReason: state.lastReason,
  }));
  const setSnapshot = useSelectorInsightsStore((state) => state.setSnapshot);
  const setLoading = useSelectorInsightsStore((state) => state.setLoading);
  const setError = useSelectorInsightsStore((state) => state.setError);

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true);
    try {
      const resp = await api.getSelectorSnapshot({ force: opts?.force });
      const sanitized = sanitizeSnapshot(resp?.snapshot);
      setSnapshot(sanitized, {
        reason: resp?.reason,
        updatedAt: resp?.refreshedAt ?? Date.now(),
      });
    } catch (err) {
      console.error('Failed to load selector snapshot:', err);
      const message = err instanceof Error ? err.message : 'Unable to load learning data';
      setError(message);
    }
  }, [setLoading, setSnapshot, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!options?.refreshIntervalMs) return;
    const interval = setInterval(() => {
      void refresh();
    }, Math.max(15_000, options.refreshIntervalMs));
    return () => clearInterval(interval);
  }, [options?.refreshIntervalMs, refresh]);

  useEffect(() => {
    if (!options?.enableLive) return;
    selectorWsSubscribers += 1;
    ensureSelectorWs();
    return () => {
      selectorWsSubscribers = Math.max(0, selectorWsSubscribers - 1);
      if (selectorWsSubscribers === 0) {
        releaseSelectorWs();
      }
    };
  }, [options?.enableLive]);

  return {
    snapshot,
    loading,
    error,
    lastUpdated,
    lastReason,
    refresh,
  };
}
