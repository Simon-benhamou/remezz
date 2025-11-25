/**
 * Meta-Adaptive Trading Orchestrator
 * 
 * Handles the complete execution loop for meta-adaptive agents:
 * 1. Fetches market data for active sessions
 * 2. Evaluates meta-adaptive signals  
 * 3. Executes entry trades based on signals
 * 4. Monitors active positions
 * 5. Executes exit trades with risk management
 * 6. Logs all activities
 */

import { prisma } from '../db/client.js';
import { type TechnicalSnapshot } from '../ai/tech.js';
import { computeMultiTimeframeDiagnostics } from '../ai/multiTimeframe.js';
import { getMarketContext } from '../analytics/marketContext.js';
import {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
  type RecognizedStrategySignal
} from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';
import { maybeAdjustOrExit } from '../quantai/strategies/metaAdaptive/exitManager.js';
import { detectReboundForShort, detectReversalForLong } from '../quantai/strategies/metaAdaptive/reboundDetection.js';
import { PositionSizer } from '../quantai/risk/positionSizing.js';
import { getQuantAIConfig } from '../quantai/config.js';
import type { QuantAIExitConfig } from '../quantai/config.js';
import { createLogger } from '../utils/logger.js';
import { createIntegrationLogger, withLogging, withRetry } from '../utils/integrationLogger.js';
import { logTradeEvaluation, type RegimeContext } from '../learning/tradeEvaluationLogger.js';
import { AgentHub } from '../agent/hub.js';
import { getAgentContext } from '../agent/context.js';
import { agentMemoryStore } from '../agent/memory/store.js';
import { getExecutionModeDirective } from '../agent/actions/directives.js';
import type { ExecutionPlan, MarketQualityScore, PredictorInsight, RiskLimits, SentimentSignal } from '../agent/subagents/types.js';
import type { Broker } from '../broker/types.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker } from '../broker/live.js';
import { CapitalPoolBroker } from '../broker/capitalPoolBroker.js';
import { getCapitalManager } from '../services/capitalPool.js';
import { capitalConfig } from '../config/capital.js';
import { recordEnter, recordExit } from '../agent/persistence.js';
import { computeQtyNotional } from '../risk/manager.js';
import { getConfig } from '../utils/env.js';
import { calculateFeeUsd } from '../quantai/executionCosts.js';
import { canFlipPosition, recordPositionFlip } from './positionFlipTracker.js';
import { activateEntryLock, releaseEntryLock, isRotationLockActive } from './sessionLocks.js';
import { applyCorrelationConstraints } from './correlationManager.js';
import { getEntryTimingAgent } from '../agent/subagents/entryTimingAgent.js';
import { getExitStrategyAgent } from '../agent/subagents/exitStrategyAgent.js';
import { getSubagentTuning } from './subagentLearning.js';
import { evaluateAdaptiveEntry } from '../learning/adaptiveThresholds.js';
import { pendingIntentService } from './pendingIntentService.js';
import { orderReconciliationService } from './orderReconciliationService.js';

const logger = createLogger('meta-adaptive');

// Helper function to derive strategy family from strategy ID
function deriveStrategyFamily(id: string): string {
  if (id === 'classic_trend_following') return 'trend';
  if (id === 'breakout_retest') return 'breakout';
  if (id === 'bollinger_mean_reversion') return 'mean_reversion';
  return 'momentum';
}

// Track brokers per session to avoid recreating them
const sessionBrokers = new Map<string, Broker>();

const clampNumber = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const agentServices = getAgentContext().services;
const SENTIMENT_PRESSURE_THRESHOLD = 0.55;
const MARKET_QUALITY_HARD_FLOOR = 0.2;

const sentimentSupportsSide = (sentiment: SentimentSignal, side: 'buy' | 'sell'): boolean => {
  if (!sentiment) return false;
  if (sentiment.bias === 'neutral') return false;
  if (sentiment.bias === 'bullish') {
    return side === 'buy';
  }
  if (sentiment.bias === 'bearish') {
    return side === 'sell';
  }
  return false;
};

const computeSupportAllocationScale = (
  marketQuality: MarketQualityScore,
  sentiment: SentimentSignal,
  side: 'buy' | 'sell',
): number => {
  const qualityBase = 0.65 + marketQuality.score * 0.45;
  const sentimentFactor = sentiment.bias === 'neutral'
    ? 1
    : sentimentSupportsSide(sentiment, side)
      ? 1 + sentiment.confidence * 0.2
      : 1 - sentiment.confidence * 0.3;
  return clampNumber(qualityBase * sentimentFactor, 0.5, 1.3);
};

const marketLooksHostile = (
  marketQuality: MarketQualityScore,
  sentiment: SentimentSignal,
  side: 'buy' | 'sell',
  executionPlan: ExecutionPlan,
): boolean => {
  const alignment = sentimentSupportsSide(sentiment, side);
  const oppositePressure = !alignment && sentiment.confidence >= SENTIMENT_PRESSURE_THRESHOLD;
  const depthInsufficient = marketQuality.bookDepthUsd < executionPlan.minFillUsd * 1.5;
  const spreadWide = marketQuality.spreadBps > executionPlan.maxSlippageBps * 2;
  const qualityFloorBreach = marketQuality.score < MARKET_QUALITY_HARD_FLOOR;
  return oppositePressure && (qualityFloorBreach || depthInsufficient || spreadWide);
};

const parsePositionPct = (raw?: string | null): number | null => {
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  return clampNumber(normalized, 0.01, 1);
};

const capitalAllocationOverrides = {
  paperMaxPositionPct: parsePositionPct(process.env.META_ADAPTIVE_PAPER_MAX_POSITION_PCT),
  liveMaxPositionPct: parsePositionPct(process.env.META_ADAPTIVE_LIVE_MAX_POSITION_PCT),
  globalMaxPositionPct: parsePositionPct(process.env.META_ADAPTIVE_MAX_POSITION_PCT),
  minPositionPct: parsePositionPct(process.env.META_ADAPTIVE_MIN_POSITION_PCT),
  minPositionUsd: (() => {
    const raw = process.env.META_ADAPTIVE_MIN_POSITION_USD;
    if (!raw) return 0;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  })(),
};

const pickMaxPositionPct = (mode: 'paper' | 'live'): number | null => {
  if (mode === 'paper') {
    return capitalAllocationOverrides.paperMaxPositionPct
      ?? capitalAllocationOverrides.globalMaxPositionPct
      ?? 1;
  }
  return capitalAllocationOverrides.liveMaxPositionPct ?? capitalAllocationOverrides.globalMaxPositionPct;
};

function pickExecutableSignal(signals: RecognizedStrategySignal[]): {
  signal: RecognizedStrategySignal | null;
  source: 'token' | 'fallback' | 'none';
} {
  if (!signals.length) {
    return { signal: null, source: 'none' };
  }
  const tokenBacked = signals.find((candidate) => Boolean(candidate.meta?.token)) ?? null;
  if (tokenBacked) {
    return { signal: tokenBacked, source: 'token' };
  }
  return { signal: null, source: 'fallback' };
}

function describeSignalSuppression(signals: RecognizedStrategySignal[]): string | null {
  const first = signals[0];
  if (!first || !first.meta) {
    return null;
  }
  if (first.meta.guardrail) {
    return first.meta.guardrail;
  }
  if (Array.isArray(first.meta.penalties) && first.meta.penalties.length > 0) {
    return first.meta.penalties.join('|');
  }
  return first.blockedReason ?? null;
}

/**
 * Calculate capital usage and determine required confidence threshold
 * 
 * Adaptive Strategy based on capital size:
 * 
 * Small accounts (<$200): 
 *   - 1 position max (80-100% per trade)
 *   - Focused approach, no diversification needed
 * 
 * Medium accounts ($200-$1000):
 *   - 2-3 positions max (40-50% per trade)
 *   - Some diversification
 * 
 * Large accounts (>$1000):
 *   - 4-5 positions max (20% per trade)
 *   - Full diversification
 *   - Progressive confidence: 80%+ usage requires 0.75 confidence
 */
async function calculateCapitalUsageAndThresholds(mode: 'paper' | 'live', userId?: string): Promise<{
  totalCapital: number;
  usedCapital: number;
  freeCapital: number;
  usageRatio: number;
  minConfidenceRequired: number;
  maxAllocationPerPosition: number;
  maxPositions: number;
}> {
  const capitalManager = getCapitalManager(mode, userId);
  const snapshot = await capitalManager.getBalance();
  
  const totalCapital = snapshot.totalUSD.toNumber();
  const freeCapital = snapshot.freeUSD.toNumber();
  const usedCapital = totalCapital - freeCapital;
  const usageRatio = totalCapital > 0 ? usedCapital / totalCapital : 0;
  const applyAllocationFloors = (proposed: number): number => {
    let result = proposed;
    if (capitalAllocationOverrides.minPositionPct && totalCapital > 0) {
      result = Math.max(result, totalCapital * capitalAllocationOverrides.minPositionPct);
    }
    if (capitalAllocationOverrides.minPositionUsd > 0) {
      result = Math.max(result, capitalAllocationOverrides.minPositionUsd);
    }
    if (totalCapital > 0) {
      result = Math.min(result, totalCapital);
    }
    return result;
  };
  
  // Adaptive allocation based on capital size
  let maxAllocationPerPosition: number;
  let maxPositions: number;
  let minConfidenceRequired: number;
  
  if (totalCapital < 200) {
    // Small account: 1 big position (80-100%)
    maxAllocationPerPosition = applyAllocationFloors(totalCapital * 0.90); // Use 90% for the single position
    maxPositions = 1;
    minConfidenceRequired = 0.30; // 🎯 CRYPTO OPTIMIZED: Lowered from 0.35
  } else if (totalCapital < 1000) {
    // Medium account: 2-3 positions (40-50% each)
    maxAllocationPerPosition = applyAllocationFloors(totalCapital * 0.45);
    maxPositions = 2;
    // 🎯 CRYPTO OPTIMIZED: Progressive threshold for 2nd position (lowered)
    minConfidenceRequired = usageRatio < 0.50 ? 0.28 : 0.35;
  } else {
    // Large account: Dynamic position limit based on available capital
    // Instead of fixed 5 positions at 20%, allow more smaller positions
    // Minimum position size: $100 (ensures orderability)
    // Maximum single position: 20% of total capital
    const minPositionSize = 100;
    const overridePct = pickMaxPositionPct(mode);
    const defaultPct = totalCapital >= 5000 ? 0.40 : 0.30;
    const maxSinglePositionPct = clampNumber(overridePct ?? defaultPct, 0.05, 1);
    
    maxAllocationPerPosition = applyAllocationFloors(totalCapital * maxSinglePositionPct);
    
    // Calculate max positions based on free capital, not total capital
    // This allows more positions if they're smaller than the max allocation
    if (freeCapital >= minPositionSize) {
      maxPositions = Math.floor(freeCapital / minPositionSize);
    } else {
      maxPositions = Math.floor(totalCapital / minPositionSize);
    }
    
    // Cap at 10 positions maximum to avoid over-diversification
    maxPositions = Math.min(10, Math.max(1, maxPositions));
    
    // 🎯 CRYPTO OPTIMIZED THRESHOLDS: Base thresholds LOWERED
    // These are BASE thresholds - will be further adjusted by adaptive system
    // based on RSI extremes, ADX trend strength, and volatility
    // 0-55% used: very opportunistic (0.23) - capture breakouts early
    // 55-75% used: opportunistic (0.28) - still aggressive but selective  
    // 75%+ used: moderate (0.30) - preserve capital for best setups
    if (usageRatio < 0.55) {
      minConfidenceRequired = 0.23;
    } else if (usageRatio < 0.75) {
      minConfidenceRequired = 0.28;
    } else {
      minConfidenceRequired = 0.30;
    }
  }
  
  return {
    totalCapital,
    usedCapital,
    freeCapital,
    usageRatio,
    minConfidenceRequired,
    maxAllocationPerPosition,
    maxPositions,
  };
}

/**
 * Helper to calculate regime context from technical data
 */
function calculateRegimeContext(tech: TechnicalSnapshot): RegimeContext {
  const atrPct = (tech.atr14 / tech.last) * 100;
  const ema20 = (tech as any).ema20;
  const ema50 = (tech as any).ema50;
  const volumeZScore = (tech as any).volumeZScore;
  
  return {
    volatilityRegime: atrPct < 3 ? 'low' : atrPct > 6 ? 'high' : 'medium',
    directionBias: ema20 && ema50 ? (ema20 > ema50 * 1.001 ? 'long' : ema20 < ema50 * 0.999 ? 'short' : 'neutral') : 'neutral',
    volumeRegime: volumeZScore !== undefined ? (volumeZScore < -0.5 ? 'low' : volumeZScore > 0.5 ? 'high' : 'normal') : 'normal',
    trendingRanging: tech.adx14 > 25 ? 'trending' : tech.adx14 < 20 ? 'ranging' : (atrPct > 4 ? 'trending' : 'ranging'),
    parameterSource: 'runtime_calculated',
  };
}

type PositionTelemetry = {
  entryAtrPct: number | null;
  expectedMinutesTo1R: number;
  mfeR: number;
  maeR: number;
  lastR: number;
  stagnationMinutes: number;
  lastUpdateTs: number;
  lastSignificantR: number;
  lastSignificantUpdateTs: number;
  atrDriftPct: number | null;
  latestAtrPct: number | null;
  minutesOpenSnapshot?: number;
};

