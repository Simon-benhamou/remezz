export type MarketQualityScore = {
  symbol: string;
  spreadBps: number;
  bookDepthUsd: number;
  impactUsd: number;
  score: number;
  timestamp: number;
  tuning?: {
    minScore?: number;
    liquidityFloorUsd?: number;
    spreadCeilBps?: number;
    confidence?: number;
  };
};

export interface MarketQualityAgent {
  assess(symbol: string): Promise<MarketQualityScore>;
}

export type SentimentSignal = {
  symbol: string;
  whaleActivity: number;
  newsHeat: number;
  bias: 'bullish' | 'bearish' | 'neutral';
  confidence: number;
  timestamp: number;
};

export interface SentimentAgent {
  getSignal(symbol: string): Promise<SentimentSignal>;
}

export type RiskLimits = {
  sessionId: string;
  maxLeverage: number;
  maxPositionUsd: number;
  clusterExposureUsd: number;
  hedgingRequired: boolean;
  reason?: string;
  timestamp: number;
};

export interface RiskGovernorAgent {
  getLimits(sessionId: string, symbol: string): Promise<RiskLimits>;
}

export type ExecutionPlan = {
  symbol: string;
  side: 'buy' | 'sell';
  sizeUsd: number;
  urgency: 'low' | 'medium' | 'high';
  strategy: 'twap' | 'sweep' | 'iceberg' | 'market';
  minFillUsd: number;
  maxSlippageBps: number;
  meta?: {
    passiveOffsetBps?: number;
    fallbackDelayMs?: number;
    twapSlices?: number;
    twapIntervalMs?: number;
    preferPassive?: boolean;
    preferAggressive?: boolean;
    depthRatio?: number;
    sizeBucket?: 'small' | 'medium' | 'large' | 'mega';
    tuningSource?: string;
    notes?: string[];
    telemetry?: Record<string, number | string | boolean | null | undefined>;
  };
};

export interface ExecutionAgent {
  plan(params: {
    symbol: string;
    side: 'buy' | 'sell';
    sizeUsd: number;
    spreadBps: number;
    marketQualityScore: number;
    marketQuality?: MarketQualityScore | null;
    riskLimits?: RiskLimits | null;
  }): Promise<ExecutionPlan>;
}
