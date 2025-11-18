import { useCallback, useEffect } from 'react';
import { api, getApiKey } from '../api';
import { useSelectorInsightsStore, useSubagentLearningStore } from '../store';
import type { SelectorDecision, SelectorSnapshot, SelectorSnapshotResponse } from '../types/selector';
import type {
  ExecutionLearningRecommendation,
  MarketQualityLearningRecommendation,
  PredictorLearningRecommendation,
  RiskLearningRecommendation,
  SentimentLearningRecommendation,
  SubagentKind,
  SubagentLearningData,
  SubagentLearningRecord,
  SubagentLearningSnapshot,
  SubagentLearningRecommendations,
  SubagentMetrics,
} from '../types/subagentLearning';
import { openWS } from '../ws';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

let insightsWsRef: ReturnType<typeof openWS> | null = null;
let insightsWsSubscribers = 0;
const EXEC_MODES: ExecutionLearningRecommendation['preferredMode'][] = ['market', 'sweep', 'iceberg', 'twap'];

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

function sanitizeNumberArray(list: any): number[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((value) => toNumber(value, Number.NaN))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function sanitizeStringArray(list: any): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((value) => (typeof value === 'string' ? value : String(value ?? '')).trim())
    .filter(Boolean)
    .slice(0, 20);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeRiskRecommendation(raw: any): RiskLearningRecommendation {
  return {
    recommendedMaxLeverage: Number(toNumber(raw?.recommendedMaxLeverage, 1).toFixed(2)),
    recommendedMaxPositionPct: Number(toNumber(raw?.recommendedMaxPositionPct, 0.1).toFixed(3)),
    hedgingTension: Number(clamp(toNumber(raw?.hedgingTension, 0), 0, 1).toFixed(3)),
    confidence: Number(clamp(toNumber(raw?.confidence, 0), 0, 1).toFixed(3)),
  };
}

function sanitizeExecutionRecommendation(raw: any): ExecutionLearningRecommendation {
  const preferred = typeof raw?.preferredMode === 'string' && EXEC_MODES.includes(raw.preferredMode)
    ? raw.preferredMode
    : undefined;
  return {
    preferredMode: preferred,
    passiveBias: Number(clamp(toNumber(raw?.passiveBias, 0.5), 0, 1).toFixed(3)),
    fallbackMs: Number.isFinite(toNumber(raw?.fallbackMs, Number.NaN)) ? Math.round(toNumber(raw?.fallbackMs, 2500)) : undefined,
    twapSliceMultiplier: Number(clamp(toNumber(raw?.twapSliceMultiplier, 1), 0.2, 3).toFixed(2)),
    confidence: Number(clamp(toNumber(raw?.confidence, 0), 0, 1).toFixed(3)),
  };
}

function sanitizePredictorRecommendation(raw: any): PredictorLearningRecommendation {
  const rawAction = typeof raw?.action === 'string' ? raw.action : 'healthy';
  const action: PredictorLearningRecommendation['action'] = rawAction === 'monitor' || rawAction === 'retrain'
    ? rawAction
    : 'healthy';
  return {
    action,
    confidenceModifier: Number(clamp(toNumber(raw?.confidenceModifier, 1), 0.1, 2).toFixed(3)),
    forceFresh: Boolean(raw?.forceFresh) || action !== 'healthy',
    cacheTtlMultiplier: Number(clamp(toNumber(raw?.cacheTtlMultiplier, 1), 0.25, 2).toFixed(2)),
    reason: typeof raw?.reason === 'string' ? raw.reason : '',
  };
}

function sanitizeSentimentRecommendation(raw: any): SentimentLearningRecommendation {
  return {
    signalWeight: Number(clamp(toNumber(raw?.signalWeight, 0.4), 0, 1).toFixed(3)),
    cooldownMs: Math.round(clamp(toNumber(raw?.cooldownMs, 20000), 5_000, 60_000)),
    newsHeatWeight: Number(clamp(toNumber(raw?.newsHeatWeight, 0.4), 0, 1).toFixed(3)),
    confidence: Number(clamp(toNumber(raw?.confidence, 0), 0, 1).toFixed(3)),
  };
}

function sanitizeMarketQualityRecommendation(raw: any): MarketQualityLearningRecommendation {
  return {
    minScore: Number(clamp(toNumber(raw?.minScore, 0.4), 0, 1).toFixed(2)),
    liquidityFloorUsd: Math.max(0, Math.round(toNumber(raw?.liquidityFloorUsd, 50000))),
    spreadCeilBps: Math.max(1, Math.round(toNumber(raw?.spreadCeilBps, 12))),
    confidence: Number(clamp(toNumber(raw?.confidence, 0), 0, 1).toFixed(3)),
  };
}

function sanitizeMetrics(raw: any): SubagentMetrics {
  return {
    tradeCount: Math.max(0, Math.round(toNumber(raw?.tradeCount, 0))),
    winRate: Number(clamp(toNumber(raw?.winRate, 0), 0, 1).toFixed(4)),
    normalizedScore: Number(clamp(toNumber(raw?.normalizedScore, 0), -1, 1).toFixed(4)),
    netPnlUsd: Number(toNumber(raw?.netPnlUsd, 0).toFixed(2)),
    avgLatencyMs: Number.isFinite(toNumber(raw?.avgLatencyMs, Number.NaN)) ? Number(toNumber(raw?.avgLatencyMs, 0).toFixed(1)) : null,
    avgSlippageBps: Number.isFinite(toNumber(raw?.avgSlippageBps, Number.NaN)) ? Number(toNumber(raw?.avgSlippageBps, 0).toFixed(2)) : null,
    avgDrawdownPct: Number.isFinite(toNumber(raw?.avgDrawdownPct, Number.NaN)) ? Number(toNumber(raw?.avgDrawdownPct, 0).toFixed(2)) : null,
    complianceRate: Number(clamp(toNumber(raw?.complianceRate, 0), 0, 1).toFixed(4)),
    sampleWindows: sanitizeNumberArray(raw?.sampleWindows),
    agentFamilies: sanitizeStringArray(raw?.agentFamilies),
  };
}

function sanitizeTuning<K extends SubagentKind>(kind: K, raw: any): SubagentLearningRecommendations[K] {
  switch (kind) {
    case 'risk_governor':
      return sanitizeRiskRecommendation(raw) as SubagentLearningRecommendations[K];
    case 'execution':
      return sanitizeExecutionRecommendation(raw) as SubagentLearningRecommendations[K];
    case 'predictor':
      return sanitizePredictorRecommendation(raw) as SubagentLearningRecommendations[K];
    case 'sentiment':
      return sanitizeSentimentRecommendation(raw) as SubagentLearningRecommendations[K];
    case 'market_quality':
      return sanitizeMarketQualityRecommendation(raw) as SubagentLearningRecommendations[K];
    default:
      return raw as SubagentLearningRecommendations[K];
  }
}

function sanitizeLearningRecord<K extends SubagentKind>(raw: any, kind: K): SubagentLearningRecord<K> | null {
  if (!raw || typeof raw !== 'object') return null;
  const symbol = typeof raw.symbol === 'string' ? raw.symbol : '';
  if (!symbol) return null;
  const mode = typeof raw.mode === 'string' && raw.mode.trim().length ? raw.mode : 'paper';
  const regime = typeof raw.regime === 'string' && raw.regime.trim().length ? raw.regime : 'default';
  const metrics = sanitizeMetrics(raw.metrics ?? raw);
  const tuning = sanitizeTuning(kind, raw.tuning ?? raw.recommendation ?? {});
  return {
    subagent: kind,
    symbol,
    mode,
    regime,
    score: Number(toNumber(raw.score, 0).toFixed(4)),
    sampleCount: Math.max(0, Math.round(toNumber(raw.sampleCount, metrics.tradeCount ?? 0))),
    metrics,
    tuning,
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  } as SubagentLearningRecord<K>;
}

function sanitizeLearningArray<K extends keyof SubagentLearningData>(raw: any, kind: SubagentKind): SubagentLearningData[K] {
  if (!Array.isArray(raw)) return [] as SubagentLearningData[K];
  return raw
    .map((row) => sanitizeLearningRecord(row, kind))
    .filter(Boolean) as SubagentLearningData[K];
}

function sanitizeSubagentSnapshot(raw: any): SubagentLearningSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  const snapshot: SubagentLearningSnapshot = {
    generatedAt: toNumber(raw.generatedAt, Date.now()),
    lookbackMinutes: Math.max(0, Math.round(toNumber(raw.lookbackMinutes, 0))),
    combosEvaluated: Math.max(0, Math.round(toNumber(raw.combosEvaluated, 0))),
    data: {
      risk: sanitizeLearningArray<'risk'>(data.risk, 'risk_governor'),
      execution: sanitizeLearningArray<'execution'>(data.execution, 'execution'),
      predictor: sanitizeLearningArray<'predictor'>(data.predictor, 'predictor'),
      sentiment: sanitizeLearningArray<'sentiment'>(data.sentiment, 'sentiment'),
      marketQuality: sanitizeLearningArray<'marketQuality'>(data.marketQuality ?? data.market_quality, 'market_quality'),
    },
  };
  return snapshot;
}

