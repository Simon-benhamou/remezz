/**
 * Correlation Matrix Manager
 * 
 * Manages correlation tracking between crypto assets to prevent over-concentration
 * in highly correlated positions. Helps reduce portfolio drawdown risk.
 */

import { prisma } from '../db/client.js';
import { getTicker } from '../data/market.js';

type CorrelationWindow = '1h' | '6h' | '24h' | '7d';

interface CorrelationData {
  symbol1: string;
  symbol2: string;
  correlation: number;
  window: CorrelationWindow;
  updatedAt: number;
  sampleSize: number;
}

interface CorrelationConstraint {
  maxCombinedExposure: number;
  symbol1AllocationPct: number;
  symbol2AllocationPct: number;
  reason: string;
}

const correlationCache = new Map<string, CorrelationData>();
const CACHE_TTL_MS = 3600_000; // 1 hour

// High correlation pairs (manually defined + to be learned)
const KNOWN_HIGH_CORRELATIONS: Record<string, string[]> = {
  'BTCUSDT': ['ETHUSDT', 'BNBUSDT'],
  'ETHUSDT': ['BTCUSDT', 'BNBUSDT'],
  'BNBUSDT': ['BTCUSDT', 'ETHUSDT'],
};

/**
 * Calculate correlation between two price series
 */
function calculateCorrelation(prices1: number[], prices2: number[]): number {
  if (prices1.length !== prices2.length || prices1.length < 2) {
    return 0;
  }

  const n = prices1.length;
  
  // Calculate means
  const mean1 = prices1.reduce((sum, p) => sum + p, 0) / n;
  const mean2 = prices2.reduce((sum, p) => sum + p, 0) / n;
  
  // Calculate standard deviations and covariance
  let covariance = 0;
  let variance1 = 0;
  let variance2 = 0;
  
  for (let i = 0; i < n; i++) {
    const diff1 = prices1[i] - mean1;
    const diff2 = prices2[i] - mean2;
    
    covariance += diff1 * diff2;
    variance1 += diff1 * diff1;
    variance2 += diff2 * diff2;
  }
  
  const stdDev1 = Math.sqrt(variance1 / n);
  const stdDev2 = Math.sqrt(variance2 / n);
  
  if (stdDev1 === 0 || stdDev2 === 0) {
    return 0;
  }
  
  return covariance / (n * stdDev1 * stdDev2);
}

/**
 * Fetch recent price data for correlation calculation
 */
