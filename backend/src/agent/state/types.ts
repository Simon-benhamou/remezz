import type { RegimeProfile } from '../../ai/regime.js';
import type { TechnicalSnapshot } from '../../ai/tech.js';
import type { BrokerMarginSnapshot } from '../../broker/types.js';
import type { PlanJson } from '../planSchema.js';
import type { ValidatedPlan } from '../validator.js';
import type { RecognizedStrategySignal } from '../../quantai/strategies/metaAdaptive/recognizedStrategies.js';
import type { EntryRelaxation } from '../../quantai/strategies/metaAdaptive/entryFilters.js';
import type { CircuitBreakerState, ExitArchetype } from '../../quantai/index.js';
import type { AdaptiveRiskResult } from '../../risk/adaptive.js';
import type { ResolvedLeverageCap } from '../../risk/leverageCaps.js';
import type { RRExpectancyConfig } from '../../risk/rrExpectancy.js';
import type { ModeParams, AgentAggressiveness } from '../../utils/env.js';

export type AgentMode = 'paper' | 'live';
export type AgentState =
  | 'IDLE'
  | 'PREFLIGHT'
  | 'SCAN'
  | 'PROPOSE'
  | 'VALIDATE'
  | 'ARMED'
  | 'ENTERED'
  | 'MANAGE'
  | 'EXIT'
  | 'REPORT'
  | 'COOLDOWN'
  | 'HALT';

export type ActivationProfile = {
  symbol: string;
  mode: AgentMode;
  maxLeverage: number; // <= 10
  requestedMaxLeverage?: number;
  leverageCap?: ResolvedLeverageCap;
  riskPerTradePct: number; // 0.5..5
  dailyLossLimitPct: number; // 3..4
  timestamp: string; // ISO, acts as a signed "freeze"
  startBalanceUsd?: number;
  budgetFraction?: number; // 0..1 fraction of free balance usable by the agent
  capitalAllocationUsd?: number;
  portfolioWeight?: number;
  portfolioScore?: number;
  portfolioUpdatedAt?: string;
  aggressiveness?: 'conservative' | 'reactive' | 'aggressive';
  userId?: string; // User ID for authenticated exchange access
  // New: control how position size is computed and liquidity guard
  sizingMode?: 'risk' | 'budget'; // default: 'risk' (risk-based, capped by budget); 'budget' uses budget * leverage
  liquidityGuard?: boolean; // default: true; when false, skip impact-based qty reduction
  // Risk-aware leverage controls (optional)
  dynamicLeverage?: boolean; // default true: scale leverage based on setup quality and risk
  minLeverage?: number; // optional floor, >=1 and <= maxLeverage
  strategyEngine?: 'meta_adaptive' | 'intraday_dual';
  rrFloor?: number;
  rrCeil?: number;
  rrBaseMin?: number;
  rrExpectancy?: Partial<{
    enabled: boolean;
    minTrades: number;
    lookbackDays: number;
    decay: number;
    safetyMult: number;
    blend: number;
    hysteresis: number;
  }>;
};

export type AccountSnapshot = {
  equityUsd?: number | null;
  freeUsd?: number | null;
  committedUsd?: number | null;
  availableMarginUsd?: number | null;
  budgetCapUsd?: number | null;
  usableBalanceUsd?: number | null;
  requestedNotionalUsd?: number | null;
  finalNotionalUsd?: number | null;
  filledNotionalUsd?: number | null;
};

