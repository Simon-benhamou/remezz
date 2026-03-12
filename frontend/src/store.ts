import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { OpsJobStatus } from './types/ops';
import type { SelectorSnapshot } from './types/selector';

// Types
export type AppMode = 'live' | 'paper';
export type ThemeMode = 'dark' | 'light';

export interface User {
  id: string;
  email: string;
  name?: string;
}

export interface AuthState {
  user: User | null;
  apiKey: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
}

export interface AppState {
  mode: AppMode;
  themeMode: ThemeMode;
  isInitialized: boolean;
  globalLoading: boolean;
  lastUpdate: number | null;
}

export interface DashboardData {
  // Cache par mode pour éviter les conflits LIVE/PAPER
  overviewCache: Partial<Record<AppMode, { data: any; timestamp: number; }>>;
  currentOverview: any; // Overview actuel selon le mode sélectionné
  opsMetrics: any;
  opsEvents: any[];
  lastFetched: number | null;
  cacheValidityMs: number; // TTL pour le cache
}

// Auth Store
interface AuthStore extends AuthState {
  setUser: (user: User | null) => void;
  setApiKey: (apiKey: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  login: (apiKey: string, user: User) => void;
  logout: () => void;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      // Initial state
      user: null,
      apiKey: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      // Actions
      setUser: (user: User | null) => set({ user, isAuthenticated: !!user }),
      setApiKey: (apiKey: string | null) => set({ apiKey, isAuthenticated: !!apiKey }),
      setLoading: (isLoading: boolean) => set({ isLoading }),
      setError: (error: string | null) => set({ error, isLoading: false }),

      login: (apiKey: string, user: User) => set({
        apiKey,
        user,
        isAuthenticated: true,
        isLoading: false,
        error: null
      }),

      logout: () => set({
        user: null,
        apiKey: null,
        isAuthenticated: false,
        isLoading: false,
        error: null
      }),

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state: AuthStore) => ({
        apiKey: state.apiKey,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

// App Store
interface AppStore extends AppState {
  setMode: (mode: AppMode) => void;
  setThemeMode: (themeMode: ThemeMode) => void;
  toggleTheme: () => void;
  setInitialized: (initialized: boolean) => void;
  setGlobalLoading: (loading: boolean) => void;
  updateLastUpdate: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // Initial state
      mode: 'live',
      themeMode: 'dark',
      isInitialized: false,
      globalLoading: false,
      lastUpdate: null,

      // Actions
      setMode: (mode: AppMode) => set({ mode }),
      setThemeMode: (themeMode: ThemeMode) => set({ themeMode }),
      toggleTheme: () => set((state) => ({ themeMode: state.themeMode === 'dark' ? 'light' : 'dark' })),
      setInitialized: (initialized: boolean) => set({ isInitialized: initialized }),
      setGlobalLoading: (globalLoading: boolean) => set({ globalLoading }),
      updateLastUpdate: () => set({ lastUpdate: Date.now() }),
    }),
    {
      name: 'app-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state: AppStore) => ({
        mode: state.mode,
        themeMode: state.themeMode,
      }),
    }
  )
);

// Dashboard Store
interface DashboardStore extends DashboardData {
  setOverview: (overview: any, mode: AppMode) => void;
  setOpsMetrics: (metrics: any) => void;
  setOpsEvents: (events: any[]) => void;
  updateLastFetched: () => void;
  switchMode: (newMode: AppMode) => void;
  isCacheValid: (mode: AppMode) => boolean;
  getCachedOverview: (mode: AppMode) => any | null;
  invalidateCache: (mode?: AppMode) => void;
  reset: () => void;
}

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      // Initial state
      overviewCache: {},
      currentOverview: {},
      opsMetrics: null,
      opsEvents: [],
      lastFetched: null,
      cacheValidityMs: 10000, // 10 seconds TTL

      // Actions
      setOverview: (overview: any, mode: AppMode) => {
        const cache = get().overviewCache;
        const newCache = {
          ...cache,
          [mode]: { data: overview, timestamp: Date.now() }
        };
        set({ 
          overviewCache: newCache,
          currentOverview: overview,
          lastFetched: Date.now()
        });
      },

      switchMode: (newMode: AppMode) => {
        const cache = get().overviewCache;
        const cachedData = cache[newMode];
        if (cachedData && get().isCacheValid(newMode)) {
          set({ currentOverview: cachedData.data });
          if (import.meta.env.DEV) console.log(`🎯 Using cached overview for ${newMode} mode`);
        } else {
          // Si pas de cache valide, on reset l'overview actuel
          set({ currentOverview: {} });
          if (import.meta.env.DEV) console.log(`📦 No valid cache for ${newMode} mode, will refresh`);
        }
      },

      isCacheValid: (mode: AppMode) => {
        const cache = get().overviewCache;
        const cachedData = cache[mode];
        if (!cachedData) return false;
        return (Date.now() - cachedData.timestamp) < get().cacheValidityMs;
      },

      getCachedOverview: (mode: AppMode) => {
        if (get().isCacheValid(mode)) {
          return get().overviewCache[mode]?.data;
        }
        return null;
      },

      invalidateCache: (mode?: AppMode) => {
        if (mode) {
          const cache = get().overviewCache;
          const newCache = { ...cache };
          delete newCache[mode];
          set({ overviewCache: newCache });
          if (import.meta.env.DEV) console.log(`🗑️ Invalidated cache for ${mode} mode`);
        } else {
          set({ overviewCache: {} });
          if (import.meta.env.DEV) console.log('🗑️ Invalidated all cache');
        }
      },

      setOpsMetrics: (opsMetrics: any) => set({ opsMetrics }),
      setOpsEvents: (opsEvents: any[]) => set({ opsEvents }),
      updateLastFetched: () => set({ lastFetched: Date.now() }),
      reset: () => set({
        overviewCache: {},
        currentOverview: {},
        opsMetrics: null,
        opsEvents: [],
        lastFetched: null,
      }),
    }),
    {
      name: 'dashboard-storage',
      storage: createJSONStorage(() => sessionStorage), // Use sessionStorage for dashboard data
      partialize: (state: DashboardStore) => ({
        overviewCache: state.overviewCache,
        currentOverview: state.currentOverview,
        lastFetched: state.lastFetched,
      }),
    }
  )
);

