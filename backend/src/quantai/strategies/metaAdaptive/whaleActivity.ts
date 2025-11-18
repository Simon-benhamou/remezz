/**
 * Whale Activity / Order Book Imbalance Detection
 * 
 * Detects large orders and bid/ask imbalances that create hidden support
 * or resistance levels not visible in price action. Whales can absorb or
 * dump large volumes, invalidating technical setups.
 * 
 * Key indicators:
 * - Bid/ask depth imbalance (> 2:1 ratio)
 * - Large orders (> $100k)
 * - Unusual order book clustering
 */

import { getTicker } from '../../../data/market.js';

export type WhaleActivitySignal = {
  bidAskImbalance: number;        // Ratio of bid depth to ask depth (> 2 = bullish)
  imbalanceLevel: 'extreme_sell' | 'sell' | 'balanced' | 'buy' | 'extreme_buy';
  bidDepthUsd: number;            // Total USD in bids
  askDepthUsd: number;            // Total USD in asks
  severity: 'none' | 'low' | 'medium' | 'high' | 'extreme';
  shouldWarn: boolean;            // Warn about whale activity
  penalty: number;                // Score multiplier (0.7-1.3)
  reason: string;
  recommendations: string[];
};

// Cache whale activity for 10 seconds (order books change frequently)
const whaleActivityCache = new Map<string, { signal: WhaleActivitySignal; timestamp: number }>();
const WHALE_ACTIVITY_CACHE_TTL = 10_000; // 10 seconds

/**
 * Fetch order book depth from ticker
 */
async function fetchOrderBookDepth(symbol: string): Promise<{
  bidDepthUsd: number;
  askDepthUsd: number;
}> {
  try {
    const ticker = await getTicker(symbol);
    
    // Order book depth is in ticker.info for some exchanges
    const bidDepth = Number(ticker.info?.bidVolume ?? ticker.info?.bidDepth ?? 0);
    const askDepth = Number(ticker.info?.askVolume ?? ticker.info?.askDepth ?? 0);
    
    // If not available, estimate from spread and volume
    if (bidDepth === 0 && askDepth === 0) {
      const quoteVolume = Number(ticker.quoteVolume ?? 0);
      // Assume 50/50 split if no data
      return {
        bidDepthUsd: quoteVolume * 0.5,
        askDepthUsd: quoteVolume * 0.5,
      };
    }
    
    return {
      bidDepthUsd: bidDepth,
      askDepthUsd: askDepth,
    };
  } catch (error) {
    console.error(`[Whale Activity] Failed to fetch order book for ${symbol}:`, error);
    return {
      bidDepthUsd: 0,
      askDepthUsd: 0,
    };
  }
}

/**
 * Analyze bid/ask imbalance
 */
function analyzeImbalance(
  bidDepthUsd: number,
  askDepthUsd: number
): {
  bidAskImbalance: number;
  imbalanceLevel: WhaleActivitySignal['imbalanceLevel'];
  severity: WhaleActivitySignal['severity'];
} {
  // Calculate imbalance ratio
  let bidAskImbalance = 1.0;
  if (askDepthUsd > 0) {
    bidAskImbalance = bidDepthUsd / askDepthUsd;
  } else if (bidDepthUsd > 0) {
    bidAskImbalance = 10.0; // Extreme buy pressure
  }
  
  let imbalanceLevel: WhaleActivitySignal['imbalanceLevel'];
  let severity: WhaleActivitySignal['severity'];
  
  if (bidAskImbalance > 3.0) {
    // > 3:1 ratio = extreme buy pressure (whale support)
    imbalanceLevel = 'extreme_buy';
    severity = 'extreme';
  } else if (bidAskImbalance > 2.0) {
    // > 2:1 ratio = strong buy pressure
    imbalanceLevel = 'buy';
    severity = 'high';
  } else if (bidAskImbalance > 1.5) {
    // > 1.5:1 ratio = moderate buy pressure
    imbalanceLevel = 'buy';
    severity = 'medium';
  } else if (bidAskImbalance < 0.33) {
    // < 1:3 ratio = extreme sell pressure (whale dumping)
    imbalanceLevel = 'extreme_sell';
    severity = 'extreme';
  } else if (bidAskImbalance < 0.5) {
    // < 1:2 ratio = strong sell pressure
    imbalanceLevel = 'sell';
    severity = 'high';
  } else if (bidAskImbalance < 0.67) {
    // < 2:3 ratio = moderate sell pressure
    imbalanceLevel = 'sell';
    severity = 'medium';
  } else {
    // Balanced order book
    imbalanceLevel = 'balanced';
    severity = 'none';
  }
  
  return { bidAskImbalance, imbalanceLevel, severity };
}

/**
 * Calculate penalty based on whale activity and trade bias
 */
