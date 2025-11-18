import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';

export class PredictorInsightLoop extends AgentLoop {
  constructor(intervalMs = 5 * 60_000) {
    super(intervalMs, false);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();
    const symbols = Array.from(new Set(sessions.map((session) => session.symbol)));

    for (const symbol of symbols) {
      const insight = await agentServiceRegistry.predictor.analyze(symbol);
      agentMemoryStore.update('predictor', symbol, insight);
      agentEventBus.emitEvent('predictor.insight', { symbol, insight });
    }
  }
}
