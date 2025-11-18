import type { DecisionProcessor } from './types.js';
import { ExecutionPlanDecisionProcessor } from './processors/executionDecision.js';
import { MarketQualityDecisionProcessor } from './processors/marketQualityDecision.js';
import { PredictorDecisionProcessor } from './processors/predictorDecision.js';
import { RiskGovernorDecisionProcessor } from './processors/riskDecision.js';
import { SentimentDecisionProcessor } from './processors/sentimentDecision.js';

const processors: DecisionProcessor[] = [
  new MarketQualityDecisionProcessor(),
  new SentimentDecisionProcessor(),
  new RiskGovernorDecisionProcessor(),
  new ExecutionPlanDecisionProcessor(),
  new PredictorDecisionProcessor(),
];

export function getDecisionProcessors(): DecisionProcessor[] {
  return processors;
}