export type ActivePosition = {
  side: 'buy' | 'sell';
  entry: number;
  qty: number;
  stop: number;
  tp: number[];
  openedAt: number;
  extended: boolean;
  partialTaken?: boolean;
  slOrderId?: string;
  tpOrderId?: string;
  trail?: { ts: number; price: number }[];
  maeR?: number;
  mfeR?: number;
  breakeven?: number;
  partialInfo?: { ts: number; price: number } | null;
  initialStopDistance?: number;
  riskUsd?: number;
  entryAtr?: number | null;
  entryAtrPct?: number | null;
  minHoldExpiry?: number | null;
  minHoldMinutes?: number;
  hitTargets?: number[];
  archetype?: ExitArchetype;
  tp1Fraction?: number;
  flowSnapshot?: { adx?: number | null; slopePct?: number | null; volRatio?: number | null; cmf?: number | null } | null;
  initialQty?: number;
  initialNotional?: number;
  addOnFilledQty?: number;
  scaleInTriggered?: boolean;
  trailConfig?: {
    mode: 'atr' | 'percent';
    multiplier: number;
    fromHighPct?: number;
    armed: boolean;
    highWatermark?: number | null;
    lastUpdateTs?: number;
  };
  contextTrail?: {
    enabled: boolean;
    breakevenR: number;
    trailActivationR: number;
    atrMultiplier: number;
    atrSource: 'atr14' | 'atr14_1h';
    alignmentThreshold: number;
    adxThreshold: number;
    breakevenTriggered: boolean;
    trailActivated: boolean;
    contextSatisfied: boolean;
    shouldExit?: boolean;
    exitCountdown?: number;
  };
  openLeverage?: number;
  equityAtEntryUsd?: number | null;
  accountSnapshot?: AccountSnapshot | null;
  entryFeePerUnit?: number;
  strategyId?: string | null;
  strategyToken?: string | null;
  strategyFamily?: 'trend' | 'breakout' | 'mean_reversion' | 'momentum' | null;
};

export type ProtectiveSnapshot = {
  slOrderId: string | null;
  tpOrderId: string | null;
  qty: number;
  side: 'buy' | 'sell';
};

export type ExitDiagnosticsPayload = {
  capturedAt: string;
  reason: string;
  agentState: AgentState;
  sessionId: string | null;
  symbol: string;
  exitOrderId: string;
  exitSide: 'buy' | 'sell';
  exitPrice: number;
  realizedPnl: number;
  plan?: {
    bias: ValidatedPlan['bias'];
    zone: ValidatedPlan['zone'];
    atr: number;
    atrPct: number;
    sizing: ValidatedPlan['sizing'];
  } | null;
  position?: {
    side: 'buy' | 'sell';
    entry: number;
    qty: number;
    openedAt: number;
    maeR?: number;
    mfeR?: number;
    breakeven?: number;
  } | null;
  protectiveSnapshot: ProtectiveSnapshot;
  diagnostics?: {
    canTrade?: boolean;
    reason?: string;
    summary?: any;
    trigger?: any;
    gates?: Record<string, { status: string; reason?: string | null; details?: any }>;
  } | null;
  indicators?: {
    last: number;
    ema20: number;
    ema50: number;
    ema100: number;
    ema200: number;
    rsi14: number;
    atr14: number;
    atrPct: number;
    adx14: number;
    cmf20?: number | null;
    support: number;
    resistance: number;
    trendBias: TechnicalSnapshot['trendBias'];
    srBias: TechnicalSnapshot['srBias'];
  } | null;
  regime?: RegimeProfile | null;
  performance?: {
    tradesToday: number;
    consecutiveStops: number;
    realizedPnlTodayPct: number;
  };
  account?: {
    before?: AccountSnapshot | null;
    after?: AccountSnapshot | null;
  } | null;
};

export type MomentumAwaitContext = {
  awaitingSince: number | null;
  avgSlopePct: number;
  lastSlopePct: number;
  lastSlopeRaw: number;
  lastLogTs: number;
  lastReason: string | null;
  unlocked: boolean;
};

export function createMomentumAwaitContext(): MomentumAwaitContext {
  return {
    awaitingSince: null,
    avgSlopePct: 0,
    lastSlopePct: 0,
    lastSlopeRaw: 0,
    lastLogTs: 0,
    lastReason: null,
    unlocked: false,
  };
}

export type QualityAssessmentSnapshot = {
  totalPoints: number;
  maxPoints: number;
  effectivePoints: number;
  bonus: number;
  passCount: number;
  failCount: number;
  partialCount: number;
  deficit: number;
  allow: boolean;
  compensated: boolean;
  failingKeys: string[];
  rawPoints?: number;
  rawMaxPoints?: number;
  weightsApplied?: Record<string, number>;
  majorityThreshold?: number;
  effectivePasses?: number;
};

export type QualityScoreProfile = {
  weights: Record<string, number>;
  majorityRatio: number;
  partialCredit: number;
  comboTolerance: number;
  minPassCount: number;
};

