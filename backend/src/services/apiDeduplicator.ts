/**
 * API Call Deduplicator
 *
 * CRITICAL FIX for audit findings:
 * - fetchPositions() called 3× per user during startup (CRITICAL)
 * - fetchMyTrades() called N× simultaneously (HIGH)
 * - fetchOHLCV() for BTC 1h called by all agents (CRITICAL - 8000 weight/min)
 *
 * Solution: Deduplicate concurrent calls to same endpoint with same parameters
 *
 * How it works:
 * 1. Agent A calls fetchPositions(userId)
 * 2. Agent B calls fetchPositions(userId) 100ms later
 * 3. Agent B gets Promise from Agent A's in-flight request (NO API CALL)
 * 4. Both agents get same result when Promise resolves
 *
 * Prevents: 1000 agents calling same API = 1 actual call
 */

import { LRUCache } from '../utils/lruCache.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('api-dedup');

type InFlightRequest<T> = {
  promise: Promise<T>;
  startedAt: number;
  callers: string[];
};

export class APIDeduplicator {
  // In-flight requests (currently executing)
  private inFlight = new Map<string, InFlightRequest<any>>();

  // Result cache (completed requests)
  private cache: LRUCache<any>;

  // Stats
  private stats = {
    totalCalls: 0,
    dedupHits: 0,
    cacheHits: 0,
    apiCalls: 0,
  };

  constructor(maxCacheSize = 1000, defaultCacheTTL = 30_000) {
    this.cache = new LRUCache(maxCacheSize, defaultCacheTTL);
  }

  /**
   * Execute an API call with deduplication
   *
   * @param key - Unique key for this API call (e.g., "fetchPositions:user_123")
   * @param fn - Function that makes the API call
   * @param cacheTTL - How long to cache result (ms), 0 = no cache
   * @param callerId - Identifier of caller (for debugging)
   */
  async execute<T>(
    key: string,
    fn: () => Promise<T>,
    cacheTTL: number = 30_000,
    callerId?: string
  ): Promise<T> {
    this.stats.totalCalls++;

    // 1. Check result cache first (completed requests)
    if (cacheTTL > 0) {
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        this.stats.cacheHits++;
        logger.debug(`[${key}] Cache HIT (caller: ${callerId})`);
        return cached;
      }
    }

    // 2. Check if request is already in flight
    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      this.stats.dedupHits++;
      if (callerId) {
        inFlight.callers.push(callerId);
      }
      logger.debug(`[${key}] Dedup HIT - reusing in-flight request (callers: ${inFlight.callers.length})`);
      return inFlight.promise;
    }

    // 3. No cache, no in-flight → Make actual API call
    this.stats.apiCalls++;
    logger.debug(`[${key}] Making API call (caller: ${callerId})`);

    const promise = fn()
      .then((result) => {
        // Cache result if TTL > 0
        if (cacheTTL > 0) {
          this.cache.set(key, result, cacheTTL);
        }

        // Remove from in-flight
        this.inFlight.delete(key);

        const request = this.inFlight.get(key);
        if (request) {
          const duration = Date.now() - request.startedAt;
          logger.info(`[${key}] ✅ Completed in ${duration}ms (served ${request.callers.length} callers)`);
        }

        return result;
      })
      .catch((error) => {
        // Remove from in-flight on error
        this.inFlight.delete(key);

        logger.error(`[${key}] ❌ API call failed:`, error.message);
        throw error;
      });

    // Store in-flight request
    this.inFlight.set(key, {
      promise,
      startedAt: Date.now(),
      callers: callerId ? [callerId] : [],
    });

    return promise;
  }

  /**
   * Invalidate cache for a key
   */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  /**
   * Invalidate all cache entries matching a pattern
   */
  invalidatePattern(pattern: RegExp): void {
    // Note: LRUCache doesn't expose keys() iterator
    // This is a simplified version - consider adding to LRUCache if needed
    logger.warn(`invalidatePattern() not fully implemented - clearing all cache`);
    this.cache.clear();
  }

  /**
   * Clear all cache and in-flight requests
   */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /**
   * Get stats
   */
  getStats() {
    const deduplicationRate = this.stats.totalCalls > 0
      ? Math.round(((this.stats.dedupHits + this.stats.cacheHits) / this.stats.totalCalls) * 100)
      : 0;

    const apiReduction = this.stats.totalCalls > 0
      ? Math.round((1 - (this.stats.apiCalls / this.stats.totalCalls)) * 100)
      : 0;

    return {
      ...this.stats,
      inFlightCount: this.inFlight.size,
      cacheStats: this.cache.getStats(),
      deduplicationRate,
      apiReduction,
    };
  }

  /**
   * Reset stats
   */
  resetStats(): void {
    this.stats = {
      totalCalls: 0,
      dedupHits: 0,
      cacheHits: 0,
      apiCalls: 0,
    };
    this.cache.resetStats();
  }
}

// ============================================================================
// Global Singleton Instances
// ============================================================================

/**
 * Deduplicator for exchange API calls
 * Prevents multiple agents calling same API simultaneously
 */
export const exchangeAPIDeduplicator = new APIDeduplicator(
  1000,  // Max 1000 cached results
  30_000 // 30 second default TTL
);

/**
 * Helper function to create cache key for fetchPositions
 */
export function makeFetchPositionsKey(userId: string): string {
  return `fetchPositions:${userId}`;
}

/**
 * Helper function to create cache key for fetchBalance
 */
export function makeFetchBalanceKey(userId: string): string {
  return `fetchBalance:${userId}`;
}

/**
 * Helper function to create cache key for fetchMyTrades
 */
export function makeFetchMyTradesKey(userId: string, symbol: string, since: number): string {
  return `fetchMyTrades:${userId}:${symbol}:${since}`;
}

/**
 * Helper function to create cache key for fetchOHLCV
 */
export function makeFetchOHLCVKey(symbol: string, timeframe: string, limit: number): string {
  return `fetchOHLCV:${symbol}:${timeframe}:${limit}`;
}
