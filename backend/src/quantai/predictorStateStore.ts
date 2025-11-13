import { createHash } from 'crypto';
import type { PythonPredictionProbabilities, PythonPredictionResult } from './pythonPredictor.js';

const MAX_HISTORY = Number(process.env.PREDICTOR_STATE_HISTORY ?? '5');
const CONSISTENT_COUNT = Math.max(1, Number(process.env.PREDICTOR_STATE_CONSISTENT ?? '2'));
const CONFIDENCE_TOLERANCE = Math.max(0, Number(process.env.PREDICTOR_STATE_CONF_TOLERANCE ?? '0.1'));
const MIN_CONFIDENCE_FOR_STABLE = Math.max(0, Number(process.env.PREDICTOR_STATE_MIN_CONF ?? '0.35'));
const STALE_AFTER_MS = Math.max(60_000, Number(process.env.PREDICTOR_STATE_STALE_MS ?? '900000'));
const HISTORY_TO_PERSIST = Math.max(1, Number(process.env.PREDICTOR_STATE_PERSIST_HISTORY ?? '3'));

type PredictorDecision = 'long' | 'short' | 'none';

type PredictorSource =
  | 'ranking'
  | 'evaluate'
  | 'tick'
  | 'diagnostics'
  | 'manual'
  | `custom:${string}`;

type PredictorCooldown = {
  active: boolean;
  reason: string | null;
  seconds: number | null;
};

export interface PredictorSnapshot {
  symbol: string;
  decision: PredictorDecision;
  confidence: number;
  probabilities: PythonPredictionProbabilities;
  probabilityLong: number;
  probabilityShort: number;
  probabilityNone: number;
  entryWeight: number;
  riskMultiplier: number;
  cooldown: PredictorCooldown;
  classOrder: string[] | null;
  features: Record<string, number> | null;
  featuresHash: string | null;
  source: PredictorSource;
  timestamp: number;
  meta?: Record<string, unknown> | null;
}

interface SymbolState {
  rawHistory: PredictorSnapshot[];
  stableSnapshot: PredictorSnapshot | null;
  updatedAt: number;
}

export interface PredictorPersistencePayload {
  stable: PredictorSnapshot | null;
  history: PredictorSnapshot[];
  updatedAt: number;
}

type RecordPredictionInput = {
  symbol: string;
  prediction: PythonPredictionResult;
  features?: Record<string, number> | null;
  source?: PredictorSource | string;
  timestamp?: number;
  meta?: Record<string, unknown> | null;
};

export interface RecordPredictionResult {
  rawSnapshot: PredictorSnapshot;
  stableSnapshot: PredictorSnapshot;
  stableChanged: boolean;
}

const store = new Map<string, SymbolState>();

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase();
}

