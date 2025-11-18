/**
 * Funding Rate Detection
 * 
 * Monitors perpetual futures funding rates to detect overheated markets.
 * High positive funding = longs pay shorts = market overheated (favor shorts)
 * High negative funding = shorts pay longs = market oversold (favor longs)
 * 
 * Funding rates are a critical signal because they represent the cost of holding
 * leveraged positions. When rates are extreme, it indicates one-sided positioning
 * that often reverses.
 */

import { getTicker } from '../../../data/market.js';

export type FundingRateSignal = {
  fundingRate: number;           // Current funding rate (%)
  annualizedRate: number;         // Annualized % (funding * 3 * 365)
  sentiment: 'extremely_long_biased' | 'long_biased' | 'neutral' | 'short_biased' | 'extremely_short_biased';
  severity: 'none' | 'low' | 'medium' | 'high' | 'extreme';
  shouldBlock: boolean;           // Block entry entirely
  penalty: number;                // Score multiplier (0-1.2)
  reason: string;
  costPerDay: number;             // Daily cost % if holding position
};

// Cache funding rates for 5 minutes (they update every 8 hours on most exchanges)
const fundingRateCache = new Map<string, { signal: FundingRateSignal; timestamp: number }>();
const FUNDING_RATE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch funding rate from exchange
 */
async function fetchFundingRate(symbol: string): Promise<number> {
  try {
    const ticker = await getTicker(symbol);
    
    // Funding rate is in ticker.info for most exchanges
    const fundingRate = Number(ticker.info?.fundingRate ?? 0);
    
    // Validate - funding rates are typically between -0.01 and 0.01 (±1%)
    if (Math.abs(fundingRate) > 0.05) {
      console.warn(`[Funding Rate] Suspicious rate for ${symbol}: ${fundingRate}`);
      return 0;
    }
    
    return fundingRate;
  } catch (error) {
    console.error(`[Funding Rate] Failed to fetch for ${symbol}:`, error);
    return 0;
  }
}

/**
 * Determine market sentiment from funding rate
 */
function analyzeFundingRate(fundingRate: number): {
  sentiment: FundingRateSignal['sentiment'];
  severity: FundingRateSignal['severity'];
  annualizedRate: number;
  costPerDay: number;
} {
  // Funding typically paid every 8 hours (3x per day)
  // Annualized = funding * 3 * 365
  const annualizedRate = fundingRate * 3 * 365 * 100; // Convert to %
  const costPerDay = fundingRate * 3 * 100; // Daily cost in %
  
  let sentiment: FundingRateSignal['sentiment'];
  let severity: FundingRateSignal['severity'];
  
  if (fundingRate > 0.0015) {
    // > 0.15% per 8h = 0.45% per day = 164% per year (EXTREME long bias)
    sentiment = 'extremely_long_biased';
    severity = 'extreme';
  } else if (fundingRate > 0.0010) {
    // > 0.10% per 8h = 0.30% per day = 109% per year (HIGH long bias)
    sentiment = 'long_biased';
    severity = 'high';
  } else if (fundingRate > 0.0005) {
    // > 0.05% per 8h = 0.15% per day = 55% per year (MEDIUM long bias)
    sentiment = 'long_biased';
    severity = 'medium';
  } else if (fundingRate > 0.0001) {
    // > 0.01% per 8h = 0.03% per day = 11% per year (LOW long bias)
    sentiment = 'long_biased';
    severity = 'low';
  } else if (fundingRate < -0.0015) {
    // < -0.15% per 8h (EXTREME short bias)
    sentiment = 'extremely_short_biased';
    severity = 'extreme';
  } else if (fundingRate < -0.0010) {
    // < -0.10% per 8h (HIGH short bias)
    sentiment = 'short_biased';
    severity = 'high';
  } else if (fundingRate < -0.0005) {
    // < -0.05% per 8h (MEDIUM short bias)
    sentiment = 'short_biased';
    severity = 'medium';
  } else if (fundingRate < -0.0001) {
    // < -0.01% per 8h (LOW short bias)
    sentiment = 'short_biased';
    severity = 'low';
  } else {
    // Between -0.01% and +0.01% = neutral
    sentiment = 'neutral';
    severity = 'none';
  }
  
  return { sentiment, severity, annualizedRate, costPerDay };
}

/**
 * Calculate penalty based on funding rate and trade bias
 */
