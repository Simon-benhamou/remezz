import os from 'os';
import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';

const TRADE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_ACTIVITY_MS = 6 * 60 * 60 * 1000;

type AgentSnapshot = ReturnType<typeof AgentHub.snapshot>;
type AgentSnapshotEntry = AgentSnapshot extends Array<infer Item> ? Item : never;

export type AgentHealthStatus = 'ok' | 'idle' | 'stale' | 'blocked';
export type AgentHealthFlag = 'no_trades' | 'vos_block' | 'stale';

type AgentAggressiveness = 'conservative' | 'reactive' | 'aggressive';

export type AgentHealthRow = {
  sessionId: string;
  symbol: string | null;
  mode: string | null;
  state: string | null;
  hasPosition: boolean;
  tradeCount24h: number;
  wins24h: number;
  losses24h: number;
  breakeven24h: number;
  lastExecutionTs: number | null;
  blockedByVos: boolean;
  lastBlockedAt: number | null;
  status: AgentHealthStatus;
  flags: AgentHealthFlag[];
  aggressiveness: AgentAggressiveness | null;
};

export type AgentHealthSnapshot = {
  timestamp: number;
  windowMs: number;
  staleThresholdMs: number;
  agents: AgentHealthRow[];
};

type OpsEventLevel = 'info'|'warn'|'error'|'watch'|'debug';

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