function handleInsightsMessage(msg: any) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'selector.snapshot') {
    const snapshot = sanitizeSnapshot(msg);
    if (!snapshot) return;
    useSelectorInsightsStore.getState().setSnapshot(snapshot, {
      reason: typeof msg.reason === 'string' ? msg.reason : undefined,
      updatedAt: Date.now(),
    });
    return;
  }
  if (msg.type === 'learning.subagents') {
    const snapshot = sanitizeSubagentSnapshot(msg.data ?? msg.snapshot ?? msg);
    if (!snapshot) return;
    useSubagentLearningStore.getState().setSnapshot(snapshot, {
      reason: typeof msg.reason === 'string' ? msg.reason : undefined,
      updatedAt: Date.now(),
    });
  }
}

function ensureInsightsWs() {
  if (insightsWsRef) return;
  const token = getApiKey();
  insightsWsRef = openWS(API_BASE, token, undefined, handleInsightsMessage);
}

function releaseInsightsWs() {
  if (insightsWsSubscribers > 0) return;
  if (!insightsWsRef) return;
  try { insightsWsRef.close(); } catch {}
  insightsWsRef = null;
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
    insightsWsSubscribers += 1;
    ensureInsightsWs();
    return () => {
      insightsWsSubscribers = Math.max(0, insightsWsSubscribers - 1);
      if (insightsWsSubscribers === 0) {
        releaseInsightsWs();
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

export function useSubagentLearningInsights(options?: { refreshIntervalMs?: number; enableLive?: boolean }) {
  const { snapshot, loading, error, lastUpdated, lastReason } = useSubagentLearningStore((state) => ({
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
    lastReason: state.lastReason,
  }));
  const setSnapshot = useSubagentLearningStore((state) => state.setSnapshot);
  const setLoading = useSubagentLearningStore((state) => state.setLoading);
  const setError = useSubagentLearningStore((state) => state.setError);

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    setLoading(true);
    try {
      const resp = await api.getSubagentLearningSnapshot({ force: opts?.force });
      const sanitized = sanitizeSubagentSnapshot(resp?.snapshot);
      setSnapshot(sanitized, {
        reason: resp?.reason ?? (resp?.fromCache ? 'cached' : undefined),
        updatedAt: sanitized?.generatedAt ?? Date.now(),
      });
    } catch (err) {
      console.error('Failed to load subagent learning snapshot:', err);
      const message = err instanceof Error ? err.message : 'Unable to load subagent learning data';
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
    }, Math.max(30_000, options.refreshIntervalMs));
    return () => clearInterval(interval);
  }, [options?.refreshIntervalMs, refresh]);

  useEffect(() => {
    if (!options?.enableLive) return;
    insightsWsSubscribers += 1;
    ensureInsightsWs();
    return () => {
      insightsWsSubscribers = Math.max(0, insightsWsSubscribers - 1);
      if (insightsWsSubscribers === 0) {
        releaseInsightsWs();
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
