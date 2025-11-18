/**
 * Multi-Agent Portfolio Exposure Risk
 * 
 * Monitors total portfolio exposure across all active agents to prevent
 * excessive correlated risk. If 7 agents are all long on correlated assets,
 * a market crash causes 7x the intended loss.
 * 
 * This module queries the database for all active positions and calculates:
 * - Total long/short exposure
 * - Correlation-adjusted risk
 * - Concentration per crypto
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type PortfolioExposureSignal = {
  totalLongExposure: number;      // % of portfolio in longs
  totalShortExposure: number;     // % of portfolio in shorts
  netExposure: number;            // Long - Short
  correlatedRisk: number;         // 0-1, higher = more correlated positions
  concentration: number;          // 0-1, higher = concentrated in few assets
  activePositions: number;        // Count of open positions
  shouldBlock: boolean;           // Block new entries
  penalty: number;                // Score multiplier (0-1)
  reason: string;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
};

// Cache portfolio analysis for 30 seconds (positions don't change that fast)
let portfolioCache: {
  signal: PortfolioExposureSignal;
  timestamp: number;
} | null = null;

const PORTFOLIO_CACHE_TTL = 30_000; // 30 seconds

/**
 * Fetch all active positions from database
 */
async function fetchActivePositions(): Promise<Array<{
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  unrealizedPnl: number;
}>> {
  try {
    // Query active positions across all agent sessions
    const positions = await prisma.position.findMany({
      where: {
        qty: {
          not: 0,
        },
        session: {
          stoppedAt: null, // Only active sessions
        },
      },
      select: {
        symbol: true,
        side: true,
        qty: true,
        entryPrice: true,
        unrealizedPnl: true,
        markPrice: true,
      },
    });
    
    return positions.map(p => ({
      symbol: p.symbol,
      side: p.side as 'long' | 'short',
      size: Math.abs(Number(p.qty || 0)),
      entryPrice: Number(p.entryPrice || 0),
      unrealizedPnl: Number(p.unrealizedPnl || 0),
    }));
  } catch (error) {
    console.error('[Portfolio Exposure] Failed to fetch positions:', error);
    return [];
  }
}

/**
 * Calculate portfolio metrics
 */
function analyzePortfolio(positions: Array<{
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
}>): {
  totalLongExposure: number;
  totalShortExposure: number;
  netExposure: number;
  correlatedRisk: number;
  concentration: number;
} {
  if (positions.length === 0) {
    return {
      totalLongExposure: 0,
      totalShortExposure: 0,
      netExposure: 0,
      correlatedRisk: 0,
      concentration: 0,
    };
  }
  
  // Calculate exposure
  const longPositions = positions.filter(p => p.side === 'long');
  const shortPositions = positions.filter(p => p.side === 'short');
  
  const totalLongExposure = longPositions.length / positions.length;
  const totalShortExposure = shortPositions.length / positions.length;
  const netExposure = totalLongExposure - totalShortExposure;
  
  // Correlation risk: If all positions are same direction, risk is high
  // Assume crypto market has 0.8 correlation coefficient
  const CRYPTO_CORRELATION = 0.8;
  const correlatedRisk = Math.abs(netExposure) * CRYPTO_CORRELATION;
  
  // Concentration: Are we over-concentrated in a few symbols?
  const symbolCounts = new Map<string, number>();
  for (const pos of positions) {
    const baseSymbol = pos.symbol.split('/')[0]; // BTC/USDT -> BTC
    symbolCounts.set(baseSymbol, (symbolCounts.get(baseSymbol) || 0) + 1);
  }
  
  const maxConcentration = Math.max(...Array.from(symbolCounts.values()));
  const concentration = maxConcentration / positions.length;
  
  return {
    totalLongExposure,
    totalShortExposure,
    netExposure,
    correlatedRisk,
    concentration,
  };
}

/**
 * Determine severity and penalties
 */
