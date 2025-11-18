import type { AgentActionIntent } from '../../actions/types.js';
import type { DecisionProcessor, DecisionResult } from '../types.js';
import { buildActionIntent } from './processorUtils.js';

export class ExecutionPlanDecisionProcessor implements DecisionProcessor {
  readonly id = 'execution-plan';
  readonly description = 'Ensures execution plans are reflected as explicit actions';

  evaluate(context: Parameters<DecisionProcessor['evaluate']>[0]): DecisionResult | null {
    const plan = context.perception.executionPlan;
    if (!plan) {
      return null;
    }

    const intents: AgentActionIntent[] = [];
    const meta = plan.meta ?? {};

    // Encourage plan adherence when urgency high
    if (plan.urgency === 'high' && plan.strategy !== 'market') {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'medium',
          reason: 'execution_plan_requires_fast_mode',
          data: {
            planStrategy: plan.strategy,
            recommendedMode: 'market',
          },
        }),
      );
    }

    if (plan.strategy === 'twap' && plan.minFillUsd > 15_000) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'low',
          reason: 'twap_plan_large_notional',
          data: {
            minFillUsd: plan.minFillUsd,
          },
        }),
      );
    }

    if (meta.preferPassive && plan.strategy === 'sweep') {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'medium',
          reason: 'telemetry_prefers_passive_execution',
          data: { suggestedMode: 'limit', passiveOffsetBps: meta.passiveOffsetBps },
        }),
      );
    }

    if (meta.preferAggressive && plan.strategy !== 'market') {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'medium',
          reason: 'telemetry_prefers_aggressive_execution',
          data: { suggestedMode: 'market' },
        }),
      );
    }

    if (typeof meta.depthRatio === 'number' && meta.depthRatio > 1.3) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: 'medium',
          confidence: 0.6,
          reason: 'order_depth_ratio_high',
          data: {
            depthRatio: meta.depthRatio,
          },
        }),
      );
    }

    if (Array.isArray(meta.notes) && meta.notes.includes('near_position_cap')) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'high',
          confidence: 0.7,
          reason: 'execution_plan_near_position_cap',
          data: { notes: meta.notes },
        }),
      );
    }

    if (plan.strategy === 'twap' && (meta.twapSlices ?? 0) >= 8) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'publish_alert',
          priority: 'medium',
          confidence: 0.55,
          reason: 'twap_plan_many_slices',
          data: {
            twapSlices: meta.twapSlices,
            twapIntervalMs: meta.twapIntervalMs,
          },
        }),
      );
    }

    if (!intents.length) {
      return null;
    }

    return {
      processorId: this.id,
      intents,
      diagnostics: {
        strategy: plan.strategy,
        urgency: plan.urgency,
        meta,
      },
    };
  }
}