function toTimestampMs(value: any): number | null {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export async function computeAgentHealth(
  now = Date.now(),
  opts: { agentsSnapshot?: AgentSnapshot } = {},
): Promise<AgentHealthSnapshot> {
  const agents = opts.agentsSnapshot ?? AgentHub.snapshot();
  const agentById = new Map<string, AgentSnapshotEntry | undefined>(
    agents.map((entry: AgentSnapshotEntry) => [entry.sessionId, entry]),
  );

  const activeSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { id: true, symbol: true, mode: true, profileJson: true },
  });
  const sessionIds = activeSessions.map((session) => session.id);

  const telemetryRepo = (prisma as any).agentOpsTelemetry as
    | { findMany: (args: any) => Promise<any[]> }
    | undefined;
  const telemetryRows = sessionIds.length && telemetryRepo
    ? await telemetryRepo.findMany({ where: { sessionId: { in: sessionIds } } })
    : [];
  const telemetryBySession = new Map<string, any>(
    Array.isArray(telemetryRows)
      ? telemetryRows.map((row: any) => [row.sessionId, row])
      : [],
  );

  const needsFallback = activeSessions
    .filter((session) => {
      const telemetry = telemetryBySession.get(session.id);
      if (!telemetry) return true;
      const tradeCount = Number(telemetry.tradeCount24h ?? 0);
      const lastExec = telemetry.lastExecutionAt ?? telemetry.lastExecutionTs;
      return tradeCount <= 0 || lastExec == null;
    })
    .map((session) => session.id);

  const fallbackCounts = new Map<string, number>();
  const fallbackLastTs = new Map<string, number>();
  const fillPerformance = new Map<string, { wins: number; losses: number; breakeven: number }>();
  if (sessionIds.length) {
    const needsFallbackSet = new Set(needsFallback);
    const fillsInWindow = await prisma.fill.findMany({
      where: {
        sessionId: { in: sessionIds },
        ts: { gte: new Date(now - TRADE_WINDOW_MS) },
      },
      select: { sessionId: true, ts: true, realizedPnl: true },
    });

    for (const row of fillsInWindow) {
      if (!row.sessionId) continue;
      const ts = toTimestampMs((row as any).ts);
      if (ts == null) continue;

      if (needsFallbackSet.has(row.sessionId)) {
        fallbackCounts.set(row.sessionId, (fallbackCounts.get(row.sessionId) ?? 0) + 1);
        if (!fallbackLastTs.has(row.sessionId) || ts > (fallbackLastTs.get(row.sessionId) ?? 0)) {
          fallbackLastTs.set(row.sessionId, ts);
        }
      }

      if (row.realizedPnl != null) {
        const pnl = Number(row.realizedPnl);
        if (!Number.isFinite(pnl)) {
          continue;
        }
        const stats = fillPerformance.get(row.sessionId) ?? { wins: 0, losses: 0, breakeven: 0 };
        if (pnl > 0) stats.wins += 1;
        else if (pnl < 0) stats.losses += 1;
        else stats.breakeven += 1;
        fillPerformance.set(row.sessionId, stats);
      }
    }
  }

  const normalizeAggressiveness = (value: unknown): AgentAggressiveness | null => {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase();
    if (lower === 'conservative' || lower === 'reactive' || lower === 'aggressive') {
      return lower;
    }
    return null;
  };

  const agentsHealth: AgentHealthRow[] = activeSessions.map((session) => {
    const telemetry = telemetryBySession.get(session.id) ?? null;
    const agent = agentById.get(session.id) ?? null;

    const telemetryTradeCount = Number(telemetry?.tradeCount24h ?? 0);
    const fallbackTradeCount = fallbackCounts.get(session.id);
    const tradeCount24h =
      fallbackTradeCount != null ? Math.max(telemetryTradeCount, fallbackTradeCount) : telemetryTradeCount;

    const telemetryLastExecution = toTimestampMs(telemetry?.lastExecutionAt);
    const fallbackLastExecution = fallbackLastTs.get(session.id) ?? null;
    const lastExecutionTs =
      telemetryLastExecution && fallbackLastExecution
        ? Math.max(telemetryLastExecution, fallbackLastExecution)
        : telemetryLastExecution ?? fallbackLastExecution ?? null;
    const blockedByVos = Boolean(telemetry?.blockedByVos);
    const lastBlockedAt = toTimestampMs(telemetry?.lastBlockedAt);

    const flags: AgentHealthFlag[] = [];
    if (blockedByVos) flags.push('vos_block');
    if (tradeCount24h === 0) flags.push('no_trades');
    const isStale = !lastExecutionTs || now - lastExecutionTs > STALE_ACTIVITY_MS;
    if (isStale) flags.push('stale');

    let status: AgentHealthStatus = 'ok';
    if (blockedByVos) status = 'blocked';
    else if (isStale) status = 'stale';
    else if (tradeCount24h === 0) status = 'idle';

    const runtimeAggressiveness = normalizeAggressiveness((agent as any)?.aggressiveness ?? (agent as any)?.profile?.aggressiveness);
    let persistedAggressiveness: AgentAggressiveness | null = null;
    if (session.profileJson && typeof session.profileJson === 'object' && !Array.isArray(session.profileJson)) {
      persistedAggressiveness = normalizeAggressiveness((session.profileJson as Record<string, unknown>).aggressiveness);
    }
    const telemetryAggressiveness = normalizeAggressiveness((telemetry as any)?.profile?.aggressiveness);
    const aggressiveness = runtimeAggressiveness || telemetryAggressiveness || persistedAggressiveness;

    const performance = fillPerformance.get(session.id) ?? { wins: 0, losses: 0, breakeven: 0 };

    return {
      sessionId: session.id,
      symbol: session.symbol,
      mode: session.mode,
      state: agent?.state ?? null,
      hasPosition: Boolean(agent?.hasPosition),
      tradeCount24h,
      wins24h: performance.wins,
      losses24h: performance.losses,
      breakeven24h: performance.breakeven,
      lastExecutionTs,
      blockedByVos,
      lastBlockedAt,
      status,
      flags,
      aggressiveness,
    };
  });

  return {
    timestamp: now,
    windowMs: TRADE_WINDOW_MS,
    staleThresholdMs: STALE_ACTIVITY_MS,
    agents: agentsHealth,
  };
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

  const [
    activeSessions,
    openPositions,
    protectiveIssues,
    alerts1h,
    alerts24h,
    kpiAgg,
    marginRows,
    agentHealth,
    tradeStats,
    profitableStats,
  ] = await Promise.all([
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
    computeAgentHealth(now, { agentsSnapshot: agents }),
    prisma.fill.groupBy({
      by: ['sessionId'],
      where: { sessionId: { not: null }, realizedPnl: { not: null } },
      _count: { _all: true },
      _max: { ts: true },
    }),
    prisma.fill.groupBy({
      by: ['sessionId'],
      where: { sessionId: { not: null }, realizedPnl: { gt: 0 } },
      _max: { ts: true },
    }),
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

  const agentSymbolMap = agents.reduce((acc: Map<string, string | null>, agent) => {
    if (agent.sessionId) {
      acc.set(agent.sessionId, agent.symbol || null);
    }
    return acc;
  }, new Map<string, string | null>());

  const vosEvents = opsEvents.filter((evt) => evt.message === 'validator_of_signal_block');
  const vosBySession = new Map<string, { sessionId: string; symbol: string | null; count: number; lastEvent: OpsEvent | null }>();

  for (const evt of vosEvents) {
    if (!evt.sessionId) continue;
    const existing = vosBySession.get(evt.sessionId) || {
      sessionId: evt.sessionId,
      symbol: evt.symbol ?? agentSymbolMap.get(evt.sessionId) ?? null,
      count: 0,
      lastEvent: null,
    };
    existing.count += 1;
    if (!existing.symbol && evt.symbol) {
      existing.symbol = evt.symbol;
    }
    if (!existing.lastEvent || existing.lastEvent.ts < evt.ts) {
      existing.lastEvent = evt;
    }
    vosBySession.set(evt.sessionId, existing);
  }

  const tradeCountMap = new Map<string, { count: number; lastTradeAt: number | null }>();
  for (const row of tradeStats as any[]) {
    const sessionId = row.sessionId as string | null;
    if (!sessionId) continue;
    const count = Number(row?._count?._all ?? 0);
    const lastTradeAt = row?._max?.ts ? new Date(row._max.ts).getTime() : null;
    tradeCountMap.set(sessionId, { count, lastTradeAt });
  }

  const profitableMap = new Map<string, number | null>();
  for (const row of profitableStats as any[]) {
    const sessionId = row.sessionId as string | null;
    if (!sessionId) continue;
    const ts = row?._max?.ts ? new Date(row._max.ts).getTime() : null;
    profitableMap.set(sessionId, ts);
  }

  const entryGateSessions = Array.from(vosBySession.values())
    .map((row) => {
      const tradeInfo = tradeCountMap.get(row.sessionId);
      const successfulTradeAt = profitableMap.get(row.sessionId) ?? null;
      const tradeCount = tradeInfo?.count ?? 0;
      const lastTradeAt = tradeInfo?.lastTradeAt ?? null;
      const lastEvent = row.lastEvent;
      const primary = lastEvent?.details?.primary as any;
      const flagged = tradeCount === 0 && row.count >= 3;

      return {
        sessionId: row.sessionId,
        symbol: row.symbol ?? agentSymbolMap.get(row.sessionId) ?? null,
        count: row.count,
        lastBlockedAt: lastEvent?.ts ?? null,
        lastReasonCode: primary?.code ?? primary?.key ?? null,
        lastReason: primary?.reason ?? primary?.message ?? null,
        lastSuccessfulTradeAt: successfulTradeAt,
        tradeCount,
        lastTradeAt,
        triggerPhase: lastEvent?.details?.trigger?.phase ?? null,
        flagged,
      };
    })
    .sort((a, b) => b.count - a.count);

  const flaggedSessions = entryGateSessions.filter((row) => row.flagged);

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
    agentHealth,
    ops: {
      entryGateBlocks: {
        total: vosEvents.length,
        sessions: entryGateSessions,
      },
      flaggedSessions,
    },
  };
}
