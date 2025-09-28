import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

// Types
export type AppMode = 'live' | 'paper';

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
  isInitialized: boolean;
  globalLoading: boolean;
  lastUpdate: number | null;
}

export interface DashboardData {
  overview: any;
  opsMetrics: any;
  opsEvents: any[];
  opsLlmLogs: any[];
  lastFetched: number | null;
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
      setUser: (user) => set({ user, isAuthenticated: !!user }),
      setApiKey: (apiKey) => set({ apiKey, isAuthenticated: !!apiKey }),
      setLoading: (isLoading) => set({ isLoading }),
      setError: (error) => set({ error, isLoading: false }),

      login: (apiKey, user) => set({
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
      partialize: (state) => ({
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
  setInitialized: (initialized: boolean) => void;
  setGlobalLoading: (loading: boolean) => void;
  updateLastUpdate: () => void;
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      // Initial state
      mode: 'live',
      isInitialized: false,
      globalLoading: false,
      lastUpdate: null,

      // Actions
      setMode: (mode) => set({ mode }),
      setInitialized: (initialized) => set({ isInitialized: initialized }),
      setGlobalLoading: (globalLoading) => set({ globalLoading }),
      updateLastUpdate: () => set({ lastUpdate: Date.now() }),
    }),
    {
      name: 'app-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        mode: state.mode,
      }),
    }
  )
);

// Dashboard Store
interface DashboardStore extends DashboardData {
  setOverview: (overview: any) => void;
  setOpsMetrics: (metrics: any) => void;
  setOpsEvents: (events: any[]) => void;
  setOpsLlmLogs: (logs: any[]) => void;
  updateLastFetched: () => void;
  reset: () => void;
}

export const useDashboardStore = create<DashboardStore>()(
  persist(
    (set, get) => ({
      // Initial state
      overview: {},
      opsMetrics: null,
      opsEvents: [],
      opsLlmLogs: [],
      lastFetched: null,

      // Actions
      setOverview: (overview) => set({ overview }),
      setOpsMetrics: (opsMetrics) => set({ opsMetrics }),
      setOpsEvents: (opsEvents) => set({ opsEvents }),
      setOpsLlmLogs: (opsLlmLogs) => set({ opsLlmLogs }),
      updateLastFetched: () => set({ lastFetched: Date.now() }),
      reset: () => set({
        overview: {},
        opsMetrics: null,
        opsEvents: [],
        opsLlmLogs: [],
        lastFetched: null,
      }),
    }),
    {
      name: 'dashboard-storage',
      storage: createJSONStorage(() => sessionStorage), // Use sessionStorage for dashboard data
      partialize: (state) => ({
        overview: state.overview,
        lastFetched: state.lastFetched,
      }),
    }
  )
);

// Selectors for better performance
export const useAuth = () => useAuthStore((state) => ({
  user: state.user,
  apiKey: state.apiKey,
  isAuthenticated: state.isAuthenticated,
  isLoading: state.isLoading,
  error: state.error,
}));

export const useApp = () => useAppStore((state) => ({
  mode: state.mode,
  isInitialized: state.isInitialized,
  globalLoading: state.globalLoading,
  lastUpdate: state.lastUpdate,
}));

export const useDashboard = () => useDashboardStore((state) => ({
  overview: state.overview,
  opsMetrics: state.opsMetrics,
  opsEvents: state.opsEvents,
  opsLlmLogs: state.opsLlmLogs,
  lastFetched: state.lastFetched,
}));
