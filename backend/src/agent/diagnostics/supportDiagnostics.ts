import type { AgentActionIntent } from '../actions/types.js';
import type { ActivationProfile, DiagnosticBlocker } from '../state.js';
import type { AgentSupportState } from '../hub.js';
import { getConfig } from '../../utils/env.js';

type SnapshotStatus = 'missing' | 'stale' | 'fresh';

type SnapshotDiagnostics<T> = {
  status: SnapshotStatus;
  ageMs: number | null;
  updatedAt: number | null;
  staleAfterMs: number;
  data: T | null;
};

const FRESHNESS_THRESHOLDS_MS = {
  marketQuality: 90_000,
  sentiment: 120_000,
  riskLimits: 150_000,
  executionPlan: 180_000,
  predictor: 6 * 60_000,
  decisions: 90_000,
  actions: 90_000,
} as const;

type SnapshotKeys = keyof typeof FRESHNESS_THRESHOLDS_MS;

type SnapshotInput<T> = { data: T; updatedAt: number } | undefined;

type ExtractSnapshotData<T> = T extends { data: infer D } ? D : never;

type DecisionsData = ExtractSnapshotData<AgentSupportState['decisions']>;
type ActionsData = ExtractSnapshotData<AgentSupportState['actions']>;

const describeSnapshot = <T>(
  snapshot: SnapshotInput<T>,
  key: SnapshotKeys,
  now: number,
): SnapshotDiagnostics<T> => {
  const threshold = FRESHNESS_THRESHOLDS_MS[key];
  if (!snapshot) {
    return {
      status: 'missing',
      ageMs: null,
      updatedAt: null,
      staleAfterMs: threshold,
      data: null,
    };
  }
  const ageMs = Math.max(0, now - snapshot.updatedAt);
  const stale = ageMs > threshold;
  return {
    status: stale ? 'stale' : 'fresh',
    ageMs,
    updatedAt: snapshot.updatedAt,
    staleAfterMs: threshold,
    data: snapshot.data,
  };
};

const buildBlocker = (input: Partial<DiagnosticBlocker>, status: DiagnosticBlocker['status'] = 'critical'): DiagnosticBlocker => ({
  key: input.key ?? 'meta_adaptive_support',
  code: input.code,
  message: input.message,
  reason: input.reason,
  status,
});

export type SupportDiagnosticsPayload = {
  sessionId: string;
  symbol: string | null;
  profile: ActivationProfile | null;
  state: string;
  bias: string;
  canTrade: boolean;
  reason: string;
  blockers: DiagnosticBlocker[];
  perception: {
    marketQuality: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['marketQuality']>>;
    sentiment: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['sentiment']>>;
    riskLimits: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['riskLimits']>>;
    executionPlan: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['executionPlan']>>;
    predictor: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['predictor']>>;
  };
  decisions: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['decisions']>> & {
    summary: {
      intentCount: number;
      lastIntentId: string | null;
      lastIntentType: string | null;
      lastReason: string | null;
    };
  };
  actions: SnapshotDiagnostics<ExtractSnapshotData<AgentSupportState['actions']>>;
  alerts: AgentSupportState['alerts'];
  trigger: {
    entryReady: boolean;
    phase: string;
    bias: string;
    price: number | undefined;
    zone: unknown;
    inZone: boolean;
    confirmationOk: boolean;
    momentumOk: boolean;
    qualityOk: boolean;
    profitOk: boolean;
    tp1ProfitPct: number;
    minProfitPct: number;
    dir: number;
  };
  support: AgentSupportState | null;
};

