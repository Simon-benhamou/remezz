import { useEffect, useCallback } from 'react';
import { useDashboardStore, useAppStore } from '../store';
import { api } from '../api';

export function useDashboard() {
  const {
    overview,
    opsMetrics,
    opsEvents,
    lastFetched,
    overviewCache,
    isCacheValid,
    getCachedOverview,
  } = useDashboardStore((state) => ({
    overview: state.currentOverview,
    opsMetrics: state.opsMetrics,
    opsEvents: state.opsEvents,
    lastFetched: state.lastFetched,
    overviewCache: state.overviewCache,
    isCacheValid: state.isCacheValid,
    getCachedOverview: state.getCachedOverview,
  }));

  const {
    setOverview,
    setOpsMetrics,
    setOpsEvents,
    updateLastFetched,
    switchMode,
    invalidateCache,
  } = useDashboardStore();

  const { mode } = useAppStore();

  const loadOverview = useCallback(async (forceRefresh = false) => {
    try {
      // Vérifier le cache d'abord si pas de force refresh
      if (!forceRefresh) {
        const cached = getCachedOverview(mode);
        if (cached) {
          if (import.meta.env.DEV) console.log(`🎯 Using cached overview for ${mode} mode`);
          return cached;
        }
      }

      if (import.meta.env.DEV) console.log(`🔄 Fetching fresh overview for ${mode} mode`);
      const data = await api.overview(mode);
      setOverview(data, mode);
      updateLastFetched();
      return data;
    } catch (error) {
      console.error('Failed to load overview:', error);
      throw error;
    }
  }, [mode, setOverview, updateLastFetched, getCachedOverview]);

  const loadOpsMetrics = useCallback(async () => {
    try {
      const data = await api.getOpsMetrics();
      setOpsMetrics(data);
    } catch (error) {
      console.error('Failed to load ops metrics:', error);
    }
  }, [setOpsMetrics]);

  const loadOpsEvents = useCallback(async () => {
    try {
      const data = await api.getOpsEvents(20);
      setOpsEvents(data);
    } catch (error) {
      console.error('Failed to load ops events:', error);
    }
  }, [setOpsEvents]);

  const loadAllData = useCallback(async () => {
    await Promise.all([
      loadOverview(),
      loadOpsMetrics(),
      loadOpsEvents(),
    ]);
  }, [loadOverview, loadOpsMetrics, loadOpsEvents]);

  // Gestion intelligente du changement de mode
  useEffect(() => {
    if (import.meta.env.DEV) console.log(`📋 Mode changed to: ${mode}`);
    
    // Switch vers les données cachées du nouveau mode
    switchMode(mode);
    
    // Si pas de cache valide pour ce mode, charger immédiatement
    if (!isCacheValid(mode)) {
      if (import.meta.env.DEV) console.log(`⚡ No valid cache for ${mode}, loading immediately`);
      loadOverview(true); // Force refresh pour le nouveau mode
    }
  }, [mode]); // Suppression des dépendances functions pour éviter boucles

  // Auto-refresh overview every 30 seconds (pour le mode actuel seulement)
  useEffect(() => {
    const interval = setInterval(() => {
      // Skip polling when tab is not visible
      if (document.hidden) return;
      // Refresh seulement si nécessaire (cache expiré)
      if (!isCacheValid(mode)) {
        if (import.meta.env.DEV) console.log(`⏰ Auto-refresh triggered for ${mode} mode`);
        loadOverview(true);
      }
    }, 30000);

    return () => clearInterval(interval);
  }, [mode]); // Suppression des dépendances functions pour éviter boucles

  // Load metrics/events on mount and whenever mode changes
  useEffect(() => {
    loadOpsMetrics();
    loadOpsEvents();
  }, [mode, loadOpsMetrics, loadOpsEvents]);

  // Auto-refresh ops metrics/events every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      // Skip polling when tab is not visible
      if (document.hidden) return;
      void loadOpsMetrics();
      void loadOpsEvents();
    }, 30000);
    return () => clearInterval(interval);
  }, [loadOpsMetrics, loadOpsEvents]);

  // Initial load pour le mode courant
  useEffect(() => {
    if (!isCacheValid(mode)) {
      loadOverview();
    }
  }, []);

  return {
    overview,
    opsMetrics,
    opsEvents,
    lastFetched,
    overviewCache,
    isCacheValid: (mode: string) => isCacheValid(mode as any),
    loadOverview,
    loadOpsMetrics,
    loadOpsEvents,
    loadAllData,
    invalidateCache,
  };
}