const TELEMETRY_TIMEFRAME_MIN = 15;
const STAGNATION_EPSILON_R = 0.12;

function estimateMinutesToOneR(stopDistance: number, atrValue: number | null): number {
  if (!(stopDistance > 0)) {
    return 30;
  }
  const atr = atrValue && atrValue > 1e-9 ? atrValue : stopDistance;
  const atrUnits = stopDistance / atr;
  const rawMinutes = atrUnits * TELEMETRY_TIMEFRAME_MIN;
  return Math.max(20, Math.min(240, Math.round(rawMinutes || 30)));
}

export function buildPositionTelemetry(params: {
  entryPrice: number;
  stopDistance: number;
  atrValue: number | null;
}): PositionTelemetry {
  const { entryPrice, stopDistance, atrValue } = params;
  const entryAtrPct = atrValue && entryPrice > 0
    ? (atrValue / entryPrice) * 100
    : null;
  const sanitizedAtrPct = entryAtrPct != null && Number.isFinite(entryAtrPct)
    ? Number(entryAtrPct.toFixed(4))
    : null;
  const now = Date.now();
  return {
    entryAtrPct: sanitizedAtrPct,
    expectedMinutesTo1R: estimateMinutesToOneR(stopDistance, atrValue),
    mfeR: 0,
    maeR: 0,
    lastR: 0,
    stagnationMinutes: 0,
    lastUpdateTs: now,
    lastSignificantR: 0,
    lastSignificantUpdateTs: now,
    atrDriftPct: null,
    latestAtrPct: sanitizedAtrPct,
  };
}

function updatePositionTelemetry(
  position: any,
  currentPrice: number,
  tech: TechnicalSnapshot,
  minutesOpen: number,
): { telemetry: PositionTelemetry; rMultiple: number } | null {
  const telemetry = position?.telemetry as PositionTelemetry | undefined;
  if (!telemetry) {
    return null;
  }
  const baselineRisk = typeof position.initialStopDistance === 'number' && position.initialStopDistance > 0
    ? position.initialStopDistance
    : Math.abs(position.entry - position.stop);
  if (!(baselineRisk > 0)) {
    return null;
  }
  const side = position.side === 'sell' ? 'short' : 'long';
  const baselineStop = side === 'long'
    ? position.entry - baselineRisk
    : position.entry + baselineRisk;
  const rMultiple = PositionSizer.rMultiple(position.entry, baselineStop, currentPrice, side);
  telemetry.lastR = rMultiple;
  telemetry.mfeR = Math.max(telemetry.mfeR, rMultiple);
  telemetry.maeR = Math.min(telemetry.maeR, rMultiple);
  const now = Date.now();
  const elapsedMinutes = telemetry.lastUpdateTs ? (now - telemetry.lastUpdateTs) / 60000 : 0;
  const moveDelta = Math.abs(rMultiple - telemetry.lastSignificantR);
  if (moveDelta < STAGNATION_EPSILON_R) {
    telemetry.stagnationMinutes += elapsedMinutes;
  } else {
    telemetry.stagnationMinutes = 0;
    telemetry.lastSignificantR = rMultiple;
    telemetry.lastSignificantUpdateTs = now;
  }
  telemetry.lastUpdateTs = now;
  const atrValue = tech.atr14 ?? null;
  const atrPct = atrValue && tech.last
    ? (atrValue / tech.last) * 100
    : null;
  if (atrPct != null && Number.isFinite(atrPct)) {
    const rounded = Number(atrPct.toFixed(4));
    telemetry.latestAtrPct = rounded;
    if (telemetry.entryAtrPct != null) {
      telemetry.atrDriftPct = Number((rounded - telemetry.entryAtrPct).toFixed(4));
    }
  }
  telemetry.minutesOpenSnapshot = minutesOpen;
  return { telemetry, rMultiple };
}

function shouldTriggerTelemetryTimeout(params: {
  telemetry: PositionTelemetry;
  minutesOpen: number;
  rMultiple: number;
  exitConfig: QuantAIExitConfig;
}): string | null {
  const { telemetry, minutesOpen, rMultiple, exitConfig } = params;
  const minHold = exitConfig.earlyExit?.minHoldMinutes ?? 0;
  if (minutesOpen < minHold) {
    return null;
  }
  
  // 🌬️ CRYPTO BREATHING ROOM: Allow longer consolidation periods before timeout
  // Crypto often consolidates 30-60min before breakouts - don't exit during accumulation
  const expectation = Math.max(20, telemetry.expectedMinutesTo1R);
  if (telemetry.stagnationMinutes < expectation * 2.0) { // Increased from 1.4x to 2.0x
    return null;
  }
  
  // Don't exit if we've seen good profit (MFE) - let winners run
  if (telemetry.mfeR >= 0.45) {
    return null;
  }
  
  // Don't exit if position is moving (even if slowly)
  if (Math.abs(rMultiple) >= 0.3) {
    return null;
  }
  
  const maxHolding = exitConfig.maxHoldingMin ?? null;
  const nearMaxHold = maxHolding != null && minutesOpen >= maxHolding * 0.85;
  
  // ✅ REMOVED volatilityCollapse check - ATR drop after explosive move is NORMAL in crypto
  // Don't penalize natural volatility compression after expansion
  const extremeStagnation = telemetry.stagnationMinutes >= expectation * 2.5; // Increased from 1.8x
  
  if (!nearMaxHold && !extremeStagnation) {
    return null;
  }
  const details: string[] = [
    `stagnation=${telemetry.stagnationMinutes.toFixed(1)}m`,
    `expectation=${expectation.toFixed(1)}m`,
    `mfe=${telemetry.mfeR.toFixed(2)}R`,
  ];
  if (nearMaxHold) {
    details.push('maxHold');
  }
  if (extremeStagnation) {
    details.push('extremeStagnation');
  }
  return `telemetry_timeout_flat(${details.join(',')})`;
}

type SessionContext = {
  sessionId: string;
  symbol: string;
  mode: 'paper' | 'live';
  profileJson: any;
  userId: string | null;
};

/**
 * Get or create a broker for a session
 */
async function getBrokerForSession(session: SessionContext): Promise<Broker | null> {
  // Check if broker already exists
  const existing = sessionBrokers.get(session.sessionId);
  if (existing) {
    return existing;
  }

  // Check if agent has a broker
  const agent = AgentHub.get(session.sessionId) as any;
  if (agent?.broker) {
    sessionBrokers.set(session.sessionId, agent.broker);
    return agent.broker;
  }

  // Create new broker
  let broker: Broker | null = null;
  
  if (session.mode === 'paper') {
    // Don't pass session balance - use shared capital pool instead
    const base = new PaperBroker();
    const capital = getCapitalManager('paper', session.userId ?? undefined);
    broker = new CapitalPoolBroker({
      agentId: session.sessionId,
      mode: 'paper',
      capital,
      broker: base,
      minOrderUsd: capitalConfig.minOrderUSD,
    });
  } else if (session.mode === 'live' && session.userId) {
    const base = new LiveBroker(session.userId);
    const capital = getCapitalManager('live', session.userId);
    broker = new CapitalPoolBroker({
      agentId: session.sessionId,
      mode: 'live',
      capital,
      broker: base,
      minOrderUsd: capitalConfig.minOrderUSD,
    });
  }

  if (broker) {
    sessionBrokers.set(session.sessionId, broker);
    // Also attach to agent if it exists
    if (agent) {
      agent.broker = broker;
    }
  }

  return broker;
}

/**
 * Process a single session tick - evaluate signals and execute trades if needed
 */
