import { useState, useCallback, useEffect, useRef } from 'react';
import { AppMode } from '../store';

/**
 * Generic data cache entry
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Cache store - keyed by cacheKey
 */
interface CacheStore<T> {
  [key: string]: CacheEntry<T>;
}

/**
 * Options for useDataCache hook
 */
interface UseDataCacheOptions<T> {
  /** Unique key for this data type (e.g., 'dashboard', 'trades', 'sessions') */
  cacheKey: string;
  /** Function that fetches the data */
  fetcher: () => Promise<T>;
  /** Time-to-live in milliseconds (default: 30000 = 30s) */
  ttlMs?: number;
  /** Auto-refresh interval in milliseconds (default: 60000 = 60s, 0 to disable) */
  autoRefreshMs?: number;
  /** Whether to include mode in cache key (default: true) */
  modeAware?: boolean;
  /** Current mode - required if modeAware is true */
  mode?: AppMode;
  /** Whether to fetch immediately on mount (default: true) */
  fetchOnMount?: boolean;
  /** Callback when data is updated */
  onDataUpdate?: (data: T) => void;
  /** Callback on error */
  onError?: (error: Error) => void;
}

/**
 * Return type for useDataCache hook
 */
interface UseDataCacheReturn<T> {
  /** The cached data (may be stale while refreshing) */
  data: T | null;
  /** True only on initial load when no cached data exists */
  isInitialLoad: boolean;
  /** True when fetching fresh data (data is still visible) */
  isRefreshing: boolean;
  /** Error from last fetch attempt */
  error: Error | null;
  /** Manually trigger a refresh */
  refresh: (force?: boolean) => Promise<T | null>;
  /** Invalidate the cache for this key */
  invalidate: () => void;
  /** Check if cache is valid */
  isCacheValid: () => boolean;
  /** Get the cache timestamp */
  lastUpdated: number | null;
}

// Global cache store (persists across component unmounts within session)
const MAX_CACHE_SIZE = 50;
const globalCache: Map<string, CacheStore<any>> = new Map();

