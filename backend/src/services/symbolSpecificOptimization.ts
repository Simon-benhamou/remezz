/**
 * Symbol-Specific Optimization Service
 * 
 * Maintains per-symbol threshold profiles optimized based on
 * historical performance and market characteristics.
 */

import { prisma, Prisma } from '../db/client.js';
import { analyzeThresholdPerformance, type ThresholdSnapshot } from './adaptiveThresholdLearning.js';
import { getSymbolTier, type SymbolTier } from './regimeAwareThresholds.js';

export type SymbolProfile = {
  symbol: string;
  tier: SymbolTier;
  customThresholds: ThresholdSnapshot | null;
  performanceMetrics: {
    totalTrades: number;
    winRate: number;
    avgPnlPct: number;
    sharpeRatio: number;
    profitFactor: number;
    lastUpdated: number;
  };
  marketCharacteristics: {
    avgVolatility: number;
    avgSpread: number;
    avgVolume: number;
    dominantRegime: string;
  };
  optimizationStatus: 'initial' | 'learning' | 'optimized' | 'manual';
  lastOptimizedAt: number;
  notes?: string;
};

/**
 * Get symbol profile with custom thresholds
 * Creates a default profile if none exists
 */
export async function getSymbolProfile(symbol: string, opts?: { createIfMissing?: boolean }): Promise<SymbolProfile | null> {
  try {
    const profile = await prisma.$queryRaw<SymbolProfile[]>`
      SELECT * FROM symbol_profiles
      WHERE symbol = ${symbol}
      LIMIT 1
    `.catch(() => null);

    if (!profile || profile.length === 0) {
      // Auto-create default profile if requested
      if (opts?.createIfMissing !== false) {
        console.log(`📝 Creating default profile for ${symbol}...`);
        await ensureSymbolProfile(symbol);
        // Try to fetch again
        const retry = await prisma.$queryRaw<SymbolProfile[]>`
          SELECT * FROM symbol_profiles
          WHERE symbol = ${symbol}
          LIMIT 1
        `.catch(() => null);
        return retry && retry.length > 0 ? retry[0] : null;
      }
      return null;
    }

    return profile[0];
  } catch (error) {
    console.error('Failed to get symbol profile:', error);
    return null;
  }
}

/**
 * Ensure a symbol has a profile (create default if missing)
 */
export async function ensureSymbolProfile(symbol: string): Promise<void> {
  try {
    // In test mode with in-memory DB, skip raw SQL queries
    const isInMemory = process.env.UNIT_TEST_MODE === 'true' || process.env.USE_IN_MEMORY_DB === 'true';
    
    if (isInMemory) {
      // For in-memory tests, just return - profile management not critical for unit tests
      return;
    }
    
    const existing = await prisma.$queryRaw<SymbolProfile[]>`
      SELECT symbol FROM symbol_profiles
      WHERE symbol = ${symbol}
      LIMIT 1
    `.catch(() => null);

    if (existing && existing.length > 0) {
      return; // Already exists
    }

    const tier = getSymbolTier(symbol);
    const defaultMetrics = {
      totalTrades: 0,
      winRate: 0,
      avgPnl: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
    };

    await prisma.$executeRaw`
      INSERT INTO symbol_profiles (
        symbol, tier, custom_thresholds, performance_metrics,
        market_characteristics, optimization_status, last_optimized_at, notes
      ) VALUES (
        ${symbol},
        ${tier},
        NULL,
        ${JSON.stringify(defaultMetrics)}::jsonb,
        ${JSON.stringify({})}::jsonb,
        'initial',
        NULL,
        'Auto-created default profile'
      )
      ON CONFLICT (symbol) DO NOTHING
    `.catch(err => {
      console.warn(`Failed to create default profile for ${symbol}:`, err.message);
    });

    console.log(`✅ Default profile created for ${symbol} (tier: ${tier})`);
  } catch (error) {
    console.error(`Failed to ensure profile for ${symbol}:`, error);
  }
}

/**
 * Create or update symbol profile
 */
export async function upsertSymbolProfile(
  symbol: string,
  updates: Partial<Omit<SymbolProfile, 'symbol' | 'tier'>>
): Promise<void> {
  try {
    const tier = getSymbolTier(symbol);
    
    await prisma.$executeRaw`
      INSERT INTO symbol_profiles (
        symbol, tier, custom_thresholds, performance_metrics,
        market_characteristics, optimization_status, last_optimized_at, notes
      ) VALUES (
        ${symbol},
        ${tier},
        ${JSON.stringify(updates.customThresholds || null)}::jsonb,
        ${JSON.stringify(updates.performanceMetrics || {})}::jsonb,
        ${JSON.stringify(updates.marketCharacteristics || {})}::jsonb,
        ${updates.optimizationStatus || 'initial'},
        ${new Date(updates.lastOptimizedAt || Date.now())},
        ${updates.notes || null}
      )
      ON CONFLICT (symbol) DO UPDATE SET
        custom_thresholds = EXCLUDED.custom_thresholds,
        performance_metrics = EXCLUDED.performance_metrics,
        market_characteristics = EXCLUDED.market_characteristics,
        optimization_status = EXCLUDED.optimization_status,
        last_optimized_at = EXCLUDED.last_optimized_at,
        notes = EXCLUDED.notes
    `.catch(err => {
      console.warn('Symbol profiles table not available:', err.message);
    });
  } catch (error) {
    console.error('Failed to upsert symbol profile:', error);
  }
}