async function processSessionTick(session: SessionContext, tech: TechnicalSnapshot): Promise<void> {
  try {
    // 🛡️ SAFETY: Check data freshness
    if (tech.timestamp) {
      const dataAge = Date.now() - tech.timestamp;
      if (dataAge > 15000) { // 15 seconds max age
        logger.warn(`[${session.sessionId}] Skipping tick with stale data (${dataAge}ms old)`);
        return;
      }
    }

    logger.info(`[${session.sessionId}] Processing tick for ${session.symbol} @ ${tech.last}`);
    
    // Get multi-timeframe diagnostics for better signal evaluation
    let multiTimeframe: any = null;
    try {
      multiTimeframe = await computeMultiTimeframeDiagnostics(session.symbol);
    } catch (error) {
      logger.warn(`[${session.sessionId}] Failed to compute multi-timeframe diagnostics:`, error);
    }

    // Get market context for comprehensive analysis
    let marketContext: any = null;
    try {
      marketContext = await getMarketContext(session.symbol);
    } catch (error) {
      logger.warn(`[${session.sessionId}] Failed to get market context:`, error);
    }

    // Evaluate recognized strategy signals
    const signals: RecognizedStrategySignal[] = await evaluateRecognizedStrategies(tech, {
      sessionId: session.sessionId,
      symbol: session.symbol,
      bias: (session.profileJson as any)?.biasPreference || undefined,
      multiTimeframe,
      fundamental: marketContext?.fundamental || null,
      derivatives: marketContext?.derivatives || null,
      onChain: marketContext?.onChain || null,
      sentiment: marketContext?.sentiment || null,
      watchlist: marketContext?.watchlist || null,
    });

    if (signals.length > 0) {
      logger.info(
        `[${session.sessionId}] Found ${signals.length} signal(s):`,
        signals.map(s => ({
          strategy: s.id,  // FIX: Use "id" field, not "strategyId"
          bias: s.bias,
          score: s.meta?.score,
          confidence: s.confidence  // FIX: Use top-level confidence, not nested
        }))
      );

      // Store pythonSignal from best signal in agent for diagnostics API
      const agent = AgentHub.get(session.sessionId);
      if (agent && signals.length > 0) {
        const { signal: diagnosticSignal } = pickExecutableSignal(signals);
        const bestSignal = diagnosticSignal ?? signals[0];
        const pythonSignalData = (bestSignal as any).meta?.pythonSignal || null;
        const predictorUsage = (bestSignal as any).predictorUsage || (bestSignal as any).meta?.predictorUsage || null;
        (agent as any).pythonSignal = pythonSignalData;
        (agent as any).lastSignal = bestSignal;
        (agent as any).predictorUsage = predictorUsage;
        
        // 🔴 FIX: Persist to profileJson for diagnostics API after restart
        try {
          const currentProfile = (session.profileJson || {}) as Record<string, any>;
          await prisma.agentSession.update({
            where: { id: session.sessionId },
            data: {
              profileJson: {
                ...currentProfile,
                _diagnostics: {
                  lastPredictorData: pythonSignalData ? {
                    decision: pythonSignalData.decision,
                    confidence: pythonSignalData.confidence,
                    probabilities: pythonSignalData.probabilities,
                    updatedAt: Date.now(),
                    usage: predictorUsage
                      ? {
                          mode: predictorUsage.mode,
                          used: predictorUsage.used,
                          fallback: predictorUsage.fallback ?? false,
                          reason: predictorUsage.reason,
                          reliability: predictorUsage.reliability ?? null,
                          reliabilityStatus: predictorUsage.reliabilityStatus ?? null,
                        }
                      : null,
                  } : null,
                  lastStrategyData: {
                    id: bestSignal.id,
                    label: (bestSignal as any).strategyLabel || 'Unknown',
                    bias: bestSignal.bias,
                    confidence: bestSignal.confidence,
                    score: bestSignal.meta?.score || 0,
                    family: (bestSignal as any).strategyFamily || 'unknown',
                    updatedAt: Date.now(),
                  },
                },
              } as any,
            },
          });
        } catch (dbError) {
          logger.warn(`[${session.sessionId}] Failed to persist diagnostics to profileJson:`, dbError);
        }
      }

      // Check for existing position from DATABASE, not just agent memory
      // This prevents ghost position bugs when agent stub persists across restarts
      const dbPosition = await prisma.position.findFirst({
        where: {
          sessionId: session.sessionId,
        },
      });
      const hasPosition = dbPosition !== null;
      
      // POST-EXIT REVERSAL DETECTION: Check if we should re-enter after recent stop-loss
      if (!hasPosition) {
        const postExitMonitoring = agentMemoryStore.get<any>('postExitMonitoring', session.sessionId)?.data;
        
        if (postExitMonitoring && Date.now() < postExitMonitoring.monitorUntil) {
          const exitedSide = postExitMonitoring.exitSide;
          const timeSinceExit = (Date.now() - postExitMonitoring.exitTime) / 1000;
          
          // Check for reversal in opposite direction
          let reversalDetected = false;
          let reversalProbability = 0;
          let reversalReasons: string[] = [];
          
          if (exitedSide === 'long') {
            // We were stopped out of a long - check if market is now bouncing (favor new long)
            const reboundSignal = detectReboundForShort(tech);
            if (reboundSignal.probability >= 0.7) {
              reversalDetected = true;
              reversalProbability = reboundSignal.probability;
              reversalReasons = reboundSignal.reasons;
              
              logger.info(
                `[${session.sessionId}] POST-STOP REVERSAL: Stopped from LONG ${timeSinceExit.toFixed(0)}s ago, now strong rebound detected (prob=${reversalProbability.toFixed(2)}) - could re-enter LONG`
              );
            }
          } else if (exitedSide === 'short') {
            // We were stopped out of a short - check if market is now dumping (favor new short)
            const reversalSignal = detectReversalForLong(tech);
            if (reversalSignal.probability >= 0.7) {
              reversalDetected = true;
              reversalProbability = reversalSignal.probability;
              reversalReasons = reversalSignal.reasons;
              
              logger.info(
                `[${session.sessionId}] POST-STOP REVERSAL: Stopped from SHORT ${timeSinceExit.toFixed(0)}s ago, now strong reversal detected (prob=${reversalProbability.toFixed(2)}) - could re-enter SHORT`
              );
            }
          }
          
          // If reversal detected, allow normal signal evaluation to potentially re-enter
          // The reversal detection in entry evaluation will NOT block same-direction re-entry
          if (reversalDetected) {
            logger.info(
              `[${session.sessionId}] Post-stop reversal confirmed: ${reversalReasons.slice(0, 3).join(', ')} - allowing signal evaluation`
            );

            // 🚀 VENGEANCE MODE: Force re-entry on strong liquidity grab
            // If we were stopped out and price immediately reverses with high probability,
            // we assume it was a liquidity grab and re-enter aggressively.
            if (reversalProbability >= 0.75) {
               logger.info(`[${session.sessionId}] 🚀 VENGEANCE MODE ACTIVATED: Liquidity grab detected (prob=${reversalProbability.toFixed(2)}) - Forcing re-entry!`);
               
               // Create synthetic signal
               const vengeanceSignal: RecognizedStrategySignal = {
                 id: `vengeance_${Date.now()}` as any,
                 label: 'Vengeance Mode (Liquidity Grab)',
                 bias: exitedSide === 'long' ? 'long' : 'short', // Re-enter same direction
                 confidence: 0.85, // High confidence
                 qualityScore: 95,
                 confidenceGatePassed: true,
                 blockedReason: null,
                 entryEligibilityScore: 1.0,
                 entryEligibilityGatePassed: true,
                 entryEligibilityReasons: ['vengeance_mode_active'],
                 active: true,
                 reasons: ['liquidity_grab_detected', 'vengeance_mode'],
                 metrics: {
                    score: 0.85,
                    rawConfidence: 0.85,
                 },
                 meta: {
                   score: 95,
                   token: 'vengeance_override',
                   guardrail: 'none',
                   riskPct: '1.0', // Standard risk
                   stopAtrMult: '2.5', // Wider stop for safety
                   penalties: [],
                   exploration: false,
                 }
               };
               
               // Execute immediately
               await executeEntryTrade(session, vengeanceSignal, tech);
               
               // Clear monitoring to prevent double entry
               agentMemoryStore.update('postExitMonitoring', session.sessionId, null);
               return; // Done for this tick
            }
          }
          
          // Clean up monitoring after time expires
          if (Date.now() >= postExitMonitoring.monitorUntil) {
            agentMemoryStore.update('postExitMonitoring', session.sessionId, null);
            logger.debug(`[${session.sessionId}] Post-exit monitoring expired`);
          }
        }
      }

      if (!hasPosition) {
        // No position - evaluate entry signals
        const entrySignals = signals.filter(s => !(s as any).isExit);
        const { signal: executableSignal, source: selectionSource } = pickExecutableSignal(entrySignals);
        
        // REVERSAL DETECTION: Block entries if strong reversal signal opposes our direction
        if (executableSignal && selectionSource === 'token') {
          const entryBias = executableSignal.bias;
          let blockEntry = false;
          let blockReason = '';
          
          if (entryBias === 'long') {
            const reversalSignal = detectReversalForLong(tech);
            if (reversalSignal.probability >= 0.65) {
              blockEntry = true;
              blockReason = `reversal_against_long: ${reversalSignal.severity} probability=${reversalSignal.probability.toFixed(2)} [${reversalSignal.reasons.slice(0, 2).join(', ')}]`;
            }
          } else if (entryBias === 'short') {
            const reboundSignal = detectReboundForShort(tech);
            if (reboundSignal.probability >= 0.65) {
              blockEntry = true;
              blockReason = `rebound_against_short: ${reboundSignal.severity} probability=${reboundSignal.probability.toFixed(2)} [${reboundSignal.reasons.slice(0, 2).join(', ')}]`;
            }
          }
          
          if (blockEntry) {
            logger.warn(`[${session.sessionId}] Entry blocked by reversal detection: ${blockReason}`);
            await logTradeEvaluation({
              userId: session.userId,
              symbol: session.symbol,
              decision: 'order_blocked_capital',
              blockedReason: blockReason,
              confidenceScore: executableSignal.confidence,
              inputMetrics: {
                adx: tech.adx14,
                atrPct: (tech.atr14 / tech.last) * 100,
                cmf: (tech as any).cmf20,
                rsi14: tech.rsi14,
                volumeRatio: (tech as any).volumeRatio,
              },
              regimeContext: calculateRegimeContext(tech),
            }).catch(err => console.warn('Failed to log reversal block:', err));
            
            // Skip entry execution
            return;
          }
        }
        
        if (selectionSource === 'token' && executableSignal) {
          logger.info(
            `[${session.sessionId}] Selected entry signal (token-backed): ${executableSignal.id} (${executableSignal.bias}) score=${executableSignal.meta?.score}`
          );

          console.log(`[MetaOrchestrator] executeEntryTrade agent=${session.sessionId}, symbol=${session.symbol}, bias=${executableSignal.bias}, selection=token-backed`);
          await executeEntryTrade(session, executableSignal, tech);
        } else if (selectionSource === 'fallback' && entrySignals.length > 0) {
          const suppression = describeSignalSuppression(entrySignals);
          logger.info(
            `[${session.sessionId}] Entry signals suppressed (no execution token${suppression ? `: ${suppression}` : ''})`
          );
        }
      } else {
        // Has position - check for counter-signals and possible position flip
        const entrySignals = signals.filter(s => !(s as any).isExit);
        
        // Get current position details from agent
        const agent = AgentHub.get(session.sessionId) as any;
        const currentPositionSide = agent?.pos?.side === 'buy' ? 'long' : 'short';
        
        let flipResult: { flip: boolean; reason: string } | null = null;
        
        const { signal: counterSignalCandidate, source: counterSelectionSource } = pickExecutableSignal(entrySignals);
        if (counterSignalCandidate && counterSelectionSource === 'token') {
          const selectionLabel = 'token-backed';
          
          // Check if this is a counter-signal (opposite direction)
          const isCounterSignal = 
            (currentPositionSide === 'long' && counterSignalCandidate.bias === 'short') ||
            (currentPositionSide === 'short' && counterSignalCandidate.bias === 'long');
          
          if (isCounterSignal) {
            logger.info(
              `[${session.sessionId}] Counter-signal detected (${selectionLabel}): current=${currentPositionSide}, signal=${counterSignalCandidate.bias}, confidence=${counterSignalCandidate.confidence.toFixed(2)}`
            );
            
            // Check if we should flip the position
            flipResult = await shouldFlipPosition(session, agent, counterSignalCandidate, tech);
            
            if (flipResult.flip) {
              logger.info(`[${session.sessionId}] Position flip conditions met: ${flipResult.reason}`);
              await executePositionFlip(session, agent, counterSignalCandidate, tech);
              return; // Exit early - flip handled the position
            } else {
              logger.debug(`[${session.sessionId}] Position flip rejected: ${flipResult.reason}`);
            }
          } else {
            logger.info(`[${session.sessionId}] Entry signal blocked - existing position present`);
          }
          
          // Log that order was blocked due to existing position (unless we just flipped)
          await logTradeEvaluation({
            userId: session.userId,
            symbol: session.symbol,
            decision: 'order_blocked_capital',
            blockedReason: flipResult 
              ? `counter_signal_flip_rejected: ${flipResult.reason}`
              : 'existing_position_present',
            confidenceScore: counterSignalCandidate.confidence,
            inputMetrics: {
              adx: tech.adx14,
              atrPct: (tech.atr14 / tech.last) * 100,
              cmf: (tech as any).cmf20,
              rsi14: tech.rsi14,
              volumeRatio: (tech as any).volumeRatio,
            },
            regimeContext: calculateRegimeContext(tech),
          }).catch(err => console.warn('Failed to log existing position block:', err));
        } else if (counterSelectionSource === 'fallback' && entrySignals.length > 0) {
          const suppression = describeSignalSuppression(entrySignals);
          logger.debug(`[${session.sessionId}] Counter-signal suppressed (no execution token${suppression ? `: ${suppression}` : ''})`);
        }
        
        // Check if we should exit normally (if we didn't flip)
        logger.debug(`[${session.sessionId}] Has position, checking exit conditions`);
        await checkAndExecuteExit(session, agent, tech);
      }
    } else {
      logger.debug(`[${session.sessionId}] No signals generated for ${session.symbol}`);
    }

  } catch (error) {
    logger.error(`[${session.sessionId}] Error processing tick:`, error);
  }
}

/**
 * Execute an entry trade based on a signal
 */
