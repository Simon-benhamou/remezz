/**
 * Trade Evaluation Logging Service
 * Records trade decisions and their context for learning
 */

import { prisma } from '../db/client.js';
import { Prisma } from '@prisma/client';

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
  [key: string]: number | undefined;
};

export type MarketOutcome = {
  pnl_15m?: number;
  pnl_1h?: number;
  max_favorable_excursion_1h?: number;
  max_adverse_excursion_1h?: number;
};

export type TradeEvaluationParams = {
  symbol: string;
  decision: 'executed' | 'blocked';
  blockedReason?: string;
  confidenceScore: number;
  inputMetrics: InputMetrics;
};

/**
 * Log a trade evaluation with its context
 */
export async function logTradeEvaluation(params: TradeEvaluationParams): Promise<string | null> {
  try {
    const record = await prisma.tradeEvaluation.create({
      data: {
        symbol: params.symbol,
        decision: params.decision,
        blockedReason: params.blockedReason || null,
        confidenceScore: params.confidenceScore,
        inputMetrics: params.inputMetrics as any,
        marketOutcome: Prisma.JsonNull,
        updatedAt: new Date(),
      },
      select: { id: true },
    });
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
      marketOutcome: { equals: Prisma.DbNull },
      timestamp: {
        lte: new Date(Date.now() - 60 * 60 * 1000), // At least 1 hour old
      },
    },
    orderBy: { timestamp: 'asc' },
    take: limit,
  });
}

/**
 * Get historical evaluations for a symbol
 */
export async function getSymbolEvaluations(symbol: string, limit = 1000) {
  return prisma.tradeEvaluation.findMany({
    where: {
      symbol,
      marketOutcome: { not: Prisma.DbNull },
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
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
