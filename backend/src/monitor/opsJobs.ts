import { prisma } from '../db/client.js';
import { getAutoUniverseStatusSnapshot } from '../services/intelligentAgent/autoUniverseScheduler.js';
import { getPredictorCacheStats } from '../quantai/predictorCache.js';
import { broadcast } from '../ws/hub.js';

export type OpsJobStatus = {
  id: string;
  label: string;
  status: 'idle' | 'running' | 'success' | 'warning' | 'error' | 'paused' | 'disabled' | 'scheduled';
  lastRunAt?: number | null;
  lastSuccessAt?: number | null;
  durationMs?: number | null;
  avgDurationMs?: number | null;
  nextRunEta?: number | null;
  lastError?: string | null;
  healthy?: boolean;
  runsToday?: number | null;
  failureStreak?: number | null;
  tags?: string[];
  meta?: Record<string, unknown> | null;
};

export type OpsJobsSnapshot = {
  jobs: OpsJobStatus[];
  lastUpdated: number;
  source: string;
};

type SchedulerJobRow = Awaited<ReturnType<typeof prisma.schedulerJob.findMany>>[number];

type CacheOptions = {
  force?: boolean;
};

const SCHEDULER_JOB_META: Record<string, { label: string; tags: string[] }> = {
  strategy_optimizer: { label: 'Strategy Optimizer', tags: ['scheduler', 'optimizer'] },
  symbol_reoptimization: { label: 'Symbol Re-Optimization', tags: ['scheduler', 'optimizer'] },
  UNIVERSE_RETRY: { label: 'Smart Selection Retry', tags: ['scheduler', 'smart-selection'] },
};

const STATUS_ORDER: Record<OpsJobStatus['status'], number> = {
  error: 5,
  warning: 4,
  running: 3,
  scheduled: 2,
  idle: 1,
  paused: 1,
  disabled: 0,
  success: 0,
};

const SNAPSHOT_TTL_MS = 15_000;
let cachedSnapshot: OpsJobsSnapshot | null = null;
let cachedAt = 0;
let heartbeatTimer: NodeJS.Timeout | null = null;

function mapSchedulerStatus(job: SchedulerJobRow): OpsJobStatus['status'] {
  switch (job.status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'error';
    case 'done':
      return 'success';
    case 'pending':
      return job.runAt.getTime() > Date.now() ? 'scheduled' : 'idle';
    default:
      return 'idle';
  }
}

