/**
 * Global Predictor Cache
 * 
 * Provides a centralized cache for Python predictions with:
 * - Symbol-based caching
 * - TTL expiration
 * - Background refresh
 * - Warmup on server start
 * - Fallback when Python is slow/unavailable
 */

import { getPrediction, isPythonPredictorAvailable, type PythonPredictionResult } from './pythonPredictor.js';
import { prisma } from '../db/client.js';

// Cache configuration
const DEFAULT_CACHE_TTL_MS = 30_000; // 30 seconds for volatile crypto markets
const WARMUP_BATCH_SIZE = 5; // Process 5 symbols at a time during warmup
const BACKGROUND_REFRESH_INTERVAL_MS = 20_000; // Refresh every 20 seconds
const MAX_CACHE_SIZE = 100; // Prevent memory leaks

// Cache entry structure
interface PredictorCacheEntry {
  symbol: string;
  prediction: PythonPredictionResult;
  features: Record<string, number>;
  timestamp: number;
  expiresAt: number;
}

// Global cache storage
const predictorCache = new Map<string, PredictorCacheEntry>();

// Background refresh state
let refreshIntervalHandle: NodeJS.Timeout | null = null;
let isWarmupComplete = false;
let lastWarmupAt: number | null = null;
let lastRefreshAt: number | null = null;
let lastRefreshError: string | null = null;

/**
 * Normalize symbol for consistent cache keys
 */
