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
import { buildTechSnapshot, type TechnicalSnapshot } from '../ai/tech.js';
import { computeMultiTimeframeDiagnostics } from '../ai/multiTimeframe.js';
import { getMarketContext } from '../analytics/marketContext.js';
import {
  evaluateRecognizedStrategies,
  registerAdaptiveTradeEntry,
  registerAdaptiveTradeOutcome,
  type RecognizedStrategySignal
} from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';
import { maybeAdjustOrExit, type ExitDirective } from '../quantai/strategies/metaAdaptive/exitManager.js';
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

const logger = createLogger('meta-adaptive');

// Track brokers per session to avoid recreating them
const sessionBrokers = new Map<string, Broker>();

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
  accountBalanceUsd: number | null;
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
    const base = new PaperBroker(session.accountBalanceUsd ?? undefined);
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
      accountBalanceUsd: session.accountBalanceUsd,
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

      // Get the agent to check current position state
      const agent = AgentHub.get(session.sessionId) as any;
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
        // Has position - log that entry signal was blocked by existing position
        const entrySignals = signals.filter(s => !(s as any).isExit);
        if (entrySignals.length > 0) {
          const bestSignal = entrySignals[0];
          logger.info(`[${session.sessionId}] Entry signal blocked - existing position present`);
          
          // Log that order was blocked due to existing position
          await logTradeEvaluation({
            symbol: session.symbol,
            decision: 'order_blocked_capital',
            blockedReason: 'existing_position_present',
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
        
        // Check if we should exit
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

    // Get account balance for position sizing
    const balance = await withLogging(
      integrationLogger,
      'fetch broker balance',
      () => broker.balance()
    );
    
    const equityUsd = balance.equityUsd || session.accountBalanceUsd || 1000;
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
    
    // Get requested leverage from profile or use DEFAULT_MAX_LEVERAGE
    const requestedLeverage = session.profileJson?.maxLeverage ?? envConfig.DEFAULT_MAX_LEVERAGE;
    
    // Use computeQtyNotional which respects leverage caps per symbol category
    const sizingResult = await computeQtyNotional({
      balanceUsd: equityUsd,
      riskPct,
      stopDistanceAbs: stopDistance,
      entryPrice,
      requestedLeverage,
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
        requestedLeverage,
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
 * Execute an exit trade
 */
async function executeExitTrade(
  session: SessionContext,
  agent: any,
  exitPrice: number,
  reason: string
): Promise<void> {
  try {
    if (!agent?.pos) {
      return;
    }

    logger.info(`[${session.sessionId}] Executing exit trade: ${reason}`);

    const broker = await getBrokerForSession(session);
    if (!broker) {
      logger.error(`[${session.sessionId}] No broker available for exit`);
      return;
    }

    const position = agent.pos;
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

    // Calculate P&L
    const pnl = position.side === 'buy'
      ? (exitPrice - position.entry) * position.qty
      : (position.entry - exitPrice) * position.qty;

    logger.info(`[${session.sessionId}] Trade closed. P&L: ${pnl.toFixed(2)} USD`);

    // Persist exit order and update position in database
    if (order.status !== 'rejected') {
      try {
        await recordExit({
          sessionId: session.sessionId,
          symbol: session.symbol,
          side: position.side,
          exitPrice: order.avgPrice ?? exitPrice,
          qty: order.filledQty ?? position.qty,
          realizedPnl: pnl,
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
      }
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

    // Clear position
    agent.pos = null;

  } catch (error) {
    logger.error(`[${session.sessionId}] Error executing exit trade:`, error);
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

    // Check if this is a meta-adaptive session (vs legacy agent type)
    // Meta-adaptive is the default now, so we process all sessions
    const sessionContext: SessionContext = {
      sessionId: session.id,
      symbol: session.symbol,
      mode: session.mode as 'paper' | 'live',
      profileJson: session.profileJson || {},
      accountBalanceUsd: session.startBalanceUsd,
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