async function executeEntryTrade(
  session: SessionContext,
  signal: RecognizedStrategySignal,
  tech: TechnicalSnapshot
): Promise<void> {
  const integrationLogger = createIntegrationLogger({
    component: 'Orchestrator',
    action: 'entry',
    sessionId: session.sessionId,
    symbol: session.symbol,
  });

  let predictorConfidenceForMetrics: number | undefined;
  const buildSupportInputMetrics = () => ({
    adx: tech.adx14,
    atrPct: (tech.atr14 / tech.last) * 100,
    cmf: (tech as any).cmf20,
    rsi14: tech.rsi14,
    volumeRatio: (tech as any).volumeRatio,
    predictorConfidence: predictorConfidenceForMetrics,
  });

  try {
    integrationLogger.info(`Executing entry trade | bias=${signal.bias} strategy=${signal.id} confidence=${signal.confidence.toFixed(3)}`);
    console.log(`[MetaOrchestrator.executeEntryTrade] START: agent=${session.sessionId}, symbol=${session.symbol}, bias=${signal.bias}`);
    
    // 🛡️ SAFETY: Prevent immediate entry after session start (wait for market observation)
    const fullSession = await prisma.agentSession.findUnique({
      where: { id: session.sessionId },
      select: { startedAt: true }
    });
    
    if (fullSession) {
      const sessionAgeMs = Date.now() - fullSession.startedAt.getTime();
      const MIN_SESSION_AGE_MS = 5 * 60 * 1000; // 5 minutes warmup period
      
      if (sessionAgeMs < MIN_SESSION_AGE_MS) {
        const waitMinutes = Math.ceil((MIN_SESSION_AGE_MS - sessionAgeMs) / 60000);
        integrationLogger.info(
          `Session too young (${Math.floor(sessionAgeMs / 60000)}min) - waiting ${waitMinutes}min before first entry to observe market`,
          { symbol: session.symbol, sessionAge: sessionAgeMs }
        );
        console.log(`[MetaOrchestrator.executeEntryTrade] SKIP: Session age ${sessionAgeMs}ms < ${MIN_SESSION_AGE_MS}ms`);
        return;
      }
    }
    
    const side: 'buy' | 'sell' = signal.bias === 'short' ? 'sell' : 'buy';

    if (isRotationLockActive(session.profileJson)) {
      integrationLogger.warn('Rotation lock active – blocking entry');
      console.log(`[MetaOrchestrator.executeEntryTrade] BLOCKED: rotation lock active for ${session.sessionId}`);
      await logTradeEvaluation({
        userId: session.userId,
        symbol: session.symbol,
        decision: 'order_blocked_rotation',
        blockedReason: 'rotation_in_progress',
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
        regimeContext: calculateRegimeContext(tech),
      }).catch(err => console.warn('Failed to log rotation block:', err));
      return;
    }

    const entryLockAcquired = await activateEntryLock(session.sessionId, 'placing_entry_order', 180_000, {
      symbol: session.symbol,
      strategyId: signal.id,
    });

    if (!entryLockAcquired) {
      integrationLogger.warn('Entry lock already active – skipping duplicate entry');
      console.log(`[MetaOrchestrator.executeEntryTrade] SKIP: entry lock already active for ${session.sessionId}`);
      await logTradeEvaluation({
        userId: session.userId,
        symbol: session.symbol,
        decision: 'order_blocked_rotation',
        blockedReason: 'entry_lock_active',
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
        regimeContext: calculateRegimeContext(tech),
      }).catch(err => console.warn('Failed to log entry-lock block:', err));
      return;
    }

    try {
      // 🔴 FIX: Check for pending entry timing intents from DATABASE (not in-memory)
      const pendingEntry = await pendingIntentService.getActive(session.sessionId);
      
      if (pendingEntry) {
        const now = Date.now();
        
        // Check expiration
        if (now > pendingEntry.expiresAt.getTime()) {
          await pendingIntentService.markExpired(pendingEntry.id);
          integrationLogger.info('Pending entry expired, proceeding with current price', { symbol: session.symbol });
        } else if (pendingEntry.action === 'wait_pullback') {
          // Check if we got the pullback
          const currentPrice = tech.last;
          const priceDiffBps = ((currentPrice - pendingEntry.originalPrice) / pendingEntry.originalPrice) * 10000;
          
          if (Math.abs(priceDiffBps) >= Math.abs(pendingEntry.targetOffset ?? 0)) {
            integrationLogger.info(
              `Pullback achieved: ${priceDiffBps.toFixed(1)}bps >= ${pendingEntry.targetOffset}bps - entering`,
              { symbol: session.symbol }
            );
            await pendingIntentService.markExecuted(pendingEntry.id);
            // Continue with entry
          } else {
            integrationLogger.debug(
              `Waiting for pullback: ${priceDiffBps.toFixed(1)}bps / ${pendingEntry.targetOffset}bps`,
            );
            await releaseEntryLock(session.sessionId);
            return; // Still waiting for pullback
          }
        } else if (pendingEntry.action === 'wait_confirmation') {
          // Simple confirmation: wait for 2 ticks showing consistent signal
          // In production, this would check actual bar closes
          const updated = await pendingIntentService.incrementConfirmationTicks(pendingEntry.id);
          
          if (!updated) {
            // Intent was already executed or cancelled by another process
            integrationLogger.warn('Pending intent no longer active', { symbol: session.symbol });
            await releaseEntryLock(session.sessionId);
            return;
          }
          
          if (updated.confirmationTicks >= 2) {
            integrationLogger.info('Confirmation complete - entering', { symbol: session.symbol });
            await pendingIntentService.markExecuted(pendingEntry.id);
            // Continue with entry
          } else {
            integrationLogger.debug(`Waiting for confirmation: ${updated.confirmationTicks}/2 ticks`);
            await releaseEntryLock(session.sessionId);
            return; // Still waiting for confirmation
          }
        }
      }
      
      // Get broker
      const broker = await getBrokerForSession(session);
      if (!broker) {
        integrationLogger.error('No broker available for session');
        console.log(`[MetaOrchestrator.executeEntryTrade] ERROR: No broker available`);
        return;
      }

      console.log(`[MetaOrchestrator.executeEntryTrade] Got broker, fetching balance...`);

      // Get account balance for position sizing from capital pool
      const balance = await withLogging(
        integrationLogger,
        'fetch broker balance',
        () => broker.balance()
      );
      
      // Use broker equity directly - no fallback to session balance
      // The broker gets its balance from the shared capital pool
      const equityUsd = balance.equityUsd || 1000; // Only fallback to default if broker returns nothing
      integrationLogger.debug(`Broker balance | equity=${equityUsd.toFixed(2)} free=${balance.freeUsd?.toFixed(2)}`);
      console.log(`[MetaOrchestrator.executeEntryTrade] Balance: equity=${equityUsd.toFixed(2)}, free=${balance.freeUsd?.toFixed(2)}`);

      // Calculate position size with leverage support
      const config = getQuantAIConfig();
      const envConfig = getConfig();
      
      const entryPrice = tech.last;
      const DEFAULT_ATR_PCT = 0.01; // 1% fallback when ATR not available
      const parseMetaNumber = (value: unknown): number | null => {
        if (typeof value === 'number') {
          return Number.isFinite(value) ? value : null;
        }
        if (typeof value === 'string') {
          const parsed = Number.parseFloat(value);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      };
      const planMeta = signal.meta ?? null;
      const planRiskPct = parseMetaNumber(planMeta?.riskPct);
      const planRiskUsd = parseMetaNumber(planMeta?.riskUsd);
      const planTargetProfitUsd = parseMetaNumber(planMeta?.targetProfitUsd);
      const planStopAtrMult = parseMetaNumber(planMeta?.stopAtrMult);
      const entryAtrFromMeta = parseMetaNumber(planMeta?.entryAtr);
      const tpMultiples = Array.isArray(planMeta?.takeProfitMultiples)
        ? planMeta.takeProfitMultiples
            .map((value) => {
              if (typeof value === 'number') {
                return Number.isFinite(value) ? value : Number.NaN;
              }
              if (typeof value === 'string') {
                const parsed = Number.parseFloat(value);
                return Number.isFinite(parsed) ? parsed : Number.NaN;
              }
              return Number.NaN;
            })
            .filter((val) => Number.isFinite(val))
        : [];
      const primaryTpMultiple = tpMultiples.length > 0 ? tpMultiples[0] : null;
      const atrForStops = (() => {
        const resolvedAtr = entryAtrFromMeta && entryAtrFromMeta > 0
          ? entryAtrFromMeta
          : tech.atr14;
        return resolvedAtr && resolvedAtr > 0
          ? resolvedAtr
          : tech.last * DEFAULT_ATR_PCT;
      })();
      
      // Calculate ATR percentage for volatility awareness
      const atrPct = (tech.atr14 / tech.last) * 100;
      
      // 🛡️ VOLATILITY-AWARE STOP DISTANCE: Wider stops in high volatility to avoid premature liquidation
      // Base multiplier from config or plan, then adjust for current volatility regime
      const baseStopMult = planStopAtrMult && planStopAtrMult > 0
        ? planStopAtrMult
        : (config.exits.slAtrMult || 2);
      
      // If ATR > 10%, widen stop to avoid liquidation from normal noise
      const volatilityAdjustedMult = atrPct > 10 
        ? baseStopMult * (1 + Math.min(0.5, (atrPct - 10) / 40)) // Max +50% wider at ATR>30%
        : baseStopMult;
      
      const stopDistance = atrForStops * volatilityAdjustedMult;
      
      if (volatilityAdjustedMult > baseStopMult) {
        integrationLogger.info(`Volatility-adjusted stop | atr=${atrPct.toFixed(1)}% baseMult=${baseStopMult.toFixed(2)}x adjMult=${volatilityAdjustedMult.toFixed(2)}x`);
      }
      
      // Get risk percentage from plan, profile, or use default
      const fallbackRiskPct = session.profileJson?.riskPerTradePct ?? config.risk.baseRiskPerTradePct;
      const riskPct = planRiskPct && planRiskPct > 0 ? planRiskPct : fallbackRiskPct;
      
      // Gather capital usage plus support-agent insights concurrently
      // BUG FIX: Check cache freshness and fallback to direct fetch if stale
      const MAX_CACHE_AGE_MS = 45_000; // 45 seconds max
      const now = Date.now();
      
      const mqEntry = agentMemoryStore.get<MarketQualityScore>('marketQuality', session.symbol);
      const cachedMarketQuality = (mqEntry && now - mqEntry.updatedAt < MAX_CACHE_AGE_MS)
        ? mqEntry.data
        : await agentServices.marketQuality.assess(session.symbol).catch(() => null);
      
      const sentEntry = agentMemoryStore.get<SentimentSignal>('sentiment', session.symbol);
      const cachedSentiment = (sentEntry && now - sentEntry.updatedAt < MAX_CACHE_AGE_MS)
        ? sentEntry.data
        : await agentServices.sentiment.getSignal(session.symbol).catch(() => null);
      
      const riskEntry = agentMemoryStore.get<RiskLimits>('riskGovernor', session.sessionId);
      const cachedRisk = (riskEntry && now - riskEntry.updatedAt < MAX_CACHE_AGE_MS)
        ? riskEntry.data
        : await agentServices.riskGovernor.getLimits(session.sessionId, session.symbol).catch(() => null);

      const [
        capitalMetrics,
        marketQualitySnapshot,
        sentimentSignal,
        riskLimits,
      ] = await Promise.all([
        calculateCapitalUsageAndThresholds(session.mode, session.userId ?? undefined),
        cachedMarketQuality
          ? Promise.resolve(cachedMarketQuality)
          : agentServices.marketQuality.assess(session.symbol).then((snapshot) => {
              agentMemoryStore.update('marketQuality', session.symbol, snapshot);
              return snapshot;
            }),
        cachedSentiment
          ? Promise.resolve(cachedSentiment)
          : agentServices.sentiment.getSignal(session.symbol).then((snapshot) => {
              agentMemoryStore.update('sentiment', session.symbol, snapshot);
              return snapshot;
            }),
        cachedRisk
          ? Promise.resolve(cachedRisk)
          : agentServices.riskGovernor.getLimits(session.sessionId, session.symbol).then((limits) => {
              agentMemoryStore.update('riskGovernor', session.sessionId, limits);
              return limits;
            }),
      ]);

      integrationLogger.info(
        `Support agents | mqScore=${marketQualitySnapshot.score.toFixed(2)} spread=${marketQualitySnapshot.spreadBps.toFixed(1)}bps depth=$${marketQualitySnapshot.bookDepthUsd.toFixed(0)} sentiment=${sentimentSignal.bias}(${(sentimentSignal.confidence * 100).toFixed(0)}%) riskMax=$${riskLimits.maxPositionUsd.toFixed(0)}`,
      );

      const predictorInsight = agentMemoryStore.get<PredictorInsight>('predictor', session.symbol)?.data ?? null;
      if (predictorInsight?.enabled) {
        integrationLogger.info(
          `Predictor insight | bias=${predictorInsight.bias} confidence=${predictorInsight.confidence.toFixed(2)} lastRetrained=${predictorInsight.lastRetrainedAt ?? 'n/a'}`,
        );
      }
      predictorConfidenceForMetrics = predictorInsight?.enabled ? predictorInsight.confidence : undefined;

      if (riskLimits.hedgingRequired) {
        const reason = riskLimits.reason ?? 'risk_governor_requires_hedge';
        integrationLogger.warn(`Entry blocked by risk governor: ${reason}`);
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'filter_blocked',
          blockedReason: reason,
          confidenceScore: signal.confidence,
          inputMetrics: {
            riskMaxPositionUsd: riskLimits.maxPositionUsd,
            hedgingRequired: 1,
          },
        }).catch(err => console.warn('Failed to log risk block:', err));
        return;
      }

      // Check capital usage and determine confidence threshold
      integrationLogger.info(`Capital usage | total=$${capitalMetrics.totalCapital.toFixed(0)} used=$${capitalMetrics.usedCapital.toFixed(0)} free=$${capitalMetrics.freeCapital.toFixed(0)} ratio=${(capitalMetrics.usageRatio * 100).toFixed(1)}% maxPos=${capitalMetrics.maxPositions} minConf=${capitalMetrics.minConfidenceRequired}`);
      
      // 🧠 ADAPTIVE LEARNING: Use historical performance to determine thresholds
      const volumeRatio = Number((tech as any).volumeRatio || 1.0);
      const volumeUsd = Number((tech as any).volumeUsd24h || 10_000_000);
      // Derive trend quality from market quality score
      const trendQuality = marketQualitySnapshot.score >= 0.70 ? 'good' : 
                           marketQualitySnapshot.score >= 0.50 ? 'acceptable' : 'poor';
      
      const adaptiveEval = await evaluateAdaptiveEntry({
        symbol: session.symbol,
        compatibilityScore: marketQualitySnapshot.score,
        predictorConfidence: predictorInsight?.confidence || signal.confidence,
        atrPct,
        volumeRatio,
        volumeUsd,
        trendQuality: trendQuality as any,
      });
      
      // Log adaptive decision
      integrationLogger.info(`🧠 Adaptive eval | allowed=${adaptiveEval.allowed} minCompat=${adaptiveEval.threshold.recommendedMinCompatibility.toFixed(2)} minPred=${adaptiveEval.threshold.recommendedMinPredictorConf.toFixed(2)} ${adaptiveEval.threshold.reasoning}`);
      
      if (adaptiveEval.override) {
        integrationLogger.info(`✨ ${adaptiveEval.override}`);
      }
      
      // 🔥 CRYPTO OPPORTUNITY DETECTION
      // Reduce thresholds for high-conviction setups while maintaining strict risk management
      let adjustedThreshold = Math.min(
        capitalMetrics.minConfidenceRequired,
        adaptiveEval.threshold.recommendedMinPredictorConf
      );
      
      const rsi = tech.rsi14;
      
      // 🚀 VOLATILITY BONUS: High ATR = explosive moves = opportunities (if risk managed properly)
      if (atrPct > 8) {
        const volatilityBonus = Math.min(0.85, 1 - (atrPct - 8) / 50); // Max -15% threshold at ATR>8%
        adjustedThreshold = adjustedThreshold * volatilityBonus;
        integrationLogger.info(`Volatility bonus applied | atr=${atrPct.toFixed(1)}% bonus=${(volatilityBonus * 100).toFixed(0)}% newThreshold=${adjustedThreshold.toFixed(2)}`);
      }
      
      if (rsi < 25 || rsi > 75) {
        // Extreme RSI: reduce threshold by 35%
        const originalThreshold = adjustedThreshold;
        adjustedThreshold = adjustedThreshold * 0.65;
        integrationLogger.info(`🔥 Extreme RSI override: RSI=${rsi.toFixed(1)} → threshold ${originalThreshold.toFixed(3)} → ${adjustedThreshold.toFixed(3)} (-35%)`);
      } else if (rsi < 30 || rsi > 70) {
        // Very oversold/overbought: reduce threshold by 20%
        const originalThreshold = adjustedThreshold;
        adjustedThreshold = adjustedThreshold * 0.80;
        integrationLogger.info(`⚡ Strong RSI override: RSI=${rsi.toFixed(1)} → threshold ${originalThreshold.toFixed(3)} → ${adjustedThreshold.toFixed(3)} (-20%)`);
      }
      
      // Additional volatility boost: if ATR > 100%, conditions are explosive
      if (atrPct > 100) {
        const originalThreshold = adjustedThreshold;
        adjustedThreshold = adjustedThreshold * 0.85;
        integrationLogger.info(`💥 Extreme volatility boost: ATR=${atrPct.toFixed(1)}% → threshold ${originalThreshold.toFixed(3)} → ${adjustedThreshold.toFixed(3)} (-15%)`);
      }
      
      // 🎯 ADAPTIVE OVERRIDE: Allow entry if adaptive learning says so, regardless of other factors
      const shouldAllowByAdaptive = adaptiveEval.allowed || adaptiveEval.override;
      
      // Progressive confidence check: reject if below threshold (unless adaptive override)
      if (!shouldAllowByAdaptive && signal.confidence < adjustedThreshold) {
        integrationLogger.warn(`⚠️ Trade rejected: confidence ${signal.confidence.toFixed(3)} below threshold ${adjustedThreshold.toFixed(3)} (base=${capitalMetrics.minConfidenceRequired.toFixed(3)}, adaptive=${adaptiveEval.threshold.recommendedMinPredictorConf.toFixed(3)}, capital usage: ${(capitalMetrics.usageRatio * 100).toFixed(1)}%)`);
        
        // 🔴 LOG THE REAL REJECTION (overrides the "filter_passed" logged by strategy)
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'filter_blocked', // Changed from order_blocked_capital to filter_blocked
          blockedReason: `Adaptive threshold: confidence ${signal.confidence.toFixed(3)} < required ${adjustedThreshold.toFixed(3)} (${adaptiveEval.threshold.reasoning})`,
          confidenceScore: signal.confidence,
          inputMetrics: {
            ...buildSupportInputMetrics(),
            capitalUsageRatio: capitalMetrics.usageRatio,
            minConfidenceRequired: capitalMetrics.minConfidenceRequired,
            adjustedThreshold,
            adaptiveMinPredictor: adaptiveEval.threshold.recommendedMinPredictorConf,
            adaptiveMinCompat: adaptiveEval.threshold.recommendedMinCompatibility,
            adaptiveReasoning: adaptiveEval.threshold.reasoning,
            rsi,
            atrPct,
          },
          strategyFamily: signal.id.split('_')[0], // Extract family from strategy id
          strategyId: signal.id,
        });
        
        return;
      }

      const supportScale = computeSupportAllocationScale(marketQualitySnapshot, sentimentSignal, side);
      const allocationCaps = [capitalMetrics.maxAllocationPerPosition, riskLimits.maxPositionUsd];
      if (riskLimits.clusterExposureUsd && riskLimits.clusterExposureUsd > 0) {
        allocationCaps.push(riskLimits.clusterExposureUsd);
      }
      const baseAllocationCap = Math.min(...allocationCaps);
      const supportAdjustedAllocation = Math.max(
        capitalAllocationOverrides.minPositionUsd || 0,
        baseAllocationCap * supportScale,
      );
      let maxPositionMargin = Math.min(equityUsd, supportAdjustedAllocation);
      if (!(maxPositionMargin > 0)) {
        integrationLogger.warn('Support-scaled allocation produced zero budget', {
          baseAllocationCap,
          supportScale,
        });
        return;
      }

      const cachedPlan = agentMemoryStore.get<ExecutionPlan>('executionPlan', session.sessionId)?.data ?? null;
      const executionPlan = cachedPlan ?? await agentServices.execution.plan({
        symbol: session.symbol,
        side,
        sizeUsd: Math.max(maxPositionMargin, capitalConfig.minOrderUSD.toNumber()),
        spreadBps: marketQualitySnapshot.spreadBps,
        marketQualityScore: marketQualitySnapshot.score,
        marketQuality: marketQualitySnapshot,
        riskLimits,
      });

      const actionDirective = getExecutionModeDirective(session.sessionId);
      if (actionDirective) {
        const forcedStrategy = actionDirective.mode === 'limit'
          ? 'sweep'
          : actionDirective.mode === 'twap'
          ? 'twap'
          : 'market';
        executionPlan.strategy = forcedStrategy as typeof executionPlan.strategy;
        integrationLogger.info('Execution strategy forced by action directive', {
          intentId: actionDirective.intentId,
          forcedStrategy,
          reason: actionDirective.reason,
        });
      }

      if (!cachedPlan) {
        agentMemoryStore.update('executionPlan', session.sessionId, executionPlan);
      }

      if (marketLooksHostile(marketQualitySnapshot, sentimentSignal, side, executionPlan)) {
        const reason = 'support_agents_blocked_low_quality_flow';
        integrationLogger.warn('Trade rejected: hostile market per support agents', { reason });
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'filter_blocked',
          blockedReason: reason,
          confidenceScore: signal.confidence,
          inputMetrics: {
            ...buildSupportInputMetrics(),
            marketQualityScore: marketQualitySnapshot.score,
            sentimentConfidence: sentimentSignal.confidence,
            executionMinFillUsd: executionPlan.minFillUsd,
          },
          regimeContext: calculateRegimeContext(tech),
        }).catch(err => console.warn('Failed to log quality block:', err));
        return;
      }

      integrationLogger.info(
        `Position sizing | equity=$${equityUsd.toFixed(0)} baseCap=$${baseAllocationCap.toFixed(0)} supportScale=${supportScale.toFixed(2)} adjCap=$${maxPositionMargin.toFixed(0)} strategy=${executionPlan.strategy}`,
      );
      
      // IMPROVEMENT: Apply correlation constraints to prevent over-concentration in correlated assets
      const correlationResult = await applyCorrelationConstraints(
        session.symbol,
        maxPositionMargin,
        riskLimits.maxPositionUsd
      );
      
      if (correlationResult.totalReduction > 0) {
        integrationLogger.info(
          `Correlation constraint applied | original=$${maxPositionMargin.toFixed(0)} adjusted=$${correlationResult.adjustedAllocationUsd.toFixed(0)} reduction=$${correlationResult.totalReduction.toFixed(0)} constraints=${correlationResult.constraints.length}`,
        );
        // Apply the reduction
        maxPositionMargin = correlationResult.adjustedAllocationUsd;
        
        // Log constraints
        for (const constraint of correlationResult.constraints) {
          integrationLogger.info(`  - ${constraint.reason}`);
        }
      }
      
      // IMPROVEMENT: Apply entry timing optimization
      const entryTimingAgent = getEntryTimingAgent();
      
      const entryTiming = await entryTimingAgent.evaluateEntryTiming(
        session.symbol,
        tech,
        signal.confidence
      );
      
      integrationLogger.info(
        `Entry timing | action=${entryTiming.action} aggr=${entryTiming.aggressiveness.toFixed(2)}x confidence=${entryTiming.confidence.toFixed(2)} offset=${entryTiming.optimalEntryOffset}bps`,
      );
      
      // Check if we should wait for better entry conditions
      if (entryTiming.action === 'wait_pullback' || entryTiming.action === 'wait_confirmation') {
        // 🔴 FIX: Store pending intent in DATABASE (not in-memory)
        const expiresAt = new Date(Date.now() + (entryTiming.action === 'wait_pullback' ? 300_000 : 600_000));
        
        await pendingIntentService.create({
          sessionId: session.sessionId,
          symbol: session.symbol,
          action: entryTiming.action,
          targetOffset: entryTiming.optimalEntryOffset,
          originalPrice: entryPrice,
          originalSignal: signal,
          expiresAt,
        });
        
        integrationLogger.info(
          `Entry deferred: ${entryTiming.action} | waiting ${Math.round((expiresAt.getTime() - Date.now()) / 60000)}min`,
        );
        
        return; // Don't enter yet, wait for better conditions
      }
      
      // Apply aggressiveness multiplier to position size
      maxPositionMargin = maxPositionMargin * entryTiming.aggressiveness;
      
      integrationLogger.info(
        `Entry timing: immediate with aggr=${entryTiming.aggressiveness.toFixed(2)}x | adjusted_margin=$${maxPositionMargin.toFixed(0)}`,
      );
      
      // Dynamic leverage based on confidence: high confidence = higher leverage
      // confidence range: 0.50-1.0 (filters block below 0.50)
      // leverage range: baseLeverage (e.g., 3x) to maxLeverage (e.g., 10x)
      const profileMaxLeverage = session.profileJson?.maxLeverage ?? envConfig.DEFAULT_MAX_LEVERAGE;
      const maxLeverage = Math.max(1, Math.min(profileMaxLeverage, riskLimits.maxLeverage));
      const baseLeverage = Math.max(2, Math.min(3, maxLeverage * 0.3)); // Minimum safe leverage (30% of max, or 2-3x)
      
      // Linear interpolation: confidence 0.50 → baseLeverage, confidence 1.0 → maxLeverage
      const confidenceRange = 1.0 - 0.50; // 0.50 range
      const normalizedConfidence = Math.max(0, Math.min(1, (signal.confidence - 0.50) / confidenceRange));
      const confidenceAdjustedLeverage = baseLeverage + (maxLeverage - baseLeverage) * normalizedConfidence;
      
      integrationLogger.info(`Confidence-based leverage | confidence=${signal.confidence.toFixed(3)} base=${baseLeverage.toFixed(1)}x max=${maxLeverage.toFixed(1)}x → adjusted=${confidenceAdjustedLeverage.toFixed(2)}x`);
      
      // Use computeQtyNotional which respects leverage caps per symbol category
      const sizingResult = await computeQtyNotional({
        balanceUsd: maxPositionMargin,
        riskPct,
        stopDistanceAbs: stopDistance,
        entryPrice,
        requestedLeverage: confidenceAdjustedLeverage,
        symbol: session.symbol,
        mode: session.mode,
        tp1DistanceAbs: primaryTpMultiple && primaryTpMultiple > 0 ? stopDistance * primaryTpMultiple : undefined,
        minTp1PnlUsd: planTargetProfitUsd && planTargetProfitUsd > 0 ? planTargetProfitUsd : undefined,
        tp1RMultiple: primaryTpMultiple && primaryTpMultiple > 0 ? primaryTpMultiple : undefined,
        minNotionalUsd: capitalAllocationOverrides.minPositionUsd || undefined,
      });
      
      let qty = entryPrice > 0 ? sizingResult.notional / entryPrice : 0;
      const leverage = sizingResult.leverageCap.resolved;
      const riskPerUnit = stopDistance;
      let notional = qty * entryPrice;
      let computedRiskUsd = riskPerUnit * qty;

      if (planRiskUsd && planRiskUsd > 0 && riskPerUnit > 0 && computedRiskUsd > planRiskUsd * 1.01) {
        const scale = planRiskUsd / computedRiskUsd;
        qty *= scale;
        notional = qty * entryPrice;
        computedRiskUsd = planRiskUsd;
      }

      const minOrderUsd = Math.max(capitalConfig.minOrderUSD.toNumber(), executionPlan.minFillUsd);
      if (minOrderUsd > 0 && notional > 0 && notional < minOrderUsd) {
        integrationLogger.warn('Position sizing below min order after risk clamp', {
          notional,
          minOrderUsd,
          planRiskUsd,
        });
        console.log('[MetaOrchestrator.executeEntryTrade] ABORTED: notional below min order after clamp');
        return;
      }

      if (!qty || qty <= 0) {
        integrationLogger.warn('Position sizing resulted in 0 quantity', {
          equityUsd,
          entryPrice,
          stopDistance,
          confidenceAdjustedLeverage,
          resolvedLeverage: leverage,
        });
        console.log(`[MetaOrchestrator.executeEntryTrade] ABORTED: sizing returned qty=0`);
        
        // Log that order was blocked due to position sizing
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'order_blocked_sizing',
          blockedReason: `qty=0: equity=${equityUsd.toFixed(2)}, stop=${stopDistance.toFixed(4)}, entry=${entryPrice.toFixed(4)}, leverage=${leverage}x`,
          confidenceScore: signal.confidence,
          inputMetrics: buildSupportInputMetrics(),
          regimeContext: calculateRegimeContext(tech),
        }).catch(err => console.warn('Failed to log sizing block:', err));
        
        return;
      }

      integrationLogger.info(`Position sized | qty=${qty.toFixed(8)} notional=${notional.toFixed(2)} entryPrice=${entryPrice.toFixed(4)} stopDistance=${stopDistance.toFixed(4)} leverage=${leverage}x riskUsd=${computedRiskUsd.toFixed(2)}`);
      console.log(`[MetaOrchestrator.executeEntryTrade] Sizing: qty=${qty.toFixed(8)}, notional=${notional.toFixed(2)}, entryPrice=${entryPrice.toFixed(4)}, stopDist=${stopDistance.toFixed(4)}, leverage=${leverage}x`);

      // Register the trade entry with meta-adaptive system
      const registrationResult = await registerAdaptiveTradeEntry({
        sessionId: session.sessionId,
        symbol: session.symbol,
        signal,
        qty,
        entryPrice,
        stopDistance,
      });

      if (registrationResult === 'skipped' || registrationResult === 'predictor_blocked') {
        integrationLogger.warn(`Trade registration ${registrationResult}`);
        console.log(`[MetaOrchestrator.executeEntryTrade] ABORTED: registration ${registrationResult}`);
        
        // Predictor and cooldown are ANALYSIS FILTERS, not execution blocks
        // They evaluate signal quality, so they should be logged as filter_blocked
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'filter_blocked',  // Changed from order_blocked_registration
          blockedReason: registrationResult === 'predictor_blocked' ? 'predictor_confidence_too_low' : 'cooldown_active',
          confidenceScore: signal.confidence,
          inputMetrics: buildSupportInputMetrics(),
          regimeContext: calculateRegimeContext(tech),
        }).catch(err => console.warn('Failed to log registration block:', err));
        
        return;
      }

      console.log(`[MetaOrchestrator.executeEntryTrade] Registration OK, placing order...`);

      // Place the actual order via broker
      const stopPrice = signal.bias === 'short'
        ? entryPrice + stopDistance
        : entryPrice - stopDistance;

      console.log(`[MetaOrchestrator.executeEntryTrade] Calling broker.place(): side=${side}, qty=${qty.toFixed(8)}, stopPrice=${stopPrice.toFixed(4)}, leverage=${leverage}x`);

      const order = await withRetry(
        integrationLogger,
        'place entry order',
        () => broker.place({
          symbol: session.symbol,
          side,
          type: 'market',
          qty,
          stopLoss: stopPrice,
          leverage,
          clientOrderId: `${session.sessionId}-entry-${Date.now()}`,
          // Add evaluation context for better logging
          _evaluationContext: {
            confidence: signal.confidence,
            inputMetrics: {
              ...buildSupportInputMetrics(),
              executionPlanMaxSlippage: executionPlan.maxSlippageBps,
              executionPlanMinFillUsd: executionPlan.minFillUsd,
            },
            regimeContext: calculateRegimeContext(tech),
          },
          executionPlan,
        }),
        3,
        500
      );

      console.log(`[MetaOrchestrator.executeEntryTrade] Order placed! id=${order.id}, status=${order.status}, filledQty=${order.filledQty}`);

      // Log successful order placement
      if (order.status !== 'rejected') {
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'order_placed',
          blockedReason: undefined,
          confidenceScore: signal.confidence,
          inputMetrics: {
            ...buildSupportInputMetrics(),
            executionPlanMaxSlippage: executionPlan.maxSlippageBps,
            executionPlanMinFillUsd: executionPlan.minFillUsd,
          },
          regimeContext: calculateRegimeContext(tech),
        }).catch(err => console.warn('Failed to log order placement:', err));

        if (order.slippageBps != null && order.slippageBps > executionPlan.maxSlippageBps) {
          integrationLogger.warn(
            `Slippage ${order.slippageBps.toFixed(2)}bps exceeded plan allowance ${executionPlan.maxSlippageBps}bps`,
            { orderId: order.id },
          );
        }

        // Persist order and position to database
        try {
          // Calculate fee using Binance taker fee (market order = taker)
          const feeUsd = calculateFeeUsd({
            price: order.avgPrice ?? entryPrice,
            qty: order.filledQty ?? qty,
            side,
            liquidity: 'taker', // Market orders are taker orders
            fees: {
              makerFeeBps: config.feesSlippage.makerFeeBps,
              takerFeeBps: config.feesSlippage.takerFeeBps,
            },
          });

          await recordEnter({
            sessionId: session.sessionId,
            symbol: session.symbol,
            side,
            qty: order.filledQty ?? qty,
            entryPrice: order.avgPrice ?? entryPrice,
            stop: stopPrice,
            leverage: order.leverage,
            requestedPrice: entryPrice,
            requestedQty: qty,
            latencyMs: order.latencyMs,
            slippageBps: order.slippageBps,
            fillRatio: order.fillRatio,
            feeUsd,
            slOrderId: order.slOrderId, // Track SL order ID from broker
            tpOrderId: order.tpOrderId, // Track TP order ID from broker
            strategyFamily: deriveStrategyFamily(signal.id),
            strategyId: signal.id,
          });
          console.log(`[MetaOrchestrator.executeEntryTrade] Position persisted to database`);
          
          // 🔴 FIX: Reconcile protective orders immediately after entry
          if (session.mode === 'live') {
            try {
              const reconciliationResult = await orderReconciliationService.reconcilePosition(
                session.sessionId,
                broker
              );
              if (!reconciliationResult.synchronized) {
                integrationLogger.warn(
                  `Protective order sync issues after entry: ${reconciliationResult.issues.join(', ')}`,
                );
              }
            } catch (reconcileError) {
              integrationLogger.error('Failed to reconcile protective orders after entry:', reconcileError);
            }
          }
          
          // IMPROVEMENT: Generate exit strategy for this position
          const exitStrategyAgent = getExitStrategyAgent();
          
          const volatility = (tech.atr14 / tech.last) * 100;
          const exitStrategy = await exitStrategyAgent.generateExitStrategy(
            session.symbol,
            tech,
            0, // Initial R-multiple
            0, // Just opened
            volatility
          );
          
          // Store strategy with position
          agentMemoryStore.update('exitStrategy', session.sessionId, {
            strategy: exitStrategy,
            entryPrice: order.avgPrice ?? entryPrice,
            initialStop: stopPrice,
            rMultipleAtEntry: 0,
            exitedPct: 0,
            createdAt: Date.now(),
          });
          
          integrationLogger.info(
            `Exit strategy set | first=${exitStrategy.scaleOutPlan[0].rMultiple}R/${(exitStrategy.scaleOutPlan[0].exitPct * 100).toFixed(0)}% trail=${exitStrategy.trailingStopAtrMultiplier}xATR max_hold=${(exitStrategy.maxHoldTimeMs / 3600000).toFixed(1)}h`,
          );
        } catch (err) {
          console.error(`[MetaOrchestrator.executeEntryTrade] Failed to persist position:`, err);
        }
      } else {
        // Order was rejected by broker
        await logTradeEvaluation({
          userId: session.userId,
          symbol: session.symbol,
          decision: 'order_rejected',
          blockedReason: (order as any).error || 'broker_rejected',
          confidenceScore: signal.confidence,
          inputMetrics: buildSupportInputMetrics(),
          regimeContext: calculateRegimeContext(tech),
        }).catch(err => console.warn('Failed to log order rejection:', err));
      }

      integrationLogger.success(`Entry order placed`, undefined, {
        orderId: order.id,
        side,
        qty,
        entryPrice,
        stopPrice,
        status: order.status,
      });

      // Update agent position state
      const agent = AgentHub.get(session.sessionId) as any;
      if (agent) {
        // CRITICAL FIX: Use actually filled quantity, not requested quantity
        // This prevents exit qty mismatch when entry has partial fill
        const actualFilledQty = order.filledQty ?? qty;
        const actualEntryPrice = order.avgPrice ?? entryPrice;
        
        console.log(`[MetaOrchestrator.executeEntryTrade] Setting position: qty=${actualFilledQty} (requested=${qty}, fillRatio=${order.fillRatio})`);
        
        agent.pos = {
          side,
          qty: actualFilledQty, // Use filled quantity, not requested quantity
          entry: actualEntryPrice,
          stop: stopPrice,
          signal,
          openedAt: Date.now(),
          peakPrice: actualEntryPrice, // Initialize peak price at actual entry price
          initialStopDistance: stopDistance, // Store original stop distance for R-multiple calculations
          telemetry: buildPositionTelemetry({
            entryPrice: actualEntryPrice,
            stopDistance,
            atrValue: atrForStops ?? null,
          }),
        };
      }
    } finally {
      await releaseEntryLock(session.sessionId, 'placing_entry_order');
    }
  } catch (error: any) {
    integrationLogger.error('Error executing entry trade', error);
    console.log(`[MetaOrchestrator.executeEntryTrade] EXCEPTION: ${error.message}`);
    
    // Log the exception as an order rejection
    await logTradeEvaluation({
      userId: session.userId,
      symbol: session.symbol,
      decision: 'order_rejected',
      blockedReason: `exception: ${error.message || 'unknown error'}`,
      confidenceScore: signal.confidence,
      inputMetrics: buildSupportInputMetrics(),
      regimeContext: calculateRegimeContext(tech),
    }).catch(err => console.warn('Failed to log exception:', err));
  }
}