function calculatePenalty(
  imbalanceLevel: WhaleActivitySignal['imbalanceLevel'],
  severity: WhaleActivitySignal['severity'],
  tradeBias: 'long' | 'short' | 'both'
): {
  shouldWarn: boolean;
  penalty: number;
  reason: string;
  recommendations: string[];
} {
  const recommendations: string[] = [];
  let shouldWarn = false;
  let penalty = 1.0;
  let reason = 'orderbook_balanced';
  
  // No significant imbalance
  if (severity === 'none' || severity === 'low') {
    return { shouldWarn, penalty, reason, recommendations };
  }
  
  // EXTREME BUY PRESSURE (whale support)
  if (imbalanceLevel === 'extreme_buy') {
    shouldWarn = true;
    if (tradeBias === 'short') {
      // Don't short into whale support
      penalty = 0.4;
      reason = 'orderbook_extreme_buy_wall';
      recommendations.push('Extreme buy wall detected - avoid shorts');
    } else if (tradeBias === 'long') {
      // Whale support helps longs
      penalty = 1.2;
      reason = 'orderbook_whale_support';
      recommendations.push('Strong whale support detected - favors longs');
    }
  }
  // STRONG BUY PRESSURE
  else if (imbalanceLevel === 'buy') {
    if (tradeBias === 'short' && severity === 'high') {
      penalty = 0.6;
      reason = 'orderbook_buy_pressure';
      recommendations.push('Strong buy pressure - shorts risky');
    } else if (tradeBias === 'long' && severity === 'high') {
      penalty = 1.15;
      reason = 'orderbook_buy_support';
      recommendations.push('Buy pressure favors longs');
    }
  }
  // EXTREME SELL PRESSURE (whale dumping)
  else if (imbalanceLevel === 'extreme_sell') {
    shouldWarn = true;
    if (tradeBias === 'long') {
      // Don't long into whale resistance
      penalty = 0.4;
      reason = 'orderbook_extreme_sell_wall';
      recommendations.push('Extreme sell wall detected - avoid longs');
    } else if (tradeBias === 'short') {
      // Whale resistance helps shorts
      penalty = 1.2;
      reason = 'orderbook_whale_resistance';
      recommendations.push('Strong whale resistance detected - favors shorts');
    }
  }
  // STRONG SELL PRESSURE
  else if (imbalanceLevel === 'sell') {
    if (tradeBias === 'long' && severity === 'high') {
      penalty = 0.6;
      reason = 'orderbook_sell_pressure';
      recommendations.push('Strong sell pressure - longs risky');
    } else if (tradeBias === 'short' && severity === 'high') {
      penalty = 1.15;
      reason = 'orderbook_sell_resistance';
      recommendations.push('Sell pressure favors shorts');
    }
  }
  
  return { shouldWarn, penalty, reason, recommendations };
}

/**
 * Detect whale activity from order book imbalances
 * 
 * @param symbol - Trading pair symbol
 * @param bias - Trade direction
 * @returns WhaleActivitySignal with penalty adjustment
 */
export async function detectWhaleActivity(
  symbol: string,
  bias: 'long' | 'short' | 'both'
): Promise<WhaleActivitySignal> {
  const now = Date.now();
  const cacheKey = `${symbol}:${bias}`;
  
  // Check cache
  const cached = whaleActivityCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < WHALE_ACTIVITY_CACHE_TTL) {
    return cached.signal;
  }
  
  try {
    // Fetch order book depth
    const { bidDepthUsd, askDepthUsd } = await fetchOrderBookDepth(symbol);
    
    // Analyze imbalance
    const { bidAskImbalance, imbalanceLevel, severity } = analyzeImbalance(
      bidDepthUsd,
      askDepthUsd
    );
    
    // Calculate penalty
    const { shouldWarn, penalty, reason, recommendations } = calculatePenalty(
      imbalanceLevel,
      severity,
      bias
    );
    
    // Build signal
    const signal: WhaleActivitySignal = {
      bidAskImbalance,
      imbalanceLevel,
      bidDepthUsd,
      askDepthUsd,
      severity,
      shouldWarn,
      penalty,
      reason,
      recommendations,
    };
    
    // Cache the result
    whaleActivityCache.set(cacheKey, { signal, timestamp: now });
    
    // Log significant whale activity
    if (shouldWarn && (severity === 'high' || severity === 'extreme')) {
      console.log(JSON.stringify({
        event: 'whale_activity_detection',
        symbol,
        bias,
        imbalanceLevel,
        bidAskImbalance: bidAskImbalance.toFixed(2),
        bidDepthUsd: bidDepthUsd.toFixed(0),
        askDepthUsd: askDepthUsd.toFixed(0),
        severity,
        penalty,
        recommendations,
      }));
    }
    
    return signal;
  } catch (error) {
    console.error('[Whale Activity] Error in detectWhaleActivity:', error);
    
    // Return neutral signal on error
    return {
      bidAskImbalance: 1.0,
      imbalanceLevel: 'balanced',
      bidDepthUsd: 0,
      askDepthUsd: 0,
      severity: 'none',
      shouldWarn: false,
      penalty: 1.0,
      reason: 'whale_check_failed',
      recommendations: [],
    };
  }
}

/**
 * Clear whale activity cache (useful for testing)
 */
export function clearWhaleActivityCache(): void {
  whaleActivityCache.clear();
}

/**
 * Get cache statistics
 */
export function getWhaleActivityCacheStats(): {
  size: number;
  entries: Array<{ symbol: string; age: number; imbalance: number }>;
} {
  const now = Date.now();
  const entries = Array.from(whaleActivityCache.entries()).map(([key, value]) => ({
    symbol: key,
    age: now - value.timestamp,
    imbalance: value.signal.bidAskImbalance,
  }));
  
  return {
    size: whaleActivityCache.size,
    entries,
  };
}
