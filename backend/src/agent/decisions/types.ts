import type { AgentActionIntent } from '../actions/types.js';
import type { ActivationProfile } from '../state.js';
import type { ActiveSession } from '../loops/helpers.js';
import type {
  ExecutionPlan,
  MarketQualityScore,
  PredictorInsight,
  RiskLimits,
  SentimentSignal,
} from '../subagents/types.js';

export type PerceptionSnapshots = {
  marketQuality?: MarketQualityScore | null;
  sentiment?: SentimentSignal | null;
  riskLimits?: RiskLimits | null;
  executionPlan?: ExecutionPlan | null;
  predictor?: PredictorInsight | null;
};

export type DecisionContext = {
  session: ActiveSession & { profile?: ActivationProfile | null };
  perception: PerceptionSnapshots;
};

export type DecisionDiagnostics = Record<string, unknown>;

export type DecisionResult = {
  processorId: string;
  intents: AgentActionIntent[];
  diagnostics?: DecisionDiagnostics;
};

export interface DecisionProcessor {
  readonly id: string;
  readonly description: string;
  evaluate(context: DecisionContext): Promise<DecisionResult | null> | DecisionResult | null;
}