/**
 * Start the periodic order reconciliation loop
 * Ensures that exchange orders (SL/TP) match the application state
 */
export function startOrderReconciliationLoop() {
  logger.info('Starting order reconciliation loop (every 30s)');
  
  setInterval(async () => {
    try {
      await orderReconciliationService.reconcileAllActiveSessions(async (sessionInfo) => {
        // Try to get existing broker
        if (sessionBrokers.has(sessionInfo.id)) {
          return sessionBrokers.get(sessionInfo.id)!;
        }
        
        // Recreate broker if missing (using the info passed from DB)
        const context: SessionContext = {
          sessionId: sessionInfo.id,
          symbol: '', // Not needed for broker creation
          mode: sessionInfo.mode as 'paper' | 'live',
          userId: sessionInfo.userId,
          profileJson: {}, // Not needed for broker creation
        };
        
        return getBrokerForSession(context);
      });
    } catch (err) {
      logger.error('Order reconciliation loop error', err);
    }
  }, 30_000); // Every 30 seconds
}

/**
 * Check if position should be flipped based on counter-signal
 */
async function shouldFlipPosition(
  session: SessionContext,
  agent: any,
  counterSignal: RecognizedStrategySignal,
  tech: TechnicalSnapshot
): Promise<{ flip: boolean; reason: string }> {
  const config = getQuantAIConfig();
  const flipConfig = config.exits.positionFlipping;
  
  // Check if position flipping is enabled
  if (!flipConfig?.enabled) {
    return { flip: false, reason: 'position_flipping_disabled' };
  }
  
  if (!agent?.pos) {
    return { flip: false, reason: 'no_position' };
  }
  
  // Check counter-signal confidence
  if (counterSignal.confidence < flipConfig.minCounterSignalConfidence) {
    return {
      flip: false,
      reason: `confidence_too_low: ${counterSignal.confidence.toFixed(2)} < ${flipConfig.minCounterSignalConfidence}`,
    };
  }
  
  // Get position details for validation
  const position = agent.pos;
  
  // ENHANCEMENT: Use reversal detection to validate counter-signal
  const currentSide = position.side === 'buy' ? 'long' : 'short';
  const targetSide = counterSignal.bias === 'short' ? 'short' : 'long';
  
  if (currentSide === 'long' && targetSide === 'short') {
    // Flipping long -> short: check for reversal signal
    const reversalSignal = detectReversalForLong(tech);
    if (reversalSignal.probability >= 0.6) {
      // Strong reversal detected - boost confidence
      logger.info(
        `[${session.sessionId}] Reversal detection supports flip: ${reversalSignal.severity} probability=${reversalSignal.probability.toFixed(2)} reasons=[${reversalSignal.reasons.join(', ')}]`
      );
    } else if (reversalSignal.probability < 0.3) {
      // No reversal detected - counter-signal may be premature
      return {
        flip: false,
        reason: `weak_reversal_signal: probability=${reversalSignal.probability.toFixed(2)} < 0.3 required`,
      };
    }
  } else if (currentSide === 'short' && targetSide === 'long') {
    // Flipping short -> long: check for rebound signal
    const reboundSignal = detectReboundForShort(tech);
    if (reboundSignal.probability >= 0.6) {
      // Strong rebound detected - boost confidence
      logger.info(
        `[${session.sessionId}] Rebound detection supports flip: ${reboundSignal.severity} probability=${reboundSignal.probability.toFixed(2)} reasons=[${reboundSignal.reasons.join(', ')}]`
      );
    } else if (reboundSignal.probability < 0.3) {
      // No rebound detected - counter-signal may be premature
      return {
        flip: false,
        reason: `weak_rebound_signal: probability=${reboundSignal.probability.toFixed(2)} < 0.3 required`,
      };
    }
  }
  
  // Calculate current R-multiple
  const currentPrice = tech.last;
  const riskPerUnit = Math.abs(position.entry - position.stop);
  const baselineStop = position.side === 'buy'
    ? position.entry - riskPerUnit
    : position.entry + riskPerUnit;
  const positionSide = position.side === 'buy' ? 'long' : 'short';
  const rNow = riskPerUnit > 0 
    ? PositionSizer.rMultiple(position.entry, baselineStop, currentPrice, positionSide)
    : 0;
  
  // Check minimum R-multiple requirement
  if (rNow < flipConfig.minRMultiple) {
    return {
      flip: false,
      reason: `r_multiple_too_low: ${rNow.toFixed(2)}R < ${flipConfig.minRMultiple}R required`,
    };
  }
  
  // Check flip cooldowns
  const cooldownCheck = canFlipPosition(session.sessionId, {
    cooldownMinutes: flipConfig.cooldownMinutes,
    maxFlipsPerHour: flipConfig.maxFlipsPerHour,
  });
  
  if (!cooldownCheck.allowed) {
    return { flip: false, reason: cooldownCheck.reason || 'cooldown_active' };
  }
  
  // All conditions met - flip is allowed
  return {
    flip: true,
    reason: `strong_counter_signal: confidence=${counterSignal.confidence.toFixed(2)}, R=${rNow.toFixed(2)}`,
  };
}

