import { AgentLoop } from '../loops/baseLoop.js';
import { getActiveSessions, type ActiveSession } from '../loops/helpers.js';
import { agentMemoryStore } from '../memory/store.js';
import { agentEventBus } from '../bus/index.js';
import { AgentHub } from '../hub.js';
import { getDecisionProcessors } from './processorRegistry.js';
import type { DecisionContext } from './types.js';
import type { AgentActionIntent } from '../actions/types.js';
import { persistActionIntents } from '../actions/store.js';
import type {
  ExecutionPlan,
  MarketQualityScore,
  PredictorInsight,
  RiskLimits,
  SentimentSignal,
} from '../subagents/types.js';

export class AgentDecisionLoop extends AgentLoop {
  constructor(intervalMs = 20_000) {
    super(intervalMs, false);
  }

  protected async tick(): Promise<void> {
    const sessions = await getActiveSessions();
    for (const session of sessions) {
      const context = this.buildContext(session);
      if (!context) continue;
      const intents = await this.runProcessors(context);
      if (!intents.length) continue;

      agentMemoryStore.update('decisions', session.id, {
        sessionId: session.id,
        symbol: session.symbol,
        intents,
        generatedAt: Date.now(),
      });

      await persistActionIntents(intents);

      agentEventBus.emitEvent('decisions.intent', {
        sessionId: session.id,
        symbol: session.symbol,
        intents,
      });
    }
  }

  private buildContext(session: ActiveSession): DecisionContext | null {
    const agent = AgentHub.get(session.id);
    const perception = {
      marketQuality: this.getSnapshot<MarketQualityScore>('marketQuality', session.symbol),
      sentiment: this.getSnapshot<SentimentSignal>('sentiment', session.symbol),
      riskLimits: this.getSnapshot<RiskLimits>('riskGovernor', session.id),
      executionPlan: this.getSnapshot<ExecutionPlan>('executionPlan', session.id),
      predictor: this.getSnapshot<PredictorInsight>('predictor', session.symbol),
    };

    const hasPerception = Object.values(perception).some(Boolean);
    if (!hasPerception) {
      return null;
    }

    return {
      session: { ...session, profile: agent?.profile ?? null },
      perception,
    };
  }

  private getSnapshot<T>(agent: string, identifier: string): T | null {
    return agentMemoryStore.get<T>(agent, identifier)?.data ?? null;
  }

  private async runProcessors(context: DecisionContext): Promise<AgentActionIntent[]> {
    const intents: AgentActionIntent[] = [];
    for (const processor of getDecisionProcessors()) {
      try {
        const result = await processor.evaluate(context);
        if (result?.intents?.length) {
          intents.push(...result.intents);
        }
      } catch (error) {
        this.logger.error('Decision processor failed', {
          processorId: processor.id,
          sessionId: context.session.id,
          error,
        });
      }
    }
    return intents;
  }
}
