import type { AgentActionIntent, AgentActionType } from '../actions/types.js';
import type { ExecutionPlan, MarketQualityScore, RiskLimits, SentimentSignal } from '../subagents/types.js';

export type AgentEventMap = {
  'marketQuality.updated': {
    symbol: string;
    sessionIds: string[];
    snapshot: MarketQualityScore;
  };
  'sentiment.updated': {
    symbol: string;
    snapshot: SentimentSignal;
  };
  'riskGovernor.updated': {
    sessionId: string;
    symbol: string;
    limits: RiskLimits;
  };
  'riskGovernor.alert': {
    sessionId: string;
    symbol: string;
    reason: string;
    limits: RiskLimits;
  };
  'execution.plan.ready': {
    sessionId: string;
    symbol: string;
    plan: ExecutionPlan;
  };
  'decisions.intent': {
    sessionId: string;
    symbol: string;
    intents: AgentActionIntent[];
  };
  'actions.executed': {
    sessionId: string;
    symbol: string;
    intentId: string;
    type: AgentActionType;
    status: 'completed' | 'failed' | 'skipped';
    details: Record<string, unknown> | null;
    failureReason?: string | null;
  };
};

export type AgentEventName = keyof AgentEventMap;
export type AgentEventPayload<E extends AgentEventName> = AgentEventMap[E];
