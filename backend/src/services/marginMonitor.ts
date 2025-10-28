import { AgentHub } from '../agent/hub.js';
import { prisma } from '../db/client.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { emitAlert } from '../monitor/policy.js';
import { LiveBroker } from '../broker/live.js';
import { BrokerMarginSnapshot } from '../broker/types.js';
import {
  evaluateMarginSnapshot,
  mergeMarginThresholds,
  MarginGuardResult,
  MarginGuardThresholds,
  MarginGuardSeverity,
} from '../risk/marginGuard.js';
import { getConfig } from '../utils/env.js';

export type MarginSweepOutcome = {
  sessionId: string;
  symbol?: string;
  snapshot: BrokerMarginSnapshot;
  assessment: MarginGuardResult;
  accountKey: string;
};

export type MarginMonitorOptions = {
  intervalMs?: number;
  runOnStart?: boolean;
  thresholds?: Partial<MarginGuardThresholds>;
};

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

const lastStatuses = new Map<string, { status: MarginGuardSeverity; ts: number }>();
let timer: NodeJS.Timeout | null = null;
let running = false;

type MarginSessionRecord = { id: string; symbol: string | null; mode: string; userId?: string | null };

function resolveAccountKey(session: MarginSessionRecord): string {
  const baseId = session.userId && session.userId.trim().length > 0 ? session.userId.trim() : session.id;
  const modePrefix = session.mode === 'paper' ? 'paper' : session.mode === 'live' ? 'live' : 'session';
  return `${modePrefix}:${baseId}`;
}

function resolveThresholds(overrides?: Partial<MarginGuardThresholds>) {
  const cfg = getConfig();
  return mergeMarginThresholds({
    utilisationWarnPct: cfg.MARGIN_UTIL_WARN_PCT,
    utilisationCriticalPct: cfg.MARGIN_UTIL_CRITICAL_PCT,
    minLiquidationDistancePct: cfg.MARGIN_LIQUIDATION_MIN_DIST_PCT,
    concentrationWarnPct: cfg.MARGIN_CONCENTRATION_WARN_PCT,
    ...overrides,
  });
}

async function persistSnapshot(
  sessionId: string,
  symbol: string | undefined,
  snapshot: BrokerMarginSnapshot,
  assessment: MarginGuardResult,
  accountKey: string,
) {
  const repo = (prisma as any).marginSnapshot;
  if (!repo) return;
  try {
    await repo.create({
      data: {
        sessionId,
        symbol,
        status: assessment.status,
        utilisationPct: assessment.utilisationPct,
        maintenanceMarginUsd: snapshot.maintenanceMarginUsd ?? null,
        marginRatio: snapshot.marginRatio ?? null,
        worstLiquidationDistancePct: assessment.worstLiquidationDistancePct ?? null,
        concentration: assessment.concentration ?? [],
        recommendedActions: assessment.actions ?? [],
        telemetry: { snapshot, assessment, accountKey },
      },
    });
  } catch (error) {
    recordOpsEvent({
      level: 'warn',
      source: 'margin_monitor',
      message: 'margin_snapshot_persist_failed',
      sessionId,
      symbol,
      details: { error: String((error as Error)?.message || error) },
    });
  }
}

async function acquireBroker(session: { id: string; mode: string; userId?: string | null }) {
  const agent = AgentHub.get(session.id) as any;
  if (agent?.broker?.balance) return agent.broker;
  if (session.mode === 'live' && session.userId) {
    return new LiveBroker(session.userId);
  }
  return null;
}

function shouldEmit(accountKey: string, status: MarginGuardSeverity, now: number) {
  const prev = lastStatuses.get(accountKey);
  if (!prev) return true;
  if (prev.status !== status) return true;
  if (status === 'ok') return false;
  return now - prev.ts > ALERT_COOLDOWN_MS;
}