export function buildSupportDiagnostics(params: {
  sessionId: string;
  symbol?: string | null;
  profile?: ActivationProfile | null;
  state: string;
  bias?: string;
  supportState?: AgentSupportState | null;
}): SupportDiagnosticsPayload {
  const { sessionId, symbol = null, profile = null, supportState = null } = params;
  const bias = params.bias ?? 'none';
  const now = Date.now();

  const perception = {
    marketQuality: describeSnapshot(supportState?.marketQuality, 'marketQuality', now),
    sentiment: describeSnapshot(supportState?.sentiment, 'sentiment', now),
    riskLimits: describeSnapshot(supportState?.riskLimits, 'riskLimits', now),
    executionPlan: describeSnapshot(supportState?.executionPlan, 'executionPlan', now),
    predictor: describeSnapshot(supportState?.predictor, 'predictor', now),
  };

  const decisions = describeSnapshot(supportState?.decisions as SnapshotInput<DecisionsData>, 'decisions', now);
  const intents = (supportState?.decisions?.data?.intents ?? []) as AgentActionIntent[];
  const lastIntent = intents[intents.length - 1] as { id?: string; type?: string; reason?: string } | undefined;

  const decisionsWithSummary: SupportDiagnosticsPayload['decisions'] = {
    ...decisions,
    summary: {
      intentCount: intents.length,
      lastIntentId: lastIntent?.id ?? null,
      lastIntentType: (lastIntent?.type as string | undefined) ?? null,
      lastReason: lastIntent?.reason ?? null,
    },
  };

  const actions = describeSnapshot(supportState?.actions as SnapshotInput<ActionsData>, 'actions', now);

  const blockers: DiagnosticBlocker[] = [];

  if (perception.marketQuality.status !== 'fresh') {
    blockers.push(buildBlocker({
      key: 'market_quality',
      code: perception.marketQuality.status === 'missing' ? 'market_quality_missing' : 'market_quality_stale',
      message: perception.marketQuality.status === 'missing'
        ? 'Awaiting market quality telemetry'
        : 'Market quality telemetry is stale',
    }, perception.marketQuality.status === 'missing' ? 'critical' : 'warning'));
  }

  if (perception.riskLimits.status !== 'fresh') {
    blockers.push(buildBlocker({
      key: 'risk_governor',
      code: perception.riskLimits.status === 'missing' ? 'risk_limits_missing' : 'risk_limits_stale',
      message: perception.riskLimits.status === 'missing'
        ? 'Risk governor limits unavailable'
        : 'Risk governor limits stale',
    }));
  } else if (perception.riskLimits.data?.hedgingRequired) {
    blockers.push(buildBlocker({
      key: 'risk_governor',
      code: 'hedging_required',
      message: 'Risk governor requires hedge before new entries',
      reason: perception.riskLimits.data.reason,
    }));
  }

  if (perception.executionPlan.status === 'missing') {
    blockers.push(buildBlocker({
      key: 'execution_plan',
      code: 'execution_plan_missing',
      message: 'Execution plan not generated yet',
    }, 'warning'));
  }

  // Predictor is disabled - no longer check for staleness

  const canTrade = blockers.length === 0;
  const reason = canTrade
    ? 'Meta-adaptive support stack ready'
    : blockers[0]?.message ?? 'Awaiting support signals';

  const cfg = getConfig();
  const trigger = {
    entryReady: canTrade,
    phase: 'meta_adaptive_support',
    bias,
    price: undefined as number | undefined,
    zone: null as unknown,
    inZone: false,
    confirmationOk: perception.sentiment.status !== 'missing',
    momentumOk: true, // Predictor disabled - always OK
    qualityOk: perception.marketQuality.status === 'fresh',
    profitOk: true,
    tp1ProfitPct: 0,
    minProfitPct: cfg.MIN_TRADE_PROFIT_PCT,
    dir: 1, // Predictor disabled - default to long
  };

  return {
    sessionId,
    symbol,
    profile,
    state: params.state,
    bias,
    canTrade,
    reason,
    blockers,
    perception,
    decisions: decisionsWithSummary,
    actions,
    alerts: supportState?.alerts ?? [],
    trigger,
    support: supportState,
  };
}
