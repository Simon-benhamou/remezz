/**
 * Flash Crash / Liquidity Vacuum Detection
 * 
 * Detects abnormal price velocity that indicates flash crashes, pump & dumps,
 * or liquidity vacuums. These events invalidate technical analysis because
 * they're driven by liquidation cascades or large market orders, not fundamentals.
 * 
 * Key indicators:
 * - Extreme price change in 1-5 minutes (> 5-10%)
 * - Price gaps (bid-ask spread > 0.5%)
 * - Volume spike (> 3x normal)
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';

export type FlashEventSignal = {
  isFlashEvent: boolean;
  eventType: 'none' | 'flash_crash' | 'flash_pump' | 'volatility_spike' | 'liquidity_gap';
  severity: 'none' | 'low' | 'medium' | 'high' | 'extreme';
  priceVelocity1m: number;        // % change in last 1 minute (estimated)
  priceVelocity5m: number;        // % change in last 5 minutes (from EMA)
  spreadBps: number;              // Bid-ask spread in basis points
  volumeSpike: number;            // Volume ratio vs MA (> 3 = spike)
  shouldBlock: boolean;           // Block all entries during flash events
  penalty: number;                // Score multiplier (0-1)
  reason: string;
  cooldownMinutes: number;        // How long to wait after flash event
};

/**
 * Estimate 1-minute price velocity from current price vs EMAs
 * Since we don't have 1m data, we estimate from EMA1 if available,
 * otherwise use distance from EMA20 as proxy
 */
function estimatePriceVelocity1m(snap: TechnicalSnapshot): number {
  const price = snap.last;
  const ema1 = Number((snap as any)?.ema1 ?? 0);
  const ema5 = Number((snap as any)?.ema5 ?? snap.ema20);
  
  if (ema1 > 0) {
    // If we have EMA1, use it
    return ((price - ema1) / ema1) * 100;
  } else if (ema5 > 0) {
    // Estimate from EMA5: divide by 5 to get ~1m velocity
    const velocity5m = ((price - ema5) / ema5) * 100;
    return velocity5m / 5;
  } else {
    // No data - assume neutral
    return 0;
  }
}

/**
 * Calculate 5-minute price velocity from EMA20 (15m data, but recent moves visible)
 */
function calculatePriceVelocity5m(snap: TechnicalSnapshot): number {
  const price = snap.last;
  const ema20 = snap.ema20;
  
  if (!ema20 || ema20 === 0) {
    return 0;
  }
  
  // Distance from EMA20 indicates recent velocity
  // For 15m timeframe, EMA20 = ~5 hour SMA
  // Recent moves show as distance from EMA
  return ((price - ema20) / ema20) * 100;
}

/**
 * Calculate bid-ask spread in basis points
 */
function calculateSpreadBps(snap: TechnicalSnapshot): number {
  const bid = Number((snap as any)?.bid ?? 0);
  const ask = Number((snap as any)?.ask ?? 0);
  const mid = (bid + ask) / 2;
  
  if (mid === 0 || bid === 0 || ask === 0) {
    return 0;
  }
  
  const spread = ask - bid;
  return (spread / mid) * 10_000; // Convert to basis points
}

/**
 * Detect volume spike vs moving average
 */
function detectVolumeSpike(snap: TechnicalSnapshot): number {
  const currentVolume = Number((snap as any)?.volume ?? 0);
  const volumeMA = Number((snap as any)?.volumeMA ?? currentVolume);
  
  if (volumeMA === 0 || currentVolume === 0) {
    return 1.0; // No spike
  }
  
  return currentVolume / volumeMA;
}

/**
 * Analyze if current market conditions indicate a flash event
 */