// Ops jobs store
type OpsJobsStore = {
  jobs: OpsJobStatus[];
  lastUpdated: number | null;
  loading: boolean;
  error: string | null;
  setJobs: (jobs: OpsJobStatus[], opts?: { lastUpdated?: number | string | null }) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  upsertJob: (job: OpsJobStatus) => void;
  reset: () => void;
};

function toTimestamp(value?: number | string | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

export const useOpsJobsStore = create<OpsJobsStore>()((set, get) => ({
  jobs: [],
  lastUpdated: null,
  loading: false,
  error: null,
  setJobs: (jobs, opts) => {
    const ts = toTimestamp(opts?.lastUpdated) ?? Date.now();
    set({ jobs, lastUpdated: ts, loading: false, error: null });
  },
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  upsertJob: (job) => {
    if (!job?.id) return;
    set((state) => {
      const idx = state.jobs.findIndex((row) => row.id === job.id);
      if (idx === -1) {
        const updated = [...state.jobs, job];
        return {
          jobs: updated.length > 200 ? updated.slice(-200) : updated,
          lastUpdated: Date.now(),
          loading: false,
          error: null,
        };
      }
      const next = state.jobs.slice();
      next[idx] = { ...next[idx], ...job };
      return {
        jobs: next,
        lastUpdated: Date.now(),
         loading: false,
         error: null,
      };
    });
  },
  reset: () => set({ jobs: [], lastUpdated: null, loading: false, error: null }),
}));

type SelectorInsightsStore = {
  snapshot: SelectorSnapshot | null;
  lastUpdated: number | null;
  lastReason: string | null;
  loading: boolean;
  error: string | null;
  setSnapshot: (snapshot: SelectorSnapshot | null, meta?: { reason?: string; updatedAt?: number }) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
};

export const useSelectorInsightsStore = create<SelectorInsightsStore>()((set) => ({
  snapshot: null,
  lastUpdated: null,
  lastReason: null,
  loading: false,
  error: null,
  setSnapshot: (snapshot, meta) => {
    const updatedAt = meta?.updatedAt ?? Date.now();
    set({
      snapshot,
      lastUpdated: updatedAt,
      lastReason: meta?.reason ?? null,
      loading: false,
      error: null,
    });
  },
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),
  reset: () => set({ snapshot: null, lastUpdated: null, lastReason: null, loading: false, error: null }),
}));

// Selectors for better performance
export const useAuth = () => useAuthStore((state: AuthStore) => ({
  user: state.user,
  apiKey: state.apiKey,
  isAuthenticated: state.isAuthenticated,
  isLoading: state.isLoading,
  error: state.error,
}));

export const useApp = () => useAppStore((state: AppStore) => ({
  mode: state.mode,
  isInitialized: state.isInitialized,
  globalLoading: state.globalLoading,
  lastUpdate: state.lastUpdate,
}));

export const useDashboard = () => useDashboardStore((state: DashboardStore) => ({
  overview: state.currentOverview,
  opsMetrics: state.opsMetrics,
  opsEvents: state.opsEvents,
  lastFetched: state.lastFetched,
  overviewCache: state.overviewCache,
  isCacheValid: state.isCacheValid,
  getCachedOverview: state.getCachedOverview,
}));
