import { randomUUID } from 'node:crypto';
import {
  FrameSource,
  ValidationRuleId,
  computeInputHash,
} from '../data/tickerValidation.js';

export type FrameStatus = 'accepted' | 'stale' | 'rejected';

interface SourceCounters {
  received: number;
  accepted: number;
  rejected: number;
  stale: number;
}

interface SymbolMetrics {
  key: string;
  displaySymbol: string;
  framesReceived: number;
  framesAccepted: number;
  framesRejected: number;
  framesStale: number;
  framesRejectedByRule: Record<string, number>;
  framesBySource: Record<FrameSource, SourceCounters>;
  lastReceivedTs: number | null;
  lastAcceptedTs: number | null;
  lastStaleTs: number | null;
  lastStatus: FrameStatus | null;
  lastSource: FrameSource | null;
  lastDataAgeMs: number;
  maxDataAgeMs: number;
  fallbackActive: boolean;
  fallbackReason?: string;
  fallbackCount: number;
  lastFallbackTs: number | null;
  reconnects: number;
}

export interface MarketFrameEvent {
  symbol: string;
  displaySymbol?: string;
  source: FrameSource;
  status: FrameStatus;
  ruleId?: ValidationRuleId | 'stale_frame';
  receivedTs: number;
  eventTs: number;
  dataAgeMs: number;
  expectedSymbolId?: string;
  agentId?: string;
  rawFrame?: unknown;
  traceId?: string;
  extra?: Record<string, unknown>;
}

export interface SymbolMetricsSnapshot {
  symbol: string;
  key: string;
  framesReceived: number;
  framesAccepted: number;
  framesRejected: number;
  framesStale: number;
  framesRejectedByRule: Record<string, number>;
  framesBySource: Record<FrameSource, SourceCounters>;
  lastReceivedTs: number | null;
  lastAcceptedTs: number | null;
  lastStaleTs: number | null;
  lastStatus: FrameStatus | null;
  lastSource: FrameSource | null;
  lastDataAgeMs: number;
  maxDataAgeMs: number;
  fallbackActive: boolean;
  fallbackReason?: string;
  fallbackCount: number;
  fallbackAgeMs: number | null;
  reconnects: number;
  staleForMs: number | null;
}

export interface LegacySymbolMetrics {
  wsFrames: number;
  invalidFrames: number;
  restFallbacks: number;
  lastWsMessageTs: number;
  lastValidMessageTs: number;
  reconnects: number;
}

export interface MarketMetricsSnapshot {
  ws: {
    connected: boolean;
    healthy: boolean;
    lastConnectTs: number | null;
    lastDisconnectTs: number | null;
    reconnects: number;
    lastStatusChangeTs: number | null;
  };
  totals: {
    restFallbacks: number;
  };
  symbols: Record<string, SymbolMetricsSnapshot>;
  legacy: Record<string, LegacySymbolMetrics>;
}

const metricsBySymbol: Map<string, SymbolMetrics> = new Map();

const wsState = {
  connected: false,
  healthy: false,
  lastConnectTs: null as number | null,
  lastDisconnectTs: null as number | null,
  lastStatusChangeTs: null as number | null,
  reconnects: 0,
};

const totals = {
  restFallbacks: 0,
};

const LOG_THROTTLE_MS = Math.max(0, Number(process.env.MARKET_METRICS_LOG_THROTTLE_MS || 60000));
const lastLogAtByKey = new Map<string, number>();

function normalizeSymbolId(value: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return 'UNKNOWN';
  const normalized = trimmed.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return normalized || trimmed.toUpperCase();
}

function createSourceCounters(): Record<FrameSource, SourceCounters> {
  return {
    WS: { received: 0, accepted: 0, rejected: 0, stale: 0 },
    REST: { received: 0, accepted: 0, rejected: 0, stale: 0 },
  };
}

function ensureSymbolMetrics(symbol: string, displaySymbol?: string): SymbolMetrics {
  const key = normalizeSymbolId(symbol);
  let entry = metricsBySymbol.get(key);
  if (!entry) {
    entry = {
      key,
      displaySymbol: displaySymbol ?? symbol,
      framesReceived: 0,
      framesAccepted: 0,
      framesRejected: 0,
      framesStale: 0,
      framesRejectedByRule: Object.create(null),
      framesBySource: createSourceCounters(),
      lastReceivedTs: null,
      lastAcceptedTs: null,
      lastStaleTs: null,
      lastStatus: null,
      lastSource: null,
      lastDataAgeMs: 0,
      maxDataAgeMs: 0,
      fallbackActive: false,
      fallbackReason: undefined,
      fallbackCount: 0,
      lastFallbackTs: null,
      reconnects: 0,
    };
    metricsBySymbol.set(key, entry);
  } else if (displaySymbol) {
    const wantDisplay =
      !entry.displaySymbol ||
      entry.displaySymbol === entry.key ||
      (!entry.displaySymbol.includes('/') && displaySymbol.includes('/'));
    if (wantDisplay) {
      entry.displaySymbol = displaySymbol;
    }
  }
  return entry;
}

