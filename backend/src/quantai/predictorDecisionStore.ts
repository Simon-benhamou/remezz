/**
 * Store and track predictor decisions - only save when decision changes
 */

import { prisma } from '../db/client.js';

// In-memory cache of last decision per symbol
const lastDecisionCache = new Map<string, string>();

export interface PredictorDecisionData {
  symbol: string;
  decision: 'long' | 'short' | 'none';
  probabilityLong: number;
  probabilityShort: number;
  confidence: number;
  entryWeight?: number;
  riskMultiplier?: number;
  price: number;
}

/**
 * Store predictor decision if it has changed from previous
 * Returns true if decision was stored (changed), false if same as before
 */
export async function storePredictorDecisionIfChanged(data: PredictorDecisionData): Promise<boolean> {
  const { symbol, decision } = data;
  
  // Get last decision for this symbol
  const lastDecision = lastDecisionCache.get(symbol);
  
  // If decision hasn't changed, don't store
  if (lastDecision === decision) {
    return false;
  }
  
  // Decision changed - store it
  try {
    await prisma.predictorDecision.create({
      data: {
        symbol,
        decision,
        previousDecision: lastDecision || null,
        probabilityLong: data.probabilityLong,
        probabilityShort: data.probabilityShort,
        confidence: data.confidence,
        entryWeight: data.entryWeight ?? null,
        riskMultiplier: data.riskMultiplier ?? null,
        price: data.price,
      },
    });
    
    // Update cache
    lastDecisionCache.set(symbol, decision);
    
    console.log(`📊 [PredictorDecision] ${symbol}: ${lastDecision || 'initial'} → ${decision} (conf=${(data.confidence * 100).toFixed(1)}%)`);
    
    return true;
  } catch (error) {
    console.error(`[PredictorDecision] Failed to store decision for ${symbol}:`, error);
    return false;
  }
}

export function getCachedPredictorDecision(symbol: string): 'long' | 'short' | 'none' | null {
  return (lastDecisionCache.get(symbol) as 'long' | 'short' | 'none' | undefined) ?? null;
}

/**
 * Get last stored decision for a symbol (from DB)
 */
export async function getLastPredictorDecision(symbol: string) {
  try {
    const last = await prisma.predictorDecision.findFirst({
      where: { symbol },
      orderBy: { createdAt: 'desc' },
    });
    
    // Update cache
    if (last) {
      lastDecisionCache.set(symbol, last.decision);
    }
    
    return last;
  } catch (error) {
    console.error(`[PredictorDecision] Failed to get last decision for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get decision history for a symbol
 */
export async function getPredictorDecisionHistory(
  symbol: string,
  limit = 50,
  fromDate?: Date
) {
  try {
    return await prisma.predictorDecision.findMany({
      where: {
        symbol,
        ...(fromDate && { createdAt: { gte: fromDate } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  } catch (error) {
    console.error(`[PredictorDecision] Failed to get history for ${symbol}:`, error);
    return [];
  }
}

/**
 * Initialize cache from DB on startup
 */
export async function initializePredictorDecisionCache() {
  try {
    // Get last decision for each symbol
    const symbols = await prisma.predictorDecision.findMany({
      distinct: ['symbol'],
      select: { symbol: true },
    });
    
    for (const { symbol } of symbols) {
      const last = await prisma.predictorDecision.findFirst({
        where: { symbol },
        orderBy: { createdAt: 'desc' },
      });
      
      if (last) {
        lastDecisionCache.set(symbol, last.decision);
      }
    }
    
    console.log(`✅ [PredictorDecision] Cache initialized with ${lastDecisionCache.size} symbols`);
  } catch (error) {
    console.error('[PredictorDecision] Failed to initialize cache:', error);
  }
}

/**
 * Clean old decisions (optional cleanup job)
 */
export async function cleanOldPredictorDecisions(olderThanDays = 30) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    const result = await prisma.predictorDecision.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
      },
    });
    
    console.log(`🧹 [PredictorDecision] Cleaned ${result.count} old decisions (older than ${olderThanDays} days)`);
    return result.count;
  } catch (error) {
    console.error('[PredictorDecision] Failed to clean old decisions:', error);
    return 0;
  }
}
