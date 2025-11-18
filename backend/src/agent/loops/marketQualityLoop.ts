import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';

export class MarketQualityLoop extends AgentLoop {
  constructor(intervalMs = 30_000) {
    super(intervalMs);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();
    const symbols = Array.from(new Set(sessions.map((session) => session.symbol)));

    for (const symbol of symbols) {
      const snapshot = await agentServiceRegistry.marketQuality.assess(symbol);
      agentMemoryStore.update('marketQuality', symbol, snapshot);
      const sessionIds = sessions.filter((session) => session.symbol === symbol).map((session) => session.id);
      agentEventBus.emitEvent('marketQuality.updated', { symbol, sessionIds, snapshot });
    }
  }
}