function analyzeFlashEvent(
  priceVelocity1m: number,
  priceVelocity5m: number,
  spreadBps: number,
  volumeSpike: number
): {
  isFlashEvent: boolean;
  eventType: FlashEventSignal['eventType'];
  severity: FlashEventSignal['severity'];
  cooldownMinutes: number;
} {
  let isFlashEvent = false;
  let eventType: FlashEventSignal['eventType'] = 'none';
  let severity: FlashEventSignal['severity'] = 'none';
  let cooldownMinutes = 0;
  
  // EXTREME FLASH CRASH (> 8% move in estimated 1m)
  if (Math.abs(priceVelocity1m) > 8 || Math.abs(priceVelocity5m) > 15) {
    isFlashEvent = true;
    eventType = priceVelocity1m < 0 || priceVelocity5m < 0 ? 'flash_crash' : 'flash_pump';
    severity = 'extreme';
    cooldownMinutes = 30; // Wait 30 minutes after extreme flash
  }
  // HIGH FLASH EVENT (> 5% move in estimated 1m)
  else if (Math.abs(priceVelocity1m) > 5 || Math.abs(priceVelocity5m) > 10) {
    isFlashEvent = true;
    eventType = priceVelocity1m < 0 || priceVelocity5m < 0 ? 'flash_crash' : 'flash_pump';
    severity = 'high';
    cooldownMinutes = 15;
  }
  // MODERATE VOLATILITY SPIKE (> 3% move + volume spike)
  else if ((Math.abs(priceVelocity1m) > 3 || Math.abs(priceVelocity5m) > 6) && volumeSpike > 3) {
    isFlashEvent = true;
    eventType = 'volatility_spike';
    severity = 'medium';
    cooldownMinutes = 10;
  }
  // LIQUIDITY GAP (spread > 50bps + moderate move)
  else if (spreadBps > 50 && Math.abs(priceVelocity5m) > 3) {
    isFlashEvent = true;
    eventType = 'liquidity_gap';
    severity = 'medium';
    cooldownMinutes = 5;
  }
  // MILD VOLATILITY (> 2% move + high volume)
  else if ((Math.abs(priceVelocity1m) > 2 || Math.abs(priceVelocity5m) > 4) && volumeSpike > 4) {
    isFlashEvent = true;
    eventType = 'volatility_spike';
    severity = 'low';
    cooldownMinutes = 5;
  }
  
  return { isFlashEvent, eventType, severity, cooldownMinutes };
}

/**
 * Calculate penalty based on flash event severity
 */
function calculatePenalty(
  isFlashEvent: boolean,
  severity: FlashEventSignal['severity']
): { shouldBlock: boolean; penalty: number; reason: string } {
  if (!isFlashEvent || severity === 'none') {
    return {
      shouldBlock: false,
      penalty: 1.0,
      reason: 'no_flash_event',
    };
  }
  
  switch (severity) {
    case 'extreme':
      // Extreme flash event - block ALL entries
      return {
        shouldBlock: true,
        penalty: 0.0,
        reason: 'flash_event_extreme',
      };
    
    case 'high':
      // High severity - block most entries
      return {
        shouldBlock: true,
        penalty: 0.0,
        reason: 'flash_event_high',
      };
    
    case 'medium':
      // Medium severity - heavy penalty
      return {
        shouldBlock: false,
        penalty: 0.3,
        reason: 'flash_event_medium',
      };
    
    case 'low':
      // Low severity - moderate penalty
      return {
        shouldBlock: false,
        penalty: 0.6,
        reason: 'flash_event_low',
      };
    
    default:
      return {
        shouldBlock: false,
        penalty: 1.0,
        reason: 'no_flash_event',
      };
  }
}

/**
 * Detect flash crash or extreme volatility events
 * 
 * @param snap - Technical snapshot
 * @returns FlashEventSignal with blocking decision
 */
export function detectFlashEvent(snap: TechnicalSnapshot): FlashEventSignal {
  try {
    // Calculate velocity metrics
    const priceVelocity1m = estimatePriceVelocity1m(snap);
    const priceVelocity5m = calculatePriceVelocity5m(snap);
    const spreadBps = calculateSpreadBps(snap);
    const volumeSpike = detectVolumeSpike(snap);
    
    // Analyze for flash event
    const { isFlashEvent, eventType, severity, cooldownMinutes } = analyzeFlashEvent(
      priceVelocity1m,
      priceVelocity5m,
      spreadBps,
      volumeSpike
    );
    
    // Calculate penalty
    const { shouldBlock, penalty, reason } = calculatePenalty(isFlashEvent, severity);
    
    // Build signal
    const signal: FlashEventSignal = {
      isFlashEvent,
      eventType,
      severity,
      priceVelocity1m,
      priceVelocity5m,
      spreadBps,
      volumeSpike,
      shouldBlock,
      penalty,
      reason,
      cooldownMinutes,
    };
    
    // Log flash events
    if (isFlashEvent && (severity === 'high' || severity === 'extreme')) {
      console.log(JSON.stringify({
        event: 'flash_event_detection',
        symbol: snap.symbol,
        eventType,
        severity,
        priceVelocity1m: priceVelocity1m.toFixed(2),
        priceVelocity5m: priceVelocity5m.toFixed(2),
        spreadBps: spreadBps.toFixed(1),
        volumeSpike: volumeSpike.toFixed(1),
        shouldBlock,
        cooldownMinutes,
      }));
    }
    
    return signal;
  } catch (error) {
    console.error('[Flash Crash] Error in detectFlashEvent:', error);
    
    // Return neutral signal on error
    return {
      isFlashEvent: false,
      eventType: 'none',
      severity: 'none',
      priceVelocity1m: 0,
      priceVelocity5m: 0,
      spreadBps: 0,
      volumeSpike: 1.0,
      shouldBlock: false,
      penalty: 1.0,
      reason: 'flash_check_failed',
      cooldownMinutes: 0,
    };
  }
}