// Sharpe ratio threshold for optimization acceptance
const MIN_SHARPE_FOR_OPTIMIZATION = Number(process.env.MIN_SHARPE_FOR_OPTIMIZATION || '0.3');

/**
 * Optimize thresholds for a specific symbol based on performance
 */
export async function optimizeSymbolThresholds(
  symbol: string,
  lookbackDays: number = 30
): Promise<ThresholdSnapshot | null> {
  try {
    const performances = await analyzeThresholdPerformance(symbol, lookbackDays);

    if (performances.length === 0 || performances[0].sampleSize < 10) {
      console.log(`Not enough data to optimize ${symbol} (need 10+ trades)`);
      return null;
    }

    // Get best performing threshold set
    const best = performances[0];

    if (best.sharpeRatio < MIN_SHARPE_FOR_OPTIMIZATION) {
      console.log(`Best Sharpe for ${symbol} is ${best.sharpeRatio.toFixed(2)}, not confident in optimization (min: ${MIN_SHARPE_FOR_OPTIMIZATION})`);
      return null;
    }

    // Parse threshold key
    const parts = best.thresholdKey.split('_');
    const optimized: ThresholdSnapshot = {
      confidence: parseInt(parts[0].replace('conf', '')) / 100,
      atr: parseInt(parts[1].replace('atr', '')) / 100,
      adx: parseInt(parts[2].replace('adx', '')),
      eligibility: parseInt(parts[3].replace('elig', '')) / 100,
      rrMin: 1.8, // Keep standard
    };

    // Update symbol profile
    await upsertSymbolProfile(symbol, {
      customThresholds: optimized,
      performanceMetrics: {
        totalTrades: best.sampleSize,
        winRate: best.winRate,
        avgPnlPct: best.avgPnlPct,
        sharpeRatio: best.sharpeRatio,
        profitFactor: best.profitFactor,
        lastUpdated: Date.now(),
      },
      optimizationStatus: 'optimized',
      lastOptimizedAt: Date.now(),
    });

    console.log(`✅ Optimized thresholds for ${symbol}:`, optimized);
    return optimized;
  } catch (error) {
    console.error(`Failed to optimize ${symbol}:`, error);
    return null;
  }
}

/**
 * Get thresholds for symbol (custom or regime-aware default)
 */
export async function getSymbolThresholds(
  symbol: string,
  fallbackThresholds: ThresholdSnapshot
): Promise<ThresholdSnapshot> {
  try {
    const profile = await getSymbolProfile(symbol);
    
    if (profile?.customThresholds && profile.optimizationStatus === 'optimized') {
      // Use custom optimized thresholds
      console.log(`Using custom thresholds for ${symbol}`);
      return profile.customThresholds;
    }

    // Use regime-aware defaults
    return fallbackThresholds;
  } catch (error) {
    console.error('Failed to get symbol thresholds:', error);
    return fallbackThresholds;
  }
}

/**
 * Batch optimize all actively traded symbols
 */
export async function optimizeAllActiveSymbols(lookbackDays: number = 30): Promise<{
  optimized: string[];
  skipped: string[];
  failed: string[];
}> {
  const result = {
    optimized: [] as string[],
    skipped: [] as string[],
    failed: [] as string[],
  };

  try {
    // Get symbols with recent trades
    const symbols = await prisma.$queryRaw<Array<{ symbol: string; trade_count: number }>>`
      SELECT symbol, COUNT(*) as trade_count
      FROM trade_outcomes
      WHERE entry_time >= NOW() - INTERVAL '${lookbackDays} days'
      GROUP BY symbol
      HAVING COUNT(*) >= 10
      ORDER BY trade_count DESC
    `.catch(() => []);

    for (const { symbol } of symbols) {
      try {
        const optimized = await optimizeSymbolThresholds(symbol, lookbackDays);
        if (optimized) {
          result.optimized.push(symbol);
        } else {
          result.skipped.push(symbol);
        }
      } catch (error) {
        console.error(`Failed to optimize ${symbol}:`, error);
        result.failed.push(symbol);
      }
    }

    console.log(`Optimization complete: ${result.optimized.length} optimized, ${result.skipped.length} skipped, ${result.failed.length} failed`);
  } catch (error) {
    console.error('Failed to optimize active symbols:', error);
  }

  return result;
}

/**
 * Initialize symbol profiles table
 */
export async function initializeSymbolProfiles(): Promise<void> {
  try {
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS symbol_profiles (
        symbol TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        custom_thresholds JSONB,
        performance_metrics JSONB,
        market_characteristics JSONB,
        optimization_status TEXT DEFAULT 'initial',
        last_optimized_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `;

    console.log('✅ Symbol profiles table initialized');
  } catch (error) {
    console.warn('⚠️ Failed to initialize symbol profiles table:', error);
  }
}

/**
 * Schedule periodic optimization
 */
export function startSymbolOptimizationScheduler(intervalHours: number = 24): NodeJS.Timer {
  console.log(`🔧 Starting symbol optimization scheduler (every ${intervalHours}h)`);

  const run = async () => {
    console.log('🔧 Running symbol optimization...');
    const result = await optimizeAllActiveSymbols();
    console.log(`✅ Optimization complete:`, result);
  };

  // Run immediately
  run().catch(console.error);

  // Then run periodically
  return setInterval(run, intervalHours * 60 * 60 * 1000);
}
