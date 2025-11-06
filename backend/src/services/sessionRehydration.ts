import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { hydrateActivationProfile } from '../agent/profilePersistence.js';
import { extractPersistedPlan } from './planStore.js';

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
