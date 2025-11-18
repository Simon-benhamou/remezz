export type OpsJobStatus = {
  id: string;
  label: string;
  status: 'idle' | 'running' | 'success' | 'warning' | 'error' | 'paused' | 'disabled' | 'scheduled';
  lastRunAt?: number | string | null;
  lastSuccessAt?: number | string | null;
  durationMs?: number | null;
  avgDurationMs?: number | null;
  nextRunEta?: number | string | null;
  lastError?: string | null;
  healthy?: boolean;
  runsToday?: number | null;
  failureStreak?: number | null;
  tags?: string[];
  meta?: Record<string, unknown> | null;
};

export type OpsJobsResponse = {
  jobs: OpsJobStatus[];
  lastUpdated?: number | string | null;
  source?: string;
};
