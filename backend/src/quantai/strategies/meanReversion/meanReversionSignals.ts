/**
 * MEAN REVERSION STRATEGY - SIGNAL GENERATION
 * 
 * Génère des signaux pour trader les bounces dans les ranges:
 * - LONG au support (attente rebond vers haut)
 * - SHORT à la résistance (attente retour vers bas)
 */

import type { TechnicalSnapshot } from '../../../ai/tech.js';
import { detectRange, isNearRangeLevel, calculateMeanReversionLevels, type RangeStructure } from './rangeDetection.js';

export type MeanReversionSignal = {
  bias: 'long' | 'short' | 'none';
  confidence: number; // 0-1
  strategy: 'mean_reversion';
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  riskRewardRatio: number;
  range: RangeStructure;
  reason: string;
  warnings: string[];
};

/**
 * Évalue si on a un setup mean reversion valide
 */
export function evaluateMeanReversionSignal(
  snap: TechnicalSnapshot,
  priceHistory?: number[]
): MeanReversionSignal {
  
  const price = snap.last;
  const rsi = snap.rsi14;
  const volume = (snap as any).volume;
  const volumeMA = (snap as any).volumeMA;
  
  // 1. Detect range structure
  const range = detectRange(snap, priceHistory);
  
  if (!range.inRange) {
    return {
      bias: 'none',
      confidence: 0,
      strategy: 'mean_reversion',
      entryPrice: price,
      targetPrice: price,
      stopPrice: price,
      riskRewardRatio: 0,
      range,
      reason: range.reason,
      warnings: ['Not in range-bound market'],
    };
  }
  
  // 2. Calculate entry/exit levels
  const levels = calculateMeanReversionLevels(range);
  if (!levels) {
    return {
      bias: 'none',
      confidence: 0,
      strategy: 'mean_reversion',
      entryPrice: price,
      targetPrice: price,
      stopPrice: price,
      riskRewardRatio: 0,
      range,
      reason: 'Could not calculate mean reversion levels',
      warnings: ['Invalid range structure'],
    };
  }
  
  // 3. Check if near support or resistance
  const nearSupport = isNearRangeLevel(price, range.support!, 0.8);
  const nearResistance = isNearRangeLevel(price, range.resistance!, 0.8);
  
  const warnings: string[] = [];
  let bias: 'long' | 'short' | 'none' = 'none';
  let confidence = 0;
  let entryPrice = price;
  let targetPrice = price;
  let stopPrice = price;
  
  // 4. LONG setup: Near support, expecting bounce UP
  if (nearSupport.near && nearSupport.side !== 'above') {
    bias = 'long';
    entryPrice = levels.longEntry;
    targetPrice = levels.longTarget;
    stopPrice = levels.longStop;
    
    // Base confidence from range quality
    confidence = range.support!.confidence * 0.5;
    
    // RSI confirmation: Oversold = higher confidence
    if (rsi !== undefined) {
      if (rsi < 30) {
        confidence += 0.25; // Strong oversold
      } else if (rsi < 40) {
        confidence += 0.15; // Moderate oversold
      }
    }
    
    // Volume confirmation: Low volume at support = consolidation
    if (volume !== undefined && volumeMA !== undefined) {
      const volumeRatio = volume / volumeMA;
      if (volumeRatio < 0.8) {
        confidence += 0.1; // Quiet accumulation
      } else if (volumeRatio > 1.5) {
        warnings.push('High volume at support - potential breakdown risk');
        confidence -= 0.1;
      }
    }
    
    // Range quality bonus
    if (range.rangeQuality === 'excellent') {
      confidence += 0.15;
    } else if (range.rangeQuality === 'good') {
      confidence += 0.08;
    }
    
  }
  // 5. SHORT setup: Near resistance, expecting bounce DOWN
  else if (nearResistance.near && nearResistance.side !== 'below') {
    bias = 'short';
    entryPrice = levels.shortEntry;
    targetPrice = levels.shortTarget;
    stopPrice = levels.shortStop;
    
    // Base confidence from range quality
    confidence = range.resistance!.confidence * 0.5;
    
    // RSI confirmation: Overbought = higher confidence
    if (rsi !== undefined) {
      if (rsi > 70) {
        confidence += 0.25; // Strong overbought
      } else if (rsi > 60) {
        confidence += 0.15; // Moderate overbought
      }
    }
    
    // Volume confirmation
    if (volume !== undefined && volumeMA !== undefined) {
      const volumeRatio = volume / volumeMA;
      if (volumeRatio < 0.8) {
        confidence += 0.1; // Quiet distribution
      } else if (volumeRatio > 1.5) {
        warnings.push('High volume at resistance - potential breakout risk');
        confidence -= 0.1;
      }
    }
    
    // Range quality bonus
    if (range.rangeQuality === 'excellent') {
      confidence += 0.15;
    } else if (range.rangeQuality === 'good') {
      confidence += 0.08;
    }
    
  } else {
    // Price in middle of range - no clear setup
    return {
      bias: 'none',
      confidence: 0,
      strategy: 'mean_reversion',
      entryPrice: price,
      targetPrice: price,
      stopPrice: price,
      riskRewardRatio: 0,
      range,
      reason: `Price in middle of range ($${price.toFixed(4)}, support $${range.support!.price.toFixed(4)}, resistance $${range.resistance!.price.toFixed(4)})`,
      warnings: ['Wait for price to approach support or resistance'],
    };
  }
  
  // 6. Calculate risk/reward
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  const riskRewardRatio = risk > 0 ? reward / risk : 0;
  
  // Require minimum R:R of 1.5:1 for mean reversion
  if (riskRewardRatio < 1.5) {
    warnings.push(`Low R:R ratio ${riskRewardRatio.toFixed(2)}:1 (min 1.5:1 required)`);
    confidence *= 0.7;
  }
  
  // 7. Cap confidence
  confidence = Math.min(0.85, Math.max(0, confidence));
  
  // 8. Build reason
  const reason = bias === 'long'
    ? `LONG setup: Price near support $${range.support!.price.toFixed(4)} (${nearSupport.distance.toFixed(1)}% away), target middle $${targetPrice.toFixed(4)}`
    : bias === 'short'
    ? `SHORT setup: Price near resistance $${range.resistance!.price.toFixed(4)} (${nearResistance.distance.toFixed(1)}% away), target middle $${targetPrice.toFixed(4)}`
    : 'No setup';
  
  return {
    bias,
    confidence,
    strategy: 'mean_reversion',
    entryPrice,
    targetPrice,
    stopPrice,
    riskRewardRatio,
    range,
    reason,
    warnings,
  };
}

