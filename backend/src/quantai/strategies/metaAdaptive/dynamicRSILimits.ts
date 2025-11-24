/**
 * Dynamic RSI Limits for Crypto
 * Adjusts RSI thresholds based on volume and market conditions
 */

import { getConfig } from '../utils/env.js';

const cfg = getConfig();

export interface RSILimitContext {
  volumeRatio: number;  // Current volume / average volume
  priceChange1h: number; // % change in last hour
  priceChange4h: number; // % change in last 4 hours
  hasCatalyst?: boolean; // News, listing, etc.
  symbol: string;
}

/**
 * Calculate dynamic RSI limit based on market conditions
 * 
 * Logic:
 * - Normal market: RSI < 65 (conservative)
 * - High volume (3x): RSI < 85 (momentum detected)
 * - Extreme volume (5x+): RSI < 95 (parabolic move)
 * - With catalyst: No RSI limit (narrative-driven)
 * 
 * @param bias - 'long' or 'short'
 * @param context - Market context for dynamic adjustment
 * @returns Maximum allowed RSI for entry
 */
export function getDynamicRSILimit(
  bias: 'long' | 'short',
  context: RSILimitContext
): number {
  const useDynamic = cfg.USE_DYNAMIC_RSI_LIMITS ?? true;
  
  // If dynamic RSI disabled, use static limits
  if (!useDynamic) {
    return bias === 'long' 
      ? (cfg.ENTRY_LONG_MAX_RSI || 65)
      : 100 - (cfg.ENTRY_SHORT_MIN_RSI || 45);
  }

  // For long positions
  if (bias === 'long') {
    const normalLimit = cfg.ENTRY_LONG_MAX_RSI_NORMAL || 65;
    const highVolumeLimit = cfg.ENTRY_LONG_MAX_RSI_HIGH_VOLUME || 85;
    const extremeVolumeLimit = cfg.ENTRY_LONG_MAX_RSI_EXTREME_VOLUME || 95;
    
    const highVolThreshold = cfg.RSI_VOLUME_THRESHOLD_HIGH || 3.0;
    const extremeVolThreshold = cfg.RSI_VOLUME_THRESHOLD_EXTREME || 5.0;
    
    // CATALYST DETECTED: No RSI limit (news-driven moves)
    if (context.hasCatalyst) {
      console.log(`🔥 Catalyst detected for ${context.symbol} - RSI limit removed`);
      return 100;
    }
    
    // EXTREME VOLUME: Parabolic move detected
    if (context.volumeRatio >= extremeVolThreshold) {
      console.log(`🚀 Extreme volume (${context.volumeRatio.toFixed(1)}x) - RSI limit: ${extremeVolumeLimit}`);
      return extremeVolumeLimit;
    }
    
    // HIGH VOLUME: Strong momentum
    if (context.volumeRatio >= highVolThreshold) {
      console.log(`📈 High volume (${context.volumeRatio.toFixed(1)}x) - RSI limit: ${highVolumeLimit}`);
      return highVolumeLimit;
    }
    
    // NORMAL VOLUME: Conservative approach
    console.log(`📊 Normal volume (${context.volumeRatio.toFixed(1)}x) - RSI limit: ${normalLimit}`);
    return normalLimit;
  } 
  
  // For short positions (inverse logic - lower RSI for dumps)
  else {
    const normalLimit = cfg.ENTRY_SHORT_MIN_RSI_NORMAL || cfg.ENTRY_SHORT_MIN_RSI || 45;
    const highVolumeLimit = cfg.ENTRY_SHORT_MIN_RSI_HIGH_VOLUME || 15;
    const extremeVolumeLimit = cfg.ENTRY_SHORT_MIN_RSI_EXTREME_VOLUME || 5;
    
    const highVolThreshold = cfg.RSI_VOLUME_THRESHOLD_HIGH || 3.0;
    const extremeVolThreshold = cfg.RSI_VOLUME_THRESHOLD_EXTREME || 5.0;
    
    // CATALYST DETECTED: No RSI limit (crash/dump events)
    if (context.hasCatalyst) {
      console.log(`🔥 Catalyst detected for ${context.symbol} - RSI limit removed (short)`);
      return 0;
    }
    
    // EXTREME VOLUME: Parabolic dump detected
    if (context.volumeRatio >= extremeVolThreshold) {
      console.log(`📉 Extreme volume (${context.volumeRatio.toFixed(1)}x) - RSI min: ${extremeVolumeLimit}`);
      return extremeVolumeLimit;
    }
    
    // HIGH VOLUME: Strong downward momentum
    if (context.volumeRatio >= highVolThreshold) {
      console.log(`📉 High volume (${context.volumeRatio.toFixed(1)}x) - RSI min: ${highVolumeLimit}`);
      return highVolumeLimit;
    }
    
    // NORMAL VOLUME: Conservative approach
    console.log(`📊 Normal volume (${context.volumeRatio.toFixed(1)}x) - RSI min: ${normalLimit}`);
    return normalLimit;
  }
}

