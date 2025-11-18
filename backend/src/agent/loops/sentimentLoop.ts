import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';

export class SentimentLoop extends AgentLoop {
  constructor(intervalMs = 45_000) {
    super(intervalMs);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();
    const symbols = Array.from(new Set(sessions.map((session) => session.symbol)));

    for (const symbol of symbols) {
      const snapshot = await agentServiceRegistry.sentiment.getSignal(symbol);
      agentMemoryStore.update('sentiment', symbol, snapshot);
      agentEventBus.emitEvent('sentiment.updated', { symbol, snapshot });
    }
  }
}
