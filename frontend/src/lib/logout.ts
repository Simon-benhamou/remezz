import { clearAllCache } from '../hooks/useDataCache';
import { clearAllMultiCache } from '../hooks/useMultiDataCache';
import { closeJobsWs } from '../hooks/useOpsJobs';
import { clearApiKey } from '../api';
import { wsManager } from '../ws';
import {
  useAuthStore,
  useDashboardStore,
  useOpsJobsStore,
  useSelectorInsightsStore,
} from '../store';

/**
 * Full logout cleanup for multi-user system.
 *
 * Clears all in-memory caches, Zustand stores, WebSocket connections,
 * local/session storage, and redirects to /login.
 */
export function fullLogout(): void {
  try {
    // 1. Close WebSocket connections
    closeJobsWs();
    wsManager.disconnect();

    // 2. Clear in-memory data caches
    clearAllCache();
    clearAllMultiCache();

    // 3. Clear API auth headers + cookies
    clearApiKey();

    // 4. Reset Zustand stores (clears user-specific data)
    useAuthStore.getState().logout();
    useDashboardStore.getState().reset();
    useOpsJobsStore.getState().reset();
    useSelectorInsightsStore.getState().reset();

    // 5. Clear all browser storage
    localStorage.clear();
    sessionStorage.clear();
  } catch (error) {
    console.error('Logout cleanup error:', error);
  }

  // 6. Hard navigate to login (always, even if cleanup errors)
  window.location.href = '/login';
}
