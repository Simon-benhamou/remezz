let currentSessionId: string | null = null;

type AICounters = {
  sessionId: string;
  total: number;
  byModel: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: number; // when session was set active
  firstCallAt?: number;
  lastCallAt?: number;
};

const store = new Map<string, AICounters>();

export function setActiveSession(sessionId: string | null) {
  currentSessionId = sessionId;
  if (!sessionId) return;
  if (!store.has(sessionId)) {
    store.set(sessionId, { sessionId, total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() });
  }
}

export function incAICall() {
  if (!currentSessionId) return;
  const s = ensure(currentSessionId);
  s.total += 1;
  s.lastCallAt = Date.now();
  if (!s.firstCallAt) s.firstCallAt = s.lastCallAt;
}

export function recordAICall(params: { model: string; inputTokens?: number; outputTokens?: number; costUsd?: number }) {
  if (!currentSessionId) return;
  const s = ensure(currentSessionId);
  s.total += 1;
  s.byModel[params.model] = (s.byModel[params.model] || 0) + 1;
  s.inputTokens += Math.max(0, params.inputTokens || 0);
  s.outputTokens += Math.max(0, params.outputTokens || 0);
  s.costUsd += Math.max(0, params.costUsd || 0);
  s.lastCallAt = Date.now();
  if (!s.firstCallAt) s.firstCallAt = s.lastCallAt;
}

export function getAICallsCount(sessionId?: string): number {
  const id = sessionId || currentSessionId || '';
  return store.get(id)?.total || 0;
}

export function getAIMetrics(sessionId?: string) {
  const id = sessionId || currentSessionId || '';
  const s = store.get(id);
  if (!s) return { total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: null as any, firstCallAt: null as any, lastCallAt: null as any, callsPerHour: 0 };
  const now = Date.now();
  const base = s.firstCallAt || s.startedAt || now;
  const hours = Math.max(0.25, (now - base) / 3600000); // smooth early spikes: min 15 min window
  const callsPerHour = s.total / hours;
  return { total: s.total, byModel: s.byModel, inputTokens: s.inputTokens, outputTokens: s.outputTokens, costUsd: s.costUsd, startedAt: s.startedAt, firstCallAt: s.firstCallAt, lastCallAt: s.lastCallAt, callsPerHour };
}

function ensure(sessionId: string): AICounters {
  let s = store.get(sessionId);
  if (!s) { s = { sessionId, total: 0, byModel: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, startedAt: Date.now() }; store.set(sessionId, s); }
  return s;
}
