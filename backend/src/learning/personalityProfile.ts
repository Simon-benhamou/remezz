/**
 * Crypto Personality Profile Service
 * Manages learned optimal parameters for each trading symbol
 */

import { prisma } from '../db/client.js';

export type MarketRegime = 'bull_market' | 'bear_market' | 'choppy_market' | 'neutral';
export type VolatilityRegime = 'low' | 'medium' | 'high';
export type DirectionBias = 'long' | 'short' | 'neutral';
export type VolumeRegime = 'low' | 'normal' | 'high';
export type TrendingRanging = 'trending' | 'ranging';

export type OptimalParams = {
  weights: {
    adx: number;
    strength: number;
    alignment: number;
    slope: number;
    flow: number;
  };
  thresholds: {
    adx: number;
    trendStrength: number;
    minConfidence: number;
    cmf?: number;
    // Meta-adaptive specific thresholds
    atr?: number;           // ATR percentage threshold
    eligibility?: number;   // Entry eligibility score
    rrMin?: number;         // Minimum risk/reward ratio
    minAtrPct?: number;     // Minimum ATR percentage
    maxAtrPct?: number;     // Maximum ATR percentage
  };
};

export type RegimeAwareParams = {
  default: OptimalParams;
  bull_market?: OptimalParams;
  bear_market?: OptimalParams;
  choppy_market?: OptimalParams;
  // Volatility regimes
  low_volatility?: OptimalParams;
  medium_volatility?: OptimalParams;
  high_volatility?: OptimalParams;
  // Direction-specific
  long_bias?: OptimalParams;
  short_bias?: OptimalParams;
  // Volume/Liquidity regimes
  low_volume?: OptimalParams;
  normal_volume?: OptimalParams;
  high_volume?: OptimalParams;
  // Trend vs Range
  trending?: OptimalParams;
  ranging?: OptimalParams;
};

/**
 * Get intelligent default parameters by regime
 * Used when no learned data is available yet
 */
export function getDefaultParamsByRegime(regime: string): OptimalParams {
  const baseWeights = { adx: 0.3, strength: 0.3, alignment: 0.2, slope: 0.1, flow: 0.1 };
  
  switch (regime) {
    case 'low_volatility':
      return {
        weights: baseWeights,
        thresholds: {
          adx: 14,              // Lower ADX OK in calm markets
          trendStrength: 0.2,   // Weaker trends acceptable
          minConfidence: 0.40,  // Can be less strict
          atr: 0.45,
          eligibility: 0.55,
          rrMin: 1.5,
          minAtrPct: 1.5,
          maxAtrPct: 3.0,
        },
      };
    
    case 'high_volatility':
      return {
        weights: { ...baseWeights, adx: 0.4, strength: 0.35, flow: 0.05 }, // Focus on momentum
        thresholds: {
          adx: 22,              // Need strong ADX in wild markets
          trendStrength: 0.35,  // Strong trends required
          minConfidence: 0.55,  // Be more selective
          atr: 0.70,
          eligibility: 0.70,
          rrMin: 2.0,           // Higher RR needed for volatility
          minAtrPct: 4.0,
          maxAtrPct: 10.0,
        },
      };
    
    case 'trending':
      return {
        weights: { ...baseWeights, adx: 0.35, strength: 0.35, alignment: 0.15 },
        thresholds: {
          adx: 20,              // Strong ADX for trends
          trendStrength: 0.30,
          minConfidence: 0.48,
          atr: 0.60,
          eligibility: 0.65,
          rrMin: 1.8,
          minAtrPct: 2.5,
          maxAtrPct: 8.0,
        },
      };
    
    case 'ranging':
      return {
        weights: { ...baseWeights, flow: 0.15, adx: 0.25 }, // Focus on CMF in ranges
        thresholds: {
          adx: 12,              // Lower ADX expected
          trendStrength: 0.15,  // Weak trends OK
          minConfidence: 0.50,  // Need good setup confirmation
          atr: 0.50,
          eligibility: 0.60,
          rrMin: 2.0,           // Higher RR for range trades
          minAtrPct: 2.0,
          maxAtrPct: 5.0,
        },
      };
    
    case 'long_bias':
    case 'short_bias':
      return {
        weights: { ...baseWeights, alignment: 0.25 }, // Focus on EMA alignment
        thresholds: {
          adx: 18,
          trendStrength: 0.25,
          minConfidence: 0.45,
          atr: 0.55,
          eligibility: 0.62,
          rrMin: 1.8,
          minAtrPct: 2.0,
          maxAtrPct: 7.0,
        },
      };
    
    case 'low_volume':
      return {
        weights: baseWeights,
        thresholds: {
          adx: 20,              // Need stronger signals with low volume
          trendStrength: 0.28,
          minConfidence: 0.52,  // Be more cautious
          atr: 0.65,
          eligibility: 0.68,
          rrMin: 2.0,
          minAtrPct: 2.5,
          maxAtrPct: 6.0,
        },
      };
    
    case 'high_volume':
      return {
        weights: { ...baseWeights, flow: 0.15 }, // CMF more reliable with volume
        thresholds: {
          adx: 16,              // Can accept lower ADX with good volume
          trendStrength: 0.22,
          minConfidence: 0.42,
          atr: 0.50,
          eligibility: 0.58,
          rrMin: 1.6,
          minAtrPct: 2.0,
          maxAtrPct: 7.0,
        },
      };
    
    default: // medium_volatility, normal_volume, neutral, or unknown
      return {
        weights: baseWeights,
        thresholds: {
          adx: 18,
          trendStrength: 0.25,
          minConfidence: 0.45,
          atr: 0.55,
          eligibility: 0.62,
          rrMin: 1.8,
          minAtrPct: 2.0,
          maxAtrPct: 8.0,
        },
      };
  }
}

