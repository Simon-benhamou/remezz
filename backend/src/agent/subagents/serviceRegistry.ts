import { DefaultExecutionAgent } from './executionAgent.js';
import { DefaultMarketQualityAgent } from './marketQualityAgent.js';
import { DefaultRiskGovernorAgent } from './riskGovernorAgent.js';
import { DefaultSentimentAgent } from './sentimentAgent.js';
import type {
  ExecutionAgent,
  MarketQualityAgent,
  PredictorAgent,
  RiskGovernorAgent,
  SentimentAgent,
  PredictorInsight,
} from './types.js';

class LazyPredictorAgent implements PredictorAgent {
  private delegate: PredictorAgent | null = null;
  private loader: Promise<PredictorAgent> | null = null;

  private async load(): Promise<PredictorAgent> {
    if (this.delegate) {
      return this.delegate;
    }
    if (!this.loader) {
      this.loader = import('./predictorAgent.js')
        .then((mod) => new mod.DefaultPredictorAgent())
        .catch((error) => {
          this.loader = null;
          throw error;
        });
    }
    this.delegate = await this.loader;
    return this.delegate;
  }

  private buildDisabledInsight(symbol: string, reason: string, error?: unknown): PredictorInsight {
    return {
      symbol,
      enabled: false,
      bias: 'neutral',
      confidence: 0,
      details: {
        disabledReason: reason,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      },
    };
  }

  async analyze(symbol: string): Promise<PredictorInsight> {
    if (process.env.NODE_ENV === 'test' || process.env.UNIT_TEST_MODE === 'true') {
      return this.buildDisabledInsight(symbol, 'unit_test_mode');
    }
    try {
      const agent = await this.load();
      return agent.analyze(symbol);
    } catch (error) {
      console.warn('[AgentServiceRegistry] Predictor agent unavailable, returning disabled insight', { error });
      return this.buildDisabledInsight(symbol, 'predictor_agent_load_failed', error);
    }
  }
}

export class AgentServiceRegistry {
  readonly marketQuality: MarketQualityAgent;
  readonly sentiment: SentimentAgent;
  readonly riskGovernor: RiskGovernorAgent;
  readonly execution: ExecutionAgent;
  readonly predictor: PredictorAgent;

  constructor() {
    this.marketQuality = new DefaultMarketQualityAgent();
    this.sentiment = new DefaultSentimentAgent();
    this.riskGovernor = new DefaultRiskGovernorAgent();
    this.execution = new DefaultExecutionAgent();
    this.predictor = new LazyPredictorAgent();
  }
}

export const agentServiceRegistry = new AgentServiceRegistry();
