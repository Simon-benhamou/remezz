/**
 * STRATEGY ROUTER - INTELLIGENT STRATEGY SELECTION
 * 
 * Sélectionne automatiquement la meilleure stratégie (Trend-Following ou Mean Reversion)
 * basé sur les conditions de marché actuelles
 */

import type { TechnicalSnapshot } from '../../ai/tech.js';
import { evaluateMeanReversionSignal, shouldUseMeanReversion, type MeanReversionSignal } from './meanReversion/meanReversionSignals.js';

export type StrategyType = 'trend_following' | 'mean_reversion' | 'breakout' | 'momentum';

export type StrategySelection = {
  primary: StrategyType;
  confidence: number; // 0-1: How confident are we this is the right strategy
  reason: string;
  alternativeStrategies: Array<{
    strategy: StrategyType;
    viability: number; // 0-1
    reason: string;
  }>;
};

/**
 * Sélectionne la stratégie optimale basée sur les conditions de marché
 */
export function selectOptimalStrategy(snap: TechnicalSnapshot): StrategySelection {
  
  const atrPct = snap.atrPct || 0;
  const adx = snap.adx14 || 0;
  const ema20 = snap.ema20;
  const ema50 = snap.ema50;
  const ema100 = snap.ema100;
  const rsi = snap.rsi14;
  
  // Calculate EMA compression
  let emaCompression = 999;
  if (ema20 && ema50 && ema100) {
    const emaRange = Math.max(ema20, ema50, ema100) - Math.min(ema20, ema50, ema100);
    const emaAvg = (ema20 + ema50 + ema100) / 3;
    emaCompression = (emaRange / emaAvg) * 100;
  }
  
  // Score each strategy
  const scores = {
    mean_reversion: 0,
    trend_following: 0,
    breakout: 0,
    momentum: 0,
  };
  
  // 1. MEAN REVERSION scoring
  if (atrPct < 0.8) scores.mean_reversion += 0.3;
  if (adx < 25) scores.mean_reversion += 0.25;
  if (emaCompression < 3.5) scores.mean_reversion += 0.25;
  if (rsi !== undefined && (rsi < 35 || rsi > 65)) scores.mean_reversion += 0.2; // Extreme RSI = reversal likely
  
  // 2. TREND FOLLOWING scoring
  if (atrPct >= 0.9 && atrPct <= 3.5) scores.trend_following += 0.3; // Good trending volatility
  if (adx >= 20 && adx <= 45) scores.trend_following += 0.3; // Strong but not extreme trend
  if (emaCompression >= 3.5) scores.trend_following += 0.25; // Clear EMA separation
  if (ema20 && ema50 && ema100) {
    const bullAlign = ema20 > ema50 && ema50 > ema100;
    const bearAlign = ema20 < ema50 && ema50 < ema100;
    if (bullAlign || bearAlign) scores.trend_following += 0.15; // EMA alignment
  }
  
  // 3. BREAKOUT scoring (transition from range to trend)
  if (atrPct >= 0.6 && atrPct <= 1.2) scores.breakout += 0.2; // Volatility increasing
  if (adx >= 15 && adx <= 25) scores.breakout += 0.25; // ADX rising
  if (emaCompression >= 2 && emaCompression <= 4) scores.breakout += 0.25; // EMAs starting to separate
  const volumeRatio = (snap as any).volumeRatio;
  if (volumeRatio && volumeRatio > 1.3) scores.breakout += 0.3; // Volume spike
  
  // 4. MOMENTUM scoring (strong directional move)
  if (atrPct > 3.5) scores.momentum += 0.3; // High volatility
  if (adx > 35) scores.momentum += 0.35; // Very strong trend
  if (rsi !== undefined && (rsi < 25 || rsi > 75)) scores.momentum += 0.2; // Extreme momentum
  if (emaCompression > 5) scores.momentum += 0.15; // Wide EMA spread
  
  // Find best strategy
  const sortedStrategies = Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .map(([strategy, score]) => ({ strategy: strategy as StrategyType, score }));
  
  const primary = sortedStrategies[0].strategy;
  const confidence = sortedStrategies[0].score;
  
  // Build alternatives
  const alternativeStrategies = sortedStrategies.slice(1).map(({ strategy, score }) => ({
    strategy,
    viability: score,
    reason: getStrategyReason(strategy, snap, emaCompression),
  }));
  
  const reason = getStrategyReason(primary, snap, emaCompression);
  
  return {
    primary,
    confidence: Math.min(1, confidence),
    reason,
    alternativeStrategies,
  };
}

function getStrategyReason(strategy: StrategyType, snap: TechnicalSnapshot, emaCompression: number): string {
  const atrPct = snap.atrPct || 0;
  const adx = snap.adx14 || 0;
  
  switch (strategy) {
    case 'mean_reversion':
      return `Range-bound market: ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, EMAs compressed ${emaCompression.toFixed(1)}%`;
    case 'trend_following':
      return `Trending market: ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, EMAs separated ${emaCompression.toFixed(1)}%`;
    case 'breakout':
      return `Breakout conditions: ATR ${atrPct.toFixed(2)}% rising, ADX ${adx.toFixed(0)} building, volatility expanding`;
    case 'momentum':
      return `Strong momentum: ATR ${atrPct.toFixed(2)}%, ADX ${adx.toFixed(0)}, extreme directional move`;
  }
}

/**
 * Unified signal that includes strategy selection
 */
export type HybridSignal = {
  selectedStrategy: StrategyType;
  strategyConfidence: number;
  signal: any; // TrendFollowingSignal | MeanReversionSignal | etc
  reason: string;
};

/**
 * Get best signal by automatically selecting optimal strategy
 */
export async function getHybridSignal(
  snap: TechnicalSnapshot,
  trendFollowingEvaluator: (snap: TechnicalSnapshot) => Promise<any>
): Promise<HybridSignal> {
  
  const strategySelection = selectOptimalStrategy(snap);
  
  // Route to appropriate strategy
  if (strategySelection.primary === 'mean_reversion') {
    const signal = evaluateMeanReversionSignal(snap);
    return {
      selectedStrategy: 'mean_reversion',
      strategyConfidence: strategySelection.confidence,
      signal,
      reason: `Using mean reversion: ${strategySelection.reason}`,
    };
  } else {
    // Default to trend-following (existing strategy)
    const signal = await trendFollowingEvaluator(snap);
    return {
      selectedStrategy: 'trend_following',
      strategyConfidence: strategySelection.confidence,
      signal,
      reason: `Using trend following: ${strategySelection.reason}`,
    };
  }
}
