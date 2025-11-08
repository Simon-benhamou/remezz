/**
 * Crypto Personality Profile Service
 * Manages learned optimal parameters for each trading symbol
 */

import { prisma } from '../db/client.js';

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

export type PersonalityProfile = {
  symbol: string;
  optimalParams: OptimalParams;
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
 * Get the personality profile for a symbol
 */
export async function getPersonalityProfile(symbol: string): Promise<OptimalParams | null> {
  try {
    const profile = await prisma.cryptoPersonalityProfile.findUnique({
      where: { symbol },
    });

    if (!profile) {
      return null;
    }

    return profile.optimalParams as OptimalParams;
  } catch (error) {
    console.warn(`Failed to fetch personality profile for ${symbol}:`, error);
    return null;
  }
}

/**
 * Save or update a personality profile
 */
export async function savePersonalityProfile(
  symbol: string,
  optimalParams: OptimalParams,
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
      optimalParams: p.optimalParams as OptimalParams,
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
