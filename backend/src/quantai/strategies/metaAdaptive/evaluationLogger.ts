/**
 * Meta-Adaptive Strategy Evaluation Logger
 * Logs trade evaluations from the meta-adaptive strategy to the learning system
 */

import { logTradeEvaluation, type InputMetrics } from '../../../learning/tradeEvaluationLogger.js';
import type { EntryEvaluation, EntryFacts } from './entryFilters.js';

/**
 * Log a meta-adaptive entry evaluation for learning
 * 
 * CRITICAL FIX: Only log filter_blocked when entry filters fail.
 * DO NOT log filter_passed here - that should only be logged when the trade
 * actually gets placed (after capital, sizing, predictor, and cooldown checks).
 * This prevents the inconsistency where trade evaluations show "filter_passed"
 * but ops logs show "blocked_trade" because later execution checks failed.
 */
export async function logMetaAdaptiveEvaluation(
  symbol: string,
  evaluation: EntryEvaluation,
  facts: EntryFacts,
): Promise<void> {
  try {
    // ONLY log when filters are blocked (evaluation.ok === false)
    // If evaluation.ok === true, the signal will proceed to execution checks
    // and those checks will log the appropriate outcome (filter_passed, order_placed, or various blocks)
    if (evaluation.ok) {
      // Signal passed initial entry filters - don't log yet
      // The orchestrator will log the final outcome after execution checks
      return;
    }

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
      // Predictor fields for transparency
      predictorBias: facts.predictorBias,
      predictorConfidence: facts.predictorConfidence,
      predictorEnabled: facts.predictorEnabled,
      predictorDecision: facts.predictorDecision,
    };
    
    // Extract blocked reasons
    const blockedReasons: string[] = [];
    if (evaluation.reasons) {
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
    if (blockedReasons.length === 0) {
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

    // Log the blocked evaluation (non-blocking)
    await logTradeEvaluation({
      userId: null, // No session context available in evaluationLogger
      symbol,
      decision: 'filter_blocked',
      blockedReason: blockedReasons.join('; '),
      confidenceScore,
      inputMetrics,
      regimeContext: evaluation.regimeContext, // Pass regime context from evaluation
    }).catch((error) => {
      console.warn(`Failed to log meta-adaptive evaluation for ${symbol}:`, error);
    });
  } catch (error) {
    console.warn(`Error in logMetaAdaptiveEvaluation for ${symbol}:`, error);
  }
}
