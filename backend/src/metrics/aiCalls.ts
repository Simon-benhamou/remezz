import { prisma } from '../db/client.js';

let currentSessionId: string | null = null;

type AICounters = {
  sessionId: string;
  total: number;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: number; // ms since epoch
  firstCallAt?: number;
  lastCallAt?: number;
};

const store = new Map<string, AICounters>();

export async function setActiveSession(sessionId: string | null) {
  currentSessionId = sessionId;
  if (!sessionId) return;
  // Initialize store from DB so metrics persist across restarts
  try {
    const [sess, kpi] = await Promise.all([
      prisma.agentSession.findUnique({ where: { id: sessionId } }),
      prisma.sessionKpi.findUnique({ where: { sessionId } }),
    ]);
    const byModel = (kpi?.aiByModel as any) || {};
    const startedAt = sess?.startedAt ? new Date(sess.startedAt).getTime() : Date.now();
    store.set(sessionId, {
      sessionId,
      total: Number(kpi?.aiCallsTotal || 0),
      byModel,
      inputTokens: Number(kpi?.aiInputTokens || 0),
      outputTokens: Number(kpi?.aiOutputTokens || 0),
      costUsd: Number(kpi?.aiCostUsd || 0),
      startedAt,
      firstCallAt: undefined,
      lastCallAt: undefined,
    });
  } catch {
    if (!store.has(sessionId)) {
      store.set(sessionId, { sessionId, total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() });
    }
  }
}

export async function recordAICall(params: { model: string; inputTokens?: number; outputTokens?: number; costUsd?: number }) {
  if (!currentSessionId) return;
  const s = ensure(currentSessionId);
  s.total += 1;
  s.byModel[params.model] = (s.byModel[params.model] || 0) + 1;
  s.inputTokens += Math.max(0, params.inputTokens || 0);
  s.outputTokens += Math.max(0, params.outputTokens || 0);
  s.costUsd += Math.max(0, params.costUsd || 0);
  s.lastCallAt = Date.now();
  if (!s.firstCallAt) s.firstCallAt = s.lastCallAt;

  // Persist increments to DB SessionKpi
  try {
    const existing = await prisma.sessionKpi.findUnique({ where: { sessionId: currentSessionId } });
    const curByModel: Record<string, number> = ((existing?.aiByModel as any) || {}) as Record<string, number>;
    curByModel[params.model] = (curByModel[params.model] || 0) + 1;
    await prisma.sessionKpi.update({
      where: { sessionId: currentSessionId },
      data: {
        aiCallsTotal: { increment: 1 },
        aiInputTokens: { increment: Math.max(0, params.inputTokens || 0) },
        aiOutputTokens: { increment: Math.max(0, params.outputTokens || 0) },
        aiCostUsd: { increment: Math.max(0, params.costUsd || 0) },
        aiByModel: curByModel as any,
        lastUpdated: new Date(),
      },
    });
  } catch {
    // ignore persistence errors to avoid breaking hot path
  }
}

export async function getAICallsCount(sessionId?: string): Promise<number> {
  const id = sessionId || currentSessionId || '';
  const mem = store.get(id)?.total;
  if (typeof mem === 'number') return mem;
  try {
    const kpi = await prisma.sessionKpi.findUnique({ where: { sessionId: id } });
    return Number(kpi?.aiCallsTotal || 0);
  } catch { return 0; }
}

export async function getAIMetrics(sessionId?: string) {
  const id = sessionId || currentSessionId || '';
  let s = store.get(id);
  if (!s) {
    try {
      const [sess, kpi] = await Promise.all([
        prisma.agentSession.findUnique({ where: { id } }),
        prisma.sessionKpi.findUnique({ where: { sessionId: id } }),
      ]);
      s = {
        sessionId: id,
        total: Number(kpi?.aiCallsTotal || 0),
        byModel: (kpi?.aiByModel as any) || {},
        inputTokens: Number(kpi?.aiInputTokens || 0),
        outputTokens: Number(kpi?.aiOutputTokens || 0),
        costUsd: Number(kpi?.aiCostUsd || 0),
        startedAt: sess?.startedAt ? new Date(sess.startedAt).getTime() : Date.now(),
      };
    } catch {
      s = { sessionId: id, total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() };
    }
  }
  const now = Date.now();
  // Use actual session startedAt if available to compute rate since creation
  const hours = Math.max(0.25, (now - (s.startedAt || now)) / 3_600_000);
  const callsPerHour = s.total / hours;
  return {
    total: s.total,
    byModel: s.byModel,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    costUsd: s.costUsd,
    startedAt: s.startedAt,
    firstCallAt: s.firstCallAt || null,
    lastCallAt: s.lastCallAt || null,
    callsPerHour,
  };
}

function ensure(sessionId: string): AICounters {
  let s = store.get(sessionId);
  if (!s) {
    s = { sessionId, total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() };
    store.set(sessionId, s);
  }
  return s;
}