function activateFallback(entry: SymbolMetrics, reason?: string, increment = false) {
  entry.fallbackActive = true;
  entry.fallbackReason = reason;
  entry.lastFallbackTs = Date.now();
  if (increment) {
    entry.fallbackCount += 1;
  }
}

function logFrameEvent(event: MarketFrameEvent, entry: SymbolMetrics): string | undefined {
  if (event.status === 'accepted') return undefined;
  if (LOG_THROTTLE_MS > 0) {
    const throttleKey = `${entry.key}:${event.ruleId || event.status}:${event.source}`;
    const now = Date.now();
    const last = lastLogAtByKey.get(throttleKey) || 0;
    if (now - last < LOG_THROTTLE_MS) {
      return undefined;
    }
    lastLogAtByKey.set(throttleKey, now);
  }
  const traceId = event.traceId || randomUUID();
  const payload: Record<string, unknown> = {
    level: event.status === 'rejected' ? 'error' : 'warn',
    event: event.status === 'rejected' ? 'market_frame_rejected' : 'market_frame_stale',
    traceId,
    agentId: event.agentId || null,
    symbol: entry.displaySymbol,
    symbolKey: entry.key,
    source: event.source,
    status: event.status,
    rule: event.ruleId || null,
    ts_recv: event.receivedTs,
    ts_emit: Date.now(),
    data_age_ms: event.dataAgeMs,
    expected_symbol: event.expectedSymbolId || null,
  };
  if (event.rawFrame !== undefined) {
    payload.frame_hash = computeInputHash(event.rawFrame);
  }
  if (event.extra) {
    payload.extra = event.extra;
  }
  const logger = event.status === 'rejected' ? console.error : console.warn;
  logger(JSON.stringify(payload));
  return traceId;
}

export function recordMarketFrame(event: MarketFrameEvent): string | undefined {
  const symbolKey = event.symbol || event.displaySymbol || 'UNKNOWN';
  const entry = ensureSymbolMetrics(symbolKey, event.displaySymbol);
  const now = Date.now();

  entry.framesReceived += 1;
  entry.framesBySource[event.source].received += 1;
  entry.lastReceivedTs = event.receivedTs;
  entry.lastSource = event.source;
  entry.lastStatus = event.status;
  entry.lastDataAgeMs = event.dataAgeMs;
  entry.maxDataAgeMs = Math.max(entry.maxDataAgeMs, event.dataAgeMs);

  if (event.status === 'accepted') {
    entry.framesAccepted += 1;
    entry.framesBySource[event.source].accepted += 1;
    entry.lastAcceptedTs = event.receivedTs;
    if (event.source === 'WS') {
      entry.fallbackActive = false;
      entry.fallbackReason = undefined;
      entry.lastFallbackTs = null;
    } else if (event.source === 'REST') {
      activateFallback(entry, event.ruleId === 'stale_frame' ? 'rest_stale' : 'rest_frame', false);
    }
  } else if (event.status === 'stale') {
    entry.framesStale += 1;
    entry.framesBySource[event.source].stale += 1;
    entry.lastStaleTs = event.receivedTs;
  } else {
    entry.framesRejected += 1;
    entry.framesBySource[event.source].rejected += 1;
    if (event.ruleId) {
      entry.framesRejectedByRule[event.ruleId] =
        (entry.framesRejectedByRule[event.ruleId] || 0) + 1;
    }
  }

  if (event.status !== 'accepted' && event.source === 'WS') {
    // leave fallback state untouched here; dedicated fallback handlers manage activation.
    // we still track last fallback timestamp if already active
    if (entry.fallbackActive && entry.lastFallbackTs === null) {
      entry.lastFallbackTs = now;
    }
  }

  return logFrameEvent(event, entry);
}

export function recordRestFallback(symbol: string, reason?: string): void {
  const entry = ensureSymbolMetrics(symbol);
  activateFallback(entry, reason || 'rest_fallback', true);
  totals.restFallbacks += 1;
  console.warn(
    JSON.stringify({
      event: 'rest_fallback',
      symbol: entry.displaySymbol,
      reason: reason || 'unknown',
      ts: Date.now(),
    }),
  );
}

