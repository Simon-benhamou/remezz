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
import { PositionSizer } from '../quantai/risk/positionSizing.js';
import { getQuantAIConfig } from '../quantai/config.js';
import { createLogger } from '../utils/logger.js';
import { createIntegrationLogger, withLogging, withRetry } from '../utils/integrationLogger.js';
import { logTradeEvaluation, type RegimeContext } from '../learning/tradeEvaluationLogger.js';
import { AgentHub } from '../agent/hub.js';
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

const logger = createLogger('meta-adaptive');

// Track brokers per session to avoid recreating them
const sessionBrokers = new Map<string, Broker>();

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
async function calculateCapitalUsageAndThresholds(mode: 'paper' | 'live'): Promise<{
  totalCapital: number;
  usedCapital: number;
  freeCapital: number;
  usageRatio: number;
  minConfidenceRequired: number;
  maxAllocationPerPosition: number;
  maxPositions: number;
}> {
  const capitalManager = getCapitalManager(mode);
  const snapshot = await capitalManager.getBalance();
  
  const totalCapital = snapshot.totalUSD.toNumber();
  const freeCapital = snapshot.freeUSD.toNumber();
  const usedCapital = totalCapital - freeCapital;
  const usageRatio = totalCapital > 0 ? usedCapital / totalCapital : 0;
  
  // Adaptive allocation based on capital size
  let maxAllocationPerPosition: number;
  let maxPositions: number;
  let minConfidenceRequired: number;
  
  if (totalCapital < 200) {
    // Small account: 1 big position (80-100%)
    maxAllocationPerPosition = totalCapital * 0.90; // Use 90% for the single position
    maxPositions = 1;
    minConfidenceRequired = 0.50; // Normal threshold
  } else if (totalCapital < 1000) {
    // Medium account: 2-3 positions (40-50% each)
    maxAllocationPerPosition = totalCapital * 0.45;
    maxPositions = 2;
    // Progressive threshold for 2nd position
    minConfidenceRequired = usageRatio < 0.50 ? 0.50 : 0.65;
  } else {
    // Large account: Dynamic position limit based on available capital
    // Instead of fixed 5 positions at 20%, allow more smaller positions
    // Minimum position size: $100 (ensures orderability)
    // Maximum single position: 20% of total capital
    const minPositionSize = 100;
    const maxSinglePositionPct = 0.20;
    
    maxAllocationPerPosition = totalCapital * maxSinglePositionPct;
    
    // Calculate max positions based on free capital, not total capital
    // This allows more positions if they're smaller than the max allocation
    if (freeCapital >= minPositionSize) {
      maxPositions = Math.floor(freeCapital / minPositionSize);
    } else {
      maxPositions = Math.floor(totalCapital / minPositionSize);
    }
    
    // Cap at 10 positions maximum to avoid over-diversification
    maxPositions = Math.min(10, Math.max(1, maxPositions));
    
    // Progressive threshold: higher confidence required as capital usage increases
    // 0-60% used: normal threshold (0.50)
    // 60-80% used: moderate threshold (0.60)
    // 80%+ used: high threshold (0.70)
    if (usageRatio < 0.60) {
      minConfidenceRequired = 0.50;
    } else if (usageRatio < 0.80) {
      minConfidenceRequired = 0.60;
    } else {
      minConfidenceRequired = 0.70;
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
    const capital = getCapitalManager('paper');
    broker = new CapitalPoolBroker({
      agentId: session.sessionId,
      mode: 'paper',
      capital,
      broker: base,
      minOrderUsd: capitalConfig.minOrderUSD,
    });
  } else if (session.mode === 'live' && session.userId) {
    const base = new LiveBroker(session.userId);
    const capital = getCapitalManager('live');
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
          strategy: (s as any).strategyId,
          bias: s.bias,
          score: s.meta?.score,
          confidence: (s.meta as any)?.confidence
        }))
      );

      // Check for existing position from DATABASE, not just agent memory
      // This prevents ghost position bugs when agent stub persists across restarts
      const dbPosition = await prisma.position.findFirst({
        where: {
          sessionId: session.sessionId,
        },
      });
      const hasPosition = dbPosition !== null;

      if (!hasPosition) {
        // No position - evaluate entry signals
        const entrySignals = signals.filter(s => !(s as any).isExit);
        if (entrySignals.length > 0) {
          const bestSignal = entrySignals[0]; // Already sorted by score
          logger.info(
            `[${session.sessionId}] Best entry signal: ${(bestSignal as any).strategyId} (${bestSignal.bias}) score=${bestSignal.meta?.score}`
          );

          console.log(`[MetaOrchestrator] Calling executeEntryTrade for agent=${session.sessionId}, symbol=${session.symbol}, bias=${bestSignal.bias}`);
          await executeEntryTrade(session, bestSignal, tech);
        }
      } else {
        // Has position - check for counter-signals and possible position flip
        const entrySignals = signals.filter(s => !(s as any).isExit);
        
        // Get current position details from agent
        const agent = AgentHub.get(session.sessionId) as any;
        const currentPositionSide = agent?.pos?.side === 'buy' ? 'long' : 'short';
        
        let flipResult: { flip: boolean; reason: string } | null = null;
        
        if (entrySignals.length > 0) {
          const bestSignal = entrySignals[0];
          
          // Check if this is a counter-signal (opposite direction)
          const isCounterSignal = 
            (currentPositionSide === 'long' && bestSignal.bias === 'short') ||
            (currentPositionSide === 'short' && bestSignal.bias === 'long');
          
          if (isCounterSignal) {
            logger.info(
              `[${session.sessionId}] Counter-signal detected: current=${currentPositionSide}, signal=${bestSignal.bias}, confidence=${bestSignal.confidence.toFixed(2)}`
            );
            
            // Check if we should flip the position
            flipResult = await shouldFlipPosition(session, agent, bestSignal, tech);
            
            if (flipResult.flip) {
              logger.info(`[${session.sessionId}] Position flip conditions met: ${flipResult.reason}`);
              await executePositionFlip(session, agent, bestSignal, tech);
              return; // Exit early - flip handled the position
            } else {
              logger.debug(`[${session.sessionId}] Position flip rejected: ${flipResult.reason}`);
            }
          } else {
            logger.info(`[${session.sessionId}] Entry signal blocked - existing position present`);
          }
          
          // Log that order was blocked due to existing position (unless we just flipped)
          await logTradeEvaluation({
            symbol: session.symbol,
            decision: 'order_blocked_capital',
            blockedReason: flipResult 
              ? `counter_signal_flip_rejected: ${flipResult.reason}`
              : 'existing_position_present',
            confidenceScore: bestSignal.confidence,
            inputMetrics: {
              adx: tech.adx14,
              atrPct: (tech.atr14 / tech.last) * 100,
              cmf: (tech as any).cmf20,
              rsi14: tech.rsi14,
              volumeRatio: (tech as any).volumeRatio,
            },
            regimeContext: calculateRegimeContext(tech),
          }).catch(err => console.warn('Failed to log existing position block:', err));
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

  try {
    integrationLogger.info(`Executing entry trade | bias=${signal.bias} strategy=${(signal as any).strategyId || signal.id} confidence=${signal.confidence.toFixed(3)}`);
    console.log(`[MetaOrchestrator.executeEntryTrade] START: agent=${session.sessionId}, symbol=${session.symbol}, bias=${signal.bias}`);

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
    const stopDistance = (tech.atr14 || tech.last * DEFAULT_ATR_PCT) * (config.exits.slAtrMult || 2); // Use ATR-based stop
    
    // Get risk percentage from profile or use default
    const riskPct = session.profileJson?.riskPerTradePct ?? config.risk.baseRiskPerTradePct;
    
    // Check capital usage and determine confidence threshold
    const capitalMetrics = await calculateCapitalUsageAndThresholds(session.mode);
    
    integrationLogger.info(`Capital usage | total=$${capitalMetrics.totalCapital.toFixed(0)} used=$${capitalMetrics.usedCapital.toFixed(0)} free=$${capitalMetrics.freeCapital.toFixed(0)} ratio=${(capitalMetrics.usageRatio * 100).toFixed(1)}% maxPos=${capitalMetrics.maxPositions} minConf=${capitalMetrics.minConfidenceRequired}`);
    
    // Progressive confidence check: reject if below threshold
    if (signal.confidence < capitalMetrics.minConfidenceRequired) {
      integrationLogger.warn(`⚠️ Trade rejected: confidence ${signal.confidence.toFixed(3)} below threshold ${capitalMetrics.minConfidenceRequired} (capital usage: ${(capitalMetrics.usageRatio * 100).toFixed(1)}%)`);
      
      await logTradeEvaluation({
        symbol: session.symbol,
        decision: 'order_blocked_capital',
        blockedReason: `confidence ${signal.confidence.toFixed(3)} < required ${capitalMetrics.minConfidenceRequired} (capital ${(capitalMetrics.usageRatio * 100).toFixed(1)}% used)`,
        confidenceScore: signal.confidence,
        inputMetrics: {
          capitalUsageRatio: capitalMetrics.usageRatio,
          minConfidenceRequired: capitalMetrics.minConfidenceRequired,
        },
      });
      
      return;
    }
    
    // Limit position size to max allocation
    const maxPositionMargin = Math.min(equityUsd, capitalMetrics.maxAllocationPerPosition);
    
    integrationLogger.info(`Position sizing | equity=$${equityUsd.toFixed(0)} maxAllocation=$${maxPositionMargin.toFixed(0)} (${((capitalMetrics.maxAllocationPerPosition / capitalMetrics.totalCapital) * 100).toFixed(0)}% for ${capitalMetrics.maxPositions} max positions)`);
    
    // Dynamic leverage based on confidence: high confidence = higher leverage
    // confidence range: 0.50-1.0 (filters block below 0.50)
    // leverage range: baseLeverage (e.g., 3x) to maxLeverage (e.g., 10x)
    const maxLeverage = session.profileJson?.maxLeverage ?? envConfig.DEFAULT_MAX_LEVERAGE;
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
    });
    
    const qty = entryPrice > 0 ? sizingResult.notional / entryPrice : 0;
    const leverage = sizingResult.leverageCap.resolved;

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
        symbol: session.symbol,
        decision: 'order_blocked_sizing',
        blockedReason: `qty=0: equity=${equityUsd.toFixed(2)}, stop=${stopDistance.toFixed(4)}, entry=${entryPrice.toFixed(4)}, leverage=${leverage}x`,
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
        regimeContext: calculateRegimeContext(tech),
      }).catch(err => console.warn('Failed to log sizing block:', err));
      
      return;
    }

    integrationLogger.info(`Position sized | qty=${qty.toFixed(8)} notional=${sizingResult.notional.toFixed(2)} entryPrice=${entryPrice.toFixed(4)} stopDistance=${stopDistance.toFixed(4)} leverage=${leverage}x`);
    console.log(`[MetaOrchestrator.executeEntryTrade] Sizing: qty=${qty.toFixed(8)}, notional=${sizingResult.notional.toFixed(2)}, entryPrice=${entryPrice.toFixed(4)}, stopDist=${stopDistance.toFixed(4)}, leverage=${leverage}x`);

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
        symbol: session.symbol,
        decision: 'filter_blocked',  // Changed from order_blocked_registration
        blockedReason: registrationResult === 'predictor_blocked' ? 'predictor_confidence_too_low' : 'cooldown_active',
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
        regimeContext: calculateRegimeContext(tech),
      }).catch(err => console.warn('Failed to log registration block:', err));
      
      return;
    }

    console.log(`[MetaOrchestrator.executeEntryTrade] Registration OK, placing order...`);

    // Place the actual order via broker
    const side = signal.bias === 'short' ? 'sell' : 'buy';
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
            adx: tech.adx14,
            rsi14: tech.rsi14,
            cmf: (tech as any).cmf20,
            atrPct: (tech.atr14 / tech.last) * 100,
            volumeRatio: (tech as any).volumeRatio,
          },
          regimeContext: calculateRegimeContext(tech),
        },
      }),
      3,
      500
    );

    console.log(`[MetaOrchestrator.executeEntryTrade] Order placed! id=${order.id}, status=${order.status}, filledQty=${order.filledQty}`);

    // Log successful order placement
    if (order.status !== 'rejected') {
      await logTradeEvaluation({
        symbol: session.symbol,
        decision: 'order_placed',
        blockedReason: undefined,
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
        regimeContext: calculateRegimeContext(tech),
      }).catch(err => console.warn('Failed to log order placement:', err));

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
        });
        console.log(`[MetaOrchestrator.executeEntryTrade] Position persisted to database`);
      } catch (err) {
        console.error(`[MetaOrchestrator.executeEntryTrade] Failed to persist position:`, err);
      }
    } else {
      // Order was rejected by broker
      await logTradeEvaluation({
        symbol: session.symbol,
        decision: 'order_rejected',
        blockedReason: (order as any).error || 'broker_rejected',
        confidenceScore: signal.confidence,
        inputMetrics: {
          adx: tech.adx14,
          atrPct: (tech.atr14 / tech.last) * 100,
          cmf: (tech as any).cmf20,
          rsi14: tech.rsi14,
          volumeRatio: (tech as any).volumeRatio,
        },
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
      agent.pos = {
        side,
        qty,
        entry: entryPrice,
        stop: stopPrice,
        signal,
        openedAt: Date.now(),
        peakPrice: entryPrice, // Initialize peak price at entry
        initialStopDistance: stopDistance, // Store original stop distance for R-multiple calculations
      };
    }

  } catch (error: any) {
    integrationLogger.error('Error executing entry trade', error);
    console.log(`[MetaOrchestrator.executeEntryTrade] EXCEPTION: ${error.message}`);
    
    // Log the exception as an order rejection
    await logTradeEvaluation({
      symbol: session.symbol,
      decision: 'order_rejected',
      blockedReason: `exception: ${error.message || 'unknown error'}`,
      confidenceScore: signal.confidence,
      inputMetrics: {
        adx: tech.adx14,
        rsi14: tech.rsi14,
        cmf: (tech as any).cmf20,
        atrPct: (tech.atr14 / tech.last) * 100,
        volumeRatio: (tech as any).volumeRatio,
      },
      regimeContext: calculateRegimeContext(tech),
    }).catch(err => console.warn('Failed to log exception:', err));
  }
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
  
  // Calculate current R-multiple
  const position = agent.pos;
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
  try {
    if (!agent?.pos) {
      return;
    }

    const currentPrice = tech.last;
    const position = agent.pos;

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
    const MS_PER_MINUTE = 60000;
    const minutesOpen = position.openedAt ? (Date.now() - position.openedAt) / MS_PER_MINUTE : 0;
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

    // Place exit order
    const order = await broker.place({
      symbol: session.symbol,
      side: exitSide,
      type: 'market',
      qty: position.qty,
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
      symbol: session.symbol,
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
