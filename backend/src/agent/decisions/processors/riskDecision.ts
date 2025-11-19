import type { AgentActionIntent } from '../../actions/types.js';
import type { DecisionProcessor, DecisionResult } from '../types.js';
import { buildActionIntent } from './processorUtils.js';

export class RiskGovernorDecisionProcessor implements DecisionProcessor {
  readonly id = 'risk-governor';
  readonly description = 'Enforces risk governor outputs as high-priority actions';

  evaluate(context: Parameters<DecisionProcessor['evaluate']>[0]): DecisionResult | null {
    const limits = context.perception.riskLimits;
    if (!limits) {
      return null;
    }

    const intents: AgentActionIntent[] = [];

    if (limits.hedgingRequired) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'enforce_hedge',
          priority: 'high',
          confidence: 0.95,
          reason: limits.reason ?? 'risk_governor_hedge_required',
          data: { limits },
        }),
      );
    }

    if (limits.maxPositionUsd < 100) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: 'high',
          confidence: 0.85,
          reason: 'max_position_cap_low',
          data: { maxPositionUsd: limits.maxPositionUsd },
        }),
      );
    }

    if (limits.maxLeverage <= 1.5) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'medium',
          confidence: 0.7,
          reason: 'leverage_cap_reduced',
          data: { maxLeverage: limits.maxLeverage },
        }),
      );
    }

    // DISABLED: Creates spam every time risk limits are checked (routine monitoring)
    // Risk governor data is logged and stored - doesn't need alerts
    // if (limits.reason) {
    //   intents.push(
    //     buildActionIntent({
    //       sessionId: context.session.id,
    //       symbol: context.session.symbol,
    //       type: 'publish_alert',
    //       priority: limits.hedgingRequired ? 'high' : 'medium',
    //       confidence: 0.6,
    //       reason: 'risk_governor_reason',
    //       data: {
    //         reason: limits.reason,
    //       },
    //     }),
    //   );
    // }

    if (!intents.length) {
      return null;
    }

    return {
      processorId: this.id,
      intents,
      diagnostics: {
        maxLeverage: limits.maxLeverage,
        maxPositionUsd: limits.maxPositionUsd,
        reason: limits.reason,
        hedgingRequired: limits.hedgingRequired,
      },
    };
  }
}