function normalizeCacheKey(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * Get cached prediction for a symbol
 */
export function getCachedPrediction(symbol: string): PythonPredictionResult | null {
  const key = normalizeCacheKey(symbol);
  const entry = predictorCache.get(key);
  
  if (!entry) {
    return null;
  }
  
  // Check if expired
  if (Date.now() > entry.expiresAt) {
    predictorCache.delete(key);
    return null;
  }
  
  return entry.prediction;
}

/**
 * Set cached prediction for a symbol
 */
export function setCachedPrediction(
  symbol: string,
  prediction: PythonPredictionResult,
  features: Record<string, number>,
  ttlMs: number = DEFAULT_CACHE_TTL_MS
): void {
  const key = normalizeCacheKey(symbol);
  const now = Date.now();
  
  // Enforce max cache size (LRU-like behavior)
  if (predictorCache.size >= MAX_CACHE_SIZE && !predictorCache.has(key)) {
    // Remove oldest entry
    const oldestKey = Array.from(predictorCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)[0]?.[0];
    if (oldestKey) {
      predictorCache.delete(oldestKey);
    }
  }
  
  predictorCache.set(key, {
    symbol,
    prediction,
    features,
    timestamp: now,
    expiresAt: now + ttlMs,
  });
}

/**
 * Invalidate cache for a specific symbol
 */
export function invalidateCachedPrediction(symbol: string): void {
  const key = normalizeCacheKey(symbol);
  predictorCache.delete(key);
}

/**
 * Clear all cached predictions
 */
export function clearPredictorCache(): void {
  predictorCache.clear();
}

/**
 * Get cache statistics
 */
export function getPredictorCacheStats() {
  const now = Date.now();
  const entries = Array.from(predictorCache.values());
  
  return {
    totalEntries: entries.length,
    validEntries: entries.filter(e => e.expiresAt > now).length,
    expiredEntries: entries.filter(e => e.expiresAt <= now).length,
    oldestEntry: entries.length > 0 
      ? Math.floor((now - Math.min(...entries.map(e => e.timestamp))) / 1000)
      : 0,
    symbols: entries.map(e => e.symbol),
    isWarmupComplete,
    backgroundRefreshActive: refreshIntervalHandle !== null,
    lastWarmupAt,
    lastRefreshAt,
    lastRefreshError,
    refreshIntervalMs: BACKGROUND_REFRESH_INTERVAL_MS,
  };
}

/**
 * Get or fetch prediction with automatic caching
 */
export async function getPredictionWithCache(
  symbol: string,
  features: Record<string, number>,
  options: {
    forceFresh?: boolean;
    ttlMs?: number;
  } = {}
): Promise<PythonPredictionResult> {
  const { forceFresh = false, ttlMs = DEFAULT_CACHE_TTL_MS } = options;
  
  // Check cache first (unless force refresh)
  if (!forceFresh) {
    const cached = getCachedPrediction(symbol);
    if (cached) {
      console.log(`📦 Using cached prediction for ${symbol}`);
      return cached;
    }
  }
  
  // Fetch fresh prediction
  console.log(`🔄 Fetching fresh prediction for ${symbol}...`);
  const prediction = await getPrediction(features);
  
  // Cache the result
  setCachedPrediction(symbol, prediction, features, ttlMs);
  
  return prediction;
}

/**
 * Warmup cache with predictions for active symbols
 */
export async function warmupPredictorCache(): Promise<void> {
  if (!isPythonPredictorAvailable()) {
    console.log('⚠️  Python predictor unavailable - skipping cache warmup');
    return;
  }
  
  console.log('🔥 Starting predictor cache warmup...');
  
  try {
    // Get all active agent symbols
    const activeSessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        haltedAt: null,
      },
      select: {
        symbol: true,
        profileJson: true,
      },
      distinct: ['symbol'],
    });
    
    console.log(`   Found ${activeSessions.length} active symbol(s) to warm up`);
    
    // Process in batches to avoid overwhelming Python
    for (let i = 0; i < activeSessions.length; i += WARMUP_BATCH_SIZE) {
      const batch = activeSessions.slice(i, i + WARMUP_BATCH_SIZE);
      
      await Promise.allSettled(
        batch.map(async (session) => {
          try {
            // Extract features from profile if available
            const profile = session.profileJson as any;
            const features = profile?._diagnostics?.lastPredictorData?.features;
            
            if (!features || Object.keys(features).length === 0) {
              console.log(`   ⏭️  ${session.symbol}: No features available, skipping`);
              return;
            }
            
            const prediction = await getPrediction(features);
            setCachedPrediction(session.symbol, prediction, features);
            console.log(`   ✅ ${session.symbol}: Cached (confidence: ${(prediction.confidence * 100).toFixed(1)}%)`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.log(`   ❌ ${session.symbol}: Failed - ${errorMsg}`);
          }
        })
      );
      
      // Small delay between batches
      if (i + WARMUP_BATCH_SIZE < activeSessions.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    isWarmupComplete = true;
    lastWarmupAt = Date.now();
    lastRefreshError = null;
    console.log(`✅ Cache warmup complete: ${predictorCache.size} symbol(s) cached`);
  } catch (error) {
    console.error('❌ Cache warmup failed:', error);
    lastWarmupAt = Date.now();
    lastRefreshError = error instanceof Error ? error.message : String(error);
  }
}

/**
 * Refresh cached predictions in the background
 */
async function refreshPredictorCache(): Promise<void> {
  if (!isPythonPredictorAvailable()) {
    return;
  }
  
  const now = Date.now();
  const entriesToRefresh = Array.from(predictorCache.values())
    .filter(entry => {
      // Refresh entries that are 75% through their TTL
      const age = now - entry.timestamp;
      const ttl = entry.expiresAt - entry.timestamp;
      return age >= ttl * 0.75;
    })
    .slice(0, WARMUP_BATCH_SIZE); // Limit batch size
  
  if (entriesToRefresh.length === 0) {
    lastRefreshAt = now;
    lastRefreshError = null;
    return;
  }

  console.log(`🔄 Background refresh: ${entriesToRefresh.length} prediction(s)`);

  let hadError = false;
  try {
    await Promise.allSettled(
      entriesToRefresh.map(async (entry) => {
        try {
          const prediction = await getPrediction(entry.features);
          setCachedPrediction(entry.symbol, prediction, entry.features);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          console.warn(`   ⚠️  Failed to refresh ${entry.symbol}:`, errorMsg);
          hadError = true;
          lastRefreshError = errorMsg;
        }
      })
    );
    lastRefreshAt = Date.now();
    if (!hadError) {
      lastRefreshError = null;
    }
  } catch (error) {
    lastRefreshAt = Date.now();
    lastRefreshError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/**
 * Start background refresh scheduler
 */
export function startBackgroundRefresh(): void {
  if (refreshIntervalHandle) {
    console.log('⚠️  Background refresh already running');
    return;
  }
  
  console.log(`🔄 Starting background predictor refresh (every ${BACKGROUND_REFRESH_INTERVAL_MS / 1000}s)`);
  
  // Initial delay before first refresh
  setTimeout(() => {
    refreshIntervalHandle = setInterval(() => {
      refreshPredictorCache().catch(err => {
        console.error('Background refresh error:', err);
      });
    }, BACKGROUND_REFRESH_INTERVAL_MS);
  }, 10_000); // Wait 10s before first refresh
}

/**
 * Stop background refresh scheduler
 */
export function stopBackgroundRefresh(): void {
  if (refreshIntervalHandle) {
    clearInterval(refreshIntervalHandle);
    refreshIntervalHandle = null;
    console.log('🛑 Background predictor refresh stopped');
  }
}

/**
 * Add prediction to cache when a new symbol is selected
 */
export async function warmupSymbol(
  symbol: string,
  features: Record<string, number>
): Promise<PythonPredictionResult | null> {
  if (!isPythonPredictorAvailable()) {
    return null;
  }
  
  try {
    console.log(`🔥 Warming up predictor cache for new symbol: ${symbol}`);
    const prediction = await getPrediction(features);
    setCachedPrediction(symbol, prediction, features);
    return prediction;
  } catch (error) {
    console.error(`❌ Failed to warmup ${symbol}:`, error);
    return null;
  }
}
