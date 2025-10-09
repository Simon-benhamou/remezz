import os from 'os';
import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';

type OpsEventLevel = 'info'|'warn'|'error';

export type OpsEvent = {
  id: string;
  ts: number;
  level: OpsEventLevel;
  source: string;
  message: string;
  sessionId?: string;
  symbol?: string;
  details?: any;
};

const MAX_EVENTS = 200;
const opsEvents: OpsEvent[] = [];

export function recordOpsEvent(evt: { level?: OpsEventLevel; source: string; message: string; sessionId?: string; symbol?: string; details?: any }) {
  const row: OpsEvent = {
    id: `ops_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
    ts: Date.now(),
    level: evt.level || 'info',
    source: evt.source,
    message: evt.message,
    sessionId: evt.sessionId,
    symbol: evt.symbol,
    details: evt.details,
  };
  opsEvents.push(row);
  if (opsEvents.length > MAX_EVENTS) opsEvents.splice(0, opsEvents.length - MAX_EVENTS);
}

export function recentOpsEvents(limit = 50) {
  const slice = opsEvents.slice(-Math.max(1, Math.min(limit, MAX_EVENTS)));
  return slice.reverse();
}

export function clearOpsEvents() {
  opsEvents.splice(0, opsEvents.length);
}

function formatMemory() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
  };
}

async function countAlertsBySeverity(since: Date) {
  const [high, med, low] = await Promise.all([
    prisma.alert.count({ where: { severity: 'high', createdAt: { gte: since } } }),
    prisma.alert.count({ where: { severity: 'med', createdAt: { gte: since } } }),
    prisma.alert.count({ where: { severity: 'low', createdAt: { gte: since } } }),
  ]);
  return { high, med, low, total: high + med + low };
}

export async function computeOpsMetrics() {
  const now = Date.now();
  const uptimeSec = Math.round(process.uptime());
  const loadAvg = os.loadavg()[0];
  const memory = formatMemory();

  const marginRepo = (prisma as any).marginSnapshot as any;

  const agents = AgentHub.snapshot();
  const agentStates = agents.reduce((acc: Record<string, number>, a) => {
    const state = a.state || 'UNKNOWN';
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const haltedAgents = agents.filter((a) => a.state === 'HALT').length;
  const managingAgents = agents.filter((a) => a.state === 'MANAGE').length;

  const [activeSessions, openPositions, protectiveIssues, alerts1h, alerts24h, kpiAgg, marginRows] = await Promise.all([
    prisma.agentSession.count({ where: { stoppedAt: null } }),
    prisma.position.count({ where: { qty: { gt: 0 } } }),
    prisma.position.count({
      where: {
        qty: { gt: 0 },
        OR: [
          { protectiveStatus: null },
          { protectiveStatus: { contains: 'error' } },
          { lastProtectiveSyncAt: { lt: new Date(now - 10 * 60 * 1000) } },
        ],
      },
    }),
    countAlertsBySeverity(new Date(now - 60 * 60 * 1000)),
    countAlertsBySeverity(new Date(now - 24 * 60 * 60 * 1000)),
    prisma.sessionKpi.aggregate({ _sum: { aiCallsTotal: true } }),
    marginRepo ? marginRepo.findMany({ orderBy: { createdAt: 'desc' }, take: 120 }) : [],
  ]);

  let marginSummary: any = null;
  if (Array.isArray(marginRows) && marginRows.length) {
    const latestBySession = new Map<string, any>();
    for (const row of marginRows) {
      if (!latestBySession.has(row.sessionId)) {
        latestBySession.set(row.sessionId, row);
      }
    }
    const latest = Array.from(latestBySession.values());
    const tracked = latest.length;
    const warnCount = latest.filter((row) => row.status === 'warn').length;
    const criticalCount = latest.filter((row) => row.status === 'critical').length;
    const averageUtilisationPct = tracked
      ? latest.reduce((acc, row) => acc + (Number(row.utilisationPct) || 0), 0) / tracked
      : 0;
    const worstSessions = latest
      .filter((row) => row.status !== 'ok')
      .sort((a, b) => Number(b.utilisationPct || 0) - Number(a.utilisationPct || 0))
      .slice(0, 5)
      .map((row) => ({
        sessionId: row.sessionId,
        symbol: row.symbol,
        status: row.status,
        utilisationPct: Number(row.utilisationPct || 0),
        worstLiquidationDistancePct: row.worstLiquidationDistancePct,
        actions: row.recommendedActions,
      }));
    marginSummary = {
      tracked,
      warn: warnCount,
      critical: criticalCount,
      averageUtilisationPct,
      worstSessions,
      lastUpdated: marginRows[0]?.createdAt ?? null,
    };
  }

  return {
    timestamp: now,
    uptimeSec,
    loadAvg,
    memory,
    sessions: {
      active: activeSessions,
      halted: haltedAgents,
      managing: managingAgents,
    },
    positions: {
      open: openPositions,
      protectiveIssues,
    },
    agents: {
      total: agents.length,
      states: agentStates,
    },
    alerts: {
      lastHour: alerts1h,
      last24h: alerts24h,
    },
    ai: {
      totalCalls: kpiAgg._sum.aiCallsTotal ?? 0,
    },
    margin: marginSummary,
  };
}
