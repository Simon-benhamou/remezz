import { message } from 'antd';
import { useRef, useCallback } from 'react';
import { AppMode } from '../store';

// Hook pour gérer les notifications de cache et mode switching
export function useCacheNotifications() {
  const lastModeRef = useRef<AppMode | null>(null);
  const messageKeyRef = useRef<any>(null);
  const cacheHitShownRef = useRef<Set<string>>(new Set());

  const notifyModeSwitch = useCallback((newMode: AppMode, hasCache: boolean) => {
    // Hide previous message if exists
    if (messageKeyRef.current) {
      message.destroy(messageKeyRef.current);
    }

    if (lastModeRef.current && lastModeRef.current !== newMode) {
      if (hasCache) {
        messageKeyRef.current = message.success({
          content: `🎯 Switched to ${newMode.toUpperCase()} mode - using cached data`,
          duration: 2,
          key: 'mode-switch',
        });
      } else {
        messageKeyRef.current = message.loading({
          content: `🔄 Switching to ${newMode.toUpperCase()} mode - loading fresh data...`,
          duration: 3,
          key: 'mode-switch',
        });
      }
      // Reset cache hit tracking pour le nouveau mode
      cacheHitShownRef.current.clear();
    }

    lastModeRef.current = newMode;
  }, []);

  const notifyCacheRefresh = useCallback((mode: AppMode, dataCount?: number) => {
    message.success({
      content: `✅ ${mode.toUpperCase()} data refreshed${dataCount ? ` (${dataCount} items)` : ''}`,
      duration: 1.5,
    });
    // Reset cache hit tracking après un refresh
    cacheHitShownRef.current.clear();
  }, []);

  const notifyCacheHit = useCallback((mode: AppMode) => {
    // Limiter les notifications de cache hit pour éviter le spam
    const key = `${mode}-cache-hit`;
    if (!cacheHitShownRef.current.has(key)) {
      message.info({
        content: `⚡ Using cached ${mode.toUpperCase()} data`,
        duration: 1,
      });
      cacheHitShownRef.current.add(key);
      
      // Auto-clear après 5 secondes pour permettre une nouvelle notification si nécessaire
      setTimeout(() => {
        cacheHitShownRef.current.delete(key);
      }, 5000);
    }
  }, []);

  const notifyError = useCallback((error: string) => {
    message.error({
      content: `❌ ${error}`,
      duration: 3,
    });
  }, []);

  return {
    notifyModeSwitch,
    notifyCacheRefresh,
    notifyCacheHit,
    notifyError,
  };
}