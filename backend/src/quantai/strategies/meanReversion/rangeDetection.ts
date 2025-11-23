/**
 * MEAN REVERSION STRATEGY - RANGE DETECTION
 * 
 * Détecte les ranges horizontaux et identifie support/résistance
 * pour trader les bounces (acheter au support, vendre à la résistance)
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';

export type RangeLevel = {
  price: number;
  strength: number; // 0-1: Nombre de touches/rebonds
  touches: number;
  type: 'support' | 'resistance';
  confidence: number; // 0-1: Fiabilité du niveau
};

export type RangeStructure = {
  inRange: boolean;
  support: RangeLevel | null;
  resistance: RangeLevel | null;
  rangeWidth: number; // % width du range
  rangeMiddle: number;
  rangeAge: number; // Combien de temps dans ce range (estimation)
  rangeQuality: 'excellent' | 'good' | 'poor'; // Qualité du range pour mean reversion
  reason: string;
};

/**
 * Détecte si le prix est dans un range horizontal et identifie les niveaux
 */
export function detectRange(
  snap: TechnicalSnapshot,
  priceHistory?: number[] // Optional: historical prices for better detection
): RangeStructure {
  
  const price = snap.last;
  const atrPct = snap.atrPct || 0;
  const adx = snap.adx14 || 0;
  const ema20 = snap.ema20;
  const ema50 = snap.ema50;
  const ema100 = snap.ema100;
  const bbUpper = (snap as any).bbUpper;
  const bbLower = (snap as any).bbLower;
  const bbWidth = (snap as any).bbWidth;
  
  // 1. Check if market conditions favor range-bound behavior
  const isLowVolatility = atrPct < 0.8;
  const isLowMomentum = adx < 25;
  const emaCompression = ema20 && ema50 && ema100
    ? ((Math.max(ema20, ema50, ema100) - Math.min(ema20, ema50, ema100)) / ((ema20 + ema50 + ema100) / 3)) * 100
    : 999;
  const emasFlat = emaCompression < 3.5;
  
  // 2. Check Bollinger Band squeeze (indicateur de range)
  const bbSqueeze = bbWidth !== undefined && bbWidth < 0.04; // BB width < 4%
  
  // Range confidence: Plus de critères = plus confiant
  let rangeConfidence = 0;
  if (isLowVolatility) rangeConfidence += 0.3;
  if (isLowMomentum) rangeConfidence += 0.25;
  if (emasFlat) rangeConfidence += 0.25;
  if (bbSqueeze) rangeConfidence += 0.2;
  
  const inRange = rangeConfidence >= 0.5;
  
  if (!inRange) {
    return {
      inRange: false,
      support: null,
      resistance: null,
      rangeWidth: 0,
      rangeMiddle: price,
      rangeAge: 0,
      rangeQuality: 'poor',
      reason: `Not in range (ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, EMA compression ${emaCompression.toFixed(1)}%)`,
    };
  }
  
  // 3. Identify support/resistance levels
  // Use Bollinger Bands as proxy for range bounds if available
  let supportPrice: number;
  let resistancePrice: number;
  
  if (bbLower && bbUpper) {
    supportPrice = bbLower;
    resistancePrice = bbUpper;
  } else {
    // Fallback: Use EMA50 +/- ATR as approximate range
    const ema = ema50 || price;
    const atr = (snap.atr14 || price * 0.02);
    supportPrice = ema - atr * 2;
    resistancePrice = ema + atr * 2;
  }
  
  const rangeWidth = ((resistancePrice - supportPrice) / supportPrice) * 100;
  const rangeMiddle = (supportPrice + resistancePrice) / 2;
  
  // 4. Estimate touches/strength (simplified - ideally use price history)
  // Distance from current price to levels indicates potential touches
  const distanceToSupport = ((price - supportPrice) / supportPrice) * 100;
  const distanceToResistance = ((resistancePrice - price) / price) * 100;
  
  // Close to level = likely touched recently
  const supportTouches = distanceToSupport < 1 ? 5 : distanceToSupport < 2 ? 3 : 1;
  const resistanceTouches = distanceToResistance < 1 ? 5 : distanceToResistance < 2 ? 3 : 1;
  
  const support: RangeLevel = {
    price: supportPrice,
    strength: Math.min(1, supportTouches / 5),
    touches: supportTouches,
    type: 'support',
    confidence: rangeConfidence,
  };
  
  const resistance: RangeLevel = {
    price: resistancePrice,
    strength: Math.min(1, resistanceTouches / 5),
    touches: resistanceTouches,
    type: 'resistance',
    confidence: rangeConfidence,
  };
  
  // 5. Assess range quality for mean reversion
  let rangeQuality: 'excellent' | 'good' | 'poor' = 'poor';
  
  if (rangeConfidence >= 0.75 && rangeWidth >= 3 && rangeWidth <= 15) {
    rangeQuality = 'excellent'; // Strong range, good width
  } else if (rangeConfidence >= 0.6 && rangeWidth >= 2 && rangeWidth <= 20) {
    rangeQuality = 'good'; // Decent range
  }
  
  // 6. Estimate range age (how long price has been ranging)
  // Use ADX decline as proxy - lower ADX = longer ranging
  const rangeAge = adx < 15 ? 10 : adx < 20 ? 5 : 1; // Days estimate
  
  return {
    inRange,
    support,
    resistance,
    rangeWidth,
    rangeMiddle,
    rangeAge,
    rangeQuality,
    reason: `Range detected (${rangeWidth.toFixed(1)}% width, support $${supportPrice.toFixed(4)}, resistance $${resistancePrice.toFixed(4)}, confidence ${(rangeConfidence * 100).toFixed(0)}%)`,
  };
}

/**
 * Détermine si on est proche d'un niveau clé pour mean reversion entry
 */
export function isNearRangeLevel(
  price: number,
  level: RangeLevel,
  tolerance: number = 0.5 // % tolerance
): { near: boolean; distance: number; side: 'above' | 'below' | 'at' } {
  const distance = ((price - level.price) / level.price) * 100;
  const absDistance = Math.abs(distance);
  
  return {
    near: absDistance <= tolerance,
    distance: absDistance,
    side: distance > 0.1 ? 'above' : distance < -0.1 ? 'below' : 'at',
  };
}

/**
 * Calculate optimal entry/exit prices for mean reversion
 */
export function calculateMeanReversionLevels(range: RangeStructure): {
  longEntry: number;
  longTarget: number;
  longStop: number;
  shortEntry: number;
  shortTarget: number;
  shortStop: number;
} | null {
  
  if (!range.inRange || !range.support || !range.resistance) {
    return null;
  }
  
  const rangeSize = range.resistance.price - range.support.price;
  const buffer = rangeSize * 0.05; // 5% buffer inside range
  
  return {
    // LONG setup: Buy near support, sell near middle
    longEntry: range.support.price + buffer,
    longTarget: range.rangeMiddle,
    longStop: range.support.price - buffer * 2, // Stop below support
    
    // SHORT setup: Sell near resistance, buy near middle
    shortEntry: range.resistance.price - buffer,
    shortTarget: range.rangeMiddle,
    shortStop: range.resistance.price + buffer * 2, // Stop above resistance
  };
}
