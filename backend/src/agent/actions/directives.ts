import { agentMemoryStore } from '../memory/store.js';

export type ExecutionModeDirective = {
  intentId: string;
  mode: 'market' | 'limit' | 'twap';
  reason: string;
  expiresAt: number;
  metadata?: Record<string, unknown> | null;
};

const EXECUTION_DIRECTIVE_KEY = 'actions.execution';

export function saveExecutionModeDirective(sessionId: string, directive: ExecutionModeDirective): void {
  agentMemoryStore.update(EXECUTION_DIRECTIVE_KEY, sessionId, directive);
}

export function getExecutionModeDirective(sessionId: string): ExecutionModeDirective | null {
  const entry = agentMemoryStore.get<ExecutionModeDirective>(EXECUTION_DIRECTIVE_KEY, sessionId);
  if (!entry?.data) {
    return null;
  }
  if (entry.data.expiresAt <= Date.now()) {
    return null;
  }
  return entry.data;
}

export function clearExecutionModeDirective(sessionId: string): void {
  agentMemoryStore.update(EXECUTION_DIRECTIVE_KEY, sessionId, {
    intentId: 'expired',
    mode: 'market',
    reason: 'expired',
    expiresAt: Date.now() - 1,
  });
}
