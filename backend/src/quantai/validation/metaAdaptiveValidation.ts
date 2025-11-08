/**
 * Meta-Adaptive Strategy Validation System
 * 
 * Integrates overfitting detection with Meta-Adaptive backtest system
 */

import type { Candle, BacktestMetrics, BacktestResult, MetaAdaptiveBacktestOptions } from '../strategies/metaAdaptive/backtest.js';
import { runMetaAdaptiveBacktest } from '../strategies/metaAdaptive/backtest.js';
import {
  type PerformanceMetrics,
  type ValidationSegment,
  type CrossValidationResult,
  type OutOfSampleResult,
  type OverfittingFlags,
  createCrossValidationFolds,
  createOutOfSampleSplit,
  detectOverfitting,
  calculateWinRateStability,
  calculateDegradation,
  logOverfittingEvent
} from './overfittingDetector.js';

/**
 * Convert BacktestMetrics to PerformanceMetrics
 */
function convertMetrics(btMetrics: BacktestMetrics): PerformanceMetrics {
  return {
    totalReturnPct: btMetrics.totalReturnPct,
    sharpe: btMetrics.sharpe,
    maxDrawdownPct: btMetrics.maxDrawdownPct,
    hitRate: btMetrics.hitRate,
    profitFactor: btMetrics.profitFactor,
    avgWin: btMetrics.avgWin,
    avgLoss: btMetrics.avgLoss,
    trades: btMetrics.trades ?? 0,
    expectancy: btMetrics.profitFactor > 0 
      ? (btMetrics.hitRate * btMetrics.avgWin + (1 - btMetrics.hitRate) * btMetrics.avgLoss)
      : 0
  };
}

/**
 * Run cross-validation on Meta-Adaptive strategy
 */
export async function runCrossValidation(
  candles: Candle[],
  options: MetaAdaptiveBacktestOptions,
  k: number = 5
): Promise<CrossValidationResult> {
  const folds = createCrossValidationFolds(candles, k);
  const segments: ValidationSegment[] = [];
  
  let trainMetricsSum: PerformanceMetrics = {
    totalReturnPct: 0,
    sharpe: 0,
    maxDrawdownPct: 0,
    hitRate: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    trades: 0
  };
  
  let testMetricsSum: PerformanceMetrics = { ...trainMetricsSum };

  for (let i = 0; i < folds.length; i++) {
    const fold = folds[i];
    
    // Run backtest on train set
    const trainResult = runMetaAdaptiveBacktest(fold.train, options);
    const trainMetrics = convertMetrics(trainResult.metrics);
    
    segments.push({
      start: fold.train[0]?.timestamp ?? 0,
      end: fold.train[fold.train.length - 1]?.timestamp ?? 0,
      type: 'train',
      metrics: trainMetrics
    });
    
    // Run backtest on test set
    const testResult = runMetaAdaptiveBacktest(fold.test, options);
    const testMetrics = convertMetrics(testResult.metrics);
    
    segments.push({
      start: fold.test[0]?.timestamp ?? 0,
      end: fold.test[fold.test.length - 1]?.timestamp ?? 0,
      type: 'test',
      metrics: testMetrics
    });
    
    // Accumulate metrics
    for (const key of Object.keys(trainMetricsSum) as Array<keyof PerformanceMetrics>) {
      trainMetricsSum[key] = (trainMetricsSum[key] as number) + (trainMetrics[key] as number);
      testMetricsSum[key] = (testMetricsSum[key] as number) + (testMetrics[key] as number);
    }
  }

  // Average the metrics
  const avgTrainMetrics: PerformanceMetrics = Object.fromEntries(
    Object.entries(trainMetricsSum).map(([key, value]) => [key, (value as number) / k])
  ) as PerformanceMetrics;
  
  const avgTestMetrics: PerformanceMetrics = Object.fromEntries(
    Object.entries(testMetricsSum).map(([key, value]) => [key, (value as number) / k])
  ) as PerformanceMetrics;

  // Calculate stability score
  const testSegments = segments.filter(s => s.type === 'test');
  const stabilityScore = calculateWinRateStability(testSegments);

  // Detect overfitting
  const overfit = detectOverfitting(avgTrainMetrics, avgTestMetrics, testSegments);

  // Log results
  logOverfittingEvent('meta-adaptive', overfit, {
    validationType: 'cross-validation',
    folds: k,
    stabilityScore,
    avgTrainSharpe: avgTrainMetrics.sharpe,
    avgTestSharpe: avgTestMetrics.sharpe
  });

  return {
    folds: segments,
    avgTrainMetrics,
    avgTestMetrics,
    stabilityScore,
    overfit
  };
}

