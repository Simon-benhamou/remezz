/**
 * Regime-Aware Threshold Configuration
 * 
 * Dynamically adjusts entry thresholds based on market regime to optimize
 * the balance between trade quality and frequency across different market conditions.
 * 
 * Now integrates with learned parameters from the strategy optimizer.
 */

import { classifyRegime, type RegimeDiagnostics } from '../diagnostics/regime.js';
import type { TechnicalSnapshot } from '../ai/tech.js';
import { 
  getParametersWithDefaults, 
  classifyVolatilityRegime,
  classifyDirectionBias,
  classifyVolumeRegime,
  classifyTrendingRanging,
  type OptimalParams 
} from '../learning/personalityProfile.js';

export type SymbolTier = 'A' | 'B' | 'C';

export type RegimeAwareThresholds = {
  confidence: number;
  atr: number;
  adx: number;
  eligibility: number;
  rrMin: number;
};

export type ThresholdContext = {
  symbol: string;
  tier: SymbolTier;
  regime: RegimeDiagnostics;
  aggressiveness: 'conservative' | 'reactive' | 'aggressive';
};

/**
 * Symbol tier classification based on market cap, volume, and quality
 */
const SYMBOL_TIERS: Record<string, SymbolTier> = {
  'BTC/USDT': 'A',
  'BTC/USDT:USDT': 'A',
  'ETH/USDT': 'A',
  'ETH/USDT:USDT': 'A',
  'SOL/USDT': 'B',
  'SOL/USDT:USDT': 'B',
  'BNB/USDT': 'B',
  'BNB/USDT:USDT': 'B',
  'XRP/USDT': 'B',
  'XRP/USDT:USDT': 'B',
  'ADA/USDT': 'B',
  'ADA/USDT:USDT': 'B',
  'AVAX/USDT': 'B',
  'AVAX/USDT:USDT': 'B',
};

/**
 * Get symbol tier with fallback to 'C' for unknown symbols
 */
export function getSymbolTier(symbol: string): SymbolTier {
  return SYMBOL_TIERS[symbol] || 'C';
}

/**
 * Base thresholds for each aggressiveness level
 */
const BASE_THRESHOLDS = {
  conservative: {
    confidence: 0.75,
    atr: 0.65,
    adx: 18,
    eligibility: 0.62,
    rrMin: 1.9,
  },
  reactive: {
    confidence: 0.68,
    atr: 0.55,
    adx: 16,
    eligibility: 0.58,
    rrMin: 1.8,
  },
  aggressive: {
    confidence: 0.62,
    atr: 0.45,
    adx: 14,
    eligibility: 0.54,
    rrMin: 1.7,
  },
};

/**
 * Tier-specific adjustments (multipliers applied to base thresholds)
 */
const TIER_ADJUSTMENTS: Record<SymbolTier, {
  confidenceAdj: number;
  atrAdj: number;
  adxAdj: number;
}> = {
  A: {
    confidenceAdj: 0.95,  // Lower confidence needed for major pairs
    atrAdj: 0.65,          // Much lower ATR requirement
    adxAdj: 0.90,          // Slightly lower ADX
  },
  B: {
    confidenceAdj: 1.0,   // Standard
    atrAdj: 0.85,         // Moderate ATR reduction
    adxAdj: 1.0,          // Standard ADX
  },
  C: {
    confidenceAdj: 1.05,  // Higher confidence for low-tier
    atrAdj: 1.0,          // Standard ATR
    adxAdj: 1.05,         // Slightly higher ADX
  },
};

/**
 * Regime-specific adjustments
 */
function getRegimeAdjustments(regime: RegimeDiagnostics): {
  confidenceAdj: number;
  atrAdj: number;
  adxAdj: number;
  eligibilityAdj: number;
} {
  const { regime: regimeType, tags, volatilityScore } = regime;

  // Start with neutral adjustments
  let confidenceAdj = 1.0;
  let atrAdj = 1.0;
  let adxAdj = 1.0;
  let eligibilityAdj = 1.0;

  // Regime-based adjustments
  switch (regimeType) {
    case 'trend':
      // Strong trends: can be more aggressive
      confidenceAdj = 0.95;
      adxAdj = 0.90;
      eligibilityAdj = 0.95;
      break;

    case 'range':
      // Ranging markets: require higher quality
      confidenceAdj = 1.05;
      atrAdj = 1.2;   // Allow lower volatility in ranges
      adxAdj = 1.1;
      break;

    case 'breakout':
      // Breakouts: moderate requirements
      confidenceAdj = 0.98;
      atrAdj = 0.85;
      eligibilityAdj = 0.98;
      break;

    case 'volatility_spike':
      // High volatility: be more selective
      confidenceAdj = 1.1;
      atrAdj = 0.90;  // Volatility is already high
      adxAdj = 0.95;
      eligibilityAdj = 1.05;
      break;

    case 'illiquid':
      // Illiquid: very selective
      confidenceAdj = 1.15;
      atrAdj = 1.0;
      adxAdj = 1.1;
      eligibilityAdj = 1.1;
      break;
  }

  // Tag-based adjustments
  if (tags.includes('momentum')) {
    confidenceAdj *= 0.97;
    eligibilityAdj *= 0.98;
  }

  if (tags.includes('mean_reversion')) {
    // Mean reversion requires higher confidence
    confidenceAdj *= 1.03;
  }

  if (tags.includes('fragile')) {
    // Fragile conditions: more selective
    confidenceAdj *= 1.05;
    eligibilityAdj *= 1.05;
  }

  if (tags.includes('heavy_volume')) {
    // Good volume: can be slightly more aggressive
    eligibilityAdj *= 0.97;
  }

  if (tags.includes('thin_volume')) {
    // Low volume: be more cautious
    confidenceAdj *= 1.03;
    eligibilityAdj *= 1.03;
  }

  // Volatility-based adjustments
  if (volatilityScore > 1.5) {
    // High volatility: allow lower ATR but higher confidence
    atrAdj *= 0.85;
    confidenceAdj *= 1.02;
  } else if (volatilityScore < -0.5) {
    // Low volatility: need less ATR
    atrAdj *= 1.3;
  }

  return { confidenceAdj, atrAdj, adxAdj, eligibilityAdj };
}

