/**
 * BTC Correlation Gate
 * 
 * Prevents alt coin entries during strong BTC moves since most alt coins
 * are highly correlated with BTC. A BTC dump typically drags all alts down,
 * invalidating long setups. A BTC pump can invalidate short setups.
 * 
 * This module fetches BTC's recent momentum and applies penalties to alt coin
 * positions when BTC is making significant moves.
 */

import { getTicker } from '../../../data/market.js';

const BTC_SYMBOL = 'BTC/USDT';

export type BTCCorrelationSignal = {
  btcChange5m: number;        // BTC's 5-minute price change %
  btcChange1m: number;        // BTC's 1-minute price change %
  momentum: 'strong_up' | 'moderate_up' | 'neutral' | 'moderate_down' | 'strong_down';
  shouldBlock: boolean;       // Block entry entirely
  penalty: number;            // Score multiplier (0-1)
  reason: string;             // Human-readable reason
  impactLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
};

// Cache BTC ticker for 2 seconds to avoid excessive API calls
let btcTickerCache: {
  ticker: any;
  timestamp: number;
  priceHistory: { price: number; timestamp: number }[];
} | null = null;

const BTC_CACHE_TTL_MS = 2000; // 2 seconds
const PRICE_HISTORY_SIZE = 6; // Keep last 6 prices (6 * 2s = 12s history)

/**
 * Get BTC ticker with caching and price history
 */
async function getBTCTicker(): Promise<{
  current: number;
  change5m: number;
  change1m: number;
}> {
  const now = Date.now();
  
  // Check cache
  if (btcTickerCache && (now - btcTickerCache.timestamp) < BTC_CACHE_TTL_MS) {
    const currentPrice = btcTickerCache.ticker.last;
    const history = btcTickerCache.priceHistory;
    
    // Calculate 5m change (using oldest price in history if available)
    let change5m = 0;
    if (history.length >= 3) { // At least 6 seconds of data
      const oldestPrice = history[0].price;
      change5m = ((currentPrice - oldestPrice) / oldestPrice) * 100;
    }
    
    // Calculate 1m change (using most recent historical price)
    let change1m = 0;
    if (history.length >= 1) {
      const recentPrice = history[history.length - 1].price;
      change1m = ((currentPrice - recentPrice) / recentPrice) * 100;
    }
    
    return {
      current: currentPrice,
      change5m,
      change1m,
    };
  }
  
  // Fetch fresh ticker
  try {
    const ticker = await getTicker(BTC_SYMBOL);
    const currentPrice = Number(ticker.last || 0);
    
    if (!currentPrice || currentPrice === 0) {
      throw new Error('Invalid BTC price');
    }
    
    // Initialize or update price history
    const priceHistory = btcTickerCache?.priceHistory || [];
    priceHistory.push({ price: currentPrice, timestamp: now });
    
    // Keep only last N prices
    if (priceHistory.length > PRICE_HISTORY_SIZE) {
      priceHistory.shift();
    }
    
    // Calculate changes
    let change5m = 0;
    let change1m = 0;
    
    if (priceHistory.length >= 3) {
      const oldestPrice = priceHistory[0].price;
      change5m = ((currentPrice - oldestPrice) / oldestPrice) * 100;
    }
    
    if (priceHistory.length >= 2) {
      const recentPrice = priceHistory[priceHistory.length - 2].price;
      change1m = ((currentPrice - recentPrice) / recentPrice) * 100;
    }
    
    // Update cache
    btcTickerCache = {
      ticker,
      timestamp: now,
      priceHistory,
    };
    
    return {
      current: currentPrice,
      change5m,
      change1m,
    };
  } catch (error) {
    console.error('[BTC Correlation] Failed to fetch BTC ticker:', error);
    
    // Return neutral signal on error
    return {
      current: 0,
      change5m: 0,
      change1m: 0,
    };
  }
}

/**
 * Check if symbol is BTC or a BTC pair
 */
function isBTCPair(symbol: string): boolean {
  const normalized = symbol.toUpperCase().replace(/[/:]/g, '');
  return normalized.startsWith('BTC');
}

/**
 * Detect BTC correlation impact for alt coin entries
 * 
 * @param symbol - Trading pair symbol (e.g., "ETH/USDT")
 * @param bias - Trade direction ('long' or 'short')
 * @returns BTCCorrelationSignal with penalty and blocking decision
 */
