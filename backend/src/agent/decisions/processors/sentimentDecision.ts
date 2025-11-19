import type { AgentActionIntent } from '../../actions/types.js';
import type { DecisionProcessor, DecisionResult } from '../types.js';
import { buildActionIntent } from './processorUtils.js';

export class SentimentDecisionProcessor implements DecisionProcessor {
  readonly id = 'sentiment';
  readonly description = 'Turns sentiment pressure into alerts or throttles';

  evaluate(context: Parameters<DecisionProcessor['evaluate']>[0]): DecisionResult | null {
    const signal = context.perception.sentiment;
    if (!signal) {
      return null;
    }

    const executionPlan = context.perception.executionPlan;
    const intents: AgentActionIntent[] = [];

    // DISABLED: Creates 1920 alerts/day per symbol (too noisy!)
    // Sentiment is logged and stored in memory - doesn't need alerts
    // if (signal.bias !== 'neutral' && signal.confidence >= 0.65) {
    //   intents.push(
    //     buildActionIntent({
    //       sessionId: context.session.id,
    //       symbol: context.session.symbol,
    //       type: 'publish_alert',
    //       priority: signal.confidence > 0.8 ? 'high' : 'medium',
    //       confidence: signal.confidence,
    //       reason: `sentiment_${signal.bias}_pressure`,
    //       data: {
    //         bias: signal.bias,
    //         confidence: signal.confidence,
    //         whaleActivity: signal.whaleActivity,
    //         newsHeat: signal.newsHeat,
    //       },
    //     }),
    //   );
    // }

    if (signal.bias === 'bearish' && (signal.confidence > 0.8 || signal.whaleActivity > 0.75)) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'throttle_entries',
          priority: 'high',
          confidence: Math.max(signal.confidence, signal.whaleActivity),
          reason: 'bearish_sentiment_block',
          data: {
            whaleActivity: signal.whaleActivity,
          },
        }),
      );
    }

    if (signal.bias === 'bullish' && signal.confidence > 0.78 && signal.whaleActivity > 0.6) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'adjust_allocation',
          priority: 'medium',
          confidence: 0.6,
          reason: 'bullish_flow_supports_upsize',
          data: {
            direction: 'increase',
            whaleActivity: signal.whaleActivity,
          },
        }),
      );
    }

    if (
      executionPlan &&
      signal.bias === 'neutral' &&
      signal.confidence < 0.4 &&
      executionPlan.strategy === 'market'
    ) {
      intents.push(
        buildActionIntent({
          sessionId: context.session.id,
          symbol: context.session.symbol,
          type: 'switch_execution_mode',
          priority: 'low',
          confidence: 0.45,
          reason: 'sentiment_neutral_prefers_cautious_execution',
          data: {
            suggestedMode: 'limit',
          },
        }),
      );
    }

    // DISABLED: Creates spam when news is hot (routine monitoring)
    // if (signal.newsHeat >= 0.85) {
    //   intents.push(
    //     buildActionIntent({
    //       sessionId: context.session.id,
    //       symbol: context.session.symbol,
    //       type: 'publish_alert',
    //       priority: 'high',
    //       confidence: 0.7,
    //       reason: 'news_heat_extreme',
    //       data: {
    //         newsHeat: signal.newsHeat,
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
        bias: signal.bias,
        confidence: signal.confidence,
        whaleActivity: signal.whaleActivity,
        newsHeat: signal.newsHeat,
      },
    };
  }
}