/**
 * Execute a position flip: exit current position and immediately enter opposite position
 */
async function executePositionFlip(
  session: SessionContext,
  agent: any,
  counterSignal: RecognizedStrategySignal,
  tech: TechnicalSnapshot
): Promise<void> {
  const integrationLogger = createIntegrationLogger({
    component: 'Orchestrator',
    action: 'position_flip',
    sessionId: session.sessionId,
    symbol: session.symbol,
  });
  
  try {
    if (!agent?.pos) {
      integrationLogger.error('No position to flip');
      return;
    }
    
    const position = agent.pos;
    const currentPrice = tech.last;
    const fromSide = position.side === 'buy' ? 'long' : 'short';
    const toSide = counterSignal.bias === 'short' ? 'short' : 'long';
    
    // Calculate R-multiple for tracking
    const riskPerUnit = Math.abs(position.entry - position.stop);
    const baselineStop = position.side === 'buy'
      ? position.entry - riskPerUnit
      : position.entry + riskPerUnit;
    const rNow = riskPerUnit > 0 
      ? PositionSizer.rMultiple(position.entry, baselineStop, currentPrice, fromSide)
      : 0;
    
    integrationLogger.info(
      `Executing position flip | from=${fromSide} to=${toSide} price=${currentPrice.toFixed(4)} R=${rNow.toFixed(2)} confidence=${counterSignal.confidence.toFixed(2)}`
    );
    
    // Step 1: Exit current position
    await executeExitTrade(session, agent, currentPrice, `position_flip: ${fromSide} -> ${toSide}`);
    
    // Step 2: Wait a tiny bit to ensure exit is processed
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Step 3: Enter new position in opposite direction
    await executeEntryTrade(session, counterSignal, tech);
    
    // Step 4: Record the flip
    recordPositionFlip(session.sessionId, {
      fromSide,
      toSide,
      price: currentPrice,
      confidence: counterSignal.confidence,
      rMultiple: rNow,
    });
    
    integrationLogger.success(
      `Position flip completed | from=${fromSide} to=${toSide} at ${currentPrice.toFixed(4)}`
    );
    
  } catch (error: any) {
    integrationLogger.error('Error executing position flip', error);
    logger.error(`[${session.sessionId}] Position flip failed:`, error);
  }
}