/**
 * Check if RSI passes dynamic threshold
 * 
 * @param rsi - Current RSI value
 * @param bias - 'long' or 'short'
 * @param context - Market context
 * @returns true if RSI is within acceptable range
 */
export function checkDynamicRSI(
  rsi: number,
  bias: 'long' | 'short',
  context: RSILimitContext
): { pass: boolean; limit: number; reason: string } {
  const limit = getDynamicRSILimit(bias, context);
  
  if (bias === 'long') {
    const pass = rsi <= limit;
    const reason = pass
      ? `RSI ${rsi.toFixed(1)} <= ${limit} (${getVolumeCategory(context.volumeRatio)})`
      : `RSI ${rsi.toFixed(1)} > ${limit} (${getVolumeCategory(context.volumeRatio)}) - Too overbought`;
    
    return { pass, limit, reason };
  } else {
    const pass = rsi >= limit;
    const reason = pass
      ? `RSI ${rsi.toFixed(1)} >= ${limit} (${getVolumeCategory(context.volumeRatio)})`
      : `RSI ${rsi.toFixed(1)} < ${limit} (${getVolumeCategory(context.volumeRatio)}) - Too oversold`;
    
    return { pass, limit, reason };
  }
}

function getVolumeCategory(volumeRatio: number): string {
  const extremeThreshold = cfg.RSI_VOLUME_THRESHOLD_EXTREME || 5.0;
  const highThreshold = cfg.RSI_VOLUME_THRESHOLD_HIGH || 3.0;
  
  if (volumeRatio >= extremeThreshold) return 'extreme volume';
  if (volumeRatio >= highThreshold) return 'high volume';
  return 'normal volume';
}

/**
 * Detect potential catalyst from price action
 * 
 * Heuristic detection:
 * - Large 1h move (>5%) + extreme volume (>5x) = likely catalyst
 * - Large 4h move (>15%) + high volume (>3x) = likely catalyst
 * 
 * @param context - Market context
 * @returns true if catalyst likely present
 */
export function detectCatalyst(context: RSILimitContext): boolean {
  const extremeVolThreshold = cfg.RSI_VOLUME_THRESHOLD_EXTREME || 5.0;
  const highVolThreshold = cfg.RSI_VOLUME_THRESHOLD_HIGH || 3.0;
  
  // Extreme 1h move + extreme volume = catalyst
  if (Math.abs(context.priceChange1h) > 5 && context.volumeRatio >= extremeVolThreshold) {
    console.log(`🔥 Catalyst detected: ${Math.abs(context.priceChange1h).toFixed(1)}% 1h move + ${context.volumeRatio.toFixed(1)}x volume`);
    return true;
  }
  
  // Large 4h move + high volume = catalyst
  if (Math.abs(context.priceChange4h) > 15 && context.volumeRatio >= highVolThreshold) {
    console.log(`🔥 Catalyst detected: ${Math.abs(context.priceChange4h).toFixed(1)}% 4h move + ${context.volumeRatio.toFixed(1)}x volume`);
    return true;
  }
  
  return false;
}

/**
 * Get adjusted risk parameters for high RSI entries
 * 
 * When entering at RSI 85-95, use tighter risk management:
 * - Smaller position size
 * - Tighter stop loss
 * - Quicker profit targets
 * 
 * @param rsi - Current RSI
 * @param normalRisk - Normal risk percentage
 * @returns Adjusted risk parameters
 */
export function getHighRSIRiskAdjustment(
  rsi: number,
  normalRisk: number
): {
  riskMultiplier: number;
  stopMultiplier: number;
  targetMultiplier: number;
  reasoning: string;
} {
  if (rsi < 75) {
    return {
      riskMultiplier: 1.0,
      stopMultiplier: 1.0,
      targetMultiplier: 1.0,
      reasoning: 'Normal RSI - standard risk parameters',
    };
  }
  
  if (rsi < 85) {
    return {
      riskMultiplier: 0.75,
      stopMultiplier: 0.8,
      targetMultiplier: 0.85,
      reasoning: 'Elevated RSI (75-85) - slightly reduced risk',
    };
  }
  
  if (rsi < 95) {
    return {
      riskMultiplier: 0.5,
      stopMultiplier: 0.6,
      targetMultiplier: 0.7,
      reasoning: 'High RSI (85-95) - reduced position, tight stop',
    };
  }
  
  // RSI 95+
  return {
    riskMultiplier: 0.35,
    stopMultiplier: 0.5,
    targetMultiplier: 0.6,
    reasoning: 'Extreme RSI (95+) - minimal position, very tight stop',
  };
}

/**
 * Example usage:
 * 
 * const context: RSILimitContext = {
 *   volumeRatio: 6.5,
 *   priceChange1h: 8.2,
 *   priceChange4h: 15.3,
 *   hasCatalyst: detectCatalyst(context),
 *   symbol: 'XRP/USDT',
 * };
 * 
 * const check = checkDynamicRSI(94, 'long', context);
 * console.log(check.pass); // true (with extreme volume)
 * console.log(check.reason); // "RSI 94.0 <= 95 (extreme volume)"
 */
