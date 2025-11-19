import type { AgentActionIntent } from '../../actions/types.js';
import type { DecisionProcessor, DecisionResult } from '../types.js';
import { buildActionIntent } from './processorUtils.js';

export class PredictorDecisionProcessor implements DecisionProcessor {
  readonly id = 'predictor';
  readonly description = 'Requests predictor refresh or alerts when signal confidence drops';

  evaluate(context: Parameters<DecisionProcessor['evaluate']>[0]): DecisionResult | null {
    const predictor = context.perception.predictor;
    if (!predictor) {
      return null;
    }

    const intents: AgentActionIntent[] = [];
    const details = predictor.details ?? {};
    const cooldown = (details?.cooldown as { active?: boolean; reason?: string | null; seconds?: number | null }) ?? null;
    const entryWeightRaw = Number((details as Record<string, unknown>)?.entryWeight ?? NaN);
    const entryWeight = Number.isFinite(entryWeightRaw) ? entryWeightRaw : null;

    if (!predictor.enabled) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'request_predictor_refresh',
          priority: 'medium',
          reason: 'predictor_disabled',
        }),
      );
    // DISABLED: Creates spam when predictor has low confidence (routine)
    // Predictor state is logged - doesn't need alerts
    // } else if (predictor.confidence < 0.45) {
    //   intents.push(
    //     buildActionIntent({
    //       sessionId: context.session.id,
    //       symbol: context.session.symbol,
    //       type: 'publish_alert',
    //       priority: 'low',
    //       confidence: predictor.confidence,
    //       reason: 'predictor_confidence_low',
    //       data: {
    //         predictorBias: predictor.bias,
    //         confidence: predictor.confidence,
    //         lastRetrainedAt: predictor.lastRetrainedAt ?? null,
    //       },
    //     }),
    //   );
    }

    if (predictor.enabled && cooldown?.active) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: 'high',
          confidence: 0.75,
          reason: 'predictor_cooldown_active',
          data: {
            reason: cooldown.reason,
            seconds: cooldown.seconds,
          },
        }),
      );
    }

    if (predictor.enabled && predictor.bias !== 'neutral' && predictor.confidence >= 0.78) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'medium',
          confidence: predictor.confidence,
          reason: 'predictor_high_confidence_bias',
          data: {
            bias: predictor.bias,
            confidence: predictor.confidence,
          },
        }),
      );
    }

    if (entryWeight != null && entryWeight < 0.6) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: 'medium',
          confidence: 0.55,
          reason: 'predictor_recommends_light_entry',
          data: { entryWeight },
        }),
      );
    } else if (entryWeight != null && entryWeight > 1.6) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'medium',
          confidence: 0.6,
          reason: 'predictor_recommends_upsize',
          data: { entryWeight },
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
        enabled: predictor.enabled,
        bias: predictor.bias,
        confidence: predictor.confidence,
        entryWeight,
        cooldownActive: Boolean(cooldown?.active),
      },
    };
  }
}
