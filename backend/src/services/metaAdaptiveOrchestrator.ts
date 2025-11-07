/**
 * Meta-Adaptive Trading Orchestrator
 * 
 * Handles the execution loop for meta-adaptive agents:
 * 1. Fetches market data for active sessions
 * 2. Evaluates meta-adaptive signals
 * 3. Executes trades based on signals
 * 4. Logs all activities
 */

import { prisma } from '../db/client.js';
import { buildTechSnapshot, type TechnicalSnapshot } from '../ai/tech.js';
import { computeMultiTimeframeDiagnostics } from '../ai/multiTimeframe.js';
import { getMarketContext } from '../analytics/marketContext.js';
import { evaluateRecognizedStrategies, type RecognizedStrategySignal } from '../quantai/strategies/metaAdaptive/recognizedStrategies.js';
import { createLogger } from '../utils/logger.js';
import { AgentHub } from '../agent/hub.js';

const logger = createLogger('meta-adaptive');

type SessionContext = {
  sessionId: string;
  symbol: string;
  mode: 'paper' | 'live';
  profileJson: any;
  accountBalanceUsd: number | null;
};

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

          // TODO: Execute entry order using broker
          // This is where actual trade execution would happen
          // For now, we're just logging to confirm the orchestrator is working
        }
      } else {
        // Has position - evaluate exit signals
        const exitSignals = signals.filter(s => (s as any).isExit);
        if (exitSignals.length > 0) {
          logger.info(
            `[${session.sessionId}] Found ${exitSignals.length} exit signal(s) for existing position`
          );

          // TODO: Execute exit order using broker
        }
      }
    } else {
      logger.debug(`[${session.sessionId}] No signals generated for ${session.symbol}`);
    }

  } catch (error) {
    logger.error(`[${session.sessionId}] Error processing tick:`, error);
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
