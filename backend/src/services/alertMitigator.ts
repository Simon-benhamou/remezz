import type { PolicyAlert } from '../monitor/policy.js';
import { AgentHub } from '../agent/hub.js';
import { prisma } from '../db/client.js';
import { recordOpsEvent } from '../monitor/ops.js';

const MARGIN_HALT_COOLDOWN_MS = 5 * 60 * 1000; // avoid hammering halt logic
const STALE_NOTE_COOLDOWN_MS = 10 * 60 * 1000;
const INACTIVITY_NOTE_COOLDOWN_MS = 30 * 60 * 1000;

const lastMarginHalt = new Map<string, number>();
const lastStaleNote = new Map<string, number>();
const lastInactivityNote = new Map<string, number>();

async function handleMarginAlert(alert: PolicyAlert) {
  const sessionId = alert.sessionId;
  if (!sessionId) return;

  const now = Date.now();
  if (alert.severity === 'high') {
    const prev = lastMarginHalt.get(sessionId) || 0;
    if (now - prev < MARGIN_HALT_COOLDOWN_MS) return;
    lastMarginHalt.set(sessionId, now);

    const symbol = alert.symbol;
    const utilisationPct = Number(alert.details?.utilisationPct ?? alert.details?.breaches?.[0]?.value ?? NaN);

    recordOpsEvent({
      level: 'error',
      source: 'alert_mitigator',
      message: 'margin_halt_engaged',
      sessionId,
      symbol,
      details: {
        utilisationPct: Number.isFinite(utilisationPct) ? utilisationPct : undefined,
        actions: alert.details?.actions ?? [],
        breaches: alert.details?.breaches ?? [],
      },
    });

    try {
      await AgentHub.closeNow(sessionId);
    } catch (error) {
      recordOpsEvent({
        level: 'warn',
        source: 'alert_mitigator',
        message: 'margin_close_now_failed',
        sessionId,
        symbol,
        details: { error: String((error as Error)?.message || error) },
      });
    }

    try {
      await AgentHub.halt(sessionId);
    } catch (error) {
      recordOpsEvent({
        level: 'warn',
        source: 'alert_mitigator',
        message: 'margin_halt_failed',
        sessionId,
        symbol,
        details: { error: String((error as Error)?.message || error) },
      });
    }

    try {
      await prisma.agentSession.updateMany({
        where: { id: sessionId },
        data: { haltedAt: new Date(), haltReason: 'margin_risk' },
      });
    } catch (error) {
      recordOpsEvent({
        level: 'warn',
        source: 'alert_mitigator',
        message: 'margin_halt_persist_failed',
        sessionId,
        symbol,
        details: { error: String((error as Error)?.message || error) },
      });
    }
  }
}

function shouldThrottle(map: Map<string, number>, key: string, cooldownMs: number) {
  const now = Date.now();
  const prev = map.get(key) || 0;
  if (now - prev < cooldownMs) return true;
  map.set(key, now);
  return false;
}

function handleStaleData(alert: PolicyAlert) {
  const sessionId = alert.sessionId;
  if (!sessionId) return;
  if (shouldThrottle(lastStaleNote, sessionId, STALE_NOTE_COOLDOWN_MS)) return;

  recordOpsEvent({
    level: 'warn',
    source: 'alert_mitigator',
    message: 'stale_data_watchdog',
    sessionId,
    symbol: alert.symbol,
    details: alert.details ?? null,
  });
}

function handleInactivity(alert: PolicyAlert) {
  const sessionId = alert.sessionId;
  if (!sessionId) return;
  if (shouldThrottle(lastInactivityNote, sessionId, INACTIVITY_NOTE_COOLDOWN_MS)) return;

  recordOpsEvent({
    level: 'warn',
    source: 'alert_mitigator',
    message: 'session_inactive_watchdog',
    sessionId,
    symbol: alert.symbol,
    details: alert.details ?? null,
  });
}

export async function handlePolicyAlert(alert: PolicyAlert): Promise<void> {
  switch (alert.kind) {
    case 'margin_risk':
      await handleMarginAlert(alert);
      break;
    case 'stale_data':
      handleStaleData(alert);
      break;
    case 'inactivity':
      handleInactivity(alert);
      break;
    default:
      break;
  }
}
