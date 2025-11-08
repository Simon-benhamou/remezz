/**
 * Validation API Routes
 * 
 * Endpoints for running overfitting detection and strategy validation
 */

import { Router } from 'express';
import { buildMetaAdaptiveSyntheticCandles, type Candle, type MetaAdaptiveBacktestOptions } from '../quantai/strategies/metaAdaptive/backtest.js';
import { 
  runComprehensiveValidation, 
  runCrossValidation, 
  runOutOfSampleValidation 
} from '../quantai/validation/metaAdaptiveValidation.js';
import { 
  checkRecalibrationNeeded,
  type PerformanceMetrics 
} from '../quantai/validation/overfittingDetector.js';

const router = Router();

/**
 * POST /api/validation/comprehensive
 * Run comprehensive validation (cross-validation + out-of-sample + walk-forward)
 */
router.post('/comprehensive', async (req, res) => {
  try {
    const { 
      candleData, 
      useSyntheticData = false,
      syntheticMinutes = 10080, // 1 week default
      options 
    } = req.body;

    // Get candle data
    let candles: Candle[];
    if (useSyntheticData) {
      candles = buildMetaAdaptiveSyntheticCandles({ minutes: syntheticMinutes });
    } else if (candleData && Array.isArray(candleData)) {
      candles = candleData;
    } else {
      return res.status(400).json({ 
        error: 'Either candleData or useSyntheticData must be provided' 
      });
    }

    // Default options
    const validationOptions: MetaAdaptiveBacktestOptions = {
      symbol: options?.symbol || 'ETH/USDT',
      equityUsd: options?.equityUsd || 10000,
      slippageBps: options?.slippageBps ?? 5,
      makerFeeBps: options?.makerFeeBps ?? 2,
      takerFeeBps: options?.takerFeeBps ?? 6,
      fundingAnnualPct: options?.fundingAnnualPct ?? 8,
      latencyMs: options?.latencyMs ?? 150,
      impactBpsPerMillion: options?.impactBpsPerMillion ?? 3,
      strategyHealthWarmupTrades: options?.strategyHealthWarmupTrades ?? 5,
      disableStrategyHealthRisk: options?.disableStrategyHealthRisk ?? false
    };

    console.log(`[Validation API] Running comprehensive validation with ${candles.length} candles`);
    
    const result = await runComprehensiveValidation(candles, validationOptions);

    res.json({
      success: true,
      validation: {
        overall: {
          metrics: result.overall.metrics,
          tradeCount: result.overall.trades.length
        },
        walkForward: (result.walkForward ?? []).map(segment => ({
          start: new Date(segment.start).toISOString(),
          end: new Date(segment.end).toISOString(),
          metrics: segment.metrics
        })),
        crossValidation: {
          stabilityScore: result.crossValidation.stabilityScore,
          avgTrainMetrics: result.crossValidation.avgTrainMetrics,
          avgTestMetrics: result.crossValidation.avgTestMetrics,
          overfitDetected: result.crossValidation.overfit.isOverfitted,
          severity: result.crossValidation.overfit.severity
        },
        outOfSample: {
          inSample: result.outOfSample.inSample,
          outOfSample: result.outOfSample.outOfSample,
          degradationPct: result.outOfSample.degradationPct,
          isSignificant: result.outOfSample.isSignificant,
          overfitDetected: result.outOfSample.overfit.isOverfitted,
          severity: result.outOfSample.overfit.severity
        },
        overfittingAnalysis: {
          isOverfitted: result.overfittingAnalysis.flags.isOverfitted,
          severity: result.overfittingAnalysis.flags.severity,
          confidence: result.overfittingAnalysis.flags.confidence,
          flags: result.overfittingAnalysis.flags.flags,
          recommendations: result.overfittingAnalysis.flags.recommendations,
          actionRequired: result.overfittingAnalysis.actionRequired,
          summary: result.overfittingAnalysis.summary
        }
      }
    });
  } catch (error) {
    console.error('[Validation API] Comprehensive validation error:', error);
    res.status(500).json({ 
      error: 'Validation failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * POST /api/validation/cross-validation
 * Run only cross-validation
 */
router.post('/cross-validation', async (req, res) => {
  try {
    const { candleData, useSyntheticData = false, syntheticMinutes = 10080, options, k = 5 } = req.body;

    let candles: Candle[];
    if (useSyntheticData) {
      candles = buildMetaAdaptiveSyntheticCandles({ minutes: syntheticMinutes });
    } else if (candleData && Array.isArray(candleData)) {
      candles = candleData;
    } else {
      return res.status(400).json({ error: 'Either candleData or useSyntheticData must be provided' });
    }

    const validationOptions: MetaAdaptiveBacktestOptions = {
      symbol: options?.symbol || 'ETH/USDT',
      equityUsd: options?.equityUsd || 10000,
      slippageBps: options?.slippageBps ?? 5,
      makerFeeBps: options?.makerFeeBps ?? 2,
      takerFeeBps: options?.takerFeeBps ?? 6
    };

    const result = await runCrossValidation(candles, validationOptions, k);

    res.json({
      success: true,
      crossValidation: {
        folds: result.folds.map(fold => ({
          start: new Date(fold.start).toISOString(),
          end: new Date(fold.end).toISOString(),
          type: fold.type,
          metrics: fold.metrics
        })),
        avgTrainMetrics: result.avgTrainMetrics,
        avgTestMetrics: result.avgTestMetrics,
        stabilityScore: result.stabilityScore,
        overfit: result.overfit
      }
    });
  } catch (error) {
    console.error('[Validation API] Cross-validation error:', error);
    res.status(500).json({ 
      error: 'Cross-validation failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * POST /api/validation/out-of-sample
 * Run only out-of-sample validation
 */
router.post('/out-of-sample', async (req, res) => {
  try {
    const { 
      candleData, 
      useSyntheticData = false, 
      syntheticMinutes = 10080, 
      options, 
      inSampleRatio = 0.7 
    } = req.body;

    let candles: Candle[];
    if (useSyntheticData) {
      candles = buildMetaAdaptiveSyntheticCandles({ minutes: syntheticMinutes });
    } else if (candleData && Array.isArray(candleData)) {
      candles = candleData;
    } else {
      return res.status(400).json({ error: 'Either candleData or useSyntheticData must be provided' });
    }

    const validationOptions: MetaAdaptiveBacktestOptions = {
      symbol: options?.symbol || 'ETH/USDT',
      equityUsd: options?.equityUsd || 10000,
      slippageBps: options?.slippageBps ?? 5,
      makerFeeBps: options?.makerFeeBps ?? 2,
      takerFeeBps: options?.takerFeeBps ?? 6
    };

    const result = await runOutOfSampleValidation(candles, validationOptions, inSampleRatio);

    res.json({
      success: true,
      outOfSample: {
        inSample: result.inSample,
        outOfSample: result.outOfSample,
        degradationPct: result.degradationPct,
        isSignificant: result.isSignificant,
        overfit: result.overfit
      }
    });
  } catch (error) {
    console.error('[Validation API] Out-of-sample validation error:', error);
    res.status(500).json({ 
      error: 'Out-of-sample validation failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * POST /api/validation/recalibration-check
 * Check if strategy needs recalibration based on recent vs historical performance
 */
router.post('/recalibration-check', async (req, res) => {
  try {
    const { recentMetrics, historicalMetrics, thresholds } = req.body;

    if (!recentMetrics || !historicalMetrics) {
      return res.status(400).json({ 
        error: 'Both recentMetrics and historicalMetrics are required' 
      });
    }

    const signal = checkRecalibrationNeeded(
      recentMetrics as PerformanceMetrics,
      historicalMetrics as PerformanceMetrics,
      thresholds
    );

    res.json({
      success: true,
      recalibration: signal
    });
  } catch (error) {
    console.error('[Validation API] Recalibration check error:', error);
    res.status(500).json({ 
      error: 'Recalibration check failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * GET /api/validation/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    service: 'validation', 
    status: 'operational',
    version: '1.0.0'
  });
});

export default router;
