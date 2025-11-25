import type { DecisionProcessor } from './types.js';
import { ExecutionPlanDecisionProcessor } from './processors/executionDecision.js';
import { MarketQualityDecisionProcessor } from './processors/marketQualityDecision.js';
import { RiskGovernorDecisionProcessor } from './processors/riskDecision.js';
import { SentimentDecisionProcessor } from './processors/sentimentDecision.js';

const processors: DecisionProcessor[] = [
  new MarketQualityDecisionProcessor(),
  new SentimentDecisionProcessor(),
  new RiskGovernorDecisionProcessor(),
  new ExecutionPlanDecisionProcessor(),
];

export function getDecisionProcessors(): DecisionProcessor[] {
  return processors;
}
