import { PreciseDecimal } from '../metaAdaptive/metaAdaptiveAgent.js';

export type Timeframe = '1m' | '5m' | '15m';

export type Candle = {
  timestamp: number; // ms UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OrderBookLevel = {
  price: number;
  size: number;
};

export type OrderBookSnapshot = {
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  takerBuyVolume?: number;
  takerSellVolume?: number;
  source?: 'depth' | 'fallback_ticker';
};

export type AggressionSample = {
  timestamp: number;
  takerBuy: number;
  takerSell: number;
};

export type TickInput = {
  symbol: string;
  timestamp: number;
  price: number;
  candles: Record<Timeframe, Candle[]>;
  orderBook: OrderBookSnapshot | null;
  aggression?: AggressionSample | null;
  newsSpike?: boolean;
};

export type VolatilityFeatures = {
  atrPct: number;
  trueRangePct: number;
  bollingerWidthPct: number;
  bollingerPercentB: number;
  bollingerUpper: number;
  bollingerLower: number;
  bollingerMiddle: number;
  bandZScore: number;
  keltnerWidthPct: number;
  squeezeRatio: number;
  squeezeState: 'range' | 'expansion' | 'neutral';
};

export type MomentumFeatures = {
  roc: Record<string, number>;
  emaSlope: Record<string, number>;
  emaValue: Record<string, number>;
  rsi: Record<string, number>;
  rsiSlope: Record<string, number>;
  macdHistogram: number;
};

export type VolumeFeatures = {
  zScore: number;
  obvDelta: number;
  spike95: boolean;
  spike99: boolean;
};

export type OrderBookFeatures = {
  imbalance: number;
  imbalanceDelta: number;
  aggressionRatio: number;
};

export type TickFeatures = {
  timeframe: Timeframe;
  timestamp: number;
  price: number;
  volatility: VolatilityFeatures;
  momentum: MomentumFeatures;
  volume: VolumeFeatures;
  orderBook: OrderBookFeatures;
};

export type RegimeLabel = 'BOM' | 'MR' | 'NONE';

export type RegimeSignal = {
  label: RegimeLabel;
  confidence: number;
  reason: string;
  biasAgeMs?: number;
};

export type EntrySignal = {
  regime: RegimeLabel;
  side: 'long' | 'short';
  entryType: 'breakout' | 'mean-reversion';
  triggerPrice: PreciseDecimal;
  stopLossPrice: PreciseDecimal;
  takeProfit1: PreciseDecimal;
  takeProfit2: PreciseDecimal;
  runnerTrailAtrMult: number;
  size: PreciseDecimal;
  riskUsd: PreciseDecimal;
  leverage: number;
  confidence: number;
  rationale: string[];
  execution: ExecutionDirective;
  entryAtrPct: number;
  pyramidAdd?: boolean;
  stopGrace?: { price: PreciseDecimal; expiresAt: number };
  telemetry?: {
    pWin: number;
    qs: number;
    riskScale: number;
    slBps: number;
    tpBps: number;
    evBps: number;
    predictedSlippageBps: number;
  };
};

export type ExecutionDirective = {
  mode: 'maker' | 'taker' | 'twap';
  passiveOffsetBps?: number;
  fallbackSeconds?: number;
  maxSlippageBps?: number;
};

export type ExitDirective = {
  reason: 'stop' | 'tp1' | 'tp2' | 'runner' | 'time' | 'guardrail';
  exitPrice: PreciseDecimal;
  timestamp: number;
};

export type TradeLog = {
  timestamp: number;
  side: 'long' | 'short';
  quantity: PreciseDecimal;
  price: PreciseDecimal;
  cumulativePnl: PreciseDecimal;
  reason: string;
  executionMode: ExecutionDirective['mode'];
  holdDurationMs: number;
  entryAtrPct: number;
  exitAtrPct: number;
};

export type BacktestMetrics = {
  totalReturnPct: number;
  cagr: number;
  sharpe: number;
  maxDrawdownPct: number;
  hitRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  pnlSeries: number[];
};

export type BacktestResult = {
  metrics: BacktestMetrics;
  trades: TradeLog[];
  signals: EntrySignal[];
  walkForward?: { start: number; end: number; metrics: BacktestMetrics }[];
};