/**
 * Run out-of-sample validation on Meta-Adaptive strategy
 */
export async function runOutOfSampleValidation(
  candles: Candle[],
  options: MetaAdaptiveBacktestOptions,
  inSampleRatio: number = 0.7
): Promise<OutOfSampleResult> {
  const { inSample, outOfSample } = createOutOfSampleSplit(candles, inSampleRatio);

  // Run backtest on in-sample data
  const inSampleResult = runMetaAdaptiveBacktest(inSample, options);
  const inSampleMetrics = convertMetrics(inSampleResult.metrics);

  // Run backtest on out-of-sample data
  const outOfSampleResult = runMetaAdaptiveBacktest(outOfSample, options);
  const outOfSampleMetrics = convertMetrics(outOfSampleResult.metrics);

  // Calculate degradation
  const degradationPct = calculateDegradation(inSampleMetrics, outOfSampleMetrics);

  // Determine if degradation is significant
  const isSignificant = degradationPct > 20 || 
    (Math.abs(inSampleMetrics.sharpe - outOfSampleMetrics.sharpe) / Math.max(Math.abs(inSampleMetrics.sharpe), 0.1)) > 0.5;

  // Detect overfitting
  const overfit = detectOverfitting(inSampleMetrics, outOfSampleMetrics);

  // Log results
  logOverfittingEvent('meta-adaptive', overfit, {
    validationType: 'out-of-sample',
    inSampleRatio,
    degradationPct,
    isSignificant,
    inSampleSharpe: inSampleMetrics.sharpe,
    outOfSampleSharpe: outOfSampleMetrics.sharpe,
    inSampleTrades: inSampleMetrics.trades,
    outOfSampleTrades: outOfSampleMetrics.trades
  });

  return {
    inSample: inSampleMetrics,
    outOfSample: outOfSampleMetrics,
    degradationPct,
    isSignificant,
    overfit
  };
}

/**
 * Run comprehensive validation including walk-forward, cross-validation, and out-of-sample
 */
export async function runComprehensiveValidation(
  candles: Candle[],
  options: MetaAdaptiveBacktestOptions
): Promise<{
  overall: BacktestResult;
  walkForward: BacktestResult['walkForward'];
  crossValidation: CrossValidationResult;
  outOfSample: OutOfSampleResult;
  overfittingAnalysis: {
    flags: OverfittingFlags;
    summary: string;
    actionRequired: boolean;
  };
}> {
  console.log('[Validation] Running comprehensive validation for Meta-Adaptive strategy...');

  // 1. Run full backtest with walk-forward
  const overall = runMetaAdaptiveBacktest(candles, options);
  const walkForward = overall.walkForward ?? [];

  // 2. Run cross-validation
  const crossValidation = await runCrossValidation(candles, options, 5);

  // 3. Run out-of-sample validation
  const outOfSample = await runOutOfSampleValidation(candles, options, 0.7);

  // 4. Aggregate overfitting analysis
  const allFlags = [
    ...crossValidation.overfit.flags,
    ...outOfSample.overfit.flags
  ];

  // Find highest severity
  const severities: OverfittingFlags['severity'][] = ['none', 'low', 'medium', 'high', 'critical'];
  const maxSeverity = Math.max(
    severities.indexOf(crossValidation.overfit.severity),
    severities.indexOf(outOfSample.overfit.severity)
  );

  const aggregatedFlags: OverfittingFlags = {
    isOverfitted: crossValidation.overfit.isOverfitted || outOfSample.overfit.isOverfitted,
    severity: severities[maxSeverity],
    flags: allFlags,
    recommendations: Array.from(new Set([
      ...crossValidation.overfit.recommendations,
      ...outOfSample.overfit.recommendations
    ])),
    confidence: Math.max(crossValidation.overfit.confidence, outOfSample.overfit.confidence)
  };

  // Generate summary
  const summary = generateValidationSummary({
    overall: convertMetrics(overall.metrics),
    crossValidation,
    outOfSample,
    overfit: aggregatedFlags
  });

  const actionRequired = aggregatedFlags.severity === 'high' || aggregatedFlags.severity === 'critical';

  // Log comprehensive results
  logOverfittingEvent('meta-adaptive', aggregatedFlags, {
    validationType: 'comprehensive',
    summary,
    actionRequired,
    walkForwardSegments: walkForward.length,
    crossValidationStability: crossValidation.stabilityScore,
    outOfSampleDegradation: outOfSample.degradationPct
  });

  console.log('[Validation] Comprehensive validation complete');
  console.log(`[Validation] Overfitting detected: ${aggregatedFlags.isOverfitted} (severity: ${aggregatedFlags.severity})`);
  console.log(`[Validation] Confidence: ${(aggregatedFlags.confidence * 100).toFixed(1)}%`);
  console.log(`[Validation] Action required: ${actionRequired}`);

  return {
    overall,
    walkForward,
    crossValidation,
    outOfSample,
    overfittingAnalysis: {
      flags: aggregatedFlags,
      summary,
      actionRequired
    }
  };
}

