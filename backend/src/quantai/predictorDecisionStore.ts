/**
 * Store and track predictor decisions - only save when decision changes
 */

import { prisma } from '../db/client.js';

// In-memory cache of last decision per symbol
const lastDecisionCache = new Map<string, string>();
// Track last confidence to detect significant changes
const lastConfidenceCache = new Map<string, number>();
// Track last update timestamp to force periodic updates
const lastUpdateTimestamp = new Map<string, number>();

// Force update every 30 minutes even if no change
const FORCE_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
// Store if confidence changes by more than this threshold
const CONFIDENCE_CHANGE_THRESHOLD = 0.10; // 10%

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
 * Store predictor decision ONLY if it has changed from previous
 * Also stores if confidence changes significantly or after timeout
 * Returns true if decision was stored, false if skipped
 */
export async function storePredictorDecisionIfChanged(data: PredictorDecisionData): Promise<boolean> {
  const { symbol, decision, confidence } = data;
  
  // Get last decision and confidence for this symbol
  const lastDecision = lastDecisionCache.get(symbol);
  const lastConfidence = lastConfidenceCache.get(symbol) ?? 0;
  const lastUpdate = lastUpdateTimestamp.get(symbol) ?? 0;
  const now = Date.now();
  
  // Check if we should store this decision
  const decisionChanged = lastDecision !== decision;
  const confidenceChanged = Math.abs(confidence - lastConfidence) >= CONFIDENCE_CHANGE_THRESHOLD;
  const forceUpdate = (now - lastUpdate) >= FORCE_UPDATE_INTERVAL_MS;
  
  // Skip if nothing significant changed
  if (!decisionChanged && !confidenceChanged && !forceUpdate) {
    return false;
  }
  
  // Determine update reason
  let updateReason = '';
  if (decisionChanged) updateReason = 'decision_changed';
  else if (confidenceChanged) updateReason = 'confidence_changed';
  else if (forceUpdate) updateReason = 'periodic_update';
  
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
    
    // Update caches
    lastDecisionCache.set(symbol, decision);
    lastConfidenceCache.set(symbol, confidence);
    lastUpdateTimestamp.set(symbol, now);
    
    const transition = lastDecision 
      ? `${lastDecision} → ${decision}` 
      : `initial: ${decision}`;
    
    const confChange = lastConfidence 
      ? ` (${(lastConfidence * 100).toFixed(1)}% → ${(confidence * 100).toFixed(1)}%)`
      : ` (${(confidence * 100).toFixed(1)}%)`;
    
    console.log(`📊 [PredictorDecision] ${symbol}: ${transition}${confChange} [${updateReason}]`);
    
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
        lastConfidenceCache.set(symbol, last.confidence);
        lastUpdateTimestamp.set(symbol, last.createdAt.getTime());
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
