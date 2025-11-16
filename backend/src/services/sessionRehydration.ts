import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { hydrateActivationProfile } from '../agent/profilePersistence.js';
import { loadActivePosition } from '../agent/persistence.js';
import { extractPersistedPlan } from './planStore.js';
import { buildPositionTelemetry } from './metaAdaptiveOrchestrator.js';

type PersistedPosition = Awaited<ReturnType<typeof loadActivePosition>>;

function parseNumericArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => {
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((value): value is number => value != null);
}

function extractTakeProfitTargets(raw: unknown): number[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return parseNumericArray(raw);
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.targets)) return parseNumericArray(record.targets);
    if (Array.isArray(record.levels)) return parseNumericArray(record.levels);
    if (Array.isArray(record.tp)) return parseNumericArray(record.tp);
  }
  return [];
}

function seedAgentPositionFromRecord(agent: any, sessionId: string, position: PersistedPosition): boolean {
  if (!position) return false;
  if (!agent) return false;
  if (agent.pos && agent.pos.qty > 0) {
    return true;
  }

  const entry = typeof position.entryPrice === 'number' ? position.entryPrice : null;
  const stop = typeof position.stopPrice === 'number' ? position.stopPrice : null;
  const qty = typeof position.qty === 'number' ? position.qty : null;

  if (!(entry && stop && qty && qty > 0)) {
    console.warn(`⚠️ [SessionRehydration] Unable to seed agent ${sessionId}: incomplete position data.`);
    return false;
  }

  const stopDistanceRaw = Math.abs(entry - stop);
  const stopDistance = stopDistanceRaw > 0 ? stopDistanceRaw : Math.max(entry * 0.0005, 1e-6);
  const openedAtMs = position.openedAt instanceof Date ? position.openedAt.getTime() : Date.now();
  const targets = extractTakeProfitTargets(position.takeProfit ?? null);

  agent.pos = {
    side: position.side === 'sell' ? 'sell' : 'buy',
    qty,
    entry,
    stop,
    openedAt: openedAtMs,
    peakPrice: entry,
    initialStopDistance: stopDistance,
    targets,
    tp: targets,
    slOrderId: position.slOrderId || null,
    tpOrderId: position.tpOrderId || null,
    signal: null,
    telemetry: buildPositionTelemetry({
      entryPrice: entry,
      stopDistance,
      atrValue: null,
    }),
  };

  console.log(`✅ [SessionRehydration] Restored runtime position for session ${sessionId}`);
  return true;
}

export async function restoreAgentRuntimeState(sessionId: string, seed?: { position?: PersistedPosition }): Promise<boolean> {
  const agent = AgentHub.get(sessionId);
  if (!agent) return false;
  const persistedPosition = seed?.position ?? (await loadActivePosition(sessionId));
  if (!persistedPosition) {
    return false;
  }
  return seedAgentPositionFromRecord(agent, sessionId, persistedPosition);
}

export async function rehydrateActiveAgentSessions() {
  const activeSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: {
      id: true,
      symbol: true,
      mode: true,
      startBalanceUsd: true,
      userId: true,
      startedAt: true,
      profileJson: true,
      planJson: true,
    },
  });

  if (activeSessions.length === 0) {
    console.log('♻️ No active agent sessions found for rehydration.');
    return;
  }

  console.log(`♻️ Rehydrating ${activeSessions.length} active agent session(s) from persistence...`);
  const failures: { id: string; reason: string }[] = [];
  const successes: string[] = [];

  for (const session of activeSessions) {
    const profile = hydrateActivationProfile(session);
    if (!profile) {
      failures.push({ id: session.id, reason: 'incomplete_profile' });
      console.warn(`⚠️ Skipping agent ${session.id} (${session.symbol}) rehydration: persisted profile incomplete.`);
      await prisma.agentSession.update({
        where: { id: session.id },
        data: { needsAttention: true },
      }).catch((error) => {
        console.warn(`⚠️ Failed to flag session ${session.id} as needs_attention:`, error);
      });
      continue;
    }

    try {
      const agent = await AgentHub.activate(session.id, profile);

      // Plan restoration not used in meta-adaptive

      await prisma.agentSession.update({
        where: { id: session.id },
        data: { needsAttention: false },
      }).catch((error) => {
        console.warn(`⚠️ Failed to clear needs_attention for ${session.id}:`, error);
      });
      await restoreAgentRuntimeState(session.id);
      successes.push(session.id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ id: session.id, reason });
      console.error(`❌ Failed to rehydrate agent ${session.id} (${session.symbol}):`, error);
      await prisma.agentSession.update({
        where: { id: session.id },
        data: { needsAttention: true },
      }).catch((updateError) => {
        console.warn(`⚠️ Failed to mark session ${session.id} as needs_attention:`, updateError);
      });
    }
  }

  const registered = new Set(AgentHub.listActiveIds());
  const missingAfterBoot = activeSessions.filter((session) => !registered.has(session.id));

  if (missingAfterBoot.length > 0) {
    const details = missingAfterBoot.map((session) => `${session.id} (${session.symbol})`).join(', ');
    console.error(`🚨 AgentHub mismatch after boot. Missing ${missingAfterBoot.length} session(s): ${details}`);
  } else {
    console.log('✅ AgentHub rehydration completed. All active sessions registered.');
  }

  if (failures.length > 0) {
    console.warn(
      `⚠️ ${failures.length} session(s) failed to rehydrate: ${failures
        .map((failure) => `${failure.id} (${failure.reason})`)
        .join('; ')}`,
    );
  }

  if (successes.length) {
    console.log(`✅ Successfully rehydrated ${successes.length} session(s): ${successes.join(', ')}`);
  }
}
