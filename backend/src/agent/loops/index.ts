import { MarketQualityLoop } from './marketQualityLoop.js';
import { SentimentLoop } from './sentimentLoop.js';
import { RiskGovernorLoop } from './riskGovernorLoop.js';
import { ExecutionPlanningLoop } from './executionLoop.js';

const loops = [
  new MarketQualityLoop(),
  new SentimentLoop(),
  new RiskGovernorLoop(),
  new ExecutionPlanningLoop(),
];

export function startAgentPerceptionLoops(): void {
  loops.forEach((loop) => loop.start());
}

export function stopAgentPerceptionLoops(): void {
  loops.forEach((loop) => loop.stop());
}