function evictOldest(map: Map<string, any>, maxSize: number): void {
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Generic hook for data fetching with caching and stale-while-revalidate pattern.
 *
 * Features:
 * - TTL-based cache validation
 * - Stale-while-revalidate: shows existing data while fetching fresh data
 * - Mode-aware caching (paper/live)
 * - Auto-refresh at configurable intervals
 * - Distinguishes between initial load (no data) and refresh (has data)
 *
 * @example
 * ```tsx
 * const { data, isRefreshing, refresh } = useDataCache({
 *   cacheKey: 'dashboard-overview',
 *   fetcher: () => api.overview(mode),
 *   mode,
 *   ttlMs: 30000,
 *   autoRefreshMs: 60000,
 * });
 * ```
 */
export function useDataCache<T>(options: UseDataCacheOptions<T>): UseDataCacheReturn<T> {
  const {
    cacheKey,
    fetcher,
    ttlMs = 30000,
    autoRefreshMs = 60000,
    modeAware = true,
    mode,
    fetchOnMount = true,
    onDataUpdate,
    onError,
  } = options;

  // Generate full cache key (optionally including mode)
  const fullCacheKey = modeAware && mode ? `${cacheKey}:${mode}` : cacheKey;

  // Initialize global cache for this key if needed
  if (!globalCache.has(cacheKey)) {
    globalCache.set(cacheKey, {});
    evictOldest(globalCache, MAX_CACHE_SIZE);
  }

  const cacheStore = globalCache.get(cacheKey)!;

  // Local state
  const [data, setData] = useState<T | null>(() => {
    const cached = cacheStore[fullCacheKey];
    return cached?.data ?? null;
  });
  const [isInitialLoad, setIsInitialLoad] = useState(!cacheStore[fullCacheKey]?.data);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(
    cacheStore[fullCacheKey]?.timestamp ?? null
  );

  // Refs for cleanup
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // Check if cache is valid
  const isCacheValid = useCallback(() => {
    const cached = cacheStore[fullCacheKey];
    if (!cached) return false;
    return (Date.now() - cached.timestamp) < ttlMs;
  }, [fullCacheKey, ttlMs]);

  // Refresh function
  const refresh = useCallback(async (force = false): Promise<T | null> => {
    // If cache is valid and not forcing, return cached data
    if (!force && isCacheValid()) {
      const cached = cacheStore[fullCacheKey];
      if (cached?.data) {
        if (import.meta.env.DEV) console.log(`🎯 [${fullCacheKey}] Using cached data`);
        return cached.data;
      }
    }

    // Determine if this is initial load or refresh
    const hasExistingData = !!cacheStore[fullCacheKey]?.data;

    if (hasExistingData) {
      // Stale-while-revalidate: show existing data, mark as refreshing
      setIsRefreshing(true);
      setData(cacheStore[fullCacheKey]!.data);
    } else {
      // No existing data: show initial load state
      setIsInitialLoad(true);
    }

    setError(null);

    try {
      if (import.meta.env.DEV) console.log(`🔄 [${fullCacheKey}] Fetching fresh data...`);
      const freshData = await fetcher();

      if (!isMountedRef.current) return null;

      // Update cache
      cacheStore[fullCacheKey] = {
        data: freshData,
        timestamp: Date.now(),
      };

      // Update state
      setData(freshData);
      setLastUpdated(Date.now());
      setError(null);

      // Callback
      onDataUpdate?.(freshData);

      if (import.meta.env.DEV) console.log(`✅ [${fullCacheKey}] Data cached`);
      return freshData;
    } catch (err) {
      if (!isMountedRef.current) return null;

      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`❌ [${fullCacheKey}] Fetch failed:`, error);
      setError(error);
      onError?.(error);

      // Return stale data if available
      return cacheStore[fullCacheKey]?.data ?? null;
    } finally {
      if (isMountedRef.current) {
        setIsInitialLoad(false);
        setIsRefreshing(false);
      }
    }
  }, [fullCacheKey, fetcher, isCacheValid, onDataUpdate, onError]);

  // Invalidate cache
  const invalidate = useCallback(() => {
    delete cacheStore[fullCacheKey];
    setLastUpdated(null);
    if (import.meta.env.DEV) console.log(`🗑️ [${fullCacheKey}] Cache invalidated`);
  }, [fullCacheKey]);

  // Initial fetch on mount
  useEffect(() => {
    if (fetchOnMount) {
      refresh();
    }
  }, [fullCacheKey]); // Re-fetch when cache key changes (e.g., mode change)

  // Auto-refresh setup
  useEffect(() => {
    if (autoRefreshMs > 0) {
      autoRefreshRef.current = setInterval(() => {
        if (!isCacheValid()) {
          if (import.meta.env.DEV) console.log(`⏰ [${fullCacheKey}] Auto-refresh triggered`);
          refresh(true);
        }
      }, autoRefreshMs);
    }

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
      }
    };
  }, [fullCacheKey, autoRefreshMs, isCacheValid, refresh]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Sync data when cache key changes (e.g., mode switch)
  useEffect(() => {
    const cached = cacheStore[fullCacheKey];
    if (cached?.data) {
      setData(cached.data);
      setLastUpdated(cached.timestamp);
      setIsInitialLoad(false);
    } else {
      setData(null);
      setLastUpdated(null);
      setIsInitialLoad(true);
    }
  }, [fullCacheKey]);

  return {
    data,
    isInitialLoad,
    isRefreshing,
    error,
    refresh,
    invalidate,
    isCacheValid,
    lastUpdated,
  };
}

/**
 * Helper to create a mode-aware cache key
 */
export function createCacheKey(base: string, mode?: AppMode, ...parts: string[]): string {
  const allParts = [base, mode, ...parts].filter(Boolean);
  return allParts.join(':');
}

/**
 * Clear all cached data (useful for logout)
 */
export function clearAllCache(): void {
  globalCache.clear();
  if (import.meta.env.DEV) console.log('🗑️ All cache cleared');
}

/**
 * Clear cache for a specific key prefix
 */
export function clearCacheByPrefix(prefix: string): void {
  globalCache.forEach((store, key) => {
    if (key.startsWith(prefix)) {
      globalCache.delete(key);
    }
  });
  if (import.meta.env.DEV) console.log(`🗑️ Cache cleared for prefix: ${prefix}`);
}