/**
 * Classify volatility regime based on ATR percentage
 */
export function classifyVolatilityRegime(atrPct?: number): VolatilityRegime {
  if (!atrPct || !Number.isFinite(atrPct)) return 'medium';
  if (atrPct < 3) return 'low';      // Calm market
  if (atrPct > 6) return 'high';     // Wild market
  return 'medium';                    // Normal volatility
}

/**
 * Classify direction bias based on EMA positioning
 */
export function classifyDirectionBias(ema20?: number, ema50?: number): DirectionBias {
  if (!ema20 || !ema50 || !Number.isFinite(ema20) || !Number.isFinite(ema50)) return 'neutral';
  if (ema20 > ema50 * 1.001) return 'long';   // Bullish with 0.1% buffer
  if (ema20 < ema50 * 0.999) return 'short';  // Bearish with 0.1% buffer
  return 'neutral';
}

/**
 * Classify volume regime based on volume Z-score or volume ratio
 * Uses volume compared to its moving average
 */
export function classifyVolumeRegime(
  volume?: number,
  volumeMA?: number,
  volumeZScore?: number
): VolumeRegime {
  // Prefer Z-score if available (more statistical)
  if (volumeZScore !== undefined && Number.isFinite(volumeZScore)) {
    if (volumeZScore < -0.5) return 'low';      // Below average volume
    if (volumeZScore > 0.5) return 'high';      // Above average volume
    return 'normal';
  }
  
  // Fall back to volume ratio
  if (volume !== undefined && volumeMA !== undefined && 
      Number.isFinite(volume) && Number.isFinite(volumeMA) && volumeMA > 0) {
    const ratio = volume / volumeMA;
    if (ratio < 0.7) return 'low';      // Low liquidity period
    if (ratio > 1.3) return 'high';     // High liquidity period
    return 'normal';
  }
  
  // Default to normal if insufficient data
  return 'normal';
}

/**
 * Classify whether market is trending or ranging
 * Uses ADX as primary indicator:
 * - ADX > 25: Strong trend (trending)
 * - ADX < 20: Weak trend (ranging)
 * - ADX 20-25: Transitional (use volatility as secondary)
 */
export function classifyTrendingRanging(adx?: number, atrPct?: number): TrendingRanging {
  if (!adx || !Number.isFinite(adx)) {
    // Fallback: use volatility if ADX not available
    if (atrPct !== undefined && Number.isFinite(atrPct)) {
      // High volatility often indicates trending, low volatility indicates ranging
      return atrPct > 4 ? 'trending' : 'ranging';
    }
    return 'ranging'; // Default to ranging if no data
  }
  
  // Clear trend (ADX > 25)
  if (adx > 25) return 'trending';
  
  // Clear range (ADX < 20)
  if (adx < 20) return 'ranging';
  
  // Transitional zone (20-25): use volatility as tiebreaker
  if (atrPct !== undefined && Number.isFinite(atrPct)) {
    return atrPct > 4 ? 'trending' : 'ranging';
  }
  
  // Default to ranging for uncertainty
  return 'ranging';
}

export type PersonalityProfile = {
  symbol: string;
  optimalParams: OptimalParams | RegimeAwareParams;
  updatedAt: Date;
  createdAt: Date;
};

/**
 * Default parameters (fallback for symbols without learned profiles)
 */
export const DEFAULT_PARAMS: OptimalParams = {
  weights: {
    adx: 0.3,
    strength: 0.3,
    alignment: 0.2,
    slope: 0.1,
    flow: 0.1,
  },
  thresholds: {
    adx: 18,
    trendStrength: 0.25,
    minConfidence: 0.45,
    atr: 0.55,
    eligibility: 0.62,
    rrMin: 1.8,
    minAtrPct: 2.0,
    maxAtrPct: 8.0,
    cmf: 0.05,
  },
};

