import { useState, useCallback, useEffect, useRef } from 'react';
import { AppMode } from '../store';

/**
 * Cache entry for multi-data cache
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Definition for a single data source
 */
interface DataSource<T> {
  /** Unique key for this data source */
  key: string;
  /** Function that fetches the data */
  fetcher: () => Promise<T>;
  /** TTL for this specific data source (overrides default) */
  ttlMs?: number;
}

/**
 * Options for useMultiDataCache hook
 */
interface UseMultiDataCacheOptions<T extends Record<string, any>> {
  /** Base cache key for this group */
  cacheKey: string;
  /** Data sources to fetch */
  sources: { [K in keyof T]: DataSource<T[K]> };
  /** Default TTL in milliseconds (default: 30000 = 30s) */
  defaultTtlMs?: number;
  /** Auto-refresh interval in milliseconds (default: 60000 = 60s, 0 to disable) */
  autoRefreshMs?: number;
  /** Whether to include mode in cache key (default: true) */
  modeAware?: boolean;
  /** Current mode - required if modeAware is true */
  mode?: AppMode;
  /** Whether to fetch immediately on mount (default: true) */
  fetchOnMount?: boolean;
  /** Callback when all data is updated */
  onDataUpdate?: (data: Partial<T>) => void;
  /** Callback on error */
  onError?: (key: string, error: Error) => void;
}

/**
 * Return type for useMultiDataCache hook
 */
interface UseMultiDataCacheReturn<T extends Record<string, any>> {
  /** All cached data */
  data: Partial<T>;
  /** True only on initial load when no cached data exists */
  isInitialLoad: boolean;
  /** True when fetching fresh data (data is still visible) */
  isRefreshing: boolean;
  /** Errors by key */
  errors: Partial<Record<keyof T, Error>>;
  /** Refresh all or specific sources */
  refresh: (keys?: (keyof T)[], force?: boolean) => Promise<Partial<T>>;
  /** Invalidate all or specific caches */
  invalidate: (keys?: (keyof T)[]) => void;
  /** Get specific data source */
  get: <K extends keyof T>(key: K) => T[K] | null;
  /** Last updated timestamp */
  lastUpdated: number | null;
}

// Global cache store
const globalMultiCache: Map<string, Map<string, CacheEntry<any>>> = new Map();

/**
 * Hook for fetching multiple data sources with shared caching and stale-while-revalidate.
 * Fetches all sources in parallel for better performance.
 *
 * @example
 * ```tsx
 * const { data, isRefreshing, refresh } = useMultiDataCache({
 *   cacheKey: 'dashboard',
 *   mode,
 *   sources: {
 *     overview: { key: 'overview', fetcher: () => api.overview(mode) },
 *     trades: { key: 'trades', fetcher: () => api.getTrades(mode), ttlMs: 60000 },
 *     conditions: { key: 'conditions', fetcher: () => api.getMarketConditions(mode) },
 *   },
 * });
 * ```
 */
/**
 * Clear all multi-data cached data (useful for logout)
 */
export function clearAllMultiCache(): void {
  globalMultiCache.clear();
  console.log('All multi-cache cleared');
}

