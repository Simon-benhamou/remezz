import { recordOpsEvent } from '../monitor/ops.js';

type ExecutionTelemetryPoint = {
  symbol: string;
  mode: 'market' | 'limit' | 'twap';
  passiveOffsetBps?: number | null;
  slippageBps?: number | null;
  fillRatio?: number | null;
  latencyMs?: number | null;
  fallbackTriggered?: boolean;
  spreadBps?: number | null;
  notionalUsd?: number | null;
  ts?: number;
};

type ExecutionTelemetryState = {
  updatedAt: number;
  ewSlippageBps: number;
  ewFillRatio: number;
  ewLatencyMs: number;
  ewPassiveOffsetBps: number;
  ewSpreadBps: number;
  ewFallbackRate: number;
  ewNotionalUsd: number;
  samples: number;
};

export type ExecutionTuning = {
  passiveOffsetBps?: number;
  limitFallbackMs?: number;
  twapSliceCount?: number;
  twapIntervalMs?: number;
  preferPassive?: boolean;
  preferAggressive?: boolean;
  modeOverride?: 'market' | 'limit' | 'twap' | null;
};

const store = new Map<string, ExecutionTelemetryState>();
const HALF_LIFE = 10; // approximately the last 10 fills dominate
const DECAY = Math.pow(0.5, 1 / Math.max(HALF_LIFE, 1));

function ensureState(symbol: string): ExecutionTelemetryState {
  const existing = store.get(symbol);
  if (existing) return existing;
  const created: ExecutionTelemetryState = {
    updatedAt: Date.now(),
    ewSlippageBps: 0,
    ewFillRatio: 1,
    ewLatencyMs: 500,
    ewPassiveOffsetBps: 5,
    ewSpreadBps: 8,
    ewFallbackRate: 0,
    ewNotionalUsd: 5_000,
    samples: 0,
  };
  store.set(symbol, created);
  return created;
}

function ewUpdate(current: number, incoming: number, weight: number): number {
  if (!Number.isFinite(incoming)) return current;
  return current * (1 - weight) + incoming * weight;
}

export function updateExecutionTelemetry(symbol: string, payload: ExecutionTelemetryPoint): void {
  const state = ensureState(symbol);
  const weight = state.samples === 0 ? 1 : 1 - DECAY;
  const now = payload.ts ?? Date.now();

  if (payload.slippageBps != null) {
    state.ewSlippageBps = ewUpdate(state.ewSlippageBps, Math.abs(payload.slippageBps), weight);
  }
  if (payload.fillRatio != null) {
    state.ewFillRatio = ewUpdate(state.ewFillRatio, Math.max(0, Math.min(1, payload.fillRatio)), weight);
  }
  if (payload.latencyMs != null) {
    state.ewLatencyMs = ewUpdate(state.ewLatencyMs, Math.max(0, payload.latencyMs), weight);
  }
  if (payload.passiveOffsetBps != null) {
    state.ewPassiveOffsetBps = ewUpdate(state.ewPassiveOffsetBps, Math.max(0, payload.passiveOffsetBps), weight);
  }
  if (payload.spreadBps != null) {
    state.ewSpreadBps = ewUpdate(state.ewSpreadBps, Math.max(0, payload.spreadBps), weight);
  }
  if (payload.notionalUsd != null) {
    state.ewNotionalUsd = ewUpdate(state.ewNotionalUsd, Math.max(0, payload.notionalUsd), weight);
  }
  if (payload.fallbackTriggered != null) {
    state.ewFallbackRate = ewUpdate(state.ewFallbackRate, payload.fallbackTriggered ? 1 : 0, weight);
  }

  state.updatedAt = now;
  state.samples += 1;
}

export function getExecutionTuning(symbol: string): ExecutionTuning {
  const state = store.get(symbol);
  if (!state) return {};

  const tuning: ExecutionTuning = {};
  const fillRatio = state.ewFillRatio;
  const slippage = state.ewSlippageBps;
  const spread = Math.max(1, state.ewSpreadBps || 1);
  const slippageVsSpread = slippage / spread;

  if (fillRatio < 0.4) {
    tuning.passiveOffsetBps = Math.round(Math.min(14, Math.max(6, state.ewPassiveOffsetBps + 2)));
    tuning.limitFallbackMs = Math.round(5_000 + (1 - fillRatio) * 3_000);
    tuning.preferPassive = false;
  } else if (fillRatio > 0.85 && slippage < spread * 0.6) {
    tuning.passiveOffsetBps = Math.round(Math.max(2, state.ewPassiveOffsetBps - 1));
    tuning.preferAggressive = true;
  }

  if (slippageVsSpread > 1.4) {
    tuning.limitFallbackMs = Math.round(6_000 + slippageVsSpread * 1_000);
    tuning.preferPassive = true;
  } else if (slippageVsSpread < 0.6 && fillRatio > 0.75) {
    tuning.limitFallbackMs = Math.round(3_000);
  }

  if (state.ewFallbackRate > 0.4) {
    tuning.modeOverride = 'limit';
  } else if (state.ewFallbackRate < 0.05 && slippageVsSpread < 0.8 && fillRatio > 0.8) {
    tuning.modeOverride = 'market';
  }

  const notional = state.ewNotionalUsd;
  if (notional > 25_000) {
    const slices = Math.min(10, Math.max(4, Math.round(notional / 8_000)));
    tuning.twapSliceCount = slices;
    const baseInterval = Math.min(900, Math.max(250, Math.round(state.ewLatencyMs * 1.5)));
    tuning.twapIntervalMs = baseInterval;
  }

  return tuning;
}

export function getExecutionTelemetryState(symbol: string): ExecutionTelemetryState | null {
  const state = store.get(symbol);
  return state ? { ...state } : null;
}

export function resetExecutionTelemetry(symbol?: string): void {
  if (symbol) {
    store.delete(symbol);
    return;
  }
  store.clear();
}

export function reportExecutionAnomaly(symbol: string, context: Partial<ExecutionTelemetryPoint> & { reason: string }): void {
  recordOpsEvent({
    level: 'warn',
    source: 'execution_telemetry',
    message: context.reason,
    symbol,
    details: {
      slippageBps: context.slippageBps ?? null,
      fillRatio: context.fillRatio ?? null,
      passiveOffsetBps: context.passiveOffsetBps ?? null,
      latencyMs: context.latencyMs ?? null,
      spreadBps: context.spreadBps ?? null,
    },
  });
}

