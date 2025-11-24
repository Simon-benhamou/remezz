import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';

export class PredictorInsightLoop extends AgentLoop {
  private tickCount = 0;
  
  constructor(intervalMs = 5 * 60_000) {
    super(intervalMs, false);
  }

  protected async tick(): Promise<void> {
    this.tickCount++;
    const sessions = await getActiveSessions();
    const symbols = Array.from(new Set(sessions.map((session) => session.symbol)));

    // Log heartbeat every 6 ticks (30 minutes with 5min interval)
    if (this.tickCount % 6 === 1) {
      console.log(`💓 [PredictorLoop] Heartbeat - analyzing ${symbols.length} symbols`);
    }

    for (const symbol of symbols) {
      const insight = await agentServiceRegistry.predictor.analyze(symbol);
      agentMemoryStore.update('predictor', symbol, insight);
      agentEventBus.emitEvent('predictor.insight', { symbol, insight });
    }
  }
}
