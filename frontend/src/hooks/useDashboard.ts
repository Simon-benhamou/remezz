import { useEffect, useCallback } from 'react';
import { useDashboardStore, useAppStore } from '../store';
import { api } from '../api';

export function useDashboard() {
  const {
    overview,
    opsMetrics,
    opsEvents,
    opsLlmLogs,
    lastFetched,
    overviewCache,
    isCacheValid,
    getCachedOverview,
  } = useDashboardStore((state) => ({
    overview: state.currentOverview,
    opsMetrics: state.opsMetrics,
    opsEvents: state.opsEvents,
    opsLlmLogs: state.opsLlmLogs,
    lastFetched: state.lastFetched,
    overviewCache: state.overviewCache,
    isCacheValid: state.isCacheValid,
    getCachedOverview: state.getCachedOverview,
  }));

  const {
    setOverview,
    setOpsMetrics,
    setOpsEvents,
    setOpsLlmLogs,
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
          console.log(`🎯 Using cached overview for ${mode} mode`);
          return cached;
        }
      }

      console.log(`🔄 Fetching fresh overview for ${mode} mode`);
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
      const data = await api.getOpsEvents();
      setOpsEvents(data);
    } catch (error) {
      console.error('Failed to load ops events:', error);
    }
  }, [setOpsEvents]);

  const loadOpsLlmLogs = useCallback(async () => {
    try {
      const data = await api.getOpsLlmLogs();
      setOpsLlmLogs(data);
    } catch (error) {
      console.error('Failed to load ops LLM logs:', error);
    }
  }, [setOpsLlmLogs]);

  const loadAllData = useCallback(async () => {
    await Promise.all([
      loadOverview(),
      loadOpsMetrics(),
      loadOpsEvents(),
      loadOpsLlmLogs(),
    ]);
  }, [loadOverview, loadOpsMetrics, loadOpsEvents, loadOpsLlmLogs]);

  // Gestion intelligente du changement de mode
  useEffect(() => {
    console.log(`📋 Mode changed to: ${mode}`);
    
    // Switch vers les données cachées du nouveau mode
    switchMode(mode);
    
    // Si pas de cache valide pour ce mode, charger immédiatement
    if (!isCacheValid(mode)) {
      console.log(`⚡ No valid cache for ${mode}, loading immediately`);
      loadOverview(true); // Force refresh pour le nouveau mode
    }
  }, [mode]); // Suppression des dépendances functions pour éviter boucles

  // Auto-refresh overview every 15 seconds (pour le mode actuel seulement)
  useEffect(() => {
    const interval = setInterval(() => {
      // Refresh seulement si nécessaire (cache expiré)
      if (!isCacheValid(mode)) {
        console.log(`⏰ Auto-refresh triggered for ${mode} mode`);
        loadOverview(true);
      }
    }, 15000);

    return () => clearInterval(interval);
  }, [mode]); // Suppression des dépendances functions pour éviter boucles

  // Load other data on mount (une seule fois)
  useEffect(() => {
    loadOpsMetrics();
    loadOpsEvents();  
    loadOpsLlmLogs();
  }, [loadOpsMetrics, loadOpsEvents, loadOpsLlmLogs]);

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
    opsLlmLogs,
    lastFetched,
    overviewCache,
    isCacheValid: (mode: string) => isCacheValid(mode as any),
    loadOverview,
    loadOpsMetrics,
    loadOpsEvents,
    loadOpsLlmLogs,
    loadAllData,
    invalidateCache,
  };
}