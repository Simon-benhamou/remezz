import { useCallback, useEffect } from 'react';
import { api } from '../api';
import { useOpsJobsStore } from '../store';
import type { OpsJobStatus, OpsJobsResponse } from '../types/ops';
import { wsManager } from '../ws';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

let jobsWsSubscribers = 0;
let jobsWsUnsubs: (() => void)[] = [];

const JOB_UPDATE_TYPES = new Set([
  'job.updated',
  'jobs.updated',
  'jobs.upserted',
  'ops.job.updated',
]);

function normalizeJobsResponse(resp: OpsJobsResponse | OpsJobStatus[] | null | undefined) {
  if (!resp) return { jobs: [], lastUpdated: null };
  if (Array.isArray(resp)) return { jobs: resp, lastUpdated: Date.now() };
  const jobs = Array.isArray(resp.jobs) ? resp.jobs : [];
  return { jobs, lastUpdated: resp.lastUpdated ?? Date.now() };
}

function handleJobsMessage(msg: any) {
  if (!msg || typeof msg !== 'object') return;
  try {
    if (msg.type === 'jobs.snapshot' || msg.type === 'jobs.refresh') {
      const { jobs, lastUpdated } = normalizeJobsResponse(msg.data ?? msg);
      useOpsJobsStore.getState().setJobs(jobs, { lastUpdated });
      return;
    }
    if (JOB_UPDATE_TYPES.has(msg.type)) {
      const payload: OpsJobStatus | null = msg.job ?? msg.data ?? msg.payload ?? null;
      if (payload && payload.id) {
        useOpsJobsStore.getState().upsertJob(payload);
      }
    }
  } catch (error) {
    console.warn('[useOpsJobs] Failed to process job message', error);
  }
}

function ensureJobsWs() {
  if (jobsWsUnsubs.length > 0) return;

  // Ensure the shared connection is open
  wsManager.connect(API_BASE);

  // Subscribe to all job-related message types
  jobsWsUnsubs.push(wsManager.subscribe('jobs.snapshot', handleJobsMessage));
  jobsWsUnsubs.push(wsManager.subscribe('jobs.refresh', handleJobsMessage));
  jobsWsUnsubs.push(wsManager.subscribe('job.updated', handleJobsMessage));
  jobsWsUnsubs.push(wsManager.subscribe('jobs.updated', handleJobsMessage));
  jobsWsUnsubs.push(wsManager.subscribe('jobs.upserted', handleJobsMessage));
  jobsWsUnsubs.push(wsManager.subscribe('ops.job.updated', handleJobsMessage));
}

function releaseJobsWs() {
  if (jobsWsSubscribers > 0) return;
  for (const unsub of jobsWsUnsubs) {
    try { unsub(); } catch {}
  }
  jobsWsUnsubs = [];
}

/**
 * Force-close the shared jobs WebSocket (used during logout cleanup).
 * Now just unsubscribes from the shared WsManager — actual disconnect
 * is handled by wsManager.disconnect() in the logout flow.
 */
export function closeJobsWs(): void {
  for (const unsub of jobsWsUnsubs) {
    try { unsub(); } catch {}
  }
  jobsWsUnsubs = [];
  jobsWsSubscribers = 0;
}

export function useOpsJobs(options?: { autoRefreshMs?: number; enableLive?: boolean }) {
  const { jobs, loading, error, lastUpdated } = useOpsJobsStore((state) => ({
    jobs: state.jobs,
    loading: state.loading,
    error: state.error,
    lastUpdated: state.lastUpdated,
  }));
  const setJobs = useOpsJobsStore((state) => state.setJobs);
  const setLoading = useOpsJobsStore((state) => state.setLoading);
  const setError = useOpsJobsStore((state) => state.setError);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await api.getOpsJobs().catch((err) => {
        throw err;
      });
      const { jobs: incoming, lastUpdated } = normalizeJobsResponse(resp as OpsJobsResponse);
      setJobs(incoming, { lastUpdated });
    } catch (err) {
      console.error('Failed to load ops jobs:', err);
      const message = err instanceof Error ? err.message : 'Unable to load jobs';
      setError(message);
    }
  }, [setLoading, setJobs, setError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!options?.autoRefreshMs) return;
    const id = setInterval(() => {
      void refresh();
    }, Math.max(5000, options.autoRefreshMs));
    return () => clearInterval(id);
  }, [options?.autoRefreshMs, refresh]);

  useEffect(() => {
    if (!options?.enableLive) return;
    jobsWsSubscribers += 1;
    ensureJobsWs();
    return () => {
      jobsWsSubscribers = Math.max(0, jobsWsSubscribers - 1);
      if (jobsWsSubscribers === 0) {
        releaseJobsWs();
      }
    };
  }, [options?.enableLive]);

  return {
    jobs,
    loading,
    error,
    lastUpdated,
    refresh,
  };
}
