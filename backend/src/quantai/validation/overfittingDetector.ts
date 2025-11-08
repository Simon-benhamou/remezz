/**
 * Overfitting Detection and Mitigation System
 * 
 * Provides comprehensive tools to detect and mitigate overfitting in Meta-Adaptive strategy results:
 * - Cross-validation segments
 * - Out-of-sample testing
 * - Performance degradation detection
 * - Statistical significance tests
 * - Automated flagging and alerting
 */

import { recordOpsEvent } from '../../monitor/ops.js';

export type ValidationSegment = {
  start: number;
  end: number;
  type: 'train' | 'test' | 'validation';
  metrics: PerformanceMetrics;
};

export type PerformanceMetrics = {
  totalReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  hitRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  trades: number;
  winRateStdDev?: number;
  expectancy?: number;
};

export type OverfittingFlags = {
  isOverfitted: boolean;
  severity: 'none' | 'low' | 'medium' | 'high' | 'critical';
  flags: OverfittingIndicator[];
  recommendations: string[];
  confidence: number; // 0-1
};

export type OverfittingIndicator = {
  type: 'performance_degradation' | 'win_rate_variability' | 'curve_fitting' | 'statistical_insignificance' | 'train_test_divergence' | 'regime_dependency';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  metrics: Record<string, number>;
};

export type CrossValidationResult = {
  folds: ValidationSegment[];
  avgTrainMetrics: PerformanceMetrics;
  avgTestMetrics: PerformanceMetrics;
  stabilityScore: number; // 0-1, higher is better
  overfit: OverfittingFlags;
};

export type OutOfSampleResult = {
  inSample: PerformanceMetrics;
  outOfSample: PerformanceMetrics;
  degradationPct: number;
  isSignificant: boolean;
  overfit: OverfittingFlags;
};

export type RecalibrationSignal = {
  shouldRecalibrate: boolean;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  metrics: {
    recentPerformance: PerformanceMetrics;
    historicalPerformance: PerformanceMetrics;
    degradationPct: number;
  };
};

/**
 * Split data into K folds for cross-validation
 */
export function createCrossValidationFolds<T extends { timestamp: number }>(
  data: T[],
  k: number = 5,
  trainRatio: number = 0.8
): Array<{ train: T[]; test: T[] }> {
  if (k < 2) {
    throw new Error('Number of folds must be at least 2');
  }
  if (trainRatio <= 0 || trainRatio >= 1) {
    throw new Error('Train ratio must be between 0 and 1');
  }

  const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);
  const foldSize = Math.floor(sortedData.length / k);
  const folds: Array<{ train: T[]; test: T[] }> = [];

  for (let i = 0; i < k; i++) {
    const testStart = i * foldSize;
    const testEnd = i === k - 1 ? sortedData.length : (i + 1) * foldSize;
    
    const test = sortedData.slice(testStart, testEnd);
    const train = [
      ...sortedData.slice(0, testStart),
      ...sortedData.slice(testEnd)
    ];

    folds.push({ train, test });
  }

  return folds;
}

/**
 * Split data into in-sample and out-of-sample sets
 */
export function createOutOfSampleSplit<T extends { timestamp: number }>(
  data: T[],
  inSampleRatio: number = 0.7
): { inSample: T[]; outOfSample: T[] } {
  if (inSampleRatio <= 0 || inSampleRatio >= 1) {
    throw new Error('In-sample ratio must be between 0 and 1');
  }

  const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);
  const splitIndex = Math.floor(sortedData.length * inSampleRatio);

  return {
    inSample: sortedData.slice(0, splitIndex),
    outOfSample: sortedData.slice(splitIndex)
  };
}

/**
 * Calculate performance degradation between two periods
 */
export function calculateDegradation(
  baseline: PerformanceMetrics,
  current: PerformanceMetrics
): number {
  // Weight different metrics for overall degradation score
  const sharpeChange = baseline.sharpe !== 0 
    ? ((current.sharpe - baseline.sharpe) / Math.abs(baseline.sharpe)) * 100 
    : 0;
  
  const returnChange = baseline.totalReturnPct !== 0
    ? ((current.totalReturnPct - baseline.totalReturnPct) / Math.abs(baseline.totalReturnPct)) * 100
    : 0;
  
  const hitRateChange = baseline.hitRate !== 0
    ? ((current.hitRate - baseline.hitRate) / baseline.hitRate) * 100
    : 0;

  const drawdownChange = baseline.maxDrawdownPct !== 0
    ? ((current.maxDrawdownPct - baseline.maxDrawdownPct) / baseline.maxDrawdownPct) * 100
    : 0;

  // Weighted average (negative means degradation)
  const degradation = (
    sharpeChange * 0.3 +
    returnChange * 0.25 +
    hitRateChange * 0.25 -
    drawdownChange * 0.2 // Drawdown increase is bad
  );

  return -degradation; // Convert to positive = bad
}

/**
 * Calculate win rate stability across segments
 */
export function calculateWinRateStability(segments: ValidationSegment[]): number {
  if (segments.length < 2) return 1.0;

  const winRates = segments.map(s => s.metrics.hitRate).filter(wr => Number.isFinite(wr));
  if (winRates.length < 2) return 1.0;

  const mean = winRates.reduce((sum, wr) => sum + wr, 0) / winRates.length;
  const variance = winRates.reduce((sum, wr) => sum + Math.pow(wr - mean, 2), 0) / winRates.length;
  const stdDev = Math.sqrt(variance);

  // Coefficient of variation (lower is better, more stable)
  const cv = mean !== 0 ? stdDev / mean : 1;
  
  // Convert to stability score (0-1, higher is better)
  // CV > 0.5 is considered unstable
  return Math.max(0, Math.min(1, 1 - (cv / 0.5)));
}

/**
 * Detect overfitting indicators from validation results
 */
export function detectOverfitting(
  trainMetrics: PerformanceMetrics,
  testMetrics: PerformanceMetrics,
  segments?: ValidationSegment[]
): OverfittingFlags {
  const flags: OverfittingIndicator[] = [];
  let maxSeverity: OverfittingFlags['severity'] = 'none';

  // 1. Performance Degradation (train vs test)
  const degradation = calculateDegradation(trainMetrics, testMetrics);
  if (degradation > 15) {
    const severity = degradation > 40 ? 'critical' : degradation > 30 ? 'high' : degradation > 20 ? 'medium' : 'low';
    flags.push({
      type: 'performance_degradation',
      severity,
      description: `Test performance is ${degradation.toFixed(1)}% worse than training performance`,
      metrics: {
        degradationPct: degradation,
        trainSharpe: trainMetrics.sharpe,
        testSharpe: testMetrics.sharpe,
        trainReturn: trainMetrics.totalReturnPct,
        testReturn: testMetrics.totalReturnPct
      }
    });
    if (compareSeverity(severity, maxSeverity) > 0) maxSeverity = severity;
  }

  // 2. Win Rate Variability
  if (segments && segments.length >= 3) {
    const stability = calculateWinRateStability(segments);
    if (stability < 0.6) {
      const severity = stability < 0.3 ? 'high' : stability < 0.45 ? 'medium' : 'low';
      const winRates = segments.map(s => s.metrics.hitRate);
      flags.push({
        type: 'win_rate_variability',
        severity,
        description: `Win rate shows high variability across segments (stability: ${(stability * 100).toFixed(1)}%)`,
        metrics: {
          stabilityScore: stability,
          winRateCount: winRates.length,
          winRateMin: Math.min(...winRates),
          winRateMax: Math.max(...winRates)
        }
      });
      if (compareSeverity(severity, maxSeverity) > 0) maxSeverity = severity;
    }
  }

  // 3. Curve Fitting Detection (excessive optimization)
  if (trainMetrics.sharpe > 3.0 && testMetrics.sharpe < 1.5) {
    const severity = testMetrics.sharpe < 0.5 ? 'critical' : testMetrics.sharpe < 1.0 ? 'high' : 'medium';
    flags.push({
      type: 'curve_fitting',
      severity,
      description: 'Training Sharpe ratio is unrealistically high compared to test performance',
      metrics: {
        trainSharpe: trainMetrics.sharpe,
        testSharpe: testMetrics.sharpe,
        ratio: trainMetrics.sharpe / Math.max(testMetrics.sharpe, 0.1)
      }
    });
    if (compareSeverity(severity, maxSeverity) > 0) maxSeverity = severity;
  }

  // 4. Statistical Insignificance (too few trades)
  if (testMetrics.trades < 20) {
    const severity = testMetrics.trades < 10 ? 'high' : testMetrics.trades < 15 ? 'medium' : 'low';
    flags.push({
      type: 'statistical_insignificance',
      severity,
      description: `Insufficient test trades (${testMetrics.trades}) for statistical significance`,
      metrics: {
        testTrades: testMetrics.trades,
        minRecommended: 30
      }
    });
    if (compareSeverity(severity, maxSeverity) > 0) maxSeverity = severity;
  }

  // 5. Train-Test Divergence
  const sharpeRatio = trainMetrics.sharpe !== 0 
    ? Math.abs((trainMetrics.sharpe - testMetrics.sharpe) / trainMetrics.sharpe) 
    : 0;
  if (sharpeRatio > 0.5) {
    const severity = sharpeRatio > 0.8 ? 'high' : sharpeRatio > 0.65 ? 'medium' : 'low';
    flags.push({
      type: 'train_test_divergence',
      severity,
      description: `Large divergence between train and test Sharpe ratios (${(sharpeRatio * 100).toFixed(1)}%)`,
      metrics: {
        divergencePct: sharpeRatio * 100,
        trainSharpe: trainMetrics.sharpe,
        testSharpe: testMetrics.sharpe
      }
    });
    if (compareSeverity(severity, maxSeverity) > 0) maxSeverity = severity;
  }

  // Generate recommendations
  const recommendations = generateRecommendations(flags);

  // Calculate confidence in overfitting detection
  const confidence = calculateOverfittingConfidence(flags, trainMetrics, testMetrics);

  return {
    isOverfitted: flags.length > 0 && (maxSeverity === 'high' || maxSeverity === 'critical' || flags.length >= 3),
    severity: maxSeverity,
    flags,
    recommendations,
    confidence
  };
}

/**
 * Compare severity levels
 */
function compareSeverity(a: OverfittingFlags['severity'], b: OverfittingFlags['severity']): number {
  const order: Record<OverfittingFlags['severity'], number> = {
    'none': 0,
    'low': 1,
    'medium': 2,
    'high': 3,
    'critical': 4
  };
  return order[a] - order[b];
}

/**
 * Generate recommendations based on detected issues
 */
function generateRecommendations(flags: OverfittingIndicator[]): string[] {
  const recommendations: string[] = [];

  for (const flag of flags) {
    switch (flag.type) {
      case 'performance_degradation':
        recommendations.push('Reduce model complexity or increase regularization');
        recommendations.push('Expand training data to cover more market regimes');
        break;
      case 'win_rate_variability':
        recommendations.push('Implement regime-aware strategy selection');
        recommendations.push('Add filters to avoid unfavorable market conditions');
        break;
      case 'curve_fitting':
        recommendations.push('Simplify strategy rules and reduce parameters');
        recommendations.push('Implement walk-forward optimization with shorter windows');
        break;
      case 'statistical_insignificance':
        recommendations.push('Collect more data or extend backtest period');
        recommendations.push('Use Monte Carlo simulation to assess robustness');
        break;
      case 'train_test_divergence':
        recommendations.push('Review strategy for market regime dependencies');
        recommendations.push('Implement dynamic parameter adjustment');
        break;
      case 'regime_dependency':
        recommendations.push('Add regime classification and regime-specific strategies');
        recommendations.push('Implement performance tracking by regime');
        break;
    }
  }

  // Remove duplicates
  return Array.from(new Set(recommendations));
}

/**
 * Calculate confidence in overfitting detection
 */
function calculateOverfittingConfidence(
  flags: OverfittingIndicator[],
  trainMetrics: PerformanceMetrics,
  testMetrics: PerformanceMetrics
): number {
  if (flags.length === 0) return 0.0;

  let confidence = 0.0;
  const weights: Record<OverfittingIndicator['type'], number> = {
    'performance_degradation': 0.3,
    'curve_fitting': 0.25,
    'train_test_divergence': 0.2,
    'win_rate_variability': 0.15,
    'statistical_insignificance': 0.05,
    'regime_dependency': 0.05
  };

  for (const flag of flags) {
    const severityMultiplier = flag.severity === 'critical' ? 1.0 
      : flag.severity === 'high' ? 0.8 
      : flag.severity === 'medium' ? 0.6 
      : 0.4;
    
    confidence += (weights[flag.type] || 0.1) * severityMultiplier;
  }

  // Additional confidence from trade sample size
  const sampleConfidence = Math.min(1.0, testMetrics.trades / 30);
  confidence *= (0.7 + 0.3 * sampleConfidence);

  return Math.min(1.0, confidence);
}

/**
 * Check if recalibration is needed based on recent performance
 */
export function checkRecalibrationNeeded(
  recentMetrics: PerformanceMetrics,
  historicalMetrics: PerformanceMetrics,
  thresholds: {
    degradationThreshold?: number;
    minTrades?: number;
  } = {}
): RecalibrationSignal {
  const degradationThreshold = thresholds.degradationThreshold ?? 20;
  const minTrades = thresholds.minTrades ?? 10;

  if (recentMetrics.trades < minTrades) {
    return {
      shouldRecalibrate: false,
      reason: 'Insufficient recent trades for recalibration assessment',
      urgency: 'low',
      metrics: {
        recentPerformance: recentMetrics,
        historicalPerformance: historicalMetrics,
        degradationPct: 0
      }
    };
  }

  const degradation = calculateDegradation(historicalMetrics, recentMetrics);

  if (degradation > degradationThreshold) {
    const urgency = degradation > 40 ? 'high' : degradation > 30 ? 'medium' : 'low';
    return {
      shouldRecalibrate: true,
      reason: `Performance degraded by ${degradation.toFixed(1)}% compared to historical baseline`,
      urgency,
      metrics: {
        recentPerformance: recentMetrics,
        historicalPerformance: historicalMetrics,
        degradationPct: degradation
      }
    };
  }

  // Check for significant drawdown increase
  const drawdownIncrease = recentMetrics.maxDrawdownPct - historicalMetrics.maxDrawdownPct;
  if (drawdownIncrease > 10) {
    return {
      shouldRecalibrate: true,
      reason: `Maximum drawdown increased by ${drawdownIncrease.toFixed(1)}%`,
      urgency: drawdownIncrease > 20 ? 'high' : 'medium',
      metrics: {
        recentPerformance: recentMetrics,
        historicalPerformance: historicalMetrics,
        degradationPct: degradation
      }
    };
  }

  // Check for win rate collapse
  const winRateDrop = historicalMetrics.hitRate - recentMetrics.hitRate;
  if (winRateDrop > 0.15) {
    return {
      shouldRecalibrate: true,
      reason: `Win rate dropped by ${(winRateDrop * 100).toFixed(1)}%`,
      urgency: winRateDrop > 0.25 ? 'high' : 'medium',
      metrics: {
        recentPerformance: recentMetrics,
        historicalPerformance: historicalMetrics,
        degradationPct: degradation
      }
    };
  }

  return {
    shouldRecalibrate: false,
    reason: 'Performance within acceptable range',
    urgency: 'low',
    metrics: {
      recentPerformance: recentMetrics,
      historicalPerformance: historicalMetrics,
      degradationPct: degradation
    }
  };
}

/**
 * Log overfitting detection event
 */
export function logOverfittingEvent(
  strategy: string,
  flags: OverfittingFlags,
  context: Record<string, any> = {}
): void {
  recordOpsEvent({
    source: 'overfitting_detection',
    message: `Overfitting detection for ${strategy}: ${flags.isOverfitted ? 'DETECTED' : 'CLEAR'}`,
    level: flags.severity === 'critical' ? 'error' : flags.severity === 'high' ? 'warn' : 'info',
    details: {
      strategy,
      isOverfitted: flags.isOverfitted,
      severity: flags.severity,
      flagCount: flags.flags.length,
      confidence: flags.confidence,
      ...context
    }
  });

  if (flags.severity === 'high' || flags.severity === 'critical') {
    recordOpsEvent({
      source: 'overfitting_alert',
      message: `ALERT: ${strategy} shows ${flags.severity} severity overfitting`,
      level: 'error',
      details: {
        strategy,
        severity: flags.severity,
        flags: flags.flags.map(f => ({ type: f.type, severity: f.severity, description: f.description })),
        recommendations: flags.recommendations,
        ...context
      }
    });
  }
}
