/**
 * Trade Evaluation Logger - Stub
 * Removed complex learning, this is a minimal stub
 */

import { prisma } from "../db/client.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tradeEvalLogger");

export interface TradeOutcome {
  tradeId: string;
  symbol: string;
  pnl: number;
  entryPrice: number;
  exitPrice: number;
  duration: number;
  timestamp: Date;
}

/**
 * Log a trade outcome (simplified - just logs to console)
 */
export async function logTradeOutcome(outcome: TradeOutcome): Promise<void> {
  logger.info("Trade outcome logged", {
    tradeId: outcome.tradeId,
    symbol: outcome.symbol,
    pnl: outcome.pnl,
    duration: outcome.duration,
  });
}

/**
 * Log a trade evaluation (stub for compatibility)
 */
export async function logTradeEvaluation(_data: any): Promise<void> {
  // No-op - learning removed
}

/**
 * Get recent trade outcomes
 */
export async function getRecentOutcomes(limit = 100): Promise<TradeOutcome[]> {
  const fills = await prisma.fill.findMany({
    take: limit,
    orderBy: { ts: "desc" },
    select: {
      id: true,
      symbol: true,
      realizedPnl: true,
      price: true,
      ts: true,
    },
  });

  return fills.map((f) => ({
    tradeId: f.id,
    symbol: f.symbol ?? "UNKNOWN",
    pnl: f.realizedPnl ?? 0,
    entryPrice: f.price ?? 0,
    exitPrice: f.price ?? 0,
    duration: 0,
    timestamp: f.ts,
  }));
}

/**
 * Empty personality logging (removed complex learning)
 */
export async function logPersonalityDecision(_data: any): Promise<void> {
  // No-op - learning removed
}