export function setFallbackState(
  symbol: string,
  active: boolean,
  reason?: string,
  opts?: { increment?: boolean },
): void {
  const entry = ensureSymbolMetrics(symbol);
  if (active) {
    activateFallback(entry, reason, opts?.increment ?? false);
  } else {
    entry.fallbackActive = false;
    entry.fallbackReason = undefined;
    entry.lastFallbackTs = null;
  }
}

export function recordWsReconnect(symbolOrContext: string): void {
  wsState.reconnects += 1;
  wsState.lastStatusChangeTs = Date.now();
  const entry = ensureSymbolMetrics(symbolOrContext);
  entry.reconnects += 1;
}

export function updateWsConnectionState(state: { connected: boolean; healthy?: boolean; reason?: string }): void {
  const now = Date.now();
  wsState.connected = state.connected;
  if (typeof state.healthy === 'boolean') {
    wsState.healthy = state.healthy;
  }
  wsState.lastStatusChangeTs = now;
  if (state.connected) {
    wsState.lastConnectTs = now;
  } else {
    wsState.lastDisconnectTs = now;
  }
  if (state.reason) {
    console.warn(
      JSON.stringify({
        event: 'ws_state_change',
        connected: state.connected,
        healthy: wsState.healthy,
        reason: state.reason,
        ts: now,
      }),
    );
  }
}

export function getMarketMetrics(): MarketMetricsSnapshot {
  const now = Date.now();
  const symbols: Record<string, SymbolMetricsSnapshot> = {};
  const legacy: Record<string, LegacySymbolMetrics> = {};
  let globalWsFrames = 0;
  let globalInvalid = 0;
  let globalLastWsTs = 0;
  let globalLastValidTs = 0;

  for (const entry of metricsBySymbol.values()) {
    symbols[entry.displaySymbol] = {
      symbol: entry.displaySymbol,
      key: entry.key,
      framesReceived: entry.framesReceived,
      framesAccepted: entry.framesAccepted,
      framesRejected: entry.framesRejected,
      framesStale: entry.framesStale,
      framesRejectedByRule: { ...entry.framesRejectedByRule },
      framesBySource: {
        WS: { ...entry.framesBySource.WS },
        REST: { ...entry.framesBySource.REST },
      },
      lastReceivedTs: entry.lastReceivedTs,
      lastAcceptedTs: entry.lastAcceptedTs,
      lastStaleTs: entry.lastStaleTs,
      lastStatus: entry.lastStatus,
      lastSource: entry.lastSource,
      lastDataAgeMs: entry.lastDataAgeMs,
      maxDataAgeMs: entry.maxDataAgeMs,
      fallbackActive: entry.fallbackActive,
      fallbackReason: entry.fallbackReason,
      fallbackCount: entry.fallbackCount,
      fallbackAgeMs:
        entry.fallbackActive && entry.lastFallbackTs !== null
          ? now - entry.lastFallbackTs
          : null,
      reconnects: entry.reconnects,
      staleForMs:
        entry.lastAcceptedTs !== null ? Math.max(0, now - entry.lastAcceptedTs) : null,
    };
    legacy[entry.key] = {
      wsFrames: entry.framesBySource.WS.received,
      invalidFrames: entry.framesRejected,
      restFallbacks: entry.framesBySource.REST.received,
      lastWsMessageTs: entry.lastReceivedTs ?? 0,
      lastValidMessageTs: entry.lastAcceptedTs ?? 0,
      reconnects: entry.reconnects,
    };
    globalWsFrames += entry.framesBySource.WS.received;
    globalInvalid += entry.framesRejected;
    globalLastWsTs = Math.max(globalLastWsTs, entry.lastReceivedTs ?? 0);
    globalLastValidTs = Math.max(globalLastValidTs, entry.lastAcceptedTs ?? 0);
  }

  legacy.global = {
    wsFrames: globalWsFrames,
    invalidFrames: globalInvalid,
    restFallbacks: totals.restFallbacks,
    lastWsMessageTs: globalLastWsTs,
    lastValidMessageTs: globalLastValidTs,
    reconnects: wsState.reconnects,
  };

  return {
    ws: {
      connected: wsState.connected,
      healthy: wsState.healthy,
      lastConnectTs: wsState.lastConnectTs,
      lastDisconnectTs: wsState.lastDisconnectTs,
      reconnects: wsState.reconnects,
      lastStatusChangeTs: wsState.lastStatusChangeTs,
    },
    totals: {
      restFallbacks: totals.restFallbacks,
    },
    symbols,
    legacy,
  };
}
