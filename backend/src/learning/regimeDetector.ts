/**
 * Market Regime Detection Helper
 * Simple regime detection based on price action and volatility
 */

import type { MarketRegime } from './personalityProfile.js';

export type RegimeIndicators = {
  ema20?: number;
  ema50?: number;
  ema200?: number;
  atrPct?: number;
  adx?: number;
  volumeRatio?: number;
};

/**
 * Detect market regime based on technical indicators
 * 
 * @param indicators - Technical indicators for regime detection
 * @returns MarketRegime classification
 */
export function detectMarketRegime(indicators: RegimeIndicators): MarketRegime {
  const { ema20, ema50, ema200, atrPct, adx } = indicators;

  // Default to neutral if insufficient data
  if (!ema20 || !ema50) {
    return 'neutral';
  }

  // Calculate trend strength
  const isBullish = ema20 > ema50;
  const isBearish = ema20 < ema50;
  
  // Check long-term trend if ema200 available
  const longTermBullish = ema200 && ema50 > ema200;
  const longTermBearish = ema200 && ema50 < ema200;

  // Check if choppy (low ADX indicates weak trend)
  const isChoppy = adx && adx < 20;

  // Determine regime
  if (isChoppy) {
    return 'choppy_market';
  }

  if (isBullish && (!ema200 || longTermBullish)) {
    return 'bull_market';
  }

  if (isBearish && (!ema200 || longTermBearish)) {
    return 'bear_market';
  }

  // Mixed signals or neutral
  return 'neutral';
}

/**
 * Get regime-specific label for display
 */
export function getRegimeLabel(regime: MarketRegime): string {
  const labels: Record<MarketRegime, string> = {
    bull_market: '📈 Bull Market',
    bear_market: '📉 Bear Market',
    choppy_market: '📊 Choppy Market',
    neutral: '➡️ Neutral',
  };
  return labels[regime];
}