/**
 * Get the personality profile for a symbol, with optional regime and direction context
 * Returns both the parameters and the source they came from for traceability
 */
export async function getPersonalityProfile(
  symbol: string,
  options?: {
    volatilityRegime?: VolatilityRegime;
    directionBias?: DirectionBias;
    marketRegime?: MarketRegime;
    volumeRegime?: VolumeRegime;
    trendingRanging?: TrendingRanging;
  }
): Promise<OptimalParams | null> {
  try {
    const profile = await prisma.cryptoPersonalityProfile.findUnique({
      where: { symbol },
    });

    if (!profile) {
      return null;
    }

    const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
    
    // Check if it's a regime-aware profile
    if (params && typeof params === 'object' && 'default' in params) {
      const regimeParams = params as RegimeAwareParams;
      
      // Priority order: 
      // 1. Volatility (most important for risk management)
      // 2. Volume/Liquidity (affects execution quality)
      // 3. Trending vs Ranging (affects strategy type)
      // 4. Direction bias (asymmetric long/short)
      // 5. Market regime (general market condition)
      // 6. Default (fallback)
      
      // 1. Try volatility regime first (most important for risk management)
      if (options?.volatilityRegime) {
        const volKey = `${options.volatilityRegime}_volatility` as keyof RegimeAwareParams;
        if (regimeParams[volKey]) {
          return regimeParams[volKey] as OptimalParams;
        }
      }
      
      // 2. Try volume regime (liquidity affects execution)
      if (options?.volumeRegime) {
        const volKey = `${options.volumeRegime}_volume` as keyof RegimeAwareParams;
        if (regimeParams[volKey]) {
          return regimeParams[volKey] as OptimalParams;
        }
      }
      
      // 3. Try trending vs ranging (strategy type selection)
      if (options?.trendingRanging) {
        if (regimeParams[options.trendingRanging]) {
          return regimeParams[options.trendingRanging] as OptimalParams;
        }
      }
      
      // 4. Try direction bias (asymmetric long/short)
      if (options?.directionBias && options.directionBias !== 'neutral') {
        const dirKey = `${options.directionBias}_bias` as keyof RegimeAwareParams;
        if (regimeParams[dirKey]) {
          return regimeParams[dirKey] as OptimalParams;
        }
      }
      
      // 5. Try market regime
      if (options?.marketRegime && regimeParams[options.marketRegime]) {
        return regimeParams[options.marketRegime] as OptimalParams;
      }
      
      // 6. Fall back to default
      return regimeParams.default;
    }

    // Return as simple OptimalParams
    return params as OptimalParams;
  } catch (error) {
    console.warn(`Failed to fetch personality profile for ${symbol}:`, error);
    return null;
  }
}

/**
 * Get parameters for a symbol with intelligent fallback to regime defaults
 * This ensures we ALWAYS have parameters, even without learned data
 */
export async function getParametersWithDefaults(
  symbol: string,
  options?: {
    volatilityRegime?: VolatilityRegime;
    directionBias?: DirectionBias;
    marketRegime?: MarketRegime;
    volumeRegime?: VolumeRegime;
    trendingRanging?: TrendingRanging;
  }
): Promise<{ params: OptimalParams; source: string }> {
  // Try to get learned profile
  const learned = await getPersonalityProfile(symbol, options);
  if (learned) {
    return { params: learned, source: 'learned' };
  }

  // Fall back to intelligent defaults based on current regime
  // Priority: volatility > trending/ranging > volume > direction > default
  
  if (options?.volatilityRegime && options.volatilityRegime !== 'medium') {
    return {
      params: getDefaultParamsByRegime(`${options.volatilityRegime}_volatility`),
      source: `default_${options.volatilityRegime}_volatility`,
    };
  }
  
  if (options?.trendingRanging) {
    return {
      params: getDefaultParamsByRegime(options.trendingRanging),
      source: `default_${options.trendingRanging}`,
    };
  }
  
  if (options?.volumeRegime && options.volumeRegime !== 'normal') {
    return {
      params: getDefaultParamsByRegime(`${options.volumeRegime}_volume`),
      source: `default_${options.volumeRegime}_volume`,
    };
  }
  
  if (options?.directionBias && options.directionBias !== 'neutral') {
    return {
      params: getDefaultParamsByRegime(`${options.directionBias}_bias`),
      source: `default_${options.directionBias}_bias`,
    };
  }

  // Ultimate fallback
  return { params: DEFAULT_PARAMS, source: 'default' };
}

/**
 * Get the personality profile with parameter source for traceability
 * Returns both the parameters and which regime they came from
 */
export async function getPersonalityProfileWithSource(
  symbol: string,
  options?: {
    volatilityRegime?: VolatilityRegime;
    directionBias?: DirectionBias;
    marketRegime?: MarketRegime;
    volumeRegime?: VolumeRegime;
    trendingRanging?: TrendingRanging;
  }
): Promise<{ params: OptimalParams; source: string } | null> {
  try {
    const profile = await prisma.cryptoPersonalityProfile.findUnique({
      where: { symbol },
    });

    if (!profile) {
      return null;
    }

    const params = profile.optimalParams as OptimalParams | RegimeAwareParams;
    
    // Check if it's a regime-aware profile
    if (params && typeof params === 'object' && 'default' in params) {
      const regimeParams = params as RegimeAwareParams;
      
      // Priority order with source tracking
      // 1. Volatility (most important for risk management)
      if (options?.volatilityRegime) {
        const volKey = `${options.volatilityRegime}_volatility` as keyof RegimeAwareParams;
        if (regimeParams[volKey]) {
          return { 
            params: regimeParams[volKey] as OptimalParams, 
            source: volKey 
          };
        }
      }
      
      // 2. Volume regime (liquidity affects execution)
      if (options?.volumeRegime) {
        const volKey = `${options.volumeRegime}_volume` as keyof RegimeAwareParams;
        if (regimeParams[volKey]) {
          return { 
            params: regimeParams[volKey] as OptimalParams, 
            source: volKey 
          };
        }
      }
      
      // 3. Trending vs ranging (strategy type selection)
      if (options?.trendingRanging) {
        if (regimeParams[options.trendingRanging]) {
          return { 
            params: regimeParams[options.trendingRanging] as OptimalParams, 
            source: options.trendingRanging 
          };
        }
      }
      
      // 4. Direction bias (asymmetric long/short)
      if (options?.directionBias && options.directionBias !== 'neutral') {
        const dirKey = `${options.directionBias}_bias` as keyof RegimeAwareParams;
        if (regimeParams[dirKey]) {
          return { 
            params: regimeParams[dirKey] as OptimalParams, 
            source: dirKey 
          };
        }
      }
      
      // 5. Market regime
      if (options?.marketRegime && regimeParams[options.marketRegime]) {
        return { 
          params: regimeParams[options.marketRegime] as OptimalParams, 
          source: options.marketRegime 
        };
      }
      
      // 6. Fall back to default
      return { 
        params: regimeParams.default, 
        source: 'default' 
      };
    }

    // Return as simple OptimalParams
    return { 
      params: params as OptimalParams, 
      source: 'single_profile' 
    };
  } catch (error) {
    console.warn(`Failed to fetch personality profile for ${symbol}:`, error);
    return null;
  }
}

/**
 * Save or update a personality profile (can be simple or regime-aware)
 */
export async function savePersonalityProfile(
  symbol: string,
  optimalParams: OptimalParams | RegimeAwareParams,
): Promise<boolean> {
  try {
    await prisma.cryptoPersonalityProfile.upsert({
      where: { symbol },
      create: {
        symbol,
        optimalParams: optimalParams as any,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      update: {
        optimalParams: optimalParams as any,
        updatedAt: new Date(),
      },
    });
    return true;
  } catch (error) {
    console.warn(`Failed to save personality profile for ${symbol}:`, error);
    return false;
  }
}

/**
 * Get all personality profiles
 */
export async function getAllPersonalityProfiles(): Promise<PersonalityProfile[]> {
  try {
    const profiles = await prisma.cryptoPersonalityProfile.findMany({
      orderBy: { updatedAt: 'desc' },
    });

    return profiles.map((p) => ({
      symbol: p.symbol,
      optimalParams: p.optimalParams as OptimalParams | RegimeAwareParams,
      updatedAt: p.updatedAt,
      createdAt: p.createdAt,
    }));
  } catch (error) {
    console.warn('Failed to fetch all personality profiles:', error);
    return [];
  }
}

/**
 * Delete a personality profile
 */
export async function deletePersonalityProfile(symbol: string): Promise<boolean> {
  try {
    await prisma.cryptoPersonalityProfile.delete({
      where: { symbol },
    });
    return true;
  } catch (error) {
    console.warn(`Failed to delete personality profile for ${symbol}:`, error);
    return false;
  }
}

/**
 * Get profiles that need updating (older than specified days)
 */
export async function getStaleProfiles(daysOld = 7): Promise<string[]> {
  try {
    const cutoffDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    const profiles = await prisma.cryptoPersonalityProfile.findMany({
      where: {
        updatedAt: { lt: cutoffDate },
      },
      select: { symbol: true },
    });
    return profiles.map((p) => p.symbol);
  } catch (error) {
    console.warn('Failed to fetch stale profiles:', error);
    return [];
  }
}