/**
 * Check if position should exit and execute if needed
 */
async function checkAndExecuteExit(
  session: SessionContext,
  agent: any,
  tech: TechnicalSnapshot
): Promise<void> {
  const integrationLogger = createIntegrationLogger({
    component: 'MetaAdaptiveOrchestrator',
    action: 'checkAndExecuteExit',
    sessionId: session.sessionId,
    symbol: session.symbol,
  });
  
  try {
    if (!agent?.pos) {
      return;
    }

    const currentPrice = tech.last;
    const position = agent.pos;
    const positionSide = position.side === 'buy' ? 'long' : 'short';
    
    // Calculate position age
    const MS_PER_MINUTE = 60000;
    const minutesOpen = position.openedAt ? (Date.now() - position.openedAt) / MS_PER_MINUTE : 0;
    
    // 🎯 FALSE BREAKOUT DETECTION: Exit fast if trade immediately goes wrong
    // If position opened recently (<10min) and already losing badly, likely false breakout
    if (minutesOpen < 10 && position.entry) {
      const immediateLoss = positionSide === 'long'
        ? (position.entry - currentPrice) / position.entry
        : (currentPrice - position.entry) / position.entry;
      
      if (immediateLoss > 0.015) { // -1.5% immediate loss = likely false breakout
        integrationLogger.info(`False breakout detected | side=${positionSide} loss=${(immediateLoss * 100).toFixed(2)}% age=${minutesOpen.toFixed(1)}m`);
        await executeExitTrade(session, agent, currentPrice, `false_breakout: ${(immediateLoss * 100).toFixed(2)}% loss in ${minutesOpen.toFixed(1)}m`);
        return;
      }
    }
    
    // REVERSAL DETECTION: Check if market is reversing against our position
    // 🔄 CRYPTO BREATHING ROOM: Only exit on VERY strong reversal signals (0.82+)
    // But only for PROFITABLE trades - losers should exit on weaker signals
    if (positionSide === 'long') {
      const reversalSignal = detectReversalForLong(tech);
      const currentR = position.entry && position.stop
        ? PositionSizer.rMultiple(position.entry, position.stop, currentPrice, positionSide)
        : 0;
      const reversalThreshold = currentR > 0.5 ? 0.82 : 0.65; // Lower threshold for losers
      
      if (reversalSignal.probability >= reversalThreshold) {
        integrationLogger.warn(
          `⚠️ Strong reversal detected against LONG | probability=${reversalSignal.probability.toFixed(2)} severity=${reversalSignal.severity} reasons=[${reversalSignal.reasons.join(', ')}]`
        );
        
        // Exit immediately on critical reversals
        if (reversalSignal.severity === 'critical' || reversalSignal.probability >= 0.8) {
          await executeExitTrade(session, agent, currentPrice, `reversal_detected: ${reversalSignal.severity} (${reversalSignal.reasons[0]})`);
          return;
        }
      }
    } else if (positionSide === 'short') {
      const reboundSignal = detectReboundForShort(tech);
      const currentR = position.entry && position.stop
        ? PositionSizer.rMultiple(position.entry, position.stop, currentPrice, positionSide)
        : 0;
      const reboundThreshold = currentR > 0.5 ? 0.82 : 0.65; // Lower threshold for losers
      
      if (reboundSignal.probability >= reboundThreshold) {
        integrationLogger.warn(
          `⚠️ Strong rebound detected against SHORT | probability=${reboundSignal.probability.toFixed(2)} severity=${reboundSignal.severity} reasons=[${reboundSignal.reasons.join(', ')}]`
        );
        
        // Exit immediately on critical rebounds
        if (reboundSignal.severity === 'critical' || reboundSignal.probability >= 0.8) {
          await executeExitTrade(session, agent, currentPrice, `rebound_detected: ${reboundSignal.severity} (${reboundSignal.reasons[0]})`);
          return;
        }
      }
    }
    
    // 🎯 SMART S/R TRAILING: Tighten trailing stop near support/resistance
    // Instead of manual exit, let trailing stop handle breakouts vs rejections automatically
    const entryPrice = Number(position.entryPrice ?? 0);
    const currentStop = agent.exitStrategy?.stop ?? position.stopLoss ?? 0;
    const currentPnl = position.side === 'buy'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;
    
    // Only adjust trailing if we have profit (> 1.0%) and haven't already tightened
    if (currentPnl > 1.0 && entryPrice > 0) {
      const atr = tech.atr14;
      const atrPct = atr > 0 && currentPrice > 0 ? (atr / currentPrice) * 100 : 2.0;
      
      if (positionSide === 'long') {
        // LONG approaching resistance → tighten trailing stop
        const nearResistance = tech.srBias === 'nearResistance';
        const rsi = Number((tech as any)?.rsi14 ?? 50);
        const reversalSignal = detectReversalForLong(tech);
        
        // Tighten if approaching resistance with ANY rejection signs
        if (nearResistance && reversalSignal.probability >= 0.35) {
          // Calculate tighter trailing: 1.0 ATR instead of default 2.0 ATR
          const tightTrailDistance = atr * 1.0; // 1x ATR = tight protection
          const newStop = currentPrice - tightTrailDistance;
          
          // Only move stop UP (never down)
          if (newStop > currentStop && newStop < currentPrice) {
            integrationLogger.info(
              `🎯 Tightening trailing near resistance | pnl=${currentPnl.toFixed(2)}% stop=${currentStop.toFixed(4)}→${newStop.toFixed(4)} trail=${tightTrailDistance.toFixed(4)} (1.0 ATR) rsi=${rsi.toFixed(1)} reversal=${reversalSignal.probability.toFixed(2)}`
            );
            
            // Update stop in agent's exit strategy
            if (agent.exitStrategy) {
              agent.exitStrategy.stop = newStop;
              
              // 🚀 SYNC: Immediately sync new stop with exchange
              if (session.mode === 'live') {
                getBrokerForSession(session).then(broker => {
                  if (broker) {
                    orderReconciliationService.reconcilePosition(session.sessionId, broker)
                      .catch(err => logger.warn(`[${session.sessionId}] Failed to sync trailing stop:`, err));
                  }
                });
              }
            }
          }
        }
        
      } else if (positionSide === 'short') {
        // SHORT approaching support → tighten trailing stop
        const nearSupport = tech.srBias === 'nearSupport';
        const rsi = Number((tech as any)?.rsi14 ?? 50);
        const reboundSignal = detectReboundForShort(tech);
        
        // Tighten if approaching support with ANY rebound signs
        if (nearSupport && reboundSignal.probability >= 0.35) {
          // Calculate tighter trailing: 1.0 ATR instead of default 2.0 ATR
          const tightTrailDistance = atr * 1.0; // 1x ATR = tight protection
          const newStop = currentPrice + tightTrailDistance;
          
          // Only move stop DOWN (never up)
          if (newStop < currentStop && newStop > currentPrice) {
            integrationLogger.info(
              `🎯 Tightening trailing near support | pnl=${currentPnl.toFixed(2)}% stop=${currentStop.toFixed(4)}→${newStop.toFixed(4)} trail=${tightTrailDistance.toFixed(4)} (1.0 ATR) rsi=${rsi.toFixed(1)} rebound=${reboundSignal.probability.toFixed(2)}`
            );
            
            // Update stop in agent's exit strategy
            if (agent.exitStrategy) {
              agent.exitStrategy.stop = newStop;
              
              // 🚀 SYNC: Immediately sync new stop with exchange
              if (session.mode === 'live') {
                getBrokerForSession(session).then(broker => {
                  if (broker) {
                    orderReconciliationService.reconcilePosition(session.sessionId, broker)
                      .catch(err => logger.warn(`[${session.sessionId}] Failed to sync trailing stop:`, err));
                  }
                });
              }
            }
          }
        }
      }
    }
    
    // IMPROVEMENT: Check for exit strategy and apply it
    const exitStrategyData = agentMemoryStore.get<any>('exitStrategy', session.sessionId)?.data;
    
    if (exitStrategyData) {
      const exitStrategyAgent = getExitStrategyAgent();
      const exitStrategy = exitStrategyData.strategy;
      const entryPrice = exitStrategyData.entryPrice;
      const initialStop = exitStrategyData.initialStop;
      const timeInPosition = Date.now() - (exitStrategyData.createdAt || Date.now());
      
      // Calculate current R-multiple
      const riskPerUnit = Math.abs(entryPrice - initialStop);
      const currentR = position.side === 'buy'
        ? (currentPrice - entryPrice) / riskPerUnit
        : (entryPrice - currentPrice) / riskPerUnit;
      
      // Check for partial exits
      const partialExit = exitStrategyAgent.shouldTakePartialProfit(
        currentR,
        exitStrategy,
        exitStrategyData.exitedPct
      );
      
      if (partialExit.shouldExit && partialExit.exitPct > 0) {
        integrationLogger.info(
          `🎯 Partial exit triggered | R=${currentR.toFixed(2)} exit=${(partialExit.exitPct * 100).toFixed(0)}% reason=${partialExit.reason}`,
        );
        
        // Calculate exit quantity
        const currentQty = Math.abs(position.qty ?? 0);
        const exitQty = currentQty * partialExit.exitPct;
        
        if (exitQty > 0) {
          try {
            // Execute partial exit
            const broker = await getBrokerForSession(session);
            if (broker) {
              const order = await broker.place({
                symbol: session.symbol,
                side: position.side === 'buy' ? 'sell' : 'buy',
                qty: exitQty,
                type: 'market',
                reduceOnly: true,
              });
              
              if (order.status === 'filled') {
                // Update exited percentage
                exitStrategyData.exitedPct += partialExit.exitPct;
                agentMemoryStore.update('exitStrategy', session.sessionId, exitStrategyData);
                
                // Update position quantity
                position.qty = position.side === 'buy' ? currentQty - exitQty : -(currentQty - exitQty);
                
                integrationLogger.info(
                  `✅ Partial exit executed | qty=${exitQty.toFixed(4)} total_exited=${(exitStrategyData.exitedPct * 100).toFixed(0)}%`,
                );
              }
            }
          } catch (error) {
            integrationLogger.error('Failed to execute partial exit', { error });
          }
        }
        
        // If fully exited, clean up
        if (exitStrategyData.exitedPct >= 0.99) {
          agentMemoryStore.update('exitStrategy', session.sessionId, null);
          return;
        }
      }
      
      // Check for profit locking (tighten stop)
      const currentStopDistance = position.stop ? Math.abs(currentPrice - position.stop) : null;
      const lockProfit = exitStrategyAgent.shouldLockProfits(
        currentR,
        exitStrategy,
        currentStopDistance ?? 0 // Use 0 if no stop is set
      );
      
      if (lockProfit.shouldTighten) {
        const newStop = position.side === 'buy'
          ? currentPrice - lockProfit.newStopDistance
          : currentPrice + lockProfit.newStopDistance;
        
        integrationLogger.info(
          `🔒 Locking profits | R=${currentR.toFixed(2)} old_stop=${position.stop?.toFixed(4)} new_stop=${newStop.toFixed(4)} reason=${lockProfit.reason}`,
        );
        
        position.stop = newStop;
      }
      
      // Check max hold time
      if (timeInPosition > exitStrategy.maxHoldTimeMs) {
        integrationLogger.info(
          `⏰ Max hold time exceeded | held=${(timeInPosition / 3600000).toFixed(1)}h max=${(exitStrategy.maxHoldTimeMs / 3600000).toFixed(1)}h`,
        );
        
        await executeExitTrade(session, agent, currentPrice, 'max_hold_time_exceeded');
        agentMemoryStore.update('exitStrategy', session.sessionId, null);
        return;
      }
      
      // Apply adaptive trailing stop
      if (currentR >= exitStrategy.trailingStopActivationR) {
        const trailingStop = position.side === 'buy'
          ? currentPrice - (tech.atr14 * exitStrategy.trailingStopAtrMultiplier)
          : currentPrice + (tech.atr14 * exitStrategy.trailingStopAtrMultiplier);
        
        // Only update if new trailing stop is better than current stop
        const shouldUpdate = position.side === 'buy'
          ? trailingStop > (position.stop ?? -Infinity)
          : trailingStop < (position.stop ?? Infinity);
        
        if (shouldUpdate) {
          integrationLogger.info(
            `📈 Trailing stop update | R=${currentR.toFixed(2)} new_stop=${trailingStop.toFixed(4)} ATR_mult=${exitStrategy.trailingStopAtrMultiplier}`,
          );
          
          position.stop = trailingStop;
        }
      }
    }

    // Update peak price tracking
    if (position.peakPrice == null) {
      // Initialize peak price on first check
      position.peakPrice = position.entry;
    }
    
    // Update peak price based on position side
    if (position.side === 'buy') {
      // For longs, track highest price
      if (currentPrice > position.peakPrice) {
        position.peakPrice = currentPrice;
        logger.debug(`[${session.sessionId}] Updated peak price (long): ${position.peakPrice.toFixed(4)}`);
      }
    } else {
      // For shorts, track lowest price
      if (currentPrice < position.peakPrice) {
        position.peakPrice = currentPrice;
        logger.debug(`[${session.sessionId}] Updated peak price (short): ${position.peakPrice.toFixed(4)}`);
      }
    }

    // Check exit conditions using exitManager
    const config = getQuantAIConfig();
    const telemetryUpdate = updatePositionTelemetry(position, currentPrice, tech, minutesOpen);
    if (telemetryUpdate) {
      // ⚖️ ASYMMETRIC RISK: Protect winners, cut losers fast
      // Winners (>0.5R): Let breathe during consolidation
      // Losers (<-0.3R): Cut quickly if no recovery momentum
      const isWinner = telemetryUpdate.rMultiple > 0.5;
      const isLoser = telemetryUpdate.rMultiple < -0.3;
      
      // 🔪 FAST CUT FOR LOSERS: If losing AND stagnating, exit faster
      let telemetryTimeoutReason: string | null = null;
      if (isLoser && telemetryUpdate.telemetry.stagnationMinutes > 15) {
        // Losing position stagnating = no recovery momentum, cut it
        telemetryTimeoutReason = `fast_cut_loser: R=${telemetryUpdate.rMultiple.toFixed(2)}, stagnation=${telemetryUpdate.telemetry.stagnationMinutes.toFixed(1)}m`;
      } else if (!isWinner) {
        // Not a winner: apply normal telemetry timeout rules
        telemetryTimeoutReason = shouldTriggerTelemetryTimeout({
          telemetry: telemetryUpdate.telemetry,
          minutesOpen,
          rMultiple: telemetryUpdate.rMultiple,
          exitConfig: config.exits,
        });
      }
      // else: isWinner = let it breathe, skip telemetry timeout
      if (telemetryTimeoutReason) {
        logger.info(`[${session.sessionId}] Telemetry timeout exit triggered: ${telemetryTimeoutReason}`);
        await executeExitTrade(session, agent, currentPrice, telemetryTimeoutReason);
        return;
      }
    }
    const DEFAULT_ATR_PCT = 0.01; // 1% fallback when ATR not available
    const exitDirective = maybeAdjustOrExit({
      side: position.side === 'sell' ? 'short' : 'long',
      entryPrice: position.entry,
      lastPrice: currentPrice,
      stop: position.stop,
      targets: position.targets || [],
      atr: tech.atr14 || (tech.last * DEFAULT_ATR_PCT),
      cfg: config.exits,
      minutesOpen,
      peakPrice: position.peakPrice,
      initialStopDistance: position.initialStopDistance, // Pass original stop distance for accurate R-multiple calculations
    });

    if (exitDirective?.action === 'exit') {
      logger.info(`[${session.sessionId}] Exit signal: ${exitDirective.reason}`);
      await executeExitTrade(session, agent, currentPrice, exitDirective.reason);
    } else if (exitDirective?.action === 'move_sl') {
      logger.info(`[${session.sessionId}] Adjusting stop from ${position.stop} to ${exitDirective.stop}`);
      position.stop = exitDirective.stop;
    }

  } catch (error) {
    logger.error(`[${session.sessionId}] Error checking exit conditions:`, error);
  }
}

