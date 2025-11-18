import { prisma } from '../../db/client.js';
import type { AgentActionIntent } from './types.js';

const PRIORITY_WEIGHT: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

type StoredActionIntent = NonNullable<Awaited<ReturnType<typeof prisma.agentActionIntent.findFirst>>>;

export type ActionIntentRecord = StoredActionIntent & { priorityWeight: number };

export async function persistActionIntents(intents: AgentActionIntent[]): Promise<void> {
  if (!intents.length) return;
  const rows: any[] = intents.map((intent) => ({
    id: intent.id,
    sessionId: intent.sessionId,
    symbol: intent.symbol,
    type: intent.type,
    priority: intent.priority,
    confidence: intent.confidence,
    reason: intent.reason,
    payload: intent.data ?? undefined,
    status: 'pending',
  }));
  await prisma.agentActionIntent.createMany({
    data: rows,
    skipDuplicates: true,
  });
}

export async function claimPendingIntents(limit = 10): Promise<ActionIntentRecord[]> {
  if (limit <= 0) return [];
  const candidates = await prisma.agentActionIntent.findMany({
    where: { status: 'pending' },
    orderBy: { createdAt: 'asc' },
    take: limit * 3,
  });

  const claimed: ActionIntentRecord[] = [];
  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    const updateResult = await prisma.agentActionIntent.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'in_progress', startedAt: new Date() },
    });
    if (updateResult.count === 0) {
      continue;
    }
    const fresh = await prisma.agentActionIntent.findUnique({ where: { id: candidate.id } });
    if (!fresh) {
      continue;
    }
    claimed.push({
      ...fresh,
      priorityWeight: PRIORITY_WEIGHT[fresh.priority] ?? 1,
    });
  }

  claimed.sort((a, b) => {
    if (a.priorityWeight === b.priorityWeight) {
      return a.createdAt.getTime() - b.createdAt.getTime();
    }
    return b.priorityWeight - a.priorityWeight;
  });

  return claimed;
}

export async function settleIntent(params: {
  id: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: Record<string, unknown> | null;
  failureReason?: string | null;
}): Promise<void> {
  const { id, status, result = null, failureReason = null } = params;
  await prisma.agentActionIntent.update({
    where: { id },
    data: {
      status,
      executedAt: new Date(),
      result: result ?? undefined,
      failureReason,
    } as any,
  });
}

export async function resetStuckActions(maxAgeMs = 5 * 60 * 1000): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await prisma.agentActionIntent.updateMany({
    where: {
      status: 'in_progress',
      startedAt: { lt: cutoff },
    },
    data: {
      status: 'pending',
      startedAt: null,
    },
  });
  return result.count;
}