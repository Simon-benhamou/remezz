import { AgentHub } from '../agent/hub.js';
import type { StopAllSessionResult } from '../agent/hub.js';
import { prisma } from '../db/client.js';
import { recordOpsEvent } from '../monitor/ops.js';

export type StopAllAgentsOptions = {
  actorId?: string | null;
  actorUsername?: string | null;
  reason?: string;
};

export type StopAllAgentsResponse = {
  results: StopAllSessionResult[];
  stoppedSessionIds: string[];
  updatedSessions: any[];
  auditLogId: string;
};

export async function stopAllAgents(options: StopAllAgentsOptions = {}): Promise<StopAllAgentsResponse> {
  const reason = options.reason || 'stop_all';
  const stopResult = await AgentHub.stopAll();
  const sessions = stopResult.sessions;
  const sessionIds = sessions.map((s) => s.sessionId);
  const now = new Date();

  const updates: any[] = [];
  if (sessionIds.length > 0) {
    for (const id of sessionIds) {
      updates.push(
        prisma.agentSession.update({
          where: { id },
          data: { stoppedAt: now, haltedAt: now, haltReason: reason },
        }),
      );
    }
  }

  const updatedSessions = updates.length ? await prisma.$transaction(updates) : [];

  const audit = await prisma.auditLog.create({
    data: {
      action: 'agent.stop_all',
      userId: options.actorId ?? null,
      username: options.actorUsername ?? null,
      details: {
        reason,
        sessionCount: sessionIds.length,
        sessions,
      },
    },
  });

  recordOpsEvent({
    level: sessionIds.length ? 'warn' : 'info',
    source: 'agent_control',
    message: 'stop_all_executed',
    details: {
      auditLogId: audit.id,
      reason,
      sessionIds,
      actorId: options.actorId ?? null,
      actorUsername: options.actorUsername ?? null,
      results: sessions,
    },
  });

  return {
    results: sessions,
    stoppedSessionIds: sessionIds,
    updatedSessions,
    auditLogId: audit.id,
  };
}
