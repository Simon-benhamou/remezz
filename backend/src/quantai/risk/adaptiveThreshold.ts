/**
 * Adaptive Confidence Threshold System
 * 
 * Dynamically adjusts minimum confidence requirements based on:
 * - Capital usage (how much allocated)
 * - Market conditions (RSI extremes, volatility)
 * - Trend strength (ADX)
 * - Market regime (volatile vs stable)
 * 
 * Goal: Lower thresholds in CLEAR extreme conditions (RSI<25, RSI>75)
 *       to capture high-probability mean reversion opportunities
 */

export interface AdaptiveThresholdContext {
  usageRatio: number;      // 0.0 - 1.0 (capital used / total)
  rsi: number;             // 0 - 100
  atr: number;             // ATR in percentage terms
  adx: number;             // 0 - 100
  regime: string;          // 'volatile' | 'trending' | 'ranging' | 'stable'
  volumeRatio?: number;    // Recent volume / average volume
  totalCapital: number;    // Account size category
}

export interface AdaptiveThresholdResult {
  minConfidence: number;
  baseThreshold: number;
  adjustments: {
    capitalPenalty: number;
    rsiBoost: number;
    trendBoost: number;
    volatilityAdjust: number;
    regimeAdjust: number;
  };
  reason: string;
}

/**
 * Calculate adaptive minimum confidence threshold
 */
export function calculateMinConfidence(context: AdaptiveThresholdContext): AdaptiveThresholdResult {
  let base = 0.35; // Default base threshold (was 0.45 with penalty)
  const adjustments = {
    capitalPenalty: 0,
    rsiBoost: 0,
    trendBoost: 0,
    volatilityAdjust: 0,
    regimeAdjust: 0,
  };
  const reasons: string[] = [];

  // 1. Capital usage penalty (REDUCED from 0.10 to 0.05)
  if (context.usageRatio > 0.7) {
    adjustments.capitalPenalty = 0.05; // Reduced penalty
    base += adjustments.capitalPenalty;
    reasons.push(`capital_usage_${(context.usageRatio * 100).toFixed(0)}%`);
  }

  // 2. 🔥 RSI EXTREME CONDITIONS = REDUCE THRESHOLD
  // When RSI < 25 (extreme oversold) or > 75 (extreme overbought)
  // These are HIGH PROBABILITY mean reversion setups
  if (context.rsi < 25) {
    adjustments.rsiBoost = -0.15; // REDUCE threshold by 15%
    base = Math.max(0.25, base + adjustments.rsiBoost);
    reasons.push(`extreme_oversold_RSI${context.rsi.toFixed(0)}`);
  } else if (context.rsi > 75) {
    adjustments.rsiBoost = -0.15; // REDUCE threshold by 15%
    base = Math.max(0.25, base + adjustments.rsiBoost);
    reasons.push(`extreme_overbought_RSI${context.rsi.toFixed(0)}`);
  } else if (context.rsi < 30) {
    adjustments.rsiBoost = -0.08; // Moderate oversold
    base = Math.max(0.28, base + adjustments.rsiBoost);
    reasons.push(`oversold_RSI${context.rsi.toFixed(0)}`);
  } else if (context.rsi > 70) {
    adjustments.rsiBoost = -0.08; // Moderate overbought
    base = Math.max(0.28, base + adjustments.rsiBoost);
    reasons.push(`overbought_RSI${context.rsi.toFixed(0)}`);
  }

  // 3. TREND STRENGTH (ADX) = Clear direction
  if (context.adx > 40) {
    adjustments.trendBoost = -0.10; // Strong trend = lower threshold
    base = Math.max(0.30, base + adjustments.trendBoost);
    reasons.push(`strong_trend_ADX${context.adx.toFixed(0)}`);
  } else if (context.adx > 30) {
    adjustments.trendBoost = -0.05; // Moderate trend
    base = Math.max(0.32, base + adjustments.trendBoost);
    reasons.push(`moderate_trend_ADX${context.adx.toFixed(0)}`);
  }

  // 4. VOLATILITY + TREND = Opportunity (not threat)
  // High ATR (>100%) with clear trend (ADX>35) = REDUCE threshold
  if (context.atr > 100 && context.adx > 35) {
    adjustments.volatilityAdjust = -0.12; // Volatile but trending = opportunity
    base = Math.max(0.28, base + adjustments.volatilityAdjust);
    reasons.push(`high_vol_trending_ATR${context.atr.toFixed(0)}`);
  } else if (context.atr > 100 && context.adx < 25) {
    adjustments.volatilityAdjust = 0.05; // Volatile + no trend = increase threshold
    base += adjustments.volatilityAdjust;
    reasons.push(`high_vol_no_trend_ATR${context.atr.toFixed(0)}`);
  }

  // 5. REGIME adjustments
  if (context.regime === 'volatile' && context.adx > 30) {
    // Volatile but with trend = OK to trade
    adjustments.regimeAdjust = -0.08;
    base = Math.max(0.32, base + adjustments.regimeAdjust);
    reasons.push('volatile_regime_with_trend');
  } else if (context.regime === 'ranging' && context.adx < 20) {
    // Ranging without trend = increase threshold
    adjustments.regimeAdjust = 0.05;
    base += adjustments.regimeAdjust;
    reasons.push('ranging_no_trend');
  }

  // 6. VOLUME confirmation (if available)
  if (context.volumeRatio && context.volumeRatio > 2.5) {
    adjustments.volatilityAdjust -= 0.03; // Volume spike = confirmation
    base = Math.max(0.25, base - 0.03);
    reasons.push(`volume_spike_${context.volumeRatio.toFixed(1)}x`);
  }

  // Final bounds: 0.25 (absolute minimum) to 0.55 (absolute maximum)
  const minConfidence = Math.max(0.25, Math.min(0.55, base));
  
  const reason = reasons.length > 0 
    ? reasons.join(', ') 
    : 'normal_conditions';

  return {
    minConfidence,
    baseThreshold: 0.35,
    adjustments,
    reason,
  };
}

