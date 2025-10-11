import { broadcast } from '../ws/hub.js';
import { AgentHub } from '../agent/hub.js';
import { getConfig } from '../utils/env.js';
import { recordOpsEvent } from './ops.js';
import { handlePolicyAlert } from '../services/alertMitigator.js';

export type PolicyAlert = {
  id: string;
  sessionId?: string;
  symbol?: string;
  kind:
    | 'late_invalidation_exit'
    | 'missed_partial'
    | 'overtrading'
    | 'capacity_breach'
    | 'order_unfilled'
    | 'stale_data'
    | 'llm_invalid'
    | 'margin_risk'
    | 'inactivity';
  severity: 'low'|'med'|'high';
  details?: any;
  ts: number;
};

const alerts: PolicyAlert[] = [];
const state = new Map<string, { invalidTicks: number; partialTicks: number; prevStop?: number; beTicks: number; trailBackTicks: number; missedPartialAlerts: number; killEngaged?: boolean; lastMissedPartialTs?: number }>();
const MISSED_PARTIAL_KILL = Number(process.env.MISSED_PARTIAL_KILL || 3);
const MISSED_PARTIAL_ALERT_COOLDOWN_MS = Math.max(10_000, Number(process.env.MISSED_PARTIAL_ALERT_COOLDOWN_MS || 45_000));

async function pushAlert(a: PolicyAlert){
  alerts.push(a);
  if (alerts.length > 500) alerts.splice(0, alerts.length - 500);
  broadcast('alert', a, a.symbol, a.sessionId);
  // Persist to DB if available
  try {
    const { prisma } = await import('../db/client.js');
    await prisma.alert.create({ data: { sessionId: a.sessionId, symbol: a.symbol || undefined, kind: a.kind, severity: a.severity, details: a.details as any } });
  } catch {}

  try {
    await handlePolicyAlert(a);
  } catch (error) {
    recordOpsEvent({
      level: 'warn',
      source: 'alert_mitigator',
      message: 'alert_handle_failed',
      sessionId: a.sessionId,
      symbol: a.symbol,
      details: { error: String((error as Error)?.message || error) },
    });
  }
}

export function recentAlerts(sessionId?: string) {
  const slice = alerts.slice(-200).reverse();
  return sessionId ? slice.filter(a => a.sessionId === sessionId) : slice;
}

export async function emitAlert(params: { sessionId?: string; symbol?: string; kind: PolicyAlert['kind']; severity: PolicyAlert['severity']; details?: any }){
  const a: PolicyAlert = {
    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    sessionId: params.sessionId,
    symbol: params.symbol,
    kind: params.kind,
    severity: params.severity,
    details: params.details,
    ts: Date.now(),
  };
  if (params.severity === 'high') {
    recordOpsEvent({
      level: 'error',
      source: 'alert',
      message: params.kind,
      sessionId: params.sessionId,
      symbol: params.symbol,
      details: params.details,
    });
  }
  await pushAlert(a);
}

// Administrative utility: clear in-memory alerts (does not touch DB)
export function clearAlertsMemory() {
  alerts.splice(0, alerts.length);
}

