import { AgentLoop } from './baseLoop.js';
import { getActiveSessions } from './helpers.js';
import { agentServiceRegistry } from '../subagents/serviceRegistry.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';
import type { MarketQualityScore, RiskLimits } from '../subagents/types.js';

export class ExecutionPlanningLoop extends AgentLoop {
  constructor(intervalMs = 30_000) { // Reduced from 75s to 30s for faster plan generation
    super(intervalMs, false);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();

    for (const session of sessions) {
      const limitsEntry = agentMemoryStore.get<RiskLimits>('riskGovernor', session.id);
      const limits = limitsEntry?.data ?? await agentServiceRegistry.riskGovernor.getLimits(session.id, session.symbol);
      const marketQualityEntry = agentMemoryStore.get<MarketQualityScore>('marketQuality', session.symbol);
      const spreadBps = marketQualityEntry?.data?.spreadBps ?? 12;
      const qualityScore = marketQualityEntry?.data?.score ?? 0.5;

      const plan = await agentServiceRegistry.execution.plan({
        symbol: session.symbol,
        side: 'buy',
        sizeUsd: limits.maxPositionUsd,
        spreadBps,
        marketQualityScore: qualityScore,
        marketQuality: marketQualityEntry?.data ?? null,
        riskLimits: limits,
      });

      agentMemoryStore.update('executionPlan', session.id, plan);
      agentEventBus.emitEvent('execution.plan.ready', {
        sessionId: session.id,
        symbol: session.symbol,
        plan,
      });
    }
  }
}