function calculateRiskPenalty(
  netExposure: number,
  correlatedRisk: number,
  concentration: number,
  activePositions: number,
  tradeBias: 'long' | 'short' | 'both'
): {
  shouldBlock: boolean;
  penalty: number;
  reason: string;
  severity: PortfolioExposureSignal['severity'];
} {
  // If no positions, no risk
  if (activePositions === 0) {
    return {
      shouldBlock: false,
      penalty: 1.0,
      reason: 'no_positions',
      severity: 'none',
    };
  }
  
  // CRITICAL: Too many positions (> 10)
  if (activePositions > 10) {
    return {
      shouldBlock: true,
      penalty: 0.0,
      reason: 'portfolio_overload',
      severity: 'critical',
    };
  }
  
  // HIGH: Extreme one-sided exposure (> 80%)
  if (tradeBias === 'long' && netExposure > 0.8) {
    return {
      shouldBlock: true,
      penalty: 0.0,
      reason: 'portfolio_extreme_long_bias',
      severity: 'critical',
    };
  }
  
  if (tradeBias === 'short' && netExposure < -0.8) {
    return {
      shouldBlock: true,
      penalty: 0.0,
      reason: 'portfolio_extreme_short_bias',
      severity: 'critical',
    };
  }
  
  // HIGH: High correlated risk (> 0.6)
  if (correlatedRisk > 0.6) {
    if (
      (tradeBias === 'long' && netExposure > 0.5) ||
      (tradeBias === 'short' && netExposure < -0.5)
    ) {
      return {
        shouldBlock: false,
        penalty: 0.4,
        reason: 'portfolio_high_correlation',
        severity: 'high',
      };
    }
  }
  
  // MEDIUM: Moderate exposure (> 60%)
  if (
    (tradeBias === 'long' && netExposure > 0.6) ||
    (tradeBias === 'short' && netExposure < -0.6)
  ) {
    return {
      shouldBlock: false,
      penalty: 0.6,
      reason: 'portfolio_moderate_bias',
      severity: 'medium',
    };
  }
  
  // MEDIUM: High concentration (> 0.5 in one asset)
  if (concentration > 0.5) {
    return {
      shouldBlock: false,
      penalty: 0.7,
      reason: 'portfolio_concentrated',
      severity: 'medium',
    };
  }
  
  // LOW: Moderate exposure (> 40%)
  if (
    (tradeBias === 'long' && netExposure > 0.4) ||
    (tradeBias === 'short' && netExposure < -0.4)
  ) {
    return {
      shouldBlock: false,
      penalty: 0.85,
      reason: 'portfolio_mild_bias',
      severity: 'low',
    };
  }
  
  // Normal portfolio - no penalty
  return {
    shouldBlock: false,
    penalty: 1.0,
    reason: 'portfolio_balanced',
    severity: 'none',
  };
}

/**
 * Detect portfolio exposure risk across all agents
 * 
 * @param tradeBias - Proposed trade direction
 * @returns PortfolioExposureSignal with blocking decision
 */
export async function detectPortfolioExposureRisk(
  tradeBias: 'long' | 'short' | 'both'
): Promise<PortfolioExposureSignal> {
  const now = Date.now();
  
  // Check cache
  if (portfolioCache && (now - portfolioCache.timestamp) < PORTFOLIO_CACHE_TTL) {
    // Recalculate penalty for this specific trade bias
    const cached = portfolioCache.signal;
    const { shouldBlock, penalty, reason, severity } = calculateRiskPenalty(
      cached.netExposure,
      cached.correlatedRisk,
      cached.concentration,
      cached.activePositions,
      tradeBias
    );
    
    return {
      ...cached,
      shouldBlock,
      penalty,
      reason,
      severity,
    };
  }
  
  try {
    // Fetch active positions
    const positions = await fetchActivePositions();
    
    // Analyze portfolio
    const {
      totalLongExposure,
      totalShortExposure,
      netExposure,
      correlatedRisk,
      concentration,
    } = analyzePortfolio(positions);
    
    // Calculate risk penalty
    const { shouldBlock, penalty, reason, severity } = calculateRiskPenalty(
      netExposure,
      correlatedRisk,
      concentration,
      positions.length,
      tradeBias
    );
    
    // Build signal
    const signal: PortfolioExposureSignal = {
      totalLongExposure,
      totalShortExposure,
      netExposure,
      correlatedRisk,
      concentration,
      activePositions: positions.length,
      shouldBlock,
      penalty,
      reason,
      severity,
    };
    
    // Cache the result
    portfolioCache = { signal, timestamp: now };
    
    // Log significant risk
    if (severity === 'high' || severity === 'critical') {
      console.log(JSON.stringify({
        event: 'portfolio_exposure_risk',
        tradeBias,
        activePositions: positions.length,
        netExposure: netExposure.toFixed(2),
        correlatedRisk: correlatedRisk.toFixed(2),
        concentration: concentration.toFixed(2),
        severity,
        shouldBlock,
        penalty,
      }));
    }
    
    return signal;
  } catch (error) {
    console.error('[Portfolio Exposure] Error in detectPortfolioExposureRisk:', error);
    
    // Return neutral signal on error
    return {
      totalLongExposure: 0,
      totalShortExposure: 0,
      netExposure: 0,
      correlatedRisk: 0,
      concentration: 0,
      activePositions: 0,
      shouldBlock: false,
      penalty: 1.0,
      reason: 'portfolio_check_failed',
      severity: 'none',
    };
  }
}

/**
 * Clear portfolio cache (useful for testing)
 */
export function clearPortfolioCache(): void {
  portfolioCache = null;
}
