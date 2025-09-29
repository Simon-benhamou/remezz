import { useCallback } from 'react';
import { useSessionsCache } from './useSessionsCache';
import { useDashboardStore } from '../store';
import { AppMode } from '../store';
import { useCacheNotifications } from './useCacheNotifications';

// Hook pour gérer l'invalidation automatique du cache lors des actions utilisateur
export function useSmartCacheInvalidation() {
  const { invalidateCache: invalidateSessionsCache } = useSessionsCache();
  const { invalidateCache: invalidateDashboardCache } = useDashboardStore();
  const { notifyError } = useCacheNotifications();

  // Invalidate cache when user performs actions that change data
  const invalidateAfterAction = useCallback((
    action: 'start' | 'stop' | 'delete' | 'update',
    mode?: AppMode
  ) => {
    try {
      console.log(`🧹 Invalidating cache after ${action} action`);

      if (mode) {
        // Invalider le cache des sessions pour ce mode spécifique
        invalidateSessionsCache(mode);
        // Invalider le cache du dashboard pour ce mode
        invalidateDashboardCache(mode);
      } else {
        // Invalider tout le cache si pas de mode spécifié
        invalidateSessionsCache();
        invalidateDashboardCache();
      }

      console.log(`✅ Cache invalidated after ${action} action`);
    } catch (error) {
      console.error('Failed to invalidate cache:', error);
      notifyError('Failed to refresh cache');
    }
  }, [invalidateSessionsCache, invalidateDashboardCache, notifyError]);

  // Smart invalidation based on action type
  const invalidateSmartly = useCallback((
    action: 'session_created' | 'session_stopped' | 'session_deleted' | 'symbol_changed' | 'settings_changed',
    metadata?: { mode?: AppMode; sessionId?: string }
  ) => {
    const mode = metadata?.mode;

    switch (action) {
      case 'session_created':
      case 'session_stopped':
      case 'session_deleted':
        // Ces actions affectent la liste des sessions et l'overview
        invalidateAfterAction('update', mode);
        break;
      
      case 'symbol_changed':
      case 'settings_changed':
        // Ces actions affectent seulement la session spécifique et l'overview
        invalidateAfterAction('update', mode);
        break;
      
      default:
        console.warn(`Unknown action for cache invalidation: ${action}`);
    }
  }, [invalidateAfterAction]);

  return {
    invalidateAfterAction,
    invalidateSmartly,
  };
}