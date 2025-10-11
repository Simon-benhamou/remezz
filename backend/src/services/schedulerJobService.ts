import { prisma } from '../db/client.js';

export type SchedulerJobRecord = {
  id: string;
  type: string;
  payload: unknown;
  runAt: Date;
  status: string;
  lockedBy: string | null;
  lockedAt: Date | null;
  attempts: number;
  lastError: string | null;
};

type JobHandler = (job: SchedulerJobRecord) => Promise<void>;

const handlers = new Map<string, JobHandler>();
const workerId = `scheduler-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let workerTimer: NodeJS.Timeout | null = null;
let workerIntervalMs = 1000;
let workerStarted = false;

export function registerSchedulerJobHandler(type: string, handler: JobHandler) {
  handlers.set(type, handler);
}

export async function scheduleJob(
  type: string,
  runAt: Date,
  payload?: unknown,
): Promise<SchedulerJobRecord> {
  const existing = await prisma.schedulerJob.findFirst({
    where: { type, runAt },
  });

  if (existing) {
    const updated = await prisma.schedulerJob.update({
      where: { id: existing.id },
      data: {
        payload: payload as any,
        status: 'pending',
        lockedBy: null,
        lockedAt: null,
        lastError: null,
      },
    });
    return updated as SchedulerJobRecord;
  }

  const created = await prisma.schedulerJob.create({
    data: {
      type,
      runAt,
      payload: payload as any,
      status: 'pending',
    },
  });
  return created as SchedulerJobRecord;
}

export async function replaySchedulerJob(jobId: string, options: { runAt?: Date } = {}) {
  const runAt = options.runAt ?? new Date();
  return prisma.schedulerJob.update({
    where: { id: jobId },
    data: {
      status: 'pending',
      runAt,
      lockedBy: null,
      lockedAt: null,
      lastError: null,
    },
  });
}

export async function listSchedulerJobs({
  limit = 50,
  status,
  type,
}: { limit?: number; status?: string; type?: string } = {}) {
  return prisma.schedulerJob.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    orderBy: { runAt: 'desc' },
    take: limit,
  });
}

async function processDueJobsOnce() {
  const now = new Date();
  const candidates = await prisma.schedulerJob.findMany({
    where: {
      status: 'pending',
      runAt: { lte: now },
    },
    orderBy: { runAt: 'asc' },
    take: 10,
  });

  for (const job of candidates) {
    const claim = await prisma.schedulerJob.updateMany({
      where: {
        id: job.id,
        status: 'pending',
        lockedBy: null,
      },
      data: {
        status: 'running',
        lockedBy: workerId,
        lockedAt: new Date(),
        attempts: { increment: 1 },
        updatedAt: new Date(),
      },
    });
    if (!claim.count) {
      continue;
    }

    const handler = handlers.get(job.type);
    if (!handler) {
      console.error(`[Scheduler] No handler registered for job type ${job.type}`);
      await prisma.schedulerJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lockedBy: null,
          lockedAt: null,
          lastError: 'no_handler_registered',
        },
      });
      continue;
    }

    try {
      await handler(job as SchedulerJobRecord);
      await prisma.schedulerJob.update({
        where: { id: job.id },
        data: {
          status: 'done',
          lockedBy: null,
          lockedAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      console.error(`[Scheduler] Job ${job.id} (${job.type}) failed:`, error);
      await prisma.schedulerJob.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          lockedBy: null,
          lockedAt: null,
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

export async function processSchedulerJobsOnce() {
  await processDueJobsOnce();
}

export function startSchedulerWorker(options: { intervalMs?: number } = {}) {
  if (workerStarted) {
    return;
  }
  workerStarted = true;
  workerIntervalMs = Math.max(500, Number(options.intervalMs ?? process.env.SCHEDULER_WORKER_INTERVAL_MS ?? '1000'));
  workerTimer = setInterval(() => {
    processDueJobsOnce().catch((error) => console.error('[Scheduler] cycle error:', error));
  }, workerIntervalMs);
  processDueJobsOnce().catch((error) => console.error('[Scheduler] initial cycle error:', error));
}

export function stopSchedulerWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  workerStarted = false;
}

export function getSchedulerWorkerId() {
  return workerId;
}
