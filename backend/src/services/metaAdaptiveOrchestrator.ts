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
import { AgentHub } from '../agent/hub.js';
import type { Broker } from '../broker/types.js';
import { PaperBroker } from '../broker/paper.js';
import { LiveBroker } from '../broker/live.js';
import { CapitalPoolBroker } from '../broker/capitalPoolBroker.js';
import { getCapitalManager } from '../services/capitalPool.js';
import { capitalConfig } from '../config/capital.js';

const logger = createLogger('meta-adaptive');

// Track brokers per session to avoid recreating them
const sessionBrokers = new Map<string, Broker>();

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
    const signals: RecognizedStrategySignal[] = evaluateRecognizedStrategies(tech, {
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
      const hasPosition = agent?.pos && agent.pos.qty > 0;

      if (!hasPosition) {
        // No position - evaluate entry signals
        const entrySignals = signals.filter(s => !(s as any).isExit);
        if (entrySignals.length > 0) {
          const bestSignal = entrySignals[0]; // Already sorted by score
          logger.info(
            `[${session.sessionId}] Best entry signal: ${(bestSignal as any).strategyId} (${bestSignal.bias}) score=${bestSignal.meta?.score}`
          );

          await executeEntryTrade(session, bestSignal, tech);
        }
      } else {
        // Has position - check if we should exit
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
  try {
    logger.info(`[${session.sessionId}] Executing entry trade for ${signal.bias} signal`);

    // Get broker
    const broker = await getBrokerForSession(session);
    if (!broker) {
      logger.error(`[${session.sessionId}] No broker available for session`);
      return;
    }

    // Get account balance for position sizing
    const balance = await broker.balance();
    const equityUsd = balance.equityUsd || session.accountBalanceUsd || 1000;

    // Calculate position size using PositionSizer
    const config = getQuantAIConfig();
    const sizer = new PositionSizer(equityUsd, config.risk);
    
    const entryPrice = tech.last;
    const stopDistance = signal.meta?.stopDistance || (tech.last * 0.01); // 1% default
    
    const sizing = sizer.calculatePosition({
      symbol: session.symbol,
      side: signal.bias === 'short' ? 'short' : 'long',
      entryPrice,
      stopDistance,
      leverage: signal.meta?.leverage || config.risk.maxLeverage || 5,
    });

    if (!sizing || sizing.qty <= 0) {
      logger.warn(`[${session.sessionId}] Position sizing resulted in 0 quantity`);
      return;
    }

    // Register the trade entry with meta-adaptive system
    const registrationResult = await registerAdaptiveTradeEntry({
      sessionId: session.sessionId,
      symbol: session.symbol,
      signal,
      qty: sizing.qty,
      entryPrice,
      stopDistance,
    });

    if (registrationResult === 'skipped' || registrationResult === 'predictor_blocked') {
      logger.info(`[${session.sessionId}] Trade registration ${registrationResult}`);
      return;
    }

    // Place the actual order via broker
    const side = signal.bias === 'short' ? 'sell' : 'buy';
    const stopPrice = signal.bias === 'short'
      ? entryPrice + stopDistance
      : entryPrice - stopDistance;

    const order = await broker.place({
      symbol: session.symbol,
      side,
      type: 'market',
      qty: sizing.qty,
      leverage: sizing.leverage,
      stopLoss: stopPrice,
      clientOrderId: `${session.sessionId}-entry-${Date.now()}`,
    });

    logger.info(`[${session.sessionId}] Entry order placed: ${order.id} ${side} ${sizing.qty} @ ${entryPrice}`);

    // Update agent position state
    const agent = AgentHub.get(session.sessionId) as any;
    if (agent) {
      agent.pos = {
        side,
        qty: sizing.qty,
        entry: entryPrice,
        stop: stopPrice,
        signal,
        openedAt: Date.now(),
      };
    }

  } catch (error) {
    logger.error(`[${session.sessionId}] Error executing entry trade:`, error);
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
    const exitDirective = maybeAdjustOrExit({
      side: position.side === 'sell' ? 'short' : 'long',
      entryPrice: position.entry,
      currentPrice,
      stop: position.stop,
      targets: position.targets || [],
      openedAt: position.openedAt,
      atr: tech.atr14 || (tech.last * 0.01),
      config: config.exits,
    });

    if (exitDirective?.action === 'exit' || exitDirective?.action === 'close') {
      logger.info(`[${session.sessionId}] Exit signal: ${exitDirective.reason}`);
      await executeExitTrade(session, agent, currentPrice, exitDirective.reason);
    } else if (exitDirective?.action === 'adjust_stop' && exitDirective.newStop) {
      logger.info(`[${session.sessionId}] Adjusting stop from ${position.stop} to ${exitDirective.newStop}`);
      position.stop = exitDirective.newStop;
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

    // Register outcome
    if (position.signal) {
      await registerAdaptiveTradeOutcome({
        sessionId: session.sessionId,
        symbol: session.symbol,
        strategyId: (position.signal as any).strategyId || (position.signal as any).id,
        side: position.side === 'buy' ? 'long' : 'short',
        entryPrice: position.entry,
        exitPrice,
        qty: position.qty,
        pnlUsd: pnl,
        reason,
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