/**
 * Generate human-readable validation summary
 */
function generateValidationSummary(results: {
  overall: PerformanceMetrics;
  crossValidation: CrossValidationResult;
  outOfSample: OutOfSampleResult;
  overfit: OverfittingFlags;
}): string {
  const lines: string[] = [
    '=== Meta-Adaptive Strategy Validation Summary ===',
    '',
    '📊 Overall Performance:',
    `  - Total Return: ${results.overall.totalReturnPct.toFixed(2)}%`,
    `  - Sharpe Ratio: ${results.overall.sharpe.toFixed(2)}`,
    `  - Max Drawdown: ${results.overall.maxDrawdownPct.toFixed(2)}%`,
    `  - Win Rate: ${(results.overall.hitRate * 100).toFixed(1)}%`,
    `  - Trades: ${results.overall.trades}`,
    '',
    '🔄 Cross-Validation (5-fold):',
    `  - Avg Train Sharpe: ${results.crossValidation.avgTrainMetrics.sharpe.toFixed(2)}`,
    `  - Avg Test Sharpe: ${results.crossValidation.avgTestMetrics.sharpe.toFixed(2)}`,
    `  - Stability Score: ${(results.crossValidation.stabilityScore * 100).toFixed(1)}%`,
    '',
    '📈 Out-of-Sample Test:',
    `  - In-Sample Sharpe: ${results.outOfSample.inSample.sharpe.toFixed(2)}`,
    `  - Out-of-Sample Sharpe: ${results.outOfSample.outOfSample.sharpe.toFixed(2)}`,
    `  - Degradation: ${results.outOfSample.degradationPct.toFixed(1)}%`,
    `  - Significant: ${results.outOfSample.isSignificant ? 'Yes' : 'No'}`,
    '',
    '⚠️  Overfitting Analysis:',
    `  - Overfitted: ${results.overfit.isOverfitted ? 'Yes' : 'No'}`,
    `  - Severity: ${results.overfit.severity.toUpperCase()}`,
    `  - Confidence: ${(results.overfit.confidence * 100).toFixed(1)}%`,
    `  - Issues Found: ${results.overfit.flags.length}`,
  ];

  if (results.overfit.flags.length > 0) {
    lines.push('', '🚨 Detected Issues:');
    for (const flag of results.overfit.flags) {
      lines.push(`  - [${flag.severity.toUpperCase()}] ${flag.description}`);
    }
  }

  if (results.overfit.recommendations.length > 0) {
    lines.push('', '💡 Recommendations:');
    for (const rec of results.overfit.recommendations) {
      lines.push(`  - ${rec}`);
    }
  }

  lines.push('', '==============================================');

  return lines.join('\n');
}

/**
 * Monitor live performance and detect degradation
 */
export async function monitorLivePerformance(
  recentMetrics: PerformanceMetrics,
  baselineMetrics: PerformanceMetrics
): Promise<{
  degradation: number;
  flags: OverfittingFlags;
  needsRecalibration: boolean;
}> {
  const degradation = calculateDegradation(baselineMetrics, recentMetrics);
  const flags = detectOverfitting(baselineMetrics, recentMetrics);
  
  const needsRecalibration = 
    degradation > 25 || 
    flags.severity === 'high' || 
    flags.severity === 'critical' ||
    recentMetrics.hitRate < baselineMetrics.hitRate * 0.7;

  if (needsRecalibration) {
    logOverfittingEvent('meta-adaptive', flags, {
      validationType: 'live-monitoring',
      degradation,
      needsRecalibration,
      recentTrades: recentMetrics.trades,
      baselineTrades: baselineMetrics.trades
    });
  }

  return {
    degradation,
    flags,
    needsRecalibration
  };
}
