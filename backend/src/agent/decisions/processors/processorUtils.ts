import { randomUUID } from 'crypto';
import type { AgentActionIntent, AgentActionPriority, AgentActionType } from '../../actions/types.js';

export function buildActionIntent(params: {
  sessionId: string;
  symbol: string;
  type: AgentActionType;
  priority?: AgentActionPriority;
  confidence?: number;
  reason: string;
  data?: Record<string, unknown>;
}): AgentActionIntent {
  const {
    sessionId,
    symbol,
    type,
    reason,
    data,
    priority = 'medium',
    confidence = 0.5,
  } = params;

  return {
    id: randomUUID(),
    sessionId,
    symbol,
    type,
    priority,
    confidence,
    reason,
    data,
    issuedAt: Date.now(),
  };
}