/**
 * Check if mean reversion strategy should be used based on market conditions
 */
export function shouldUseMeanReversion(snap: TechnicalSnapshot): {
  use: boolean;
  reason: string;
  confidence: number;
} {
  const atrPct = snap.atrPct || 0;
  const adx = snap.adx14 || 0;
  const ema20 = snap.ema20;
  const ema50 = snap.ema50;
  const ema100 = snap.ema100;
  
  // Mean reversion works best in:
  // 1. Low volatility (ATR < 0.8%)
  // 2. Low momentum (ADX < 25)
  // 3. Compressed EMAs (< 3.5%)
  
  const lowVol = atrPct < 0.8;
  const lowMomentum = adx < 25;
  
  let emaCompression = 999;
  if (ema20 && ema50 && ema100) {
    const emaRange = Math.max(ema20, ema50, ema100) - Math.min(ema20, ema50, ema100);
    const emaAvg = (ema20 + ema50 + ema100) / 3;
    emaCompression = (emaRange / emaAvg) * 100;
  }
  const compressedEmas = emaCompression < 3.5;
  
  let confidence = 0;
  if (lowVol) confidence += 0.35;
  if (lowMomentum) confidence += 0.35;
  if (compressedEmas) confidence += 0.3;
  
  const use = confidence >= 0.6;
  
  const reason = use
    ? `Range-bound conditions (ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, EMA compression ${emaCompression.toFixed(1)}%)`
    : `Trending conditions (ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, EMA compression ${emaCompression.toFixed(1)}%) - use trend-following instead`;
  
  return { use, reason, confidence };
}
