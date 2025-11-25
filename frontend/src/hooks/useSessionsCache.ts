import { useState, useCallback, useEffect, useRef } from 'react';
import { api } from '../api';
import { AppMode } from '../store';

interface SessionsCacheData {
  sessions: any[];
  timestamp: number;
}

interface SessionsCache {
  [key: string]: SessionsCacheData; // key = `${mode}:${includeStats}`
}

const SESSIONS_CACHE_TTL = 8000; // 8 seconds TTL
const AUTO_REFRESH_INTERVAL = 20000; // Auto refresh every 20s

export function useSessionsCache() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cacheRef = useRef<SessionsCache>({});
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const generateCacheKey = (mode: AppMode, includeStats = false) => {
    return `${mode}:${includeStats}`;
  };

  const isCacheValid = useCallback((key: string) => {
    const cached = cacheRef.current[key];
    if (!cached) return false;
    return (Date.now() - cached.timestamp) < SESSIONS_CACHE_TTL;
  }, []);

  const getCachedSessions = useCallback((mode: AppMode, includeStats = false) => {
    const key = generateCacheKey(mode, includeStats);
    if (isCacheValid(key)) {
      console.log(`🎯 Using cached sessions for ${key}`);
      return cacheRef.current[key].sessions;
    }
    return null;
  }, [isCacheValid]);

  const loadSessions = useCallback(async (
    mode: AppMode, 
    includeStats = false, 
    forceRefresh = false
  ) => {
    const key = generateCacheKey(mode, includeStats);
    
    // Check cache first
    if (!forceRefresh) {
      const cached = getCachedSessions(mode, includeStats);
      if (cached) {
        return cached;
      }
    }

    setLoading(true);
    setError(null);

    try {
      console.log(`🔄 Fetching fresh sessions for ${key}`);
      const response = await api.listSessions(mode, includeStats);
      
      // Handle both formats: direct array or { sessions: [...] }
      const sessions = Array.isArray(response) ? response : (response?.sessions || []);
      
      // Cache the result
      cacheRef.current[key] = {
        sessions,
        timestamp: Date.now()
      };

      console.log(`✅ Cached ${sessions.length} sessions for ${key}`);
      return sessions;
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || err?.message || 'Failed to load sessions';
      setError(errorMsg);
      console.error(`❌ Failed to load sessions for ${key}:`, err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [getCachedSessions]);

  const invalidateCache = useCallback((mode?: AppMode, includeStats?: boolean) => {
    if (mode !== undefined && includeStats !== undefined) {
      const key = generateCacheKey(mode, includeStats);
      delete cacheRef.current[key];
      console.log(`🗑️ Invalidated sessions cache for ${key}`);
    } else if (mode !== undefined) {
      // Invalidate all variations of this mode
      const keysToDelete = Object.keys(cacheRef.current).filter(k => k.startsWith(`${mode}:`));
      keysToDelete.forEach(key => delete cacheRef.current[key]);
      console.log(`🗑️ Invalidated all sessions cache for mode ${mode}`);
    } else {
      // Invalidate all cache
      cacheRef.current = {};
      console.log('🗑️ Invalidated all sessions cache');
    }
  }, []);

  const refreshCache = useCallback(async (mode: AppMode, includeStats = false) => {
    try {
      await loadSessions(mode, includeStats, true);
    } catch (error) {
      console.error('Failed to refresh sessions cache:', error);
    }
  }, [loadSessions]);

  // Auto refresh setup
  const setupAutoRefresh = useCallback((mode: AppMode, includeStats = false) => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      const key = generateCacheKey(mode, includeStats);
      if (!isCacheValid(key)) {
        console.log(`⏰ Auto-refresh triggered for sessions ${key}`);
        refreshCache(mode, includeStats);
      }
    }, AUTO_REFRESH_INTERVAL);
  }, [isCacheValid, refreshCache]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  return {
    loading,
    error,
    loadSessions,
    getCachedSessions,
    invalidateCache,
    refreshCache,
    setupAutoRefresh,
    isCacheValid: (mode: AppMode, includeStats = false) => {
      const key = generateCacheKey(mode, includeStats);
      return isCacheValid(key);
    }
  };
}
