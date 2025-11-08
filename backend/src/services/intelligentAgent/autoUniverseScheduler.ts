import { prisma, Prisma } from '../../db/client.js';
import { scheduleJob, registerSchedulerJobHandler, processSchedulerJobsOnce } from '../../services/schedulerJobService.js';

type AutoUniverseStatus = {
  source: 'dynamic' | 'fallback_dynamic' | 'fallback_static';
  attempt: number;
  candidateCount: number;
  ts: number;
  reason?: string;
  retryScheduledMs?: number;
  nextRetryAt?: number | null;
  persistedNextRetryAt?: number | null;
  pendingExcludeSessionId?: string;
  persistedExcludeSessionId?: string | null;
};

type UniverseFetcher = (excludeSessionId?: string, attempt?: number) => Promise<unknown>;

const AUTO_UNIVERSE_MAX_ATTEMPTS = 3;
const AUTO_UNIVERSE_RETRY_DEFAULT_MS = 60_000;
const AUTO_UNIVERSE_SCHEDULE_ID = 'auto_universe_retry';
const UNIT_TEST_MODE = (process.env.UNIT_TEST_MODE || 'false') === 'true';

let lastAutoUniverseStatus: AutoUniverseStatus = {
  source: 'dynamic',
  attempt: 0,
  candidateCount: 0,
  ts: 0,
  reason: 'uninitialized',
};
let pendingUniverseRetryDeadline = 0;
let pendingUniverseRetryExcludeSessionId: string | undefined;
let pendingUniverseRetryJobId: string | null = null;
let persistedUniverseRetryAt: number | null = null;
let persistedUniverseRetryExcludeSessionId: string | null = null;
let universeFetcher: UniverseFetcher | null = null;

function updateAutoUniverseStatus(status: AutoUniverseStatus) {
  lastAutoUniverseStatus = { ...status, ts: Date.now() };
}

function rememberPersistedUniverseRetryState(
  nextRetryAt: number | null,
  excludeSessionId?: string | null,
  jobId?: string | null,
) {
  persistedUniverseRetryAt = nextRetryAt;
  persistedUniverseRetryExcludeSessionId = excludeSessionId ?? null;
  if (jobId !== undefined) {
    pendingUniverseRetryJobId = jobId;
  }
}

function persistAutoUniverseRetryState(
  nextRetryAt: number | null,
  excludeSessionId?: string | null,
  jobId?: string | null,
) {
  rememberPersistedUniverseRetryState(nextRetryAt, excludeSessionId, jobId ?? null);
  const nextRetryDate = nextRetryAt && Number.isFinite(nextRetryAt) && nextRetryAt > 0 ? new Date(nextRetryAt) : null;
  return prisma.autoUniverseSchedule
    .upsert({
      where: { id: AUTO_UNIVERSE_SCHEDULE_ID },
      create: {
        id: AUTO_UNIVERSE_SCHEDULE_ID,
        nextRetryAt: nextRetryDate,
        excludeSessionId: excludeSessionId ?? null,
        metadata: jobId ? { schedulerJobId: jobId } : Prisma.JsonNull,
      },
      update: {
        nextRetryAt: nextRetryDate,
        excludeSessionId: excludeSessionId ?? null,
        metadata: jobId === undefined ? undefined : jobId ? { schedulerJobId: jobId } : Prisma.JsonNull,
      },
    })
    .catch((error) => {
      console.warn('⚠️ Failed to persist auto universe retry schedule:', error);
    });
}

async function loadPersistedAutoUniverseSchedule() {
  try {
    const schedule = await prisma.autoUniverseSchedule.findUnique({
      where: { id: AUTO_UNIVERSE_SCHEDULE_ID },
    });
    if (schedule) {
      const metadata = (schedule as any).metadata as Record<string, unknown> | null;
      const schedulerJobId = metadata && typeof metadata.schedulerJobId === 'string' ? metadata.schedulerJobId : null;
      rememberPersistedUniverseRetryState(
        schedule.nextRetryAt ? schedule.nextRetryAt.getTime() : null,
        schedule.excludeSessionId ?? null,
        schedulerJobId,
      );
      return schedule;
    }
    rememberPersistedUniverseRetryState(null, null, null);
    return null;
  } catch (error) {
    console.warn('⚠️ Failed to load auto universe retry schedule:', error);
    rememberPersistedUniverseRetryState(null, null, null);
    return null;
  }
}

async function scheduleAutoUniverseRetry(
  excludeSessionId: string | undefined,
  delayMs: number = AUTO_UNIVERSE_RETRY_DEFAULT_MS,
) {
  const now = Date.now();
  const boundedDelay =
    delayMs <= 0
      ? 0
      : UNIT_TEST_MODE
      ? Math.max(delayMs, 10)
      : Math.min(Math.max(delayMs, 30_000), 120_000);

  if (pendingUniverseRetryDeadline > now && boundedDelay >= pendingUniverseRetryDeadline - now) {
    return;
  }

  const runAt = new Date(now + boundedDelay);
  const job = await scheduleJob('UNIVERSE_RETRY', runAt, { excludeSessionId });
  pendingUniverseRetryDeadline = job.runAt.getTime();
  pendingUniverseRetryExcludeSessionId = excludeSessionId;
  pendingUniverseRetryJobId = job.id;
  await persistAutoUniverseRetryState(pendingUniverseRetryDeadline, excludeSessionId, job.id);
  if (UNIT_TEST_MODE) {
    setTimeout(() => {
      processSchedulerJobsOnce().catch((error) =>
        console.warn('⚠️ Failed to process scheduler jobs during unit test mode:', error),
      );
    }, Math.max(0, boundedDelay + 5));
  }
  updateAutoUniverseStatus({
    ...lastAutoUniverseStatus,
    retryScheduledMs: boundedDelay,
    nextRetryAt: pendingUniverseRetryDeadline,
    persistedNextRetryAt: persistedUniverseRetryAt,
    pendingExcludeSessionId: excludeSessionId,
    persistedExcludeSessionId: persistedUniverseRetryExcludeSessionId,
  });
}

