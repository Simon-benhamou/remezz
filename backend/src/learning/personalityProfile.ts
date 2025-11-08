/**
 * Crypto Personality Profile Service
 * Manages learned optimal parameters for each trading symbol
 */

import { prisma } from '../db/client.js';

export type MarketRegime = 'bull_market' | 'bear_market' | 'choppy_market' | 'neutral';
export type VolatilityRegime = 'low' | 'medium' | 'high';
export type DirectionBias = 'long' | 'short' | 'neutral';

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
};

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
    cmf: 0.05,
  },
};

/**
 * Get the personality profile for a symbol, with optional regime and direction context
 */
export async function getPersonalityProfile(
  symbol: string,
  options?: {
    volatilityRegime?: VolatilityRegime;
    directionBias?: DirectionBias;
    marketRegime?: MarketRegime;
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
      
      // Priority order: volatility > direction > market regime > default
      
      // 1. Try volatility regime first (most important for risk management)
      if (options?.volatilityRegime) {
        const volKey = `${options.volatilityRegime}_volatility` as keyof RegimeAwareParams;
        if (regimeParams[volKey]) {
          return regimeParams[volKey] as OptimalParams;
        }
      }
      
      // 2. Try direction bias (asymmetric long/short)
      if (options?.directionBias && options.directionBias !== 'neutral') {
        const dirKey = `${options.directionBias}_bias` as keyof RegimeAwareParams;
        if (regimeParams[dirKey]) {
          return regimeParams[dirKey] as OptimalParams;
        }
      }
      
      // 3. Try market regime
      if (options?.marketRegime && regimeParams[options.marketRegime]) {
        return regimeParams[options.marketRegime] as OptimalParams;
      }
      
      // 4. Fall back to default
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