function calculatePenalty(
  sentiment: FundingRateSignal['sentiment'],
  severity: FundingRateSignal['severity'],
  tradeBias: 'long' | 'short' | 'both'
): { shouldBlock: boolean; penalty: number; reason: string } {
  // No funding impact = neutral
  if (severity === 'none' || severity === 'low') {
    return {
      shouldBlock: false,
      penalty: 1.0,
      reason: 'funding_neutral',
    };
  }
  
  // LONG BIAS: Longs are expensive (favor shorts)
  if (sentiment === 'extremely_long_biased') {
    if (tradeBias === 'long') {
      if (severity === 'extreme') {
        // Extremely expensive to hold longs - block
        return {
          shouldBlock: true,
          penalty: 0.0,
          reason: 'funding_extreme_long_cost',
        };
      } else {
        // Expensive longs - heavy penalty
        return {
          shouldBlock: false,
          penalty: 0.4,
          reason: 'funding_high_long_cost',
        };
      }
    } else if (tradeBias === 'short') {
      // Shorts receive funding - boost
      return {
        shouldBlock: false,
        penalty: 1.2,
        reason: 'funding_short_receives',
      };
    }
  } else if (sentiment === 'long_biased') {
    if (tradeBias === 'long' && severity === 'high') {
      // High cost longs - penalty
      return {
        shouldBlock: false,
        penalty: 0.6,
        reason: 'funding_moderate_long_cost',
      };
    } else if (tradeBias === 'short' && severity === 'high') {
      // Moderate boost for shorts
      return {
        shouldBlock: false,
        penalty: 1.15,
        reason: 'funding_short_benefit',
      };
    }
  }
  
  // SHORT BIAS: Shorts are expensive (favor longs)
  if (sentiment === 'extremely_short_biased') {
    if (tradeBias === 'short') {
      if (severity === 'extreme') {
        // Extremely expensive to hold shorts - block
        return {
          shouldBlock: true,
          penalty: 0.0,
          reason: 'funding_extreme_short_cost',
        };
      } else {
        // Expensive shorts - heavy penalty
        return {
          shouldBlock: false,
          penalty: 0.4,
          reason: 'funding_high_short_cost',
        };
      }
    } else if (tradeBias === 'long') {
      // Longs receive funding - boost
      return {
        shouldBlock: false,
        penalty: 1.2,
        reason: 'funding_long_receives',
      };
    }
  } else if (sentiment === 'short_biased') {
    if (tradeBias === 'short' && severity === 'high') {
      // High cost shorts - penalty
      return {
        shouldBlock: false,
        penalty: 0.6,
        reason: 'funding_moderate_short_cost',
      };
    } else if (tradeBias === 'long' && severity === 'high') {
      // Moderate boost for longs
      return {
        shouldBlock: false,
        penalty: 1.15,
        reason: 'funding_long_benefit',
      };
    }
  }
  
  // Default: no impact
  return {
    shouldBlock: false,
    penalty: 1.0,
    reason: 'funding_neutral',
  };
}

/**
 * Detect funding rate impact on trading decisions
 * 
 * @param symbol - Trading pair symbol (e.g., "BTC/USDT:USDT")
 * @param bias - Trade direction ('long' or 'short')
 * @returns FundingRateSignal with penalty and blocking decision
 */
export async function detectFundingRateImpact(
  symbol: string,
  bias: 'long' | 'short' | 'both'
): Promise<FundingRateSignal> {
  const now = Date.now();
  const cacheKey = `${symbol}:${bias}`;
  
  // Check cache
  const cached = fundingRateCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < FUNDING_RATE_CACHE_TTL) {
    return cached.signal;
  }
  
  try {
    // Fetch funding rate
    const fundingRate = await fetchFundingRate(symbol);
    
    // Analyze funding rate
    const { sentiment, severity, annualizedRate, costPerDay } = analyzeFundingRate(fundingRate);
    
    // Calculate penalty
    const { shouldBlock, penalty, reason } = calculatePenalty(sentiment, severity, bias);
    
    // Build signal
    const signal: FundingRateSignal = {
      fundingRate,
      annualizedRate,
      sentiment,
      severity,
      shouldBlock,
      penalty,
      reason,
      costPerDay,
    };
    
    // Cache the result
    fundingRateCache.set(cacheKey, { signal, timestamp: now });
    
    // Log significant funding rates
    if (severity === 'high' || severity === 'extreme') {
      console.log(JSON.stringify({
        event: 'funding_rate_detection',
        symbol,
        bias,
        fundingRate: fundingRate.toFixed(6),
        annualizedRate: `${annualizedRate.toFixed(1)}%`,
        costPerDay: `${costPerDay.toFixed(3)}%`,
        sentiment,
        severity,
        shouldBlock,
        penalty,
      }));
    }
    
    return signal;
  } catch (error) {
    console.error('[Funding Rate] Error in detectFundingRateImpact:', error);
    
    // Return neutral signal on error
    return {
      fundingRate: 0,
      annualizedRate: 0,
      sentiment: 'neutral',
      severity: 'none',
      shouldBlock: false,
      penalty: 1.0,
      reason: 'funding_check_failed',
      costPerDay: 0,
    };
  }
}

/**
 * Clear funding rate cache (useful for testing)
 */
export function clearFundingRateCache(): void {
  fundingRateCache.clear();
}

/**
 * Get cache statistics
 */
export function getFundingRateCacheStats(): {
  size: number;
  entries: Array<{ symbol: string; age: number; rate: number }>;
} {
  const now = Date.now();
  const entries = Array.from(fundingRateCache.entries()).map(([key, value]) => ({
    symbol: key,
    age: now - value.timestamp,
    rate: value.signal.fundingRate,
  }));
  
  return {
    size: fundingRateCache.size,
    entries,
  };
}
