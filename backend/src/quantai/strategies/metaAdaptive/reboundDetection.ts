/**
 * Rebound Detection Module
 * 
 * Detects potential price rebounds that could invalidate short positions
 * or provide long opportunities. Uses RSI, price structure, volume, and
 * momentum indicators to assess rebound probability.
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';

export type ReboundSignal = {
  probability: number; // 0-1, higher = more likely rebound
  severity: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  shouldBlock: boolean;
  tradeBias: 'avoid_short' | 'favor_long' | 'neutral';
  components: {
    rsi: number;
    priceStructure: number;
    volume: number;
    momentum: number;
  };
};

/**
 * Detect potential rebounds for SHORT positions
 * Returns high probability when conditions favor a bounce that would hurt shorts
 */
export function detectReboundForShort(snap: TechnicalSnapshot): ReboundSignal {
  const components = {
    rsi: 0,
    priceStructure: 0,
    volume: 0,
    momentum: 0,
  };
  
  const reasons: string[] = [];
  
  // 1. RSI OVERSOLD DETECTION (STRENGTHENED)
  const rsi14 = Number((snap as any)?.rsi14 ?? 50);
  const rsi7 = Number((snap as any)?.rsi7 ?? rsi14);
  
  if (rsi14 < 25) {
    components.rsi = 0.95; // Extreme oversold - VERY high rebound risk (was 0.9)
    reasons.push(`rsi14_extreme_oversold(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 30) {
    components.rsi = 0.75; // Oversold - high rebound risk (was 0.7)
    reasons.push(`rsi14_oversold(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 35) {
    components.rsi = 0.55; // Approaching oversold (was 0.5)
    reasons.push(`rsi14_low(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 40) {
    components.rsi = 0.35; // Mild weakness (was 0.3)
    reasons.push(`rsi14_weak(${rsi14.toFixed(1)})`);
  } else if (rsi14 < 45) {
    // 🔥 NEW TIER: Early warning for potential rebounds
    components.rsi = 0.2;
    reasons.push(`rsi14_bearish_weakening(${rsi14.toFixed(1)})`);
  } else {
    components.rsi = 0.05; // No RSI concern (was 0.1)
  }
  
  // RSI divergence: price making lower lows but RSI making higher lows = bullish divergence
  const rsiSlope = Number((snap as any)?.rsiSlope ?? 0);
  if (rsi14 < 40 && rsiSlope > 1.5) {
    // 🔥 EXPANDED: Detect divergence earlier (was rsi14 < 35)
    components.rsi = Math.min(1, components.rsi + 0.25); // Stronger signal (was 0.2)
    reasons.push('rsi_bullish_divergence_detected');
  }
  
  // 2. PRICE STRUCTURE (Distance from EMAs)
  const price = snap.last;
  const ema20 = Number((snap as any)?.ema20 ?? price);
  const ema50 = Number((snap as any)?.ema50 ?? price);
  const ema200 = Number((snap as any)?.ema200 ?? price);
  
  // Calculate distance below EMA20 (key support level)
  let distBelowEma20 = 0;
  if (price > 0 && ema20 > 0 && price < ema20) {
    distBelowEma20 = ((ema20 - price) / price) * 100;
  }
  
  if (distBelowEma20 > 3) {
    components.priceStructure = 0.8; // Far from EMA20, likely to bounce
    reasons.push(`stretched_below_ema20(-${distBelowEma20.toFixed(1)}%)`);
  } else if (distBelowEma20 > 2) {
    components.priceStructure = 0.6;
    reasons.push(`extended_below_ema20(-${distBelowEma20.toFixed(1)}%)`);
  } else if (distBelowEma20 > 1) {
    components.priceStructure = 0.4;
    reasons.push(`below_ema20(-${distBelowEma20.toFixed(1)}%)`);
  }
  
  // Check if price near EMA50 support
  if (price > 0 && ema50 > 0) {
    const distToEma50 = Math.abs((price - ema50) / price) * 100;
    if (distToEma50 < 0.5 && price < ema50 * 1.01) {
      components.priceStructure = Math.min(1, components.priceStructure + 0.2);
      reasons.push('near_ema50_support');
    }
  }
  
  // Check if price near EMA200 major support
  if (price > 0 && ema200 > 0) {
    const distToEma200 = Math.abs((price - ema200) / price) * 100;
    if (distToEma200 < 1 && price < ema200 * 1.01) {
      components.priceStructure = Math.min(1, components.priceStructure + 0.3);
      reasons.push('near_ema200_major_support');
    }
  }
  
  // 3. VOLUME ANALYSIS
  const volumeRatio = Number((snap as any)?.volumeRatio ?? 1);
  const cmf = Number((snap as any)?.cmf20 ?? 0);
  
  // Low volume on downmove = weak selling pressure = likely bounce
  if (volumeRatio < 0.7 && cmf < 0) {
    components.volume = 0.6;
    reasons.push('low_volume_downmove');
  } else if (volumeRatio < 0.9) {
    components.volume = 0.3;
    reasons.push('declining_volume');
  }
  
  // Positive CMF despite downtrend = hidden buying pressure
  if (cmf > 0.05 && price < ema20) {
    components.volume = Math.min(1, components.volume + 0.3);
    reasons.push('positive_cmf_on_dip');
  }
  
  // 4. MOMENTUM CHECKS
  const adx = snap.adx14;
  const trend = Number((snap as any)?.trend ?? 0);
  
  // Weak ADX = choppy market = rebounds likely
  if (adx < 15) {
    components.momentum = 0.6;
    reasons.push(`weak_momentum(adx=${adx.toFixed(1)})`);
  } else if (adx < 20) {
    components.momentum = 0.4;
    reasons.push(`moderate_momentum(adx=${adx.toFixed(1)})`);
  }
  
  // Trend weakening = potential reversal
  if (trend < -0.4 && rsiSlope > 0) {
    components.momentum = Math.min(1, components.momentum + 0.2);
    reasons.push('trend_weakening');
  }
  
  // COMPOSITE SCORE
  const weights = {
    rsi: 0.35,          // RSI is primary rebound indicator
    priceStructure: 0.30, // Price structure is critical
    volume: 0.20,       // Volume confirms
    momentum: 0.15,     // Momentum context
  };
  
  const probability = 
    components.rsi * weights.rsi +
    components.priceStructure * weights.priceStructure +
    components.volume * weights.volume +
    components.momentum * weights.momentum;
  
  // DETERMINE SEVERITY
  let severity: 'low' | 'medium' | 'high' | 'critical';
  if (probability >= 0.75) {
    severity = 'critical';
  } else if (probability >= 0.6) {
    severity = 'high';
  } else if (probability >= 0.4) {
    severity = 'medium';
  } else {
    severity = 'low';
  }
  
  // BLOCKING DECISION
  // Block shorts when rebound probability is high
  const shouldBlock = probability >= 0.6 || (rsi14 < 25 && components.priceStructure >= 0.6);
  
  // TRADE BIAS
  let tradeBias: 'avoid_short' | 'favor_long' | 'neutral';
  if (probability >= 0.65) {
    tradeBias = 'favor_long'; // Actually favor long entries on rebounds
  } else if (probability >= 0.45) {
    tradeBias = 'avoid_short'; // Avoid shorts, but not ready for longs
  } else {
    tradeBias = 'neutral';
  }
  
  return {
    probability: Number(probability.toFixed(4)),
    severity,
    reasons,
    shouldBlock,
    tradeBias,
    components,
  };
}

/**
 * Detect potential reversals for LONG positions
 * Returns high probability when conditions favor a dump that would hurt longs
 */
export function detectReversalForLong(snap: TechnicalSnapshot): ReboundSignal {
  const components = {
    rsi: 0,
    priceStructure: 0,
    volume: 0,
    momentum: 0,
  };
  
  const reasons: string[] = [];
  
  // 1. RSI OVERBOUGHT DETECTION
  const rsi14 = Number((snap as any)?.rsi14 ?? 50);
  const rsi7 = Number((snap as any)?.rsi7 ?? rsi14);
  
  if (rsi14 > 75) {
    components.rsi = 0.9; // Extreme overbought
    reasons.push(`rsi14_extreme_overbought(${rsi14.toFixed(1)})`);
  } else if (rsi14 > 70) {
    components.rsi = 0.7; // Overbought
    reasons.push(`rsi14_overbought(${rsi14.toFixed(1)})`);
  } else if (rsi14 > 65) {
    components.rsi = 0.5;
    reasons.push(`rsi14_high(${rsi14.toFixed(1)})`);
  } else if (rsi14 > 60) {
    components.rsi = 0.3;
    reasons.push(`rsi14_elevated(${rsi14.toFixed(1)})`);
  }
  
  // RSI bearish divergence
  const rsiSlope = Number((snap as any)?.rsiSlope ?? 0);
  if (rsi14 > 65 && rsiSlope < -1.5) {
    components.rsi = Math.min(1, components.rsi + 0.2);
    reasons.push('rsi_bearish_divergence_detected');
  }
  
  // 2. PRICE STRUCTURE
  const price = snap.last;
  const ema20 = Number((snap as any)?.ema20 ?? price);
  const ema50 = Number((snap as any)?.ema50 ?? price);
  
  let distAboveEma20 = 0;
  if (price > 0 && ema20 > 0 && price > ema20) {
    distAboveEma20 = ((price - ema20) / price) * 100;
  }
  
  if (distAboveEma20 > 3) {
    components.priceStructure = 0.8;
    reasons.push(`stretched_above_ema20(+${distAboveEma20.toFixed(1)}%)`);
  } else if (distAboveEma20 > 2) {
    components.priceStructure = 0.6;
    reasons.push(`extended_above_ema20(+${distAboveEma20.toFixed(1)}%)`);
  } else if (distAboveEma20 > 1) {
    components.priceStructure = 0.4;
    reasons.push(`above_ema20(+${distAboveEma20.toFixed(1)}%)`);
  }
  
  // 3. VOLUME
  const volumeRatio = Number((snap as any)?.volumeRatio ?? 1);
  const cmf = Number((snap as any)?.cmf20 ?? 0);
  
  if (volumeRatio < 0.7 && cmf > 0) {
    components.volume = 0.6;
    reasons.push('low_volume_rally');
  }
  
  if (cmf < -0.05 && price > ema20) {
    components.volume = Math.min(1, components.volume + 0.3);
    reasons.push('negative_cmf_on_rally');
  }
  
  // 4. MOMENTUM
  const adx = snap.adx14;
  
  if (adx < 15) {
    components.momentum = 0.6;
    reasons.push(`weak_momentum(adx=${adx.toFixed(1)})`);
  } else if (adx < 20) {
    components.momentum = 0.4;
    reasons.push(`moderate_momentum(adx=${adx.toFixed(1)})`);
  }
  
  const probability = 
    components.rsi * 0.35 +
    components.priceStructure * 0.30 +
    components.volume * 0.20 +
    components.momentum * 0.15;
  
  let severity: 'low' | 'medium' | 'high' | 'critical';
  if (probability >= 0.75) severity = 'critical';
  else if (probability >= 0.6) severity = 'high';
  else if (probability >= 0.4) severity = 'medium';
  else severity = 'low';
  
  const shouldBlock = probability >= 0.6 || (rsi14 > 75 && components.priceStructure >= 0.6);
  
  let tradeBias: 'avoid_short' | 'favor_long' | 'neutral';
  if (probability >= 0.65) {
    tradeBias = 'avoid_short'; // Should be 'favor_short' but keeping API consistent
  } else if (probability >= 0.45) {
    tradeBias = 'neutral';
  } else {
    tradeBias = 'favor_long';
  }
  
  return {
    probability: Number(probability.toFixed(4)),
    severity,
    reasons,
    shouldBlock,
    tradeBias,
    components,
  };
}

/**
 * Detect Bollinger Band squeeze - low volatility that precedes expansion
 * Avoid entries during squeeze as direction is unpredictable
 */
export function detectVolatilitySqueeze(snap: TechnicalSnapshot): {
  isSqueezed: boolean;
  severity: 'none' | 'mild' | 'moderate' | 'extreme';
  bbWidth: number | null;
  reasons: string[];
} {
  const reasons: string[] = [];
  
  // Use ATR as proxy for BB width if BBs not available
  const atr14 = snap.atr14;
  const price = snap.last;
  
  if (!atr14 || price <= 0) {
    return { isSqueezed: false, severity: 'none', bbWidth: null, reasons: ['no_atr_data'] };
  }
  
  const atrPct = (atr14 / price) * 100;
  
  // Low ATR% indicates squeeze
  let isSqueezed = false;
  let severity: 'none' | 'mild' | 'moderate' | 'extreme' = 'none';
  
  if (atrPct < 0.8) {
    isSqueezed = true;
    severity = 'extreme';
    reasons.push(`extreme_squeeze(atr=${atrPct.toFixed(2)}%)`);
  } else if (atrPct < 1.2) {
    isSqueezed = true;
    severity = 'moderate';
    reasons.push(`moderate_squeeze(atr=${atrPct.toFixed(2)}%)`);
  } else if (atrPct < 1.5) {
    isSqueezed = true;
    severity = 'mild';
    reasons.push(`mild_squeeze(atr=${atrPct.toFixed(2)}%)`);
  } else {
    reasons.push(`normal_volatility(atr=${atrPct.toFixed(2)}%)`);
  }
  
  // Check ADX - low ADX during squeeze = direction unclear
  const adx = snap.adx14;
  if (isSqueezed && adx < 18) {
    reasons.push('low_adx_during_squeeze');
  }
  
  return {
    isSqueezed,
    severity,
    bbWidth: atrPct,
    reasons,
  };
}
