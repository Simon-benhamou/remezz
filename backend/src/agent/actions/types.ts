export type AgentActionPriority = 'low' | 'medium' | 'high';

export type AgentActionType =
  | 'throttle_entries'
  | 'enforce_hedge'
  | 'switch_execution_mode'
  | 'adjust_allocation'
  | 'publish_alert'
  | 'request_predictor_refresh';

export type AgentActionIntent = {
  id: string;
  sessionId: string;
  symbol: string;
  type: AgentActionType;
  priority: AgentActionPriority;
  confidence: number;
  reason: string;
  issuedAt: number;
  data?: Record<string, unknown>;
};
