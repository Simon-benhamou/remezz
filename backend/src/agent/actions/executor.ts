import { AgentHub } from '../hub.js';
import { recordOpsEvent } from '../../monitor/ops.js';
import { activateEntryLock } from '../../services/sessionLocks.js';
import { prisma } from '../../db/client.js';
import { broadcast } from '../../ws/hub.js';
import { invalidateCachedPrediction } from '../../quantai/predictorCache.js';
import type { ActionIntentRecord } from './store.js';
import { saveExecutionModeDirective } from './directives.js';

export type ActionExecutionResult = {
  status: 'completed' | 'failed' | 'skipped';
  details?: Record<string, unknown>;
  failureReason?: string;
};

type UnknownPayload = Record<string, unknown> | null;

type ActionHandler = (record: ActionIntentRecord, payload: UnknownPayload) => Promise<ActionExecutionResult>;

const PRIORITY_TTL_MS: Record<string, number> = {
  high: 15 * 60 * 1000,
  medium: 7 * 60 * 1000,
  low: 3 * 60 * 1000,
};

const severityMap: Record<string, 'low' | 'med' | 'high'> = {
  high: 'high',
  medium: 'med',
  low: 'low',
};

function resolveTtl(priority: string, requested?: unknown): number {
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return Math.max(30_000, Math.min(requested, 60 * 60 * 1000));
  }
  return PRIORITY_TTL_MS[priority] ?? PRIORITY_TTL_MS.medium;
}

const handleThrottleEntries: ActionHandler = async (record, payload) => {
  const payloadRecord = payload as Record<string, unknown> | null;
  const throttleMs = payloadRecord && typeof payloadRecord['throttleMs'] === 'number'
    ? payloadRecord['throttleMs'] as number
    : undefined;
  const ttlMs = resolveTtl(record.priority, throttleMs);
  const acquired = await activateEntryLock(record.sessionId, record.reason, ttlMs, {
    intentId: record.id,
    priority: record.priority,
    payload,
  });
  if (!acquired) {
    return {
      status: 'skipped',
      details: { ttlMs, reason: 'lock_already_active' },
    };
  }
  return {
    status: 'completed',
    details: { ttlMs },
  };
};

function normalizeMode(rawMode: unknown): 'market' | 'limit' | 'twap' | null {
  if (typeof rawMode !== 'string') return null;
  const lower = rawMode.toLowerCase();
  if (lower === 'market') return 'market';
  if (lower === 'limit' || lower === 'sweep') return 'limit';
  if (lower === 'twap' || lower === 'iceberg') return 'twap';
  return null;
}

const handleSwitchExecutionMode: ActionHandler = async (record, payload) => {
  const payloadRecord = payload as Record<string, unknown> | null;
  const suggested = payloadRecord && typeof payloadRecord['suggestedMode'] === 'string'
    ? payloadRecord['suggestedMode'] as string
    : undefined;
  const recommended = payloadRecord && typeof payloadRecord['recommendedMode'] === 'string'
    ? payloadRecord['recommendedMode'] as string
    : undefined;
  const fallback = payloadRecord && typeof payloadRecord['mode'] === 'string'
    ? payloadRecord['mode'] as string
    : undefined;
  const requested = normalizeMode(suggested ?? recommended ?? fallback);
  if (!requested) {
    return { status: 'skipped', details: { reason: 'unknown_mode', payload } };
  }
  const ttlOverride = payloadRecord && typeof payloadRecord['ttlMs'] === 'number'
    ? payloadRecord['ttlMs'] as number
    : undefined;
  const ttlMs = resolveTtl(record.priority, ttlOverride);
  saveExecutionModeDirective(record.sessionId, {
    intentId: record.id,
    mode: requested,
    reason: record.reason,
    expiresAt: Date.now() + ttlMs,
    metadata: payload ?? null,
  });
  return {
    status: 'completed',
    details: { mode: requested, ttlMs },
  };
};