/**
 * Calculate regime-aware thresholds for a given context
 */
export function calculateRegimeAwareThresholds(
  context: ThresholdContext
): RegimeAwareThresholds {
  const { symbol, tier, regime, aggressiveness } = context;

  // Get base thresholds for aggressiveness level
  const base = BASE_THRESHOLDS[aggressiveness];

  // Get tier-specific adjustments
  const tierAdj = TIER_ADJUSTMENTS[tier];

  // Get regime-specific adjustments
  const regimeAdj = getRegimeAdjustments(regime);

  // Calculate final thresholds
  const thresholds: RegimeAwareThresholds = {
    confidence: Math.max(0.55, Math.min(0.85, 
      base.confidence * tierAdj.confidenceAdj * regimeAdj.confidenceAdj
    )),
    atr: Math.max(0.25, Math.min(1.0, 
      base.atr * tierAdj.atrAdj * regimeAdj.atrAdj
    )),
    adx: Math.max(10, Math.min(25, 
      base.adx * tierAdj.adxAdj * regimeAdj.adxAdj
    )),
    eligibility: Math.max(0.50, Math.min(0.70, 
      base.eligibility * regimeAdj.eligibilityAdj
    )),
    rrMin: base.rrMin,
  };

  return thresholds;
}

/**
 * Get regime-aware thresholds with technical snapshot
 * Now integrates learned parameters from strategy optimizer
 */
export async function getThresholdsForSymbol(
  symbol: string,
  tech: TechnicalSnapshot & { spreadBps?: number; liquidityScore?: number },
  aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 'reactive'
): Promise<RegimeAwareThresholds & { regime: RegimeDiagnostics; tier: SymbolTier; source: string }> {
  const tier = getSymbolTier(symbol);
  
  // Extract numeric fields only for regime classification
  // The classifyRegime function safely handles non-numeric fields via safeNumber()
  const { symbol: _, ...numericTech } = tech;
  const regime = classifyRegime(numericTech as any, {
    spreadBps: tech.spreadBps,
    liquidityScore: tech.liquidityScore,
  });

  // Classify current market regime
  const atrPct = tech.atr14 && tech.last ? (tech.atr14 / tech.last) * 100 : undefined;
  const volatilityRegime = classifyVolatilityRegime(atrPct);
  const directionBias = classifyDirectionBias(tech.ema20, tech.ema50);
  const volumeRegime = classifyVolumeRegime(
    tech.volume,
    tech.volumeMA,
    (tech as any).volumeZScore
  );
  const trendingRanging = classifyTrendingRanging(tech.adx14, atrPct);

  // Get learned or intelligent default parameters
  const { params, source } = await getParametersWithDefaults(symbol, {
    volatilityRegime,
    directionBias,
    volumeRegime,
    trendingRanging,
  });

  // Calculate regime adjustments
  const regimeAdj = getRegimeAdjustments(regime);
  const tierAdj = TIER_ADJUSTMENTS[tier];
  
  // Aggressiveness multipliers
  const aggMult = aggressiveness === 'aggressive' ? 0.92 : aggressiveness === 'conservative' ? 1.08 : 1.0;

  // Merge learned parameters with regime/tier adjustments
  const thresholds: RegimeAwareThresholds = {
    confidence: Math.max(0.55, Math.min(0.85, 
      (params.thresholds.minConfidence ?? 0.62) * tierAdj.confidenceAdj * regimeAdj.confidenceAdj * aggMult
    )),
    atr: Math.max(0.25, Math.min(1.0, 
      (params.thresholds.atr ?? 0.55) * tierAdj.atrAdj * regimeAdj.atrAdj * aggMult
    )),
    adx: Math.max(10, Math.min(25, 
      (params.thresholds.adx ?? 18) * tierAdj.adxAdj * regimeAdj.adxAdj * aggMult
    )),
    eligibility: Math.max(0.50, Math.min(0.70, 
      (params.thresholds.eligibility ?? 0.62) * regimeAdj.eligibilityAdj * aggMult
    )),
    rrMin: params.thresholds.rrMin ?? 1.8,
  };

  return {
    ...thresholds,
    regime,
    tier,
    source, // Track whether these came from learned data or intelligent defaults
  };
}

/**
 * Format threshold explanation for logging/UI
 */
export function explainThresholds(
  thresholds: RegimeAwareThresholds & { regime: RegimeDiagnostics; tier: SymbolTier },
  symbol: string,
  aggressiveness: string
): string {
  const { regime, tier } = thresholds;
  
  const parts = [
    `Symbol: ${symbol} (Tier ${tier})`,
    `Regime: ${regime.regime} (${regime.direction})`,
    `Aggressiveness: ${aggressiveness}`,
    ``,
    `Thresholds:`,
    `  Confidence: ${(thresholds.confidence * 100).toFixed(1)}%`,
    `  ATR: ${(thresholds.atr).toFixed(2)}%`,
    `  ADX: ${thresholds.adx.toFixed(1)}`,
    `  Eligibility: ${(thresholds.eligibility * 100).toFixed(1)}%`,
    `  RR Min: ${thresholds.rrMin.toFixed(1)}`,
  ];

  if (regime.tags.length > 0) {
    parts.push(`  Tags: ${regime.tags.join(', ')}`);
  }

  return parts.join('\n');
}