async function emitSignals(
  accountKey: string,
  sessionId: string,
  symbol: string | undefined,
  assessment: MarginGuardResult,
) {
  if (assessment.status === 'ok') return;
  const now = Date.now();
  if (!shouldEmit(accountKey, assessment.status, now)) return;

  recordOpsEvent({
    level: assessment.status === 'critical' ? 'error' : 'warn',
    source: 'margin_monitor',
    message: assessment.status === 'critical' ? 'margin_critical' : 'margin_warning',
    sessionId,
    symbol,
    details: {
      utilisationPct: assessment.utilisationPct,
      worstLiquidationDistancePct: assessment.worstLiquidationDistancePct,
      actions: assessment.actions,
    },
  });

  try {
    await emitAlert({
      sessionId,
      symbol,
      kind: 'margin_risk',
      severity: assessment.status === 'critical' ? 'high' : 'med',
      details: {
        utilisationPct: assessment.utilisationPct,
        worstLiquidationDistancePct: assessment.worstLiquidationDistancePct,
        actions: assessment.actions,
        breaches: assessment.breaches,
      },
    });
  } catch (error) {
    recordOpsEvent({
      level: 'warn',
      source: 'margin_monitor',
      message: 'margin_alert_failed',
      sessionId,
      symbol,
      details: { error: String((error as Error)?.message || error) },
    });
  }

  lastStatuses.set(accountKey, { status: assessment.status, ts: now });
}

export async function runMarginSweepOnce(opts?: { thresholds?: Partial<MarginGuardThresholds> }): Promise<MarginSweepOutcome[]> {
  const repo = (prisma as any).marginSnapshot;
  if (!repo) return [];

  const thresholds = resolveThresholds(opts?.thresholds);
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { id: true, symbol: true, mode: true, userId: true },
  });

  const results: MarginSweepOutcome[] = [];
  const accountCache = new Map<string, { snapshot: BrokerMarginSnapshot; assessment: MarginGuardResult }>();

  for (const session of sessions) {
    const accountKey = resolveAccountKey(session);
    let cached = accountCache.get(accountKey);
    let snapshot: BrokerMarginSnapshot;
    let assessment: MarginGuardResult;

    if (!cached) {
      const broker = await acquireBroker(session);
      if (!broker?.balance) continue;

      try {
        snapshot = await broker.balance();
      } catch (error) {
        recordOpsEvent({
          level: 'warn',
          source: 'margin_monitor',
          message: 'balance_fetch_failed',
          sessionId: session.id,
          symbol: session.symbol,
          details: { error: String((error as Error)?.message || error) },
        });
        continue;
      }

      assessment = evaluateMarginSnapshot(snapshot, { thresholds, symbol: session.symbol });
      accountCache.set(accountKey, { snapshot, assessment });
    } else {
      snapshot = cached.snapshot;
      assessment = cached.assessment;
    }

    await persistSnapshot(session.id, session.symbol, snapshot, assessment, accountKey);
    await emitSignals(accountKey, session.id, session.symbol, assessment);
    if (assessment.status === 'ok') {
      lastStatuses.set(accountKey, { status: 'ok', ts: Date.now() });
    }

    results.push({ sessionId: session.id, symbol: session.symbol, snapshot, assessment, accountKey });
  }

  return results;
}

async function tick(thresholds: Partial<MarginGuardThresholds> | undefined) {
  if (running) return;
  running = true;
  try {
    await runMarginSweepOnce({ thresholds });
  } catch (error) {
    recordOpsEvent({
      level: 'error',
      source: 'margin_monitor',
      message: 'sweep_failed',
      details: { error: String((error as Error)?.message || error) },
    });
  } finally {
    running = false;
  }
}

export function startMarginMonitor(options?: MarginMonitorOptions) {
  if (timer) return;
  const cfg = getConfig();
  const interval = Math.max(10_000, options?.intervalMs ?? cfg.MARGIN_MONITOR_INTERVAL_MS);
  const thresholds = options?.thresholds;

  if (options?.runOnStart !== false) {
    tick(thresholds);
  }
  timer = setInterval(() => tick(thresholds), interval);
}
