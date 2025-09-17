import { AgentHub } from '../agent/hub.js';
import { prisma } from '../db/client.js';
import { recentAlerts } from './policy.js';

type PanelLevel = 'ok'|'warn'|'alert'|'idle';

type Panel = {
  key: string;
  title: string;
  status: PanelLevel;
  value: string;
  hint?: string;
  issues?: string[];
  meta?: Record<string, unknown>;
};

type HealthSummary = {
  level: 'ok'|'warn'|'alert';
  headline: string;
  bullets: string[];
};

const MS_PER_MIN = 60_000;

function avg(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function max(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => Math.max(a, b), values[0]);
}

function toAgo(ms?: number): string {
  if (!ms || ms < 0) return 'n/a';
  const minutes = Math.floor(ms / MS_PER_MIN);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMin = minutes % 60;
    return restMin ? `${hours}h${restMin}m ago` : `${hours}h ago`;
  }
  if (minutes >= 1) return `${minutes}m ago`;
  const seconds = Math.max(1, Math.floor(ms / 1000));
  return `${seconds}s ago`;
}

function severityScore(level: PanelLevel | HealthSummary['level']): number {
  if (level === 'alert') return 2;
  if (level === 'warn') return 1;
  return 0;
}

export async function computeMonitorAnalytics(sessionId: string) {
  const now = Date.now();
  const lookbackMs = 2 * 60 * MS_PER_MIN; // 2 hours

  const agent = AgentHub.get(sessionId) as any;

  const [session, kpi, position, recentOrders, storedAlerts] = await Promise.all([
    prisma.agentSession.findUnique({ where: { id: sessionId } }),
    prisma.sessionKpi.findUnique({ where: { sessionId } }),
    prisma.position.findFirst({ where: { sessionId, qty: { gt: 0 } }, orderBy: { openedAt: 'desc' } }),
    prisma.order.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.alert.findMany({ where: { sessionId, createdAt: { gte: new Date(now - lookbackMs) } }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const liveAlerts = recentAlerts(sessionId).filter((a) => now - a.ts <= lookbackMs);
  const alerts = storedAlerts.length ? storedAlerts.map((a) => ({ id: a.id, kind: a.kind, severity: a.severity as 'low'|'med'|'high', ts: new Date(a.createdAt).getTime(), details: a.details })) : liveAlerts;

  const panels: Panel[] = [];
  const issues: string[] = [];

  // Protective sync panel
  const livePos = agent?.pos;
  const activeQty = livePos?.qty ?? Number(position?.qty || 0);
  if (!activeQty) {
    panels.push({
      key: 'protective',
      title: 'Protective Sync',
      status: 'idle',
      value: 'No active position',
      hint: 'Agent is flat',
    });
  } else {
    const stop = typeof livePos?.stop === 'number' ? livePos.stop : (position?.stopPrice ?? null);
    const tpArray = Array.isArray(livePos?.tp) ? livePos?.tp : (() => {
      if (Array.isArray(position?.takeProfit)) return position?.takeProfit as unknown as number[];
      if (typeof position?.takeProfit === 'number') return [position?.takeProfit];
      return [];
    })();
    const lastSync = position?.lastProtectiveSyncAt ? position.lastProtectiveSyncAt.getTime() : undefined;
    const syncAge = lastSync ? now - lastSync : undefined;
    let status: PanelLevel = 'ok';
    const probs: string[] = [];

    if (!stop || Number.isNaN(stop)) {
      status = 'alert';
      probs.push('Stop-loss missing');
    }
    if (!tpArray || tpArray.length === 0) {
      if (status === 'ok') status = 'warn';
      probs.push('No take-profit synced');
    }
    if (syncAge != null) {
      if (syncAge > 10 * MS_PER_MIN) {
        status = 'alert';
        probs.push('Protective orders stale (>10m)');
      } else if (syncAge > 5 * MS_PER_MIN && status !== 'alert') {
        status = status === 'warn' ? 'warn' : 'warn';
        probs.push('Protective orders ageing');
      }
    } else {
      status = 'warn';
      probs.push('No protective sync recorded');
    }
    if (typeof position?.protectiveStatus === 'string' && position.protectiveStatus.includes('error')) {
      status = 'alert';
      probs.push('Last sync reported error');
    }
    const stopLabel = stop != null ? stop.toFixed(4) : '—';
    const tpLabel = tpArray && tpArray.length ? tpArray[0].toFixed(4) : '—';

    const hint = lastSync ? `Last sync ${toAgo(syncAge)}` : 'No sync timestamp';
    if (probs.length) issues.push(...probs);

    panels.push({
      key: 'protective',
      title: 'Protective Sync',
      status,
      value: `${stopLabel} / ${tpLabel}`,
      hint,
      issues: probs,
      meta: { syncAgeMs: syncAge, stop, tpArray },
    });
  }

  // Order telemetry panel
  const filledOrders = recentOrders.filter((o) => String(o.source || '') === 'agent' && String(o.status || '').toLowerCase() === 'filled');
  const recentFilled = filledOrders.slice(0, 8);
  const slipValues = recentFilled.map((o) => (o.slippageBps != null ? Math.abs(Number(o.slippageBps)) : null)).filter((v): v is number => v != null && Number.isFinite(v));
  const latencyValues = recentFilled.map((o) => (o.latencyMs != null ? Math.max(0, Number(o.latencyMs)) : null)).filter((v): v is number => v != null && Number.isFinite(v));
  const fillRatios = recentFilled.map((o) => (o.fillRatio != null ? Number(o.fillRatio) : null)).filter((v): v is number => v != null && Number.isFinite(v));
  const retryCounts = recentFilled.map((o) => (o.attempts != null ? Number(o.attempts) : null)).filter((v): v is number => v != null && Number.isFinite(v));

  const avgSlip = avg(slipValues);
  const avgLatency = avg(latencyValues);
  const minFill = fillRatios.length ? Math.min(...fillRatios) : null;
  const maxAttempts = max(retryCounts);

  let orderStatus: PanelLevel = 'ok';
  const orderIssues: string[] = [];
  if (avgSlip != null) {
    if (avgSlip > 20) {
      orderStatus = 'alert';
      orderIssues.push(`High slippage (${avgSlip.toFixed(1)}bps)`);
    } else if (avgSlip > 10) {
      orderStatus = 'warn';
      orderIssues.push(`Slippage creeping (${avgSlip.toFixed(1)}bps)`);
    }
  }
  if (avgLatency != null) {
    if (avgLatency > 2500) {
      orderStatus = 'alert';
      orderIssues.push(`Latency high (${(avgLatency / 1000).toFixed(1)}s)`);
    } else if (avgLatency > 1500 && orderStatus !== 'alert') {
      orderStatus = 'warn';
      orderIssues.push(`Latency elevated (${(avgLatency / 1000).toFixed(1)}s)`);
    }
  }
  if (minFill != null && minFill < 0.6) {
    orderStatus = 'alert';
    orderIssues.push(`Partial fills < 60% (${Math.round(minFill * 100)}%)`);
  } else if (minFill != null && minFill < 0.9 && orderStatus !== 'alert') {
    orderStatus = 'warn';
    orderIssues.push(`Fill quality dropping (${Math.round(minFill * 100)}%)`);
  }
  if (maxAttempts != null && maxAttempts > 2 && orderStatus !== 'alert') {
    orderStatus = 'warn';
    orderIssues.push(`Multiple retries observed (${maxAttempts} attempts)`);
  }
  if (orderIssues.length) issues.push(...orderIssues);

  panels.push({
    key: 'orders',
    title: 'Order Telemetry',
    status: orderStatus,
    value: `${avgSlip != null ? `${avgSlip.toFixed(1)}bps` : '—'} · ${avgLatency != null ? `${(avgLatency / 1000).toFixed(1)}s` : '—'}`,
    hint: `fills: ${recentFilled.length} · worst fill ${(minFill != null ? `${Math.round(minFill * 100)}%` : 'n/a')}`,
    issues: orderIssues,
    meta: { avgSlipBps: avgSlip, avgLatencyMs: avgLatency, minFill, maxAttempts },
  });

  // Alerts panel
  const counts = alerts.reduce((acc, cur) => {
    const level = cur.severity || 'low';
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  let alertStatus: PanelLevel = 'ok';
  if ((counts.high || 0) > 0) alertStatus = 'alert';
  else if ((counts.med || 0) > 0) alertStatus = 'warn';

  const lastAlert = alerts[0];
  const alertIssues: string[] = [];
  if (alertStatus !== 'ok' && lastAlert) {
    alertIssues.push(`Recent ${lastAlert.kind.replace(/_/g, ' ')} alert (${lastAlert.severity})`);
  }
  if (alertIssues.length) issues.push(...alertIssues);

  panels.push({
    key: 'alerts',
    title: 'Policy Alerts',
    status: alertStatus,
    value: `${alerts.length} in 2h`,
    hint: lastAlert ? `${lastAlert.kind} · ${toAgo(now - lastAlert.ts)}` : 'No recent alerts',
    issues: alertIssues,
    meta: { counts },
  });

  // Health aggregate
  let healthLevel: HealthSummary['level'] = 'ok';
  const worstPanel = panels.reduce((worst, panel) => Math.max(worst, severityScore(panel.status)), 0);
  if (worstPanel === 2) healthLevel = 'alert';
  else if (worstPanel === 1) healthLevel = 'warn';

  if (agent?.state === 'HALT') {
    healthLevel = 'alert';
    issues.push('Agent halted');
  } else if (agent?.state === 'COOLDOWN' && severityScore(healthLevel) < 1) {
    healthLevel = 'warn';
    issues.push('Agent cooling down');
  }

  const uniqueIssues = Array.from(new Set(issues)).slice(0, 6);
  let headline = 'Session nominal';
  if (healthLevel === 'alert') headline = 'Immediate attention required';
  else if (healthLevel === 'warn') headline = 'Heightened monitoring advised';

  const health: HealthSummary = {
    level: healthLevel,
    headline,
    bullets: uniqueIssues.length ? uniqueIssues : ['No outstanding issues detected.'],
  };

  return {
    sessionId,
    symbol: session?.symbol ?? agent?.profile?.symbol,
    updatedAt: now,
    health,
    panels,
    telemetry: {
      order: {
        avgSlippageBps: avgSlip,
        avgLatencyMs: avgLatency,
        minFillRatio: minFill,
        maxAttempts,
      },
      ai: {
        callsTotal: kpi?.aiCallsTotal ?? null,
        lastUpdated: kpi?.lastUpdated ?? null,
      },
    },
    alerts,
    agentState: agent?.state ?? null,
  };
}