function sortFeatureEntries(features: Record<string, number>): Array<[string, number]> {
  return Object.entries(features)
    .filter(([_, value]) => Number.isFinite(value))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function computeFeaturesHash(features?: Record<string, number> | null): string | null {
  if (!features || Object.keys(features).length === 0) {
    return null;
  }
  const entries = sortFeatureEntries(features);
  const hasher = createHash('sha1');
  for (const [key, value] of entries) {
    hasher.update(key);
    hasher.update(':');
    hasher.update(Number(value).toFixed(10));
    hasher.update('|');
  }
  return hasher.digest('hex');
}

function cloneSnapshot(snapshot: PredictorSnapshot): PredictorSnapshot {
  return {
    ...snapshot,
    probabilities: { ...snapshot.probabilities },
    cooldown: { ...snapshot.cooldown },
    features: snapshot.features ? { ...snapshot.features } : null,
    classOrder: snapshot.classOrder ? [...snapshot.classOrder] : null,
    meta: snapshot.meta ? { ...snapshot.meta } : null,
  };
}

function trimHistory(history: PredictorSnapshot[]): PredictorSnapshot[] {
  if (history.length <= MAX_HISTORY) {
    return history;
  }
  return history.slice(0, MAX_HISTORY);
}

function consecutiveCount(history: PredictorSnapshot[], decision: PredictorDecision): number {
  let count = 0;
  for (const entry of history) {
    if (entry.decision === decision) {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

function shouldAdoptStable(
  latest: PredictorSnapshot,
  state: SymbolState,
): boolean {
  const current = state.stableSnapshot;
  if (!current) {
    return true;
  }

  const now = Date.now();
  if (now - current.timestamp >= STALE_AFTER_MS) {
    return true;
  }

  if (latest.decision === current.decision) {
    const confidenceDelta = Math.abs(latest.confidence - current.confidence);
    if (confidenceDelta >= CONFIDENCE_TOLERANCE) {
      return true;
    }

    const probabilityDelta = Math.abs(latest.probabilityLong - current.probabilityLong)
      + Math.abs(latest.probabilityShort - current.probabilityShort)
      + Math.abs(latest.probabilityNone - current.probabilityNone);
    if (probabilityDelta >= CONFIDENCE_TOLERANCE * 2) {
      return true;
    }

    if (latest.featuresHash && latest.featuresHash !== current.featuresHash) {
      return true;
    }

    return false;
  }

  const consistent = consecutiveCount(state.rawHistory, latest.decision) >= CONSISTENT_COUNT;
  if (consistent) {
    if (latest.decision === 'none') {
      return latest.confidence + CONFIDENCE_TOLERANCE <= current.confidence;
    }
    return latest.confidence + CONFIDENCE_TOLERANCE >= current.confidence;
  }

  if (latest.decision !== 'none' && current.decision === 'none') {
    return latest.confidence >= MIN_CONFIDENCE_FOR_STABLE;
  }

  return false;
}

function ensureState(symbol: string): SymbolState {
  const key = normalizeSymbol(symbol);
  const existing = store.get(key);
  if (existing) {
    return existing;
  }
  const created: SymbolState = {
    rawHistory: [],
    stableSnapshot: null,
    updatedAt: 0,
  };
  store.set(key, created);
  return created;
}

function buildSnapshot(
  symbol: string,
  prediction: PythonPredictionResult,
  features: Record<string, number> | null,
  source: PredictorSource,
  timestamp: number,
  meta?: Record<string, unknown> | null,
): PredictorSnapshot {
  const cooldown: PredictorCooldown = {
    active: Boolean(prediction.cooldown?.active),
    reason: typeof prediction.cooldown?.reason === 'string' ? prediction.cooldown.reason : null,
    seconds:
      Number.isFinite(Number(prediction.cooldown?.seconds)) && prediction.cooldown?.seconds != null
        ? Number(prediction.cooldown.seconds)
        : null,
  };

  const mergedMeta = (() => {
    const layers = [prediction.meta, meta] as Array<Record<string, unknown> | null | undefined>;
    const result: Record<string, unknown> = {};
    for (const layer of layers) {
      if (layer && typeof layer === 'object') {
        Object.assign(result, layer);
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  })();

  return {
    symbol,
    decision: prediction.decision,
    confidence: Number.isFinite(prediction.confidence) ? prediction.confidence : 0,
    probabilities: { ...prediction.probabilities },
    probabilityLong: Number.isFinite(prediction.probabilityLong) ? prediction.probabilityLong : prediction.probabilities.long ?? 0,
    probabilityShort: Number.isFinite(prediction.probabilityShort) ? prediction.probabilityShort : prediction.probabilities.short ?? 0,
    probabilityNone: Number.isFinite(prediction.probabilityNone) ? prediction.probabilityNone : prediction.probabilities.none ?? 0,
    entryWeight: Number.isFinite(prediction.entryWeight) ? prediction.entryWeight : 1,
    riskMultiplier: Number.isFinite(prediction.riskMultiplier) ? prediction.riskMultiplier : 1,
    cooldown,
    classOrder: Array.isArray(prediction.classOrder)
      ? prediction.classOrder.filter((item): item is string => typeof item === 'string')
      : null,
    features,
    featuresHash: computeFeaturesHash(features ?? undefined),
    source,
    timestamp,
    meta: mergedMeta,
  };
}

export function recordPrediction(input: RecordPredictionInput): RecordPredictionResult {
  const symbol = normalizeSymbol(input.symbol);
  const source: PredictorSource = (input.source as PredictorSource) ?? 'tick';
  const state = ensureState(symbol);
  const timestamp = input.timestamp ?? Date.now();
  const features = input.features ? { ...input.features } : null;
  const snapshot = buildSnapshot(symbol, input.prediction, features, source, timestamp, input.meta);

  state.rawHistory.unshift(snapshot);
  state.rawHistory = trimHistory(state.rawHistory);

  const adopt = shouldAdoptStable(snapshot, state);
  if (adopt) {
    state.stableSnapshot = snapshot;
  }

  state.updatedAt = Date.now();

  const stable = state.stableSnapshot ?? snapshot;
  return {
    rawSnapshot: snapshot,
    stableSnapshot: stable,
    stableChanged: adopt,
  };
}

export function getStableSnapshot(symbol: string): PredictorSnapshot | null {
  const state = store.get(normalizeSymbol(symbol));
  return state?.stableSnapshot ?? null;
}

export function isSnapshotStale(
  snapshot: PredictorSnapshot,
  options: { maxAgeMs?: number; now?: number } = {},
): boolean {
  const { maxAgeMs = STALE_AFTER_MS, now = Date.now() } = options;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return false;
  }
  const age = Math.max(0, now - snapshot.timestamp);
  return age > maxAgeMs;
}

export function getRawHistory(symbol: string): PredictorSnapshot[] {
  const state = store.get(normalizeSymbol(symbol));
  if (!state) {
    return [];
  }
  return state.rawHistory.map(cloneSnapshot);
}

export function getPredictorState(symbol: string): PredictorPersistencePayload | null {
  const state = store.get(normalizeSymbol(symbol));
  if (!state) {
    return null;
  }
  const history = state.rawHistory
    .slice(0, HISTORY_TO_PERSIST)
    .map(cloneSnapshot);
  const stable = state.stableSnapshot ? cloneSnapshot(state.stableSnapshot) : null;
  return {
    stable,
    history,
    updatedAt: state.updatedAt,
  };
}

export function resetPredictorState(symbol?: string): void {
  if (!symbol) {
    store.clear();
    return;
  }
  store.delete(normalizeSymbol(symbol));
}