/**
 * Boost predictor confidence for extreme conditions
 * 
 * When technical indicators show CLEAR signals (RSI extremes, divergence, volume)
 * multiply the base confidence to reflect higher probability
 */
export function boostConfidenceForExtremeConditions(
  baseConfidence: number,
  context: {
    rsi: number;
    rsiDivergence?: number;
    volumeRatio?: number;
    adx: number;
  }
): { boostedConfidence: number; boostFactor: number; reason: string } {
  let boostFactor = 1.0;
  const reasons: string[] = [];

  // RSI extreme oversold/overbought
  if (context.rsi < 25) {
    boostFactor *= 1.4; // +40% for extreme oversold
    reasons.push('extreme_oversold');
  } else if (context.rsi > 75) {
    boostFactor *= 1.4; // +40% for extreme overbought
    reasons.push('extreme_overbought');
  } else if (context.rsi < 30) {
    boostFactor *= 1.2; // +20% for oversold
    reasons.push('oversold');
  } else if (context.rsi > 70) {
    boostFactor *= 1.2; // +20% for overbought
    reasons.push('overbought');
  }

  // RSI divergence = strong reversal signal
  if (context.rsiDivergence && context.rsiDivergence > 0.6) {
    boostFactor *= 1.3; // +30% for divergence
    reasons.push('rsi_divergence');
  }

  // Volume confirmation
  if (context.volumeRatio && context.volumeRatio > 2.5) {
    boostFactor *= 1.2; // +20% for volume spike
    reasons.push('volume_spike');
  }

  // Strong trend (ADX > 40)
  if (context.adx > 40) {
    boostFactor *= 1.25; // +25% for strong trend
    reasons.push('strong_trend');
  }

  const boostedConfidence = Math.min(0.95, baseConfidence * boostFactor); // Cap at 95%
  const reason = reasons.length > 0 ? reasons.join(', ') : 'no_boost';

  return {
    boostedConfidence,
    boostFactor,
    reason,
  };
}

/**
 * Check if conditions are so extreme that we should override normal filters
 * "Panic Mode" for crash/moonshot scenarios
 */
export function shouldOverrideFilters(context: {
  rsi: number;
  change24h: number;
  atr: number;
  volume: number;
}): { override: boolean; reason: string } {
  // Extreme oversold (potential crash bottom)
  if (context.rsi < 20) {
    return { override: true, reason: 'extreme_oversold_panic' };
  }

  // Extreme overbought (potential moonshot)
  if (context.rsi > 80) {
    return { override: true, reason: 'extreme_overbought_panic' };
  }

  // Market crash (-15%+ in 24h with high vol)
  if (context.change24h < -15 && context.atr > 120) {
    return { override: true, reason: 'crash_detected' };
  }

  // Moonshot (+20%+ in 24h with high vol)
  if (context.change24h > 20 && context.volume > 3.0) {
    return { override: true, reason: 'moonshot_detected' };
  }

  return { override: false, reason: 'normal_conditions' };
}
