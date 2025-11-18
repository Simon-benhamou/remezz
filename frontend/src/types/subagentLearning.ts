export type SubagentKind = 'risk_governor' | 'execution' | 'predictor' | 'sentiment' | 'market_quality';

export type SubagentMetrics = {
  tradeCount: number;
  winRate: number;
  normalizedScore: number;
  netPnlUsd: number;
  avgLatencyMs: number | null;
  avgSlippageBps: number | null;
  avgDrawdownPct: number | null;
  complianceRate: number;
  sampleWindows: number[];
  agentFamilies: string[];
};

export type RiskLearningRecommendation = {
  recommendedMaxLeverage: number;
  recommendedMaxPositionPct: number;
  hedgingTension: number;
  confidence: number;
};

export type ExecutionLearningRecommendation = {
  preferredMode?: 'market' | 'sweep' | 'iceberg' | 'twap';
  passiveBias?: number;
  fallbackMs?: number;
  twapSliceMultiplier?: number;
  confidence: number;
};

export type PredictorLearningRecommendation = {
  action: 'healthy' | 'monitor' | 'retrain';
  confidenceModifier: number;
  forceFresh: boolean;
  cacheTtlMultiplier: number;
  reason: string;
};

export type SentimentLearningRecommendation = {
  signalWeight: number;
  cooldownMs: number;
  newsHeatWeight: number;
  confidence: number;
};

export type MarketQualityLearningRecommendation = {
  minScore: number;
  liquidityFloorUsd: number;
  spreadCeilBps: number;
  confidence: number;
};

export type SubagentLearningRecommendations = {
  risk_governor: RiskLearningRecommendation;
  execution: ExecutionLearningRecommendation;
  predictor: PredictorLearningRecommendation;
  sentiment: SentimentLearningRecommendation;
  market_quality: MarketQualityLearningRecommendation;
};

export type SubagentLearningRecord<K extends SubagentKind = SubagentKind> = {
  subagent: K;
  symbol: string;
  mode: string;
  regime: string;
  score: number;
  sampleCount: number;
  metrics: SubagentMetrics;
  tuning: SubagentLearningRecommendations[K];
  reason?: string;
};

export type SubagentLearningData = {
  risk: Array<SubagentLearningRecord<'risk_governor'>>;
  execution: Array<SubagentLearningRecord<'execution'>>;
  predictor: Array<SubagentLearningRecord<'predictor'>>;
  sentiment: Array<SubagentLearningRecord<'sentiment'>>;
  marketQuality: Array<SubagentLearningRecord<'market_quality'>>;
};

export type SubagentLearningSnapshot = {
  generatedAt: number;
  lookbackMinutes: number;
  combosEvaluated: number;
  data: SubagentLearningData;
};

export type SubagentLearningResponse = {
  ok: boolean;
  snapshot: SubagentLearningSnapshot | null;
  fromCache?: boolean;
  reason?: string;
};
