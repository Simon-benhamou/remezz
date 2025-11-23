/**
 * Meta-Adaptive Strategy Evaluation Logger
 * Logs trade evaluations from the meta-adaptive strategy to the learning system
 */

import { logTradeEvaluation, type InputMetrics } from '../../../learning/tradeEvaluationLogger.js';
import type { EntryEvaluation, EntryFacts } from './entryFilters.js';

/**
 * Log a meta-adaptive entry evaluation for learning
 * 
 * ✅ FIX: Log ALL evaluations (accepted + rejected) so dashboard shows predictor data
 * Previously: Only logged rejections → predictor column showed "NO DATA"
 * Now: Logs all evaluations → predictor data always visible in dashboard
 */
export async function logMetaAdaptiveEvaluation(
  symbol: string,
  evaluation: EntryEvaluation,
  facts: EntryFacts,
  strategyInfo?: { family?: string; id?: string; eligibilityScore?: number; finalScore?: number }, // Strategy selection tracking
): Promise<void> {
  try {
    // Extract metrics from facts (for both accepted and rejected signals)
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
      // Predictor fields for transparency (CRITICAL for dashboard visibility)
      predictorBias: facts.predictorBias,
      predictorConfidence: facts.predictorConfidence,
      predictorEnabled: facts.predictorEnabled,
      predictorDecision: facts.predictorDecision,
    };
    
    // Determine decision type based on evaluation outcome
    const decision = evaluation.ok ? 'filter_passed' : 'filter_blocked';
    
    // Extract blocked reasons (only for rejections)
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

    // Log the evaluation (both accepted and rejected)
    await logTradeEvaluation({
      userId: null, // No session context available in evaluationLogger
      symbol,
      decision,
      blockedReason: blockedReasons.length > 0 ? blockedReasons.join('; ') : undefined,
      confidenceScore,
      inputMetrics,
      regimeContext: evaluation.regimeContext, // Pass regime context from evaluation
      strategyFamily: strategyInfo?.family,
      strategyId: strategyInfo?.id,
      eligibilityScore: strategyInfo?.eligibilityScore,
      finalScore: strategyInfo?.finalScore,
    }).catch((error) => {
      console.warn(`Failed to log meta-adaptive evaluation for ${symbol}:`, error);
    });
  } catch (error) {
    console.warn(`Error in logMetaAdaptiveEvaluation for ${symbol}:`, error);
  }
}