export async function detectBTCCorrelationImpact(
  symbol: string,
  bias: 'long' | 'short' | 'both'
): Promise<BTCCorrelationSignal> {
  // Skip BTC correlation check for BTC itself
  if (isBTCPair(symbol)) {
    return {
      btcChange5m: 0,
      btcChange1m: 0,
      momentum: 'neutral',
      shouldBlock: false,
      penalty: 1.0,
      reason: 'btc_pair_skip',
      impactLevel: 'none',
    };
  }
  
  try {
    const btcData = await getBTCTicker();
    const { change5m, change1m } = btcData;
    
    // Determine BTC momentum
    let momentum: BTCCorrelationSignal['momentum'] = 'neutral';
    if (change5m > 1.5 || change1m > 1.0) {
      momentum = 'strong_up';
    } else if (change5m > 0.8 || change1m > 0.5) {
      momentum = 'moderate_up';
    } else if (change5m < -1.5 || change1m < -1.0) {
      momentum = 'strong_down';
    } else if (change5m < -0.8 || change1m < -0.5) {
      momentum = 'moderate_down';
    }
    
    // Default: no impact
    let shouldBlock = false;
    let penalty = 1.0;
    let reason = 'btc_neutral';
    let impactLevel: BTCCorrelationSignal['impactLevel'] = 'none';
    
    // 🚀 OPPORTUNITY-FIRST: BTC correlation = directional signal, not blocker!
    // BTC moves WITH your trade = BOOST, against = soft penalty (not block)
    
    // LONG BIAS: BTC pump = tailwind (boost), BTC dump = headwind (soft penalty)
    if (bias === 'long' || bias === 'both') {
      if (momentum === 'strong_up') {
        // BTC pumping hard → STRONG BOOST for alt longs (ride the wave!)
        penalty = 1.35;
        reason = `btc_pump_tailwind_strong(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      } else if (momentum === 'moderate_up') {
        // BTC rising → Moderate boost for alt longs
        penalty = 1.15;
        reason = `btc_pump_tailwind(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      } else if (momentum === 'strong_down') {
        // BTC dumping hard → Soft penalty, NOT block (still tradeable with good signal)
        penalty = 0.65;
        reason = `btc_dump_headwind(${change5m.toFixed(2)}%)`;
        impactLevel = 'medium';
      } else if (momentum === 'moderate_down') {
        // BTC declining → Very soft penalty
        penalty = 0.85;
        reason = `btc_dip_caution(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      }
    }
    
    // SHORT BIAS: BTC dump = tailwind (boost), BTC pump = headwind (soft penalty)
    if (bias === 'short' || bias === 'both') {
      if (momentum === 'strong_down') {
        // BTC dumping hard → STRONG BOOST for alt shorts (ride the dump!)
        penalty = 1.35;
        reason = `btc_dump_tailwind_strong(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      } else if (momentum === 'moderate_down') {
        // BTC declining → Moderate boost for alt shorts
        penalty = 1.15;
        reason = `btc_dump_tailwind(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      } else if (momentum === 'strong_up') {
        // BTC pumping hard → Soft penalty, NOT block (still tradeable with good signal)
        penalty = 0.65;
        reason = `btc_pump_headwind(${change5m.toFixed(2)}%)`;
        impactLevel = 'medium';
      } else if (momentum === 'moderate_up') {
        // BTC rising → Very soft penalty
        penalty = 0.85;
        reason = `btc_rise_caution(${change5m.toFixed(2)}%)`;
        impactLevel = 'low';
      }
    }
    
    return {
      btcChange5m: change5m,
      btcChange1m: change1m,
      momentum,
      shouldBlock,
      penalty,
      reason,
      impactLevel,
    };
  } catch (error) {
    console.error('[BTC Correlation] Error in detectBTCCorrelationImpact:', error);
    
    // Return neutral signal on error (don't block trades due to our own failure)
    return {
      btcChange5m: 0,
      btcChange1m: 0,
      momentum: 'neutral',
      shouldBlock: false,
      penalty: 1.0,
      reason: 'btc_check_failed',
      impactLevel: 'none',
    };
  }
}

/**
 * Clear BTC ticker cache (useful for testing)
 */
export function clearBTCCache(): void {
  btcTickerCache = null;
}
