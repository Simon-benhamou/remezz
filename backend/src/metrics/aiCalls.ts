let currentSessionId: string | null = null;
const counts = new Map<string, number>();

export function setActiveSession(sessionId: string | null) {
  currentSessionId = sessionId;
  if (sessionId && !counts.has(sessionId)) counts.set(sessionId, 0);
}

export function incAICall() {
  if (!currentSessionId) return;
  counts.set(currentSessionId, (counts.get(currentSessionId) || 0) + 1);
}

export function getAICallsCount(sessionId?: string): number {
  const id = sessionId || currentSessionId || '';
  return counts.get(id) || 0;
}

