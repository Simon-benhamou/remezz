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
    // 'filter_passed' means entry filters PASSED
    // 'filter_blocked' means entry filters FAILED
    const decision = evaluation.ok ? 'filter_passed' : 'filter_blocked';
    
    // Extract blocked reasons
    const blockedReasons: string[] = [];
    if (!evaluation.ok && evaluation.reasons) {
      for (const [key, value] of Object.entries(evaluation.reasons)) {
        if (typeof value === 'string') {
          // Include all non-OK reasons
          if (value !== 'OK' && value !== 'PASS') {
            blockedReasons.push(`${key}=${value}`);
          }
        }
      }
    }
    
    // If blocked but no specific reasons found, provide generic reason
    if (!evaluation.ok && blockedReasons.length === 0) {
      // Check meta object for more context
      if (evaluation.meta) {
        const metaStr = JSON.stringify(evaluation.meta);
        blockedReasons.push(`entry_filters_failed (meta: ${metaStr.substring(0, 100)})`);
      } else {
        blockedReasons.push('entry_filters_failed');
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