const handleAdjustAllocation: ActionHandler = async (record, payload) => {
  if (!payload || typeof payload !== 'object') {
    return { status: 'skipped', details: { reason: 'missing_payload' } };
  }
  
  // BUG FIX: Verify position still exists before adjusting allocation
  const dbPosition = await prisma.position.findFirst({
    where: { sessionId: record.sessionId },
  });
  if (!dbPosition) {
    return { status: 'skipped', details: { reason: 'position_closed' } };
  }
  
  const payloadRecord = payload as Record<string, unknown> | null;
  const allowedFields = ['capitalUsd', 'budgetFraction', 'maxLeverage', 'weight', 'score'] as const;
  const updatePayload: Record<string, number> = {};
  for (const field of allowedFields) {
    const value = payloadRecord ? payloadRecord[field] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) {
      updatePayload[field] = value;
    }
  }
  if (!Object.keys(updatePayload).length) {
    return { status: 'skipped', details: { reason: 'no_numeric_fields' } };
  }

  const leverageCap = payloadRecord && typeof payloadRecord['leverageCap'] === 'object'
    ? payloadRecord['leverageCap'] as { resolved: number; requested?: number; dynamicMax?: number }
    : undefined;

  AgentHub.applyAllocation(record.sessionId, {
    ...updatePayload,
    reason: record.reason,
    leverageCap,
  });

  const session = await prisma.agentSession.findUnique({
    where: { id: record.sessionId },
    select: { profileJson: true },
  });
  const profile = (session?.profileJson as Record<string, any> | null) ?? {};
  const mergedProfile = {
    ...profile,
    actionOverrides: {
      ...(profile.actionOverrides ?? {}),
      allocation: {
        ...(profile.actionOverrides?.allocation ?? {}),
        ...updatePayload,
        reason: record.reason,
        updatedAt: Date.now(),
      },
    },
  };

  await prisma.agentSession.update({
    where: { id: record.sessionId },
    data: { profileJson: mergedProfile as any },
  });

  return {
    status: 'completed',
    details: updatePayload,
  };
};

const handlePublishAlert: ActionHandler = async (record, payload) => {
  const severity = severityMap[record.priority] ?? 'med';
  const alertPayload = {
    sessionId: record.sessionId,
    symbol: record.symbol,
    kind: `agent_action_${record.type}`,
    severity,
    details: {
      reason: record.reason,
      intentId: record.id,
      payload,
    },
    createdAt: new Date(),
  };

  const dbAlert = await prisma.alert.create({
    data: {
      sessionId: alertPayload.sessionId,
      symbol: alertPayload.symbol,
      kind: alertPayload.kind,
      severity: alertPayload.severity,
      details: alertPayload.details as any,
    },
  });

  broadcast('alert', { ...alertPayload, id: dbAlert.id }, record.symbol, record.sessionId);

  return {
    status: 'completed',
    details: { severity },
  };
};

const handlePredictorRefresh: ActionHandler = async (record) => {
  try {
    invalidateCachedPrediction(record.symbol);
  } catch (error) {
    return {
      status: 'failed',
      failureReason: (error as Error).message,
      details: { reason: 'cache_invalidate_failed' },
    };
  }
  return {
    status: 'completed',
    details: { action: 'cache_invalidated' },
  };
};

const handleEnforceHedge: ActionHandler = async (record) => {
  try {
    await AgentHub.halt(record.sessionId, 'entries_only');
  } catch (error) {
    recordOpsEvent({
      level: 'warn',
      source: 'agent_action',
      message: 'enforce_hedge_halt_failed',
      sessionId: record.sessionId,
      symbol: record.symbol,
      details: { error: (error as Error).message },
    });
    return {
      status: 'failed',
      failureReason: 'halt_failed',
    };
  }
  return {
    status: 'completed',
    details: { action: 'entries_only_halt' },
  };
};

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  throttle_entries: handleThrottleEntries,
  switch_execution_mode: handleSwitchExecutionMode,
  adjust_allocation: handleAdjustAllocation,
  publish_alert: handlePublishAlert,
  request_predictor_refresh: handlePredictorRefresh,
  enforce_hedge: handleEnforceHedge,
};

export async function executeActionIntent(record: ActionIntentRecord): Promise<ActionExecutionResult> {
  const payload = (record.payload ?? null) as UnknownPayload;
  const handler = ACTION_HANDLERS[record.type];

  try {
    if (!handler) {
      return {
        status: 'skipped',
        details: { reason: 'unsupported_action' },
      };
    }
    const result = await handler(record, payload);
    if (result.status === 'failed') {
      recordOpsEvent({
        level: 'error',
        source: 'agent_action',
        message: `${record.type}_failed`,
        sessionId: record.sessionId,
        symbol: record.symbol,
        details: {
          reason: result.failureReason ?? 'unknown',
          intentId: record.id,
        },
      });
    }
    return result;
  } catch (error) {
    const failureReason = (error as Error).message ?? 'unexpected_error';
    recordOpsEvent({
      level: 'error',
      source: 'agent_action',
      message: `${record.type}_exception`,
      sessionId: record.sessionId,
      symbol: record.symbol,
      details: {
        error: failureReason,
        intentId: record.id,
      },
    });
    return {
      status: 'failed',
      failureReason,
    };
  }
}
