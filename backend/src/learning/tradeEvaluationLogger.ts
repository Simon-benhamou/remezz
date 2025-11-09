/**
 * Trade Evaluation Logging Service
 * Records trade decisions and their context for learning
 */

import { prisma, Prisma } from '../db/client.js';

// Time constants
const OUTCOME_WAIT_MS = 60 * 60 * 1000; // 1 hour in milliseconds
const DEDUP_WINDOW_MS = 60 * 1000; // 1 minute - prevent duplicate evaluations within this window

// In-memory cache to prevent duplicate evaluations
const recentEvaluations = new Map<string, number>(); // symbol -> last evaluation timestamp

export type InputMetrics = {
  adx?: number;
  cmf?: number;
  atrPct?: number;
  slope?: number;
  trendStrength?: number;
  ema20?: number;
  ema50?: number;
  ema100?: number;
  ema200?: number;
  rsi14?: number;
  volumeRatio?: number;
  volume?: number;
  volumeMA?: number;
  volumeZScore?: number;
  [key: string]: number | undefined;
};

export type MarketOutcome = {
  pnl_15m?: number;
  pnl_1h?: number;
  max_favorable_excursion_1h?: number;
  max_adverse_excursion_1h?: number;
};

export type RegimeContext = {
  volatilityRegime?: 'low' | 'medium' | 'high';
  directionBias?: 'long' | 'short' | 'neutral';
  volumeRegime?: 'low' | 'normal' | 'high';
  trendingRanging?: 'trending' | 'ranging';
  parameterSource?: string; // Which regime parameters were used (e.g., 'high_volatility', 'default')
};

export type TradeEvaluationParams = {
  symbol: string;
  /**
   * Decision outcome tracking the full execution flow:
   * 
   * FILTER STAGE (Analysis & Signal Quality):
   * - 'filter_passed': Entry filters PASSED (ADX, confidence, volatility, predictor, cooldown all OK)
   * - 'filter_blocked': Entry filters FAILED (insufficient signal quality, predictor confidence too low, cooldown active, etc.)
   * 
   * EXECUTION STAGE (Technical & Operational - only reached if filters passed):
   * - 'order_placed': Order successfully placed on exchange (ACTUAL TRADE ✅)
   * - 'order_blocked_capital': Capital reservation failed (pool exhausted, symbol cap exceeded)
   * - 'order_blocked_sizing': Position sizing returned qty=0 (stop too wide, equity too low)
   * - 'order_rejected': Broker rejected order (exchange error, rate limit, insufficient balance)
   * 
   * NOTE: Predictor confidence and cooldown are ANALYSIS FILTERS (filter_blocked), not execution blocks.
   * They evaluate signal quality like ADX/CMF/trend strength.
   */
  decision: 'filter_passed' | 'filter_blocked' | 'order_placed' | 'order_blocked_capital' | 'order_blocked_sizing' | 'order_rejected';
  /**
   * Reason why entry filters blocked the signal (required when decision='filter_blocked')
   * Examples: 'adx_below_trend_threshold', 'weak_trend_structure', 'confidence_too_low', 
   *           'predictor_confidence_too_low', 'cooldown_active'
   */
  blockedReason?: string;
  confidenceScore: number;
  inputMetrics: InputMetrics;
  regimeContext?: RegimeContext; // NEW: Track which regime parameters were used
};

/**
 * Log a trade evaluation with its context
 * Includes deduplication to prevent logging the same decision multiple times within a short window
 */
export async function logTradeEvaluation(params: TradeEvaluationParams): Promise<string | null> {
  try {
    const now = Date.now();
    const lastEvalTime = recentEvaluations.get(params.symbol);
    
    // Check if we recently logged an evaluation for this symbol
    if (lastEvalTime && (now - lastEvalTime) < DEDUP_WINDOW_MS) {
      // Skip this evaluation to avoid duplicates
      return null;
    }
    
    // Update the cache
    recentEvaluations.set(params.symbol, now);
    
    // Clean up old entries from cache (keep only last 5 minutes worth)
    for (const [symbol, timestamp] of recentEvaluations.entries()) {
      if (now - timestamp > 5 * 60 * 1000) {
        recentEvaluations.delete(symbol);
      }
    }
    
    const record = await prisma.tradeEvaluation.create({
      data: {
        symbol: params.symbol,
        decision: params.decision,
        blockedReason: params.blockedReason || null,
        confidenceScore: params.confidenceScore,
        inputMetrics: params.inputMetrics as any,
        regimeContext: params.regimeContext as any, // NEW: Store regime context for traceability
        marketOutcome: Prisma.JsonNull,
        updatedAt: new Date(),
      },
      select: { id: true },
    });
    
    // Log parameter traceability for debugging
    if (params.regimeContext?.parameterSource) {
      console.log(`[TRACE] ${params.symbol} decision=${params.decision} regime=${params.regimeContext.parameterSource} confidence=${params.confidenceScore.toFixed(4)}`);
    }
    
    return record.id;
  } catch (error) {
    console.warn('Failed to log trade evaluation:', error);
    return null;
  }
}

/**
 * Update the market outcome for a trade evaluation
 */
export async function updateTradeOutcome(
  evaluationId: string,
  outcome: MarketOutcome,
): Promise<boolean> {
  try {
    await prisma.tradeEvaluation.update({
      where: { id: evaluationId },
      data: {
        marketOutcome: outcome as any,
        updatedAt: new Date(),
      },
    });
    return true;
  } catch (error) {
    console.warn('Failed to update trade outcome:', error);
    return false;
  }
}

/**
 * Get evaluations that need market outcome updates
 */
export async function getEvaluationsPendingOutcome(limit = 100) {
  return prisma.tradeEvaluation.findMany({
    where: {
      marketOutcome: { equals: Prisma.JsonNull },
      timestamp: {
        lte: new Date(Date.now() - OUTCOME_WAIT_MS),
      },
    },
    orderBy: { timestamp: 'asc' },
    take: limit,
  });
}

/**
 * Get historical evaluations for a symbol
 * Uses SQL to properly filter non-null market outcomes
 * 
 * Includes ALL evaluations (filter_passed AND filter_blocked) because:
 * - filter_blocked signals may have been profitable → missed opportunities
 * - Optimizer tests different thresholds to find optimal balance
 * - Need to learn if filters were too restrictive or too lenient
 */
export async function getSymbolEvaluations(symbol: string, limit = 1000) {
  // Use raw SQL to properly handle JSONB null vs SQL NULL
  return prisma.$queryRaw<Array<{
    id: string;
    symbol: string;
    timestamp: Date;
    decision: string;
    blockedReason: string | null;
    confidenceScore: number;
    inputMetrics: any;
    regimeContext: any;
    marketOutcome: any;
    createdAt: Date;
    updatedAt: Date;
  }>>`
    SELECT *
    FROM "TradeEvaluation"
    WHERE symbol = ${symbol}
      AND "marketOutcome" IS NOT NULL
      AND "marketOutcome" != 'null'::jsonb
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;
}

/**
 * Prune old evaluations to keep database size manageable
 */
export async function pruneOldEvaluations(daysToKeep = 90): Promise<number> {
  try {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);
    const result = await prisma.tradeEvaluation.deleteMany({
      where: {
        timestamp: { lt: cutoffDate },
      },
    });
    return result.count;
  } catch (error) {
    console.warn('Failed to prune old evaluations:', error);
    return 0;
  }
}
