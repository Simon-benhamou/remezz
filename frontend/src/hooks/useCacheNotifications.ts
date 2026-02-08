import { toast } from '@/lib/toast';
import { useRef, useCallback } from 'react';
import { AppMode } from '../store';

// Hook pour gérer les notifications de cache et mode switching
export function useCacheNotifications() {
  const lastModeRef = useRef<AppMode | null>(null);
  const cacheHitShownRef = useRef<Set<string>>(new Set());

  const notifyModeSwitch = useCallback((newMode: AppMode, hasCache: boolean) => {
    if (lastModeRef.current && lastModeRef.current !== newMode) {
      if (hasCache) {
        toast.success(`Switched to ${newMode.toUpperCase()} mode - using cached data`);
      } else {
        toast.loading(`Switching to ${newMode.toUpperCase()} mode - loading fresh data...`);
      }
      // Reset cache hit tracking pour le nouveau mode
      cacheHitShownRef.current.clear();
    }

    lastModeRef.current = newMode;
  }, []);

  const notifyCacheRefresh = useCallback((mode: AppMode, dataCount?: number) => {
    toast.success(`${mode.toUpperCase()} data refreshed${dataCount ? ` (${dataCount} items)` : ''}`);
    // Reset cache hit tracking après un refresh
    cacheHitShownRef.current.clear();
  }, []);

  const notifyCacheHit = useCallback((mode: AppMode) => {
    // Limiter les notifications de cache hit pour éviter le spam
    const key = `${mode}-cache-hit`;
    if (!cacheHitShownRef.current.has(key)) {
      toast.info(`Using cached ${mode.toUpperCase()} data`);
      cacheHitShownRef.current.add(key);

      // Auto-clear après 5 secondes pour permettre une nouvelle notification si nécessaire
      setTimeout(() => {
        cacheHitShownRef.current.delete(key);
      }, 5000);
    }
  }, []);

  const notifyError = useCallback((error: string) => {
    toast.error(error);
  }, []);

  return {
    notifyModeSwitch,
    notifyCacheRefresh,
    notifyCacheHit,
    notifyError,
  };
}
