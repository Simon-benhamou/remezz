import { message } from 'antd';
import { useRef, useEffect } from 'react';
import { AppMode } from '../store';

// Hook pour gérer les notifications de cache et mode switching
export function useCacheNotifications() {
  const lastModeRef = useRef<AppMode | null>(null);
  const messageKeyRef = useRef<any>(null);

  const notifyModeSwitch = (newMode: AppMode, hasCache: boolean) => {
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
    }

    lastModeRef.current = newMode;
  };

  const notifyCacheRefresh = (mode: AppMode, dataCount?: number) => {
    message.success({
      content: `✅ ${mode.toUpperCase()} data refreshed${dataCount ? ` (${dataCount} items)` : ''}`,
      duration: 1.5,
    });
  };

  const notifyCacheHit = (mode: AppMode) => {
    message.info({
      content: `⚡ Using cached ${mode.toUpperCase()} data`,
      duration: 1,
    });
  };

  const notifyError = (error: string) => {
    message.error({
      content: `❌ ${error}`,
      duration: 3,
    });
  };

  return {
    notifyModeSwitch,
    notifyCacheRefresh,
    notifyCacheHit,
    notifyError,
  };
}