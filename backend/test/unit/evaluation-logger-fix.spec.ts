/**
 * Test for evaluation logger fix
 * Verifies that filter_passed is NOT logged when evaluation.ok is true
 * to prevent inconsistency with execution outcome logging
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the trade evaluation logger BEFORE importing the module
vi.mock('../../src/learning/tradeEvaluationLogger.js', () => ({
  logTradeEvaluation: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocking
import { logMetaAdaptiveEvaluation } from '../../src/quantai/strategies/metaAdaptive/evaluationLogger.js';
import { logTradeEvaluation } from '../../src/learning/tradeEvaluationLogger.js';
import type { EntryEvaluation, EntryFacts } from '../../src/quantai/strategies/metaAdaptive/entryFilters.js';

describe('Evaluation Logger Fix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should NOT log when evaluation.ok is true (filters passed)', async () => {
    const evaluation: EntryEvaluation = {
      ok: true,
      reasons: {},
      regimeContext: {
        volatilityRegime: 'medium',
        directionBias: 'long',
        volumeRegime: 'normal',
        trendingRanging: 'trending',
        parameterSource: 'test',
      },
    };

    const facts: EntryFacts = {
      adx: 30,
      atrPct: 2.5,
      rsi: 55,
      cmf: 0.15,
      volumeRatio: 1.2,
      slopeAbsPct: 0.5,
      spreadBps: 5,
      ema20: 45000,
      ema50: 44000,
      ema100: 43000,
      ema200: 42000,
      volume: 1000000,
      volumeMA: 900000,
      volumeZScore: 0.3,
      trendStrength: 0.8,
      modelConfidence: 0.75,
    };

    await logMetaAdaptiveEvaluation('BTC/USDT', evaluation, facts);

    // Should NOT have called logTradeEvaluation
    expect(logTradeEvaluation).not.toHaveBeenCalled();
  });

  it('should log filter_blocked when evaluation.ok is false', async () => {
    const evaluation: EntryEvaluation = {
      ok: false,
      reasons: {
        adx: 'adx_too_low',
        confidence: 'confidence_below_threshold',
      },
      regimeContext: {
        volatilityRegime: 'low',
        directionBias: 'neutral',
        volumeRegime: 'low',
        trendingRanging: 'ranging',
        parameterSource: 'test',
      },
    };

    const facts: EntryFacts = {
      adx: 15,
      atrPct: 1.2,
      rsi: 50,
      cmf: 0.05,
      volumeRatio: 0.8,
      slopeAbsPct: 0.1,
      spreadBps: 3,
      ema20: 45000,
      ema50: 45100,
      ema100: 45200,
      ema200: 45300,
      volume: 500000,
      volumeMA: 600000,
      volumeZScore: -0.5,
      trendStrength: 0.3,
      modelConfidence: 0.35,
    };

    await logMetaAdaptiveEvaluation('BTC/USDT', evaluation, facts);

    // Should have called logTradeEvaluation with filter_blocked
    expect(logTradeEvaluation).toHaveBeenCalledTimes(1);
    expect(logTradeEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTC/USDT',
        decision: 'filter_blocked',
        blockedReason: expect.stringContaining('adx'),
        confidenceScore: 0.35,
      })
    );
  });

  it('should include all blocked reasons in the log', async () => {
    const evaluation: EntryEvaluation = {
      ok: false,
      reasons: {
        adx: 'adx_too_low',
        cmf: 'cmf_negative',
        volatility: 'volatility_too_high',
      },
      regimeContext: {
        volatilityRegime: 'high',
        directionBias: 'short',
        volumeRegime: 'high',
        trendingRanging: 'trending',
        parameterSource: 'test',
      },
    };

    const facts: EntryFacts = {
      adx: 10,
      atrPct: 5.0,
      rsi: 40,
      cmf: -0.1,
      volumeRatio: 1.5,
      slopeAbsPct: 0.3,
      spreadBps: 10,
      ema20: 44000,
      ema50: 44500,
      ema100: 45000,
      ema200: 45500,
      volume: 2000000,
      volumeMA: 1000000,
      volumeZScore: 1.2,
      trendStrength: 0.5,
      modelConfidence: 0.6,
    };

    await logMetaAdaptiveEvaluation('ETH/USDT', evaluation, facts);

    expect(logTradeEvaluation).toHaveBeenCalledTimes(1);
    const call = (logTradeEvaluation as any).mock.calls[0][0];
    expect(call.decision).toBe('filter_blocked');
    expect(call.blockedReason).toContain('adx');
    expect(call.blockedReason).toContain('cmf');
    expect(call.blockedReason).toContain('volatility');
  });
});
