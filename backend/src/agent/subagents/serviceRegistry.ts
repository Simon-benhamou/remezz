import { DefaultExecutionAgent } from './executionAgent.js';
import { DefaultMarketQualityAgent } from './marketQualityAgent.js';
import { DefaultRiskGovernorAgent } from './riskGovernorAgent.js';
import { DefaultSentimentAgent } from './sentimentAgent.js';
import type {
  ExecutionAgent,
  MarketQualityAgent,
  RiskGovernorAgent,
  SentimentAgent,
} from './types.js';

export class AgentServiceRegistry {
  readonly marketQuality: MarketQualityAgent;
  readonly sentiment: SentimentAgent;
  readonly riskGovernor: RiskGovernorAgent;
  readonly execution: ExecutionAgent;

  constructor() {
    this.marketQuality = new DefaultMarketQualityAgent();
    this.sentiment = new DefaultSentimentAgent();
    this.riskGovernor = new DefaultRiskGovernorAgent();
    this.execution = new DefaultExecutionAgent();
  }
}

export const agentServiceRegistry = new AgentServiceRegistry();