/**
 * Execute an exit trade with retry logic
 */
async function executeExitTrade(
  session: SessionContext,
  agent: any,
  exitPrice: number,
  reason: string
): Promise<void> {
  const config = getQuantAIConfig();
  const MAX_EXIT_RETRIES = 5;
  const RETRY_DELAY_MS = 2000; // 2 seconds between retries
  
  try {
    if (!agent?.pos) {
      return;
    }

    const position = agent.pos;
    
    // Initialize exit attempt tracking
    if (!position.exitAttempts) {
      position.exitAttempts = 0;
      position.firstExitAttemptTime = Date.now();
    }
    
    position.exitAttempts += 1;
    const attemptNumber = position.exitAttempts;
    
    // Log retry attempt if not first
    if (attemptNumber > 1) {
      const timeSinceFirst = Date.now() - position.firstExitAttemptTime;
      logger.warn(`[${session.sessionId}] Exit retry attempt ${attemptNumber}/${MAX_EXIT_RETRIES} (${(timeSinceFirst / 1000).toFixed(1)}s since first attempt)`);
    } else {
      logger.info(`[${session.sessionId}] Executing exit trade: ${reason}`);
    }

    const broker = await getBrokerForSession(session);
    if (!broker) {
      logger.error(`[${session.sessionId}] No broker available for exit (attempt ${attemptNumber})`);
      
      // Schedule retry if under max attempts
      if (attemptNumber < MAX_EXIT_RETRIES) {
        setTimeout(() => {
          executeExitTrade(session, agent, exitPrice, reason).catch(err => {
            logger.error(`[${session.sessionId}] Retry failed:`, err);
          });
        }, RETRY_DELAY_MS);
      } else {
        logger.error(`[${session.sessionId}] CRITICAL: Exit failed after ${MAX_EXIT_RETRIES} attempts. Position may be stuck!`);
      }
      return;
    }

    const exitSide = position.side === 'buy' ? 'sell' : 'buy';

    // BUG FIX: Fetch actual position quantity from database to avoid using stale agent.pos.qty
    // This fixes issues where exit uses wrong quantity due to partial fills or state desync
    let actualQty = position.qty;
    try {
      const dbPosition = await prisma.position.findFirst({
        where: { sessionId: session.sessionId },
        select: { qty: true },
      });
      if (dbPosition && dbPosition.qty !== null && dbPosition.qty > 0) {
        actualQty = dbPosition.qty;
        if (Math.abs(actualQty - position.qty) > 0.0001) {
          logger.warn(`[${session.sessionId}] Position qty mismatch: agent.pos=${position.qty}, db=${actualQty}, using db value`);
        }
      }
    } catch (error) {
      logger.warn(`[${session.sessionId}] Failed to fetch position from DB, using agent.pos.qty:`, error);
    }

    // Place exit order
    const order = await broker.place({
      symbol: session.symbol,
      side: exitSide,
      type: 'market',
      qty: actualQty,
      reduceOnly: true,
      clientOrderId: `${session.sessionId}-exit-${Date.now()}`,
    });

    logger.info(`[${session.sessionId}] Exit order placed: ${order.id} ${exitSide} ${position.qty} @ ${exitPrice}`);

    // Check if order was rejected
    if (order.status === 'rejected') {
      logger.error(`[${session.sessionId}] Exit order rejected (attempt ${attemptNumber})`);
      
      // Schedule retry if under max attempts
      if (attemptNumber < MAX_EXIT_RETRIES) {
        setTimeout(() => {
          executeExitTrade(session, agent, exitPrice, reason).catch(err => {
            logger.error(`[${session.sessionId}] Retry failed:`, err);
          });
        }, RETRY_DELAY_MS);
      } else {
        logger.error(`[${session.sessionId}] CRITICAL: Exit rejected after ${MAX_EXIT_RETRIES} attempts. Position may be stuck!`);
      }
      return;
    }

    // Calculate P&L
    const pnl = position.side === 'buy'
      ? (exitPrice - position.entry) * position.qty
      : (position.entry - exitPrice) * position.qty;

    logger.info(`[${session.sessionId}] Trade closed. P&L: ${pnl.toFixed(2)} USD`);

    // Persist exit order and update position in database
    try {
      // Calculate fee using Binance taker fee (market order = taker)
      const feeUsd = calculateFeeUsd({
        price: order.avgPrice ?? exitPrice,
        qty: order.filledQty ?? position.qty,
        side: exitSide,
        liquidity: 'taker', // Market orders are taker orders
        fees: {
          makerFeeBps: config.feesSlippage.makerFeeBps,
          takerFeeBps: config.feesSlippage.takerFeeBps,
        },
      });

      await recordExit({
        sessionId: session.sessionId,
        symbol: session.symbol,
        side: position.side,
        exitPrice: order.avgPrice ?? exitPrice,
        qty: order.filledQty ?? position.qty,
        realizedPnl: pnl,
        feeUsd,
        requestedPrice: exitPrice,
        requestedQty: position.qty,
        latencyMs: order.latencyMs,
        slippageBps: order.slippageBps,
        fillRatio: order.fillRatio,
        reason,
      });
      logger.info(`[${session.sessionId}] Exit persisted to database`);
    } catch (err) {
      logger.error(`[${session.sessionId}] Failed to persist exit:`, err);
      // Continue with position clearing even if persistence fails
    }

    // Register outcome
    if (position.signal) {
      await registerAdaptiveTradeOutcome({
        sessionId: session.sessionId,
        symbol: session.symbol,
        token: (position.signal as any).meta?.token || null,
        realizedPnlUsd: pnl,
        exitReason: reason as any,
        rawExitReason: reason,
        sideEffective: position.side === 'buy' ? 'long' : 'short',
      });
    }

    // Clear position - SUCCESS!
    agent.pos = null;
    logger.info(`[${session.sessionId}] Position cleared after ${attemptNumber} attempt(s)`);
    
    // 🛡️ SAFETY: Explicitly cancel any remaining protective orders (SL/TP)
    // The reconciliation loop might miss this if it skips closed positions
    try {
      if (broker.syncProtective) {
        logger.info(`[${session.sessionId}] Cleaning up protective orders for closed position`);
        await broker.syncProtective({
          symbol: session.symbol,
          side: position.side === 'buy' ? 'sell' : 'buy', // Side doesn't matter for cancellation
          qty: 0, // 0 qty signals to cancel all
        });
      }
    } catch (cleanupError) {
      logger.warn(`[${session.sessionId}] Failed to cleanup protective orders:`, cleanupError);
    }
    
    // POST-EXIT REVERSAL MONITORING: Watch for immediate reversals after stop-loss
    if (reason.includes('Stop loss hit') || reason.includes('stop_loss')) {
      logger.info(`[${session.sessionId}] Stop-loss exit detected - activating reversal monitoring`);
      
      // Store exit context for reversal detection
      agentMemoryStore.update('postExitMonitoring', session.sessionId, {
        exitPrice,
        exitTime: Date.now(),
        exitReason: reason,
        exitSide: position.side === 'buy' ? 'long' : 'short',
        monitorUntil: Date.now() + (10 * 60 * 1000), // Monitor for 10 minutes
      });
    }

  } catch (error) {
    logger.error(`[${session.sessionId}] Error executing exit trade (attempt ${agent?.pos?.exitAttempts || 1}):`, error);
    
    // Schedule retry if under max attempts and position still exists
    if (agent?.pos && agent.pos.exitAttempts < MAX_EXIT_RETRIES) {
      setTimeout(() => {
        executeExitTrade(session, agent, exitPrice, reason).catch(err => {
          logger.error(`[${session.sessionId}] Retry failed:`, err);
        });
      }, RETRY_DELAY_MS);
    } else if (agent?.pos) {
      logger.error(`[${session.sessionId}] CRITICAL: Exit failed after ${MAX_EXIT_RETRIES} attempts. Position may be stuck!`);
    }
  }
}

/**
 * Main orchestration function - called by event engine for each tick
 */
export async function processMetaAdaptiveTick(sessionId: string, symbol: string, tech: TechnicalSnapshot): Promise<void> {
  try {
    // Fetch session details
    const session = await prisma.agentSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        symbol: true,
        currentSymbol: true, // ✅ NEW: Use currentSymbol for active trading
        mode: true,
        startBalanceUsd: true,
        profileJson: true,
        userId: true,
      },
    });

    if (!session) {
      logger.warn(`[${sessionId}] Session not found in database`);
      return;
    }

    // 🛡️ SAFETY: Ensure we have a valid trading symbol
    const tradingSymbol = session.currentSymbol || session.symbol;
    if (!tradingSymbol) {
      logger.error(`[${sessionId}] No currentSymbol or symbol set - cannot process tick`);
      return;
    }

    // Store snapshot in AgentHub for diagnostics API
    const agent = AgentHub.get(sessionId);
    if (agent) {
      (agent as any).snap = tech;
      (agent as any).lastSnap = tech;
    }

    // Check if this is a meta-adaptive session (vs legacy agent type)
    // Meta-adaptive is the default now, so we process all sessions
    const sessionContext: SessionContext = {
      sessionId: session.id,
      symbol: tradingSymbol, // ✅ FIXED: Use currentSymbol instead of NULL symbol
      mode: session.mode as 'paper' | 'live',
      profileJson: session.profileJson || {},
      userId: session.userId,
    };

    await processSessionTick(sessionContext, tech);

  } catch (error) {
    logger.error(`[${sessionId}] Fatal error in meta-adaptive orchestrator:`, error);
  }
}

/**
 * Initialize meta-adaptive orchestrator
 */
export function initMetaAdaptiveOrchestrator(): void {
  logger.info('Meta-Adaptive Trading Orchestrator initialized');
}
