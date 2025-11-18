import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';

export class RiskGovernorLoop extends AgentLoop {
  constructor(intervalMs = 60_000) {
    super(intervalMs);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();

    for (const session of sessions) {
      const limits = await agentServiceRegistry.riskGovernor.getLimits(session.id, session.symbol);
      agentMemoryStore.update('riskGovernor', session.id, limits);
      agentEventBus.emitEvent('riskGovernor.updated', {
        sessionId: session.id,
        symbol: session.symbol,
        limits,
      });

      if (limits.hedgingRequired) {
        agentEventBus.emitEvent('riskGovernor.alert', {
          sessionId: session.id,
          symbol: session.symbol,
          reason: limits.reason ?? 'hedging_required',
          limits,
        });
      }
    }
  }
}