async function fetchPriceHistory(
  symbol: string,
  windowMs: number
): Promise<number[]> {
  try {
    // In production, fetch from broker or database
    // For now, use recent ticker prices
    const ticker = await getTicker(symbol);
    if (!ticker?.last) {
      return [];
    }
    
    // TODO: Replace with actual historical data fetch
    // This is a placeholder - need to implement proper OHLCV fetching
    return [ticker.last];
  } catch (error) {
    console.warn(`[CorrelationManager] Failed to fetch price history for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get correlation between two symbols
 */
export async function getCorrelation(
  symbol1: string,
  symbol2: string,
  window: CorrelationWindow = '24h'
): Promise<number> {
  const cacheKey = `${symbol1}|${symbol2}|${window}`;
  
  // Check cache
  const cached = correlationCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL_MS) {
    return cached.correlation;
  }
  
  // Check known high correlations (manual override)
  if (KNOWN_HIGH_CORRELATIONS[symbol1]?.includes(symbol2)) {
    return 0.85; // Assume high correlation
  }
  
  // Calculate correlation
  const windowMs = {
    '1h': 3600_000,
    '6h': 6 * 3600_000,
    '24h': 24 * 3600_000,
    '7d': 7 * 24 * 3600_000,
  }[window];
  
  const [prices1, prices2] = await Promise.all([
    fetchPriceHistory(symbol1, windowMs),
    fetchPriceHistory(symbol2, windowMs),
  ]);
  
  if (prices1.length < 10 || prices2.length < 10) {
    // Not enough data - use default assumption
    if (KNOWN_HIGH_CORRELATIONS[symbol1]?.includes(symbol2)) {
      return 0.85;
    }
    return 0.3; // Default low correlation
  }
  
  const correlation = calculateCorrelation(prices1, prices2);
  
  // Cache result
  correlationCache.set(cacheKey, {
    symbol1,
    symbol2,
    correlation,
    window,
    updatedAt: Date.now(),
    sampleSize: prices1.length,
  });
  
  return correlation;
}

/**
 * Get all correlations for a symbol against active positions
 */
export async function getSymbolCorrelations(
  symbol: string,
  activePositions: Array<{ symbol: string; exposureUsd: number }>
): Promise<Map<string, number>> {
  const correlations = new Map<string, number>();
  
  for (const position of activePositions) {
    if (position.symbol === symbol) continue;
    
    const correlation = await getCorrelation(symbol, position.symbol);
    correlations.set(position.symbol, correlation);
  }
  
  return correlations;
}

/**
 * Calculate correlation-adjusted allocation constraint
 * 
 * If BTC and ETH have 0.85 correlation and we want to open both:
 * - Instead of 20% + 20% = 40% exposure
 * - Use 20% + 12% = 32% (reduced second position)
 */
export function calculateCorrelationConstraint(
  proposedSymbol: string,
  proposedAllocationUsd: number,
  existingSymbol: string,
  existingExposureUsd: number,
  correlation: number,
  maxPositionUsd: number
): CorrelationConstraint | null {
  // Only apply constraints for high correlation (> 0.7)
  if (correlation < 0.7) {
    return null;
  }
  
  // Calculate correlation penalty
  const correlationPenalty = Math.max(0, (correlation - 0.7) / 0.3); // 0 to 1
  
  // Reduce combined exposure based on correlation
  const idealCombinedMax = maxPositionUsd * 2; // Normal max for 2 positions
  const correlationAdjustedMax = idealCombinedMax * (1 - correlationPenalty * 0.4); // Up to 40% reduction
  
  // If combined exposure within limit, no constraint needed
  const combinedExposure = existingExposureUsd + proposedAllocationUsd;
  if (combinedExposure <= correlationAdjustedMax) {
    return null;
  }
  
  // Need to reduce proposed allocation
  const availableRoom = Math.max(0, correlationAdjustedMax - existingExposureUsd);
  const reducedProposedAllocation = Math.min(proposedAllocationUsd, availableRoom);
  
  return {
    maxCombinedExposure: correlationAdjustedMax,
    symbol1AllocationPct: existingExposureUsd / maxPositionUsd,
    symbol2AllocationPct: reducedProposedAllocation / maxPositionUsd,
    reason: `correlation_constraint: ${correlation.toFixed(2)} with ${existingSymbol}`,
  };
}

/**
 * Apply correlation constraints to proposed allocation
 * 
 * Returns adjusted allocation amount (may be reduced)
 */
export async function applyCorrelationConstraints(
  symbol: string,
  proposedAllocationUsd: number,
  maxPositionUsd: number
): Promise<{
  adjustedAllocationUsd: number;
  constraints: CorrelationConstraint[];
  totalReduction: number;
}> {
  // Fetch active positions
  const openPositions = await prisma.position.findMany({
    where: { qty: { gt: 0 } },
    select: {
      symbol: true,
      qty: true,
      entryPrice: true,
    },
  });
  
  if (openPositions.length === 0) {
    return {
      adjustedAllocationUsd: proposedAllocationUsd,
      constraints: [],
      totalReduction: 0,
    };
  }
  
  // Calculate correlations
  const activePositions = openPositions.map(p => ({
    symbol: p.symbol,
    exposureUsd: Math.abs((p.qty ?? 0) * (p.entryPrice ?? 0)),
  }));
  
  const correlations = await getSymbolCorrelations(symbol, activePositions);
  
  // Apply constraints
  let adjustedAllocation = proposedAllocationUsd;
  const appliedConstraints: CorrelationConstraint[] = [];
  
  for (const [otherSymbol, correlation] of correlations.entries()) {
    const position = activePositions.find(p => p.symbol === otherSymbol);
    if (!position) continue;
    
    const constraint = calculateCorrelationConstraint(
      symbol,
      adjustedAllocation,
      otherSymbol,
      position.exposureUsd,
      correlation,
      maxPositionUsd
    );
    
    if (constraint) {
      // Reduce allocation
      adjustedAllocation = Math.min(
        adjustedAllocation,
        constraint.symbol2AllocationPct * maxPositionUsd
      );
      appliedConstraints.push(constraint);
    }
  }
  
  const totalReduction = proposedAllocationUsd - adjustedAllocation;
  
  return {
    adjustedAllocationUsd: Math.max(0, adjustedAllocation),
    constraints: appliedConstraints,
    totalReduction,
  };
}

/**
 * Get correlation matrix for all active positions
 */
export async function getCorrelationMatrix(): Promise<Record<string, Record<string, number>>> {
  const positions = await prisma.position.findMany({
    where: { qty: { gt: 0 } },
    select: { symbol: true },
    distinct: ['symbol'],
  });
  
  const symbols = positions.map(p => p.symbol);
  const matrix: Record<string, Record<string, number>> = {};
  
  for (const symbol1 of symbols) {
    matrix[symbol1] = {};
    for (const symbol2 of symbols) {
      if (symbol1 === symbol2) {
        matrix[symbol1][symbol2] = 1.0;
      } else {
        matrix[symbol1][symbol2] = await getCorrelation(symbol1, symbol2);
      }
    }
  }
  
  return matrix;
}

/**
 * Clear correlation cache (useful for testing)
 */
export function clearCorrelationCache(): void {
  correlationCache.clear();
}
