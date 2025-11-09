/**
 * Meta-Adaptive Strategy Evaluation Logger
 * Logs trade evaluations from the meta-adaptive strategy to the learning system
 */

import { logTradeEvaluation, type InputMetrics } from '../../../learning/tradeEvaluationLogger.js';
import type { EntryEvaluation, EntryFacts } from './entryFilters.js';

/**
 * Log a meta-adaptive entry evaluation for learning
 */
export async function logMetaAdaptiveEvaluation(
  symbol: string,
  evaluation: EntryEvaluation,
  facts: EntryFacts,
): Promise<void> {
  try {
    // Extract metrics from facts
    const inputMetrics: InputMetrics = {
      adx: facts.adx,
      atrPct: facts.atrPct,
      rsi14: facts.rsi,
      cmf: facts.cmf,
      volumeRatio: facts.volumeRatio,
      slope: facts.slopeAbsPct,
      // Additional meta-adaptive specific metrics
      spreadBps: facts.spreadBps,
      // Fields needed for regime-aware optimization
      ema20: facts.ema20,
      ema50: facts.ema50,
      ema100: facts.ema100,
      ema200: facts.ema200,
      volume: facts.volume,
      volumeMA: facts.volumeMA,
      volumeZScore: facts.volumeZScore,
      trendStrength: facts.trendStrength,
    };

    // Determine decision
    const decision = evaluation.ok ? 'executed' : 'blocked';
    
    // Extract blocked reasons
    const blockedReasons: string[] = [];
    if (!evaluation.ok && evaluation.reasons) {
      for (const [key, value] of Object.entries(evaluation.reasons)) {
        if (typeof value === 'string' && (value.includes('FAIL') || value.includes('BLOCKED'))) {
          blockedReasons.push(`${key}: ${value}`);
        }
      }
    }

    // Use model confidence as the confidence score if available, otherwise use a derived score
    const confidenceScore = facts.modelConfidence ?? 0.5;

    // Log the evaluation (non-blocking)
    await logTradeEvaluation({
      symbol,
      decision,
      blockedReason: blockedReasons.length > 0 ? blockedReasons.join('; ') : undefined,
      confidenceScore,
      inputMetrics,
    }).catch((error) => {
      console.warn(`Failed to log meta-adaptive evaluation for ${symbol}:`, error);
    });
  } catch (error) {
    console.warn(`Error in logMetaAdaptiveEvaluation for ${symbol}:`, error);
  }
}