export type TradeCadenceStageConfig = {
  maxTrades: number;
  cooldownMs: number;
  winRateThreshold: number;
  minTrades: number;
  label: string;
};

export type TradeCadenceConfig = {
  stages: TradeCadenceStageConfig[];
  hysteresis: number;
};

export type TradeCadenceState = {
  stageIndex: number;
  stageLabel: string;
  maxTradesPerDay: number;
  cooldownMs: number;
  lastWinRate: number;
  sampleSize: number;
  lastUpdated: number;
  reason: string;
};

export interface StrategyPerformance {
  strategy: string; // 'mean_reversion', 'momentum_breakout', etc.
  bias: 'long' | 'short';
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  avgPnL: number;
  profitRatio: number; // total profit / total loss
  maxDrawdown: number;
  consecutiveLosses: number;
  lastTradeTime: number;
  adaptationMultiplier: number; // Multiplier for ATR/ADX thresholds
}

export interface PerformanceMetrics {
  symbol: string;
  totalTrades: number;
  winRate: number;
  profitRatio: number;
  maxDrawdown: number;
  dailyPnL: number;
  strategyPerformance: Map<string, StrategyPerformance>;
  circuitBreaker: {
    isActive: boolean;
    reason: string;
    activatedAt: number;
    lossThreshold: number;
    winRateThreshold: number;
    lossStreak: number;
    winStreak: number;
    sizeMultiplier: number;
    resumeAt: number | null;
  };
  tradeCadence: {
    stageIndex: number;
    label: string;
    maxTradesPerDay: number;
    cooldownMs: number;
    winRate: number;
    sampleSize: number;
    lastUpdated: number;
  };
  adaptationState: {
    atrMultiplier: number;
    adxMultiplier: number;
    qualityThresholdAdjustment: number;
    lastUpdated: number;
  };
  biasSwitching: {
    currentBias: 'long' | 'short' | 'standby';
    lastBiasSwitch: number;
    consecutiveLosses: number;
    triggerThreshold: number;
  };
};

export type VolumeContext = {
  emaRatio: number;
  emaUsd: number;
  rejectionScore: number;
  sampleCount: number;
  lastUpdated: number;
};

export type DiagnosticCheckRef = {
  key: string;
  code?: string;
  message?: string;
  reason?: string;
};

export type DiagnosticBlocker = DiagnosticCheckRef & {
  status?: string;
};

export type MomentumGateEvaluation = {
  pass: boolean;
  status: 'PASS' | 'SOFT_FAIL' | 'FAIL';
  reasons: string[];
  details: {
    snapshotId?: string | number | null;
    candleTime?: string | number | null;
    tfLTF?: string | null;
    tfHTF?: string | null;
    atrPct: number;
    minAtr: number;
    adx: number;
    minAdx: number;
    slopePctAbs: number;
    minSlope: number;
    slopePct: number;
    minSlopePct: number;
    playbook: string;
    bias: string;
    reasonHint: 'enter' | 'reverse';
    overrideApplied?: boolean;
    context?: MarketContext | null;
    strongTrendOverride?: boolean;
    recognizedOverrideId?: string | null;
    recognizedOverrideConfidence?: number | null;
  };
};

export type StrongTrendAssessment = {
  strong: boolean;
  moderate: boolean;
  direction: 'long' | 'short' | 'none';
  confidence: number;
  adx: number;
  emaSpreadPct: number;
  emaSlopePct: number;
  hurst?: number;
  reasons: string[];
  multiTimeframeAgreement: boolean;
};

export type MarketContext = {
  regime: 'trend_following' | 'range' | 'breakout';
  basePlaybook: string;
  effectivePlaybook: 'trend_following' | 'mean_reversion' | 'momentum_breakout';
  strongTrend: boolean;
  moderateTrend: boolean;
  direction: 'long' | 'short' | 'none';
  allowMomentumOverride: boolean;
  favorMeanReversion: boolean;
  confidence: number;
  notes: string[];
  hurst?: number;
  trendStrength?: number;
  adx?: number;
  recognizedStrategies: RecognizedStrategySignal[];
  primaryStrategy: RecognizedStrategySignal | null;
  strategyToken?: string | null;
  strategyFamily?: 'trend' | 'breakout' | 'mean_reversion' | 'momentum' | null;
};
