import { AgentLoop } from '../loops/baseLoop.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';
import { claimPendingIntents, resetStuckActions, settleIntent } from './store.js';
import { executeActionIntent } from './executor.js';
import type { AgentActionType } from './types.js';

const DEFAULT_BATCH_SIZE = 10;

export class AgentActionExecutorLoop extends AgentLoop {
  constructor(intervalMs = 5_000) {
    super(intervalMs, true);
  }

  protected async tick(): Promise<void> {
    await resetStuckActions();
    const intents = await claimPendingIntents(DEFAULT_BATCH_SIZE);
    if (!intents.length) return;

    for (const intent of intents) {
      const intentType = intent.type as AgentActionType;
      const result = await executeActionIntent(intent);
      await settleIntent({
        id: intent.id,
        status: result.status,
        result: result.details ?? null,
        failureReason: result.failureReason ?? null,
      });

      agentMemoryStore.update('actions', intent.sessionId, {
        intentId: intent.id,
        type: intentType,
        status: result.status,
        details: result.details ?? null,
        failureReason: result.failureReason ?? null,
        updatedAt: Date.now(),
      });

      agentEventBus.emitEvent('actions.executed', {
        sessionId: intent.sessionId,
        symbol: intent.symbol,
        intentId: intent.id,
        type: intentType,
        status: result.status,
        details: result.details ?? null,
        failureReason: result.failureReason ?? null,
      });
    }
  }
}
