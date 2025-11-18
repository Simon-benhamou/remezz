import type { ExecutionPlan } from '../agent/subagents/types.js';

export type OrderSide = 'buy'|'sell';
export type OrderType = 'market'|'limit';

export type NewOrder = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number; // base units (e.g. BTC)
  price?: number; // for limit
  leverage?: number;
  clientOrderId?: string;
  takeProfit?: number;
  stopLoss?: number;
  reduceOnly?: boolean;
  timeInForce?: string;
  postOnly?: boolean;
  // Optional context for trade evaluation logging
  _evaluationContext?: {
    confidence: number;
    inputMetrics: {
      adx?: number;
      rsi14?: number;
      cmf?: number;
      atrPct?: number;
      [key: string]: number | undefined;
    };
    regimeContext?: {
      volatilityRegime?: 'low' | 'medium' | 'high';
      directionBias?: 'long' | 'short' | 'neutral';
      volumeRegime?: 'low' | 'normal' | 'high';
      trendingRanging?: 'trending' | 'ranging';
      parameterSource?: string;
    };
  };
  executionPlan?: ExecutionPlan;
};

export type PlacedOrder = NewOrder & {
  id: string; // broker id
  status: 'new'|'open'|'partially_filled'|'filled'|'canceled'|'rejected';
  avgPrice?: number;
  filledQty?: number;
  ts: number;
  // Optional protective orders identifiers (live broker)
  slOrderId?: string;
  tpOrderId?: string;
  attempts?: number;
  cancelCount?: number;
  latencyMs?: number;
  slippageBps?: number;
  fillRatio?: number;
  requestedQty?: number;
  requestedPrice?: number;
  simImpactBps?: number;
  estImpactBps?: number;
  usedDepth?: boolean;
  depthFallback?: boolean;
  releasedNotionalUsd?: number;
  realizedPnlUsd?: number;
};

export type BrokerPositionMargin = {
  symbol: string;
  side: 'long'|'short';
  qty: number;
  notionalUsd?: number;
  entryPrice?: number;
  markPrice?: number;
  liquidationPrice?: number;
  maintenanceMarginUsd?: number;
  initialMarginUsd?: number;
  leverage?: number;
  unrealizedPnlUsd?: number;
  marginRatio?: number;
  raw?: any;
};

export type BrokerCorrelatedExposure = {
  key: string;
  base?: string;
  quote?: string;
  totalNotionalUsd: number;
  longNotionalUsd: number;
  shortNotionalUsd: number;
  positions: string[];
  concentrationPct?: number;
};

export type BrokerMarginSnapshot = {
  freeUsd: number;
  equityUsd: number;
  committedUsd: number;
  maintenanceMarginUsd?: number;
  marginRatio?: number;
  marginLevel?: number;
  marginMode?: string;
  positions?: BrokerPositionMargin[];
  correlatedExposure?: Record<string, BrokerCorrelatedExposure>;
  timestamp?: number;
};

export interface Broker {
  mode: 'paper'|'live';
  balance(): Promise<BrokerMarginSnapshot>;
  place(o: NewOrder): Promise<PlacedOrder>;
  cancel(id: string): Promise<void>;
  estimateFillableQty?(params: { symbol: string; side: OrderSide; desiredQty: number; maxImpactPct?: number }): Promise<{ fillableQty: number; impactPct?: number; minQty?: number }>;
  // optional: paper-specific reserve release
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  releaseCommitted?(usd: number): void;
  syncProtective?(params: { symbol: string; side: OrderSide; qty: number; stopLoss?: number; takeProfit?: number | number[]; slOrderId?: string|null; tpOrderId?: string|null }): Promise<{ slOrderId?: string | null; tpOrderId?: string | null } | void>;
}