export function useMultiDataCache<T extends Record<string, any>>(
  options: UseMultiDataCacheOptions<T>
): UseMultiDataCacheReturn<T> {
  const {
    cacheKey,
    sources,
    defaultTtlMs = 30000,
    autoRefreshMs = 60000,
    modeAware = true,
    mode,
    fetchOnMount = true,
    onDataUpdate,
    onError,
  } = options;

  // Generate full cache key
  const fullCacheKey = modeAware && mode ? `${cacheKey}:${mode}` : cacheKey;

  // Initialize global cache for this key if needed
  if (!globalMultiCache.has(fullCacheKey)) {
    globalMultiCache.set(fullCacheKey, new Map());
  }

  const cacheStore = globalMultiCache.get(fullCacheKey)!;

  // Get initial data from cache
  const getInitialData = useCallback((): Partial<T> => {
    const result: Partial<T> = {};
    for (const key of Object.keys(sources) as (keyof T)[]) {
      const cached = cacheStore.get(String(key));
      if (cached?.data !== undefined) {
        result[key] = cached.data;
      }
    }
    return result;
  }, [sources]);

  // Check if any source has cached data
  const hasAnyCachedData = useCallback((): boolean => {
    for (const key of Object.keys(sources)) {
      if (cacheStore.has(key)) return true;
    }
    return false;
  }, [sources]);

  // Local state
  const [data, setData] = useState<Partial<T>>(getInitialData);
  const [isInitialLoad, setIsInitialLoad] = useState(!hasAnyCachedData());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof T, Error>>>({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Refs for cleanup
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);

  // Check if a specific source's cache is valid
  const isSourceCacheValid = useCallback((sourceKey: keyof T): boolean => {
    const source = sources[sourceKey];
    const cached = cacheStore.get(String(sourceKey));
    if (!cached) return false;
    const ttl = source.ttlMs ?? defaultTtlMs;
    return (Date.now() - cached.timestamp) < ttl;
  }, [sources, defaultTtlMs]);

  // Check if any cache is stale
  const hasStaleCache = useCallback((): boolean => {
    for (const key of Object.keys(sources) as (keyof T)[]) {
      if (!isSourceCacheValid(key)) return true;
    }
    return false;
  }, [sources, isSourceCacheValid]);

  // Refresh function
  const refresh = useCallback(async (
    keys?: (keyof T)[],
    force = false
  ): Promise<Partial<T>> => {
    const keysToFetch = keys ?? (Object.keys(sources) as (keyof T)[]);

    // Filter to only stale sources (unless forcing)
    const staleSources = force
      ? keysToFetch
      : keysToFetch.filter(key => !isSourceCacheValid(key));

    if (staleSources.length === 0) {
      console.log(`🎯 [${fullCacheKey}] All data cached and valid`);
      return data;
    }

    // Determine if this is initial load or refresh
    const hasExistingData = hasAnyCachedData();

    if (hasExistingData) {
      setIsRefreshing(true);
      // Keep showing existing data
      setData(getInitialData());
    } else {
      setIsInitialLoad(true);
    }

    const newErrors: Partial<Record<keyof T, Error>> = { ...errors };
    const updatedData: Partial<T> = { ...data };

    console.log(`🔄 [${fullCacheKey}] Fetching: ${staleSources.join(', ')}`);

    // Fetch all stale sources in parallel
    const fetchPromises = staleSources.map(async (key) => {
      const source = sources[key];
      try {
        const freshData = await source.fetcher();

        if (!isMountedRef.current) return;

        // Update cache
        cacheStore.set(String(key), {
          data: freshData,
          timestamp: Date.now(),
        });

        updatedData[key] = freshData;
        delete newErrors[key];

        console.log(`✅ [${fullCacheKey}:${String(key)}] Cached`);
      } catch (err) {
        if (!isMountedRef.current) return;

        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`❌ [${fullCacheKey}:${String(key)}] Failed:`, error);
        newErrors[key] = error;
        onError?.(String(key), error);

        // Keep stale data if available
        const cached = cacheStore.get(String(key));
        if (cached?.data !== undefined) {
          updatedData[key] = cached.data;
        }
      }
    });

    await Promise.all(fetchPromises);

    if (!isMountedRef.current) return updatedData;

    setData(updatedData);
    setErrors(newErrors);
    setLastUpdated(Date.now());
    setIsInitialLoad(false);
    setIsRefreshing(false);

    onDataUpdate?.(updatedData);

    return updatedData;
  }, [
    fullCacheKey,
    sources,
    data,
    errors,
    isSourceCacheValid,
    hasAnyCachedData,
    getInitialData,
    onDataUpdate,
    onError,
  ]);

  // Invalidate cache
  const invalidate = useCallback((keys?: (keyof T)[]) => {
    const keysToInvalidate = keys ?? (Object.keys(sources) as (keyof T)[]);
    for (const key of keysToInvalidate) {
      cacheStore.delete(String(key));
    }
    console.log(`🗑️ [${fullCacheKey}] Invalidated: ${keysToInvalidate.join(', ')}`);
  }, [fullCacheKey, sources]);

  // Get specific data
  const get = useCallback(<K extends keyof T>(key: K): T[K] | null => {
    return data[key] ?? null;
  }, [data]);

  // Initial fetch on mount
  useEffect(() => {
    if (fetchOnMount) {
      refresh();
    }
  }, [fullCacheKey]); // Re-fetch when cache key changes

  // Auto-refresh setup
  useEffect(() => {
    if (autoRefreshMs > 0) {
      autoRefreshRef.current = setInterval(() => {
        if (hasStaleCache()) {
          console.log(`⏰ [${fullCacheKey}] Auto-refresh triggered`);
          refresh(undefined, false);
        }
      }, autoRefreshMs);
    }

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
      }
    };
  }, [fullCacheKey, autoRefreshMs, hasStaleCache, refresh]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Sync data when cache key changes (e.g., mode switch)
  useEffect(() => {
    setData(getInitialData());
    setIsInitialLoad(!hasAnyCachedData());
  }, [fullCacheKey, getInitialData, hasAnyCachedData]);

  return {
    data,
    isInitialLoad,
    isRefreshing,
    errors,
    refresh,
    invalidate,
    get,
    lastUpdated,
  };
}
