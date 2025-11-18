import type { AgentActionIntent } from '../../actions/types.js';
import type { DecisionProcessor, DecisionResult } from '../types.js';
import { buildActionIntent } from './processorUtils.js';

export class MarketQualityDecisionProcessor implements DecisionProcessor {
  readonly id = 'market-quality';
  readonly description = 'Translates market quality snapshots into throttling or execution actions';

  evaluate(context: Parameters<DecisionProcessor['evaluate']>[0]): DecisionResult | null {
    const snapshot = context.perception.marketQuality;
    if (!snapshot) {
      return null;
    }

    const executionPlan = context.perception.executionPlan;
    const planMeta = executionPlan?.meta;
    const depthRequirement = executionPlan
      ? Math.max(executionPlan.minFillUsd * 1.2, executionPlan.sizeUsd * 0.15)
      : null;
    const spreadAllowance = executionPlan?.maxSlippageBps ?? 18;
    const intents: AgentActionIntent[] = [];

    const depthInsufficient = depthRequirement != null && snapshot.bookDepthUsd < depthRequirement;
    const spreadPressure = snapshot.spreadBps > spreadAllowance * 1.15;
    const hostileScore = snapshot.score < 0.3;

    if (hostileScore || depthInsufficient) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: hostileScore ? 'high' : 'medium',
          confidence: hostileScore ? 0.9 : 0.7,
          reason: hostileScore ? 'market_quality_extreme_low' : 'insufficient_depth_vs_plan',
          data: {
            score: snapshot.score,
            bookDepthUsd: snapshot.bookDepthUsd,
            requiredDepthUsd: depthRequirement,
          },
        }),
      );
    }

    if (spreadPressure) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'medium',
          confidence: 0.65,
          reason: 'spread_exceeds_plan_threshold',
          data: {
            spreadBps: snapshot.spreadBps,
            suggestedMode: executionPlan?.strategy === 'twap' ? 'twap' : 'limit',
            planMaxSlippageBps: spreadAllowance,
          },
        }),
      );
    }

    if (executionPlan && snapshot.score >= 0.75 && snapshot.spreadBps < spreadAllowance * 0.9) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'low',
          confidence: 0.55,
          reason: 'market_quality_supports_aggressive_execution',
          data: {
            spreadBps: snapshot.spreadBps,
            suggestedMode: 'market',
            score: snapshot.score,
          },
        }),
      );
    }

    const impactUsd = snapshot.impactUsd;
    if (
      executionPlan &&
      Number.isFinite(impactUsd) &&
      impactUsd != null &&
      impactUsd > executionPlan.sizeUsd * 0.025
    ) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'medium',
          confidence: 0.6,
          reason: 'estimated_impact_exceeds_tolerance',
          data: {
            estimatedImpactUsd: impactUsd,
            plannedSizeUsd: executionPlan.sizeUsd,
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
        score: snapshot.score,
        spreadBps: snapshot.spreadBps,
        bookDepthUsd: snapshot.bookDepthUsd,
        depthRequirementUsd: depthRequirement,
        impactUsd: snapshot.impactUsd,
        planStrategy: executionPlan?.strategy ?? null,
      },
    };
  }
}
