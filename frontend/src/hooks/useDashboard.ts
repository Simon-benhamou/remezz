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
    setOverview,
    setOpsMetrics,
    setOpsEvents,
    setOpsLlmLogs,
    updateLastFetched,
  } = useDashboardStore();

  const { mode } = useAppStore();

  const loadOverview = useCallback(async () => {
    try {
      const data = await api.overview(mode);
      setOverview(data);
      updateLastFetched();
    } catch (error) {
      console.error('Failed to load overview:', error);
    }
  }, [mode, setOverview, updateLastFetched]);

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

  // Auto-refresh overview every 15 seconds
  useEffect(() => {
    loadOverview(); // Initial load

    const interval = setInterval(() => {
      loadOverview();
    }, 15000);

    return () => clearInterval(interval);
  }, [loadOverview]);

  // Load other data on mount
  useEffect(() => {
    loadOpsMetrics();
    loadOpsEvents();
    loadOpsLlmLogs();
  }, [loadOpsMetrics, loadOpsEvents, loadOpsLlmLogs]);

  // Reload when mode changes
  useEffect(() => {
    loadAllData();
  }, [mode, loadAllData]);

  return {
    overview,
    opsMetrics,
    opsEvents,
    opsLlmLogs,
    lastFetched,
    loadOverview,
    loadOpsMetrics,
    loadOpsEvents,
    loadOpsLlmLogs,
    loadAllData,
  };
}