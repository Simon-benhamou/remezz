import { prisma } from '../db/client.js';
import { AgentHub } from '../agent/hub.js';
import { restoreAgentRuntimeState } from './sessionRehydration.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('agent-state-watchdog');
let watchdogTimer: NodeJS.Timeout | null = null;
let evaluationInFlight = false;

async function evaluateAgentRuntimeState(): Promise<void> {
  if (evaluationInFlight) {
    return;
  }
  evaluationInFlight = true;
  try {
    const activeAgentIds = AgentHub.listActiveIds();
    if (activeAgentIds.length === 0) {
      return;
    }

    const positions = await prisma.position.findMany({
      where: {
        sessionId: { in: activeAgentIds },
        qty: { gt: 0 },
      },
    });

    if (positions.length === 0) {
      return;
    }

    for (const position of positions) {
      const sessionId = position.sessionId;
      if (!sessionId) {
        continue;
      }

      const agent = AgentHub.get(sessionId);
      if (!agent) {
        logger.warn(`[${sessionId}] Database shows open position but agent is not registered in AgentHub.`);
        continue;
      }

      const hasRuntimePosition = agent.pos && agent.pos.qty > 0;
      if (hasRuntimePosition) {
        continue;
      }

      const restored = await restoreAgentRuntimeState(sessionId, { position });
      if (restored) {
        logger.warn(`[${sessionId}] Runtime position missing. Restored from persistence snapshot.`);
      } else {
        logger.error(`[${sessionId}] Runtime position missing and could not be restored (incomplete data).`);
      }
    }
  } catch (error) {
    logger.error('Agent state watchdog iteration failed:', error);
  } finally {
    evaluationInFlight = false;
  }
}

export function startAgentStateWatchdog(options?: { intervalMs?: number }): void {
  const intervalMs = options?.intervalMs ?? 60_000;
  if (watchdogTimer) {
    return;
  }

  logger.info(`Agent state watchdog started (interval=${Math.round(intervalMs / 1000)}s)`);

  const schedule = () => {
    watchdogTimer = setTimeout(async () => {
      await evaluateAgentRuntimeState();
      schedule();
    }, intervalMs);
  };

  // Run immediately to cover freshly restarted processes
  evaluateAgentRuntimeState().catch((error) => {
    logger.error('Initial agent state watchdog iteration failed:', error);
  }).finally(() => {
    schedule();
  });
}