async function restoreAutoUniverseRetrySchedule() {
  const existingJob = await prisma.schedulerJob.findFirst({
    where: { type: 'UNIVERSE_RETRY', status: 'pending' },
    orderBy: { runAt: 'asc' },
  });
  if (existingJob) {
    const payload = (existingJob.payload as any) ?? {};
    const exclude = typeof payload?.excludeSessionId === 'string' ? payload.excludeSessionId : undefined;
    pendingUniverseRetryJobId = existingJob.id;
    pendingUniverseRetryDeadline = existingJob.runAt.getTime();
    pendingUniverseRetryExcludeSessionId = exclude;
    rememberPersistedUniverseRetryState(pendingUniverseRetryDeadline, exclude ?? null, existingJob.id);
    updateAutoUniverseStatus({
      ...lastAutoUniverseStatus,
      nextRetryAt: pendingUniverseRetryDeadline,
      persistedNextRetryAt: persistedUniverseRetryAt,
      pendingExcludeSessionId: exclude,
      persistedExcludeSessionId: persistedUniverseRetryExcludeSessionId,
    });
    return;
  }

  const schedule = await loadPersistedAutoUniverseSchedule();
  if (!schedule?.nextRetryAt) {
    return;
  }
  const delay = schedule.nextRetryAt.getTime() - Date.now();
  await scheduleAutoUniverseRetry(schedule.excludeSessionId ?? undefined, delay);
}

function getAutoUniverseStatusSnapshot(): AutoUniverseStatus {
  return {
    ...lastAutoUniverseStatus,
    nextRetryAt: pendingUniverseRetryDeadline || null,
    persistedNextRetryAt: persistedUniverseRetryAt,
    pendingExcludeSessionId: pendingUniverseRetryExcludeSessionId,
    persistedExcludeSessionId: persistedUniverseRetryExcludeSessionId,
  };
}

function registerUniverseFetcher(fetcher: UniverseFetcher) {
  universeFetcher = fetcher;
}

registerSchedulerJobHandler('UNIVERSE_RETRY', async (job) => {
  const payload = (job.payload as any) ?? {};
  const exclude = typeof payload?.excludeSessionId === 'string' ? payload.excludeSessionId : undefined;
  pendingUniverseRetryJobId = job.id;
  pendingUniverseRetryDeadline = job.runAt.getTime();
  pendingUniverseRetryExcludeSessionId = exclude;
  updateAutoUniverseStatus({
    ...lastAutoUniverseStatus,
    retryScheduledMs: undefined,
    nextRetryAt: pendingUniverseRetryDeadline,
    pendingExcludeSessionId: exclude,
  });
  try {
    if (!universeFetcher) {
      throw new Error('Auto universe fetcher not registered');
    }
    await universeFetcher(exclude, AUTO_UNIVERSE_MAX_ATTEMPTS);
  } catch (error) {
    console.warn('⚠️ Auto universe retry job failed:', error);
    throw error;
  } finally {
    await persistAutoUniverseRetryState(null, null, null).catch((persistError) => {
      console.warn('⚠️ Failed to clear persisted auto universe schedule after job:', persistError);
    });
    pendingUniverseRetryDeadline = 0;
    pendingUniverseRetryExcludeSessionId = undefined;
    pendingUniverseRetryJobId = null;
    rememberPersistedUniverseRetryState(null, null, null);
  }
});

const __autoUniverseSchedulerTesting = {
  schedule: (excludeSessionId?: string, delayMs: number = AUTO_UNIVERSE_RETRY_DEFAULT_MS) =>
    scheduleAutoUniverseRetry(excludeSessionId, delayMs),
  async clear(options: { clearPersisted?: boolean } = {}) {
    pendingUniverseRetryDeadline = 0;
    pendingUniverseRetryExcludeSessionId = undefined;
    pendingUniverseRetryJobId = null;
    await prisma.schedulerJob.deleteMany({ where: { type: 'UNIVERSE_RETRY' } });
    if (options.clearPersisted !== false) {
      await persistAutoUniverseRetryState(null, null, null);
    }
  },
  async simulateRestart() {
    pendingUniverseRetryDeadline = 0;
    pendingUniverseRetryExcludeSessionId = undefined;
    pendingUniverseRetryJobId = null;
    await loadPersistedAutoUniverseSchedule();
  },
  async reloadPersisted() {
    await loadPersistedAutoUniverseSchedule();
  },
  getState() {
    return {
      pendingUniverseRetryDeadline,
      pendingUniverseRetryExcludeSessionId,
      pendingUniverseRetryJobId,
      persistedUniverseRetryAt,
      persistedUniverseRetryExcludeSessionId,
    };
  },
};

export {
  AutoUniverseStatus,
  AUTO_UNIVERSE_MAX_ATTEMPTS,
  AUTO_UNIVERSE_RETRY_DEFAULT_MS,
  updateAutoUniverseStatus,
  getAutoUniverseStatusSnapshot,
  scheduleAutoUniverseRetry,
  restoreAutoUniverseRetrySchedule,
  registerUniverseFetcher,
  __autoUniverseSchedulerTesting,
};