export async function auditTick(sessionId: string, symbol: string, price: number){
  const a = AgentHub.get(sessionId) as any;
  if (!a || !a.plan) return;
  const key = sessionId;
  const s = state.get(key) || { invalidTicks: 0, partialTicks: 0, prevStop: undefined, beTicks: 0, trailBackTicks: 0, missedPartialAlerts: 0 };
  const cfg = getConfig();
  // Overtrading
  try {
    const tradesToday = Number(a.tradesToday || 0);
    const maxTrades = 3; // mirrors defaultLimits()
    if (tradesToday > maxTrades) {
      await pushAlert({ id: `alert_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, sessionId, symbol, kind: 'overtrading', severity: 'med', details: { tradesToday, maxTrades }, ts: Date.now() });
    }
  } catch {}
  // Late invalidation: price outside zone +/- hysteresis while still in position
  try {
    if (a.pos) {
      const from = Math.min(a.plan.zone.from, a.plan.zone.to);
      const to = Math.max(a.plan.zone.from, a.plan.zone.to);
      const above = price > to * (1 + cfg.BREAKOUT_HYSTERESIS_PCT/100);
      const below = price < from * (1 - cfg.BREAKOUT_HYSTERESIS_PCT/100);
      const invalid = (a.pos.side === 'sell') ? above : below;
      if (invalid) s.invalidTicks += 1; else s.invalidTicks = 0;
      if (s.invalidTicks >= Math.max(3, cfg.BREAKOUT_CONFIRM_TICKS + 1)) {
        await pushAlert({ id: `alert_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, sessionId, symbol, kind: 'late_invalidation_exit', severity: 'high', details: { invalidTicks: s.invalidTicks }, ts: Date.now() });
        s.invalidTicks = 0;
      }
    } else {
      s.invalidTicks = 0;
    }
  } catch {}
  // Missed partial: if price well beyond first TP and partialTaken still false for a few ticks
  try {
    if (a.pos && a.plan) {
      const dir = a.pos.side === 'buy' ? 1 : -1;
      const firstR = (a.plan?.plan?.risk?.tp?.[0]?.value || a.plan?.rPrices?.[0]?.r || 1.0) as number;
      const needPartial = dir * (price - a.pos.entry) >= (firstR * a.plan.stopDistance) * 1.02; // 2% buffer beyond TP1
      if (needPartial && !a.pos.partialTaken) {
        s.partialTicks += 1;
        if (s.partialTicks >= 3) {
          const now = Date.now();
          if (!s.lastMissedPartialTs || (now - s.lastMissedPartialTs) > MISSED_PARTIAL_ALERT_COOLDOWN_MS) {
            await pushAlert({ id: `alert_${now}_${Math.random().toString(36).slice(2,8)}`, sessionId, symbol, kind: 'missed_partial', severity: 'med', details: { entry: a.pos.entry, tp1R: firstR }, ts: now });
            s.lastMissedPartialTs = now;
            s.missedPartialAlerts = (s.missedPartialAlerts || 0) + 1;
            if (!s.killEngaged && MISSED_PARTIAL_KILL > 0 && s.missedPartialAlerts >= MISSED_PARTIAL_KILL) {
              s.killEngaged = true;
              try { AgentHub.halt(sessionId); } catch {}
              recordOpsEvent({ level: 'error', source: 'kill_switch', message: 'missed_partial_threshold', sessionId, symbol, details: { missedPartialAlerts: s.missedPartialAlerts } });
              broadcast('agent_state', { state: 'HALT', killSwitch: 'missed_partial' }, symbol, sessionId);
            }
          }
          s.partialTicks = 0;
        }
      } else {
        s.partialTicks = 0;
        if (a.pos?.partialTaken) {
          s.missedPartialAlerts = 0;
          s.lastMissedPartialTs = undefined;
        }
      }
    } else {
      s.partialTicks = 0;
    }
  } catch {}

  state.set(key, s);

  // No break-even after partial: stop should not be beyond entry in the wrong direction
  try {
    if (a.pos?.partialTaken) {
      const ok = a.pos.side === 'buy' ? (a.pos.stop >= a.pos.entry) : (a.pos.stop <= a.pos.entry);
      if (!ok) {
        s.beTicks += 1;
        if (s.beTicks >= 2) {
          await pushAlert({ id: `alert_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, sessionId, symbol, kind: 'missed_partial', severity: 'med', details: { note: 'no_break_even_after_partial' }, ts: Date.now() });
          s.beTicks = 0;
        }
      } else {
        s.beTicks = 0;
      }
    } else {
      s.beTicks = 0;
    }
  } catch {}

  // Trailing regression: when upR > 1, stop should not move away from price vs previous tick
  try {
    if (a.pos && a.plan) {
      const dir = a.pos.side === 'buy' ? 1 : -1;
      const upR = (dir * (price - a.pos.entry)) / a.plan.stopDistance;
      const prev = s.prevStop;
      const cur = a.pos.stop;
      if (upR > 1 && typeof prev === 'number') {
        const regressed = a.pos.side === 'buy' ? (cur < prev - 1e-8) : (cur > prev + 1e-8);
        if (regressed) {
          s.trailBackTicks += 1;
          if (s.trailBackTicks >= 2) {
            await pushAlert({ id: `alert_${Date.now()}_${Math.random().toString(36).slice(2,8)}`, sessionId, symbol, kind: 'late_invalidation_exit', severity: 'low', details: { note: 'trailing_regression', prevStop: prev, curStop: cur }, ts: Date.now() });
            s.trailBackTicks = 0;
          }
        } else {
          s.trailBackTicks = 0;
        }
      } else {
        s.trailBackTicks = 0;
      }
      s.prevStop = cur;
    } else {
      s.prevStop = undefined; s.trailBackTicks = 0;
    }
  } catch {}
}