function jobDurationMs(job: SchedulerJobRow): number | null {
  if (!job.lockedAt || !job.updatedAt) return null;
  const value = job.updatedAt.getTime() - job.lockedAt.getTime();
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function summarizeSchedulerType(
  type: string,
  runs: SchedulerJobRow[],
  sinceTs: number,
): OpsJobStatus {
  const latest = runs[0];
  const meta = SCHEDULER_JOB_META[type] ?? { label: type, tags: ['scheduler'] };
  const runsToday = runs.filter((row) => row.updatedAt && row.updatedAt.getTime() >= sinceTs && row.status === 'done').length;
  let failureStreak = 0;
  for (const row of runs) {
    if (row.status === 'failed') {
      failureStreak += 1;
    } else {
      break;
    }
  }
  const lastSuccess = runs.find((row) => row.status === 'done');
  const durations = runs
    .map((row) => jobDurationMs(row))
    .filter((value): value is number => typeof value === 'number');
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
    : null;

  return {
    id: `scheduler:${type}`,
    label: meta.label,
    status: mapSchedulerStatus(latest),
    lastRunAt: latest.updatedAt ? latest.updatedAt.getTime() : latest.runAt.getTime(),
    lastSuccessAt: lastSuccess?.updatedAt ? lastSuccess.updatedAt.getTime() : null,
    durationMs: jobDurationMs(latest),
     avgDurationMs,
    nextRunEta: latest.status === 'pending' ? latest.runAt.getTime() : null,
    lastError: latest.lastError,
    healthy: latest.status !== 'failed',
    runsToday,
    failureStreak: failureStreak || null,
    tags: meta.tags,
    meta: {
      status: latest.status,
      attempts: latest.attempts,
    },
  };
}

function buildPredictorCacheJob(): OpsJobStatus {
  const stats = getPredictorCacheStats();
  return {
    id: 'predictor_cache_refresh',
    label: 'Predictor Cache Refresh',
    status: stats.backgroundRefreshActive ? 'running' : 'paused',
    lastRunAt: stats.lastRefreshAt ?? stats.lastWarmupAt ?? null,
    lastSuccessAt: stats.isWarmupComplete ? stats.lastRefreshAt ?? stats.lastWarmupAt ?? null : null,
    nextRunEta: stats.backgroundRefreshActive ? Date.now() + (stats.refreshIntervalMs ?? 20_000) : null,
    lastError: stats.lastRefreshError ?? null,
    healthy: stats.backgroundRefreshActive && !stats.lastRefreshError,
    tags: ['predictor', 'python'],
    meta: {
      totalEntries: stats.totalEntries,
      validEntries: stats.validEntries,
      isWarmupComplete: stats.isWarmupComplete,
      refreshIntervalMs: stats.refreshIntervalMs,
    },
  };
}

function buildAutoUniverseJob(): OpsJobStatus {
  const state = getAutoUniverseStatusSnapshot();
  const status: OpsJobStatus['status'] = state.nextRetryAt ? 'scheduled' : 'idle';
  return {
    id: 'auto_universe_scheduler',
    label: 'Auto Universe Scheduler',
    status,
    lastRunAt: state.ts || null,
    nextRunEta: state.nextRetryAt ?? null,
    lastError: typeof state.reason === 'string' && state.reason?.includes('error') ? state.reason : null,
    healthy: !state.reason || !state.reason.toLowerCase().includes('error'),
    tags: ['smart-selection'],
    meta: {
      attempt: state.attempt,
      candidateCount: state.candidateCount,
      retryScheduledMs: state.retryScheduledMs,
      pendingExcludeSessionId: state.pendingExcludeSessionId,
    },
  };
}

function sortJobs(jobs: OpsJobStatus[]) {
  return jobs.sort((a, b) => {
    const diff = (STATUS_ORDER[b.status] ?? 0) - (STATUS_ORDER[a.status] ?? 0);
    if (diff !== 0) return diff;
    const at = a.lastRunAt ?? 0;
    const bt = b.lastRunAt ?? 0;
    return bt - at;
  });
}

export async function computeOpsJobsSnapshot(): Promise<OpsJobsSnapshot> {
  const now = Date.now();
  const sinceMidnight = new Date();
  sinceMidnight.setHours(0, 0, 0, 0);
  const recentRows = await prisma.schedulerJob.findMany({
    orderBy: { runAt: 'desc' },
    take: 200,
  });
  const grouped = recentRows.reduce<Record<string, SchedulerJobRow[]>>((acc, row) => {
    if (!acc[row.type]) acc[row.type] = [];
    acc[row.type].push(row);
    return acc;
  }, {});

  const schedulerJobs = Object.entries(grouped).map(([type, rows]) =>
    summarizeSchedulerType(type, rows, sinceMidnight.getTime()),
  );

  const jobs: OpsJobStatus[] = [
    ...schedulerJobs,
    buildPredictorCacheJob(),
    buildAutoUniverseJob(),
  ];

  return {
    jobs: sortJobs(jobs),
    lastUpdated: now,
    source: 'ops_jobs_service',
  };
}

export async function getOpsJobsSnapshot(options: CacheOptions = {}): Promise<OpsJobsSnapshot> {
  if (!options.force && cachedSnapshot && Date.now() - cachedAt < SNAPSHOT_TTL_MS) {
    return cachedSnapshot;
  }
  cachedSnapshot = await computeOpsJobsSnapshot();
  cachedAt = Date.now();
  return cachedSnapshot;
}

export async function broadcastOpsJobsSnapshot(reason?: string): Promise<OpsJobsSnapshot> {
  const snapshot = await getOpsJobsSnapshot({ force: true });
  broadcast('jobs.snapshot', { ...snapshot, reason });
  return snapshot;
}

export function startOpsJobsHeartbeat(intervalMs = 30_000) {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    broadcastOpsJobsSnapshot('heartbeat').catch((error) => {
      console.warn('[OpsJobs] Heartbeat broadcast failed:', error);
    });
  }, intervalMs);
  broadcastOpsJobsSnapshot('startup').catch((error) => {
    console.warn('[OpsJobs] Initial broadcast failed:', error);
  });
}

export function resetOpsJobsCacheForTests() {
  cachedSnapshot = null;
  cachedAt = 0;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
