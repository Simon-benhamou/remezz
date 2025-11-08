/**
 * Overfitting Detection Unit Tests
 * 
 * Tests the core logic of overfitting detection and validation
 */

import assert from 'node:assert/strict';
import {
  createCrossValidationFolds,
  createOutOfSampleSplit,
  calculateDegradation,
  calculateWinRateStability,
  detectOverfitting,
  checkRecalibrationNeeded,
  type PerformanceMetrics,
  type ValidationSegment
} from '../../src/quantai/validation/overfittingDetector.js';

console.log('\n🧪 Testing Overfitting Detection System...\n');

// Test data helpers
const createMockCandles = (count: number): Array<{ timestamp: number }> => {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1700000000000 + i * 60000
  }));
};

const createMockMetrics = (overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics => ({
  totalReturnPct: 10.0,
  sharpe: 1.5,
  maxDrawdownPct: 5.0,
  hitRate: 0.55,
  profitFactor: 1.8,
  avgWin: 100,
  avgLoss: -60,
  trades: 50,
  ...overrides
});

// Test 1: Cross-validation fold creation
console.log('🧪 Test 1: Cross-validation fold creation');
{
  const candles = createMockCandles(100);
  const folds = createCrossValidationFolds(candles, 5);
  
  assert.equal(folds.length, 5, 'Should create 5 folds');
  assert.ok(folds.every(fold => fold.train.length > 0), 'All folds should have training data');
  assert.ok(folds.every(fold => fold.test.length > 0), 'All folds should have test data');
  
  // Check that timestamps are in order
  for (const fold of folds) {
    const trainTimestamps = fold.train.map(c => c.timestamp);
    const testTimestamps = fold.test.map(c => c.timestamp);
    assert.ok(trainTimestamps.every((t, i) => i === 0 || t >= trainTimestamps[i - 1]), 'Train data should be chronological');
    assert.ok(testTimestamps.every((t, i) => i === 0 || t >= testTimestamps[i - 1]), 'Test data should be chronological');
  }
  
  console.log('✅ Cross-validation fold creation tests passed');
}

// Test 2: Out-of-sample split
console.log('\n🧪 Test 2: Out-of-sample split');
{
  const candles = createMockCandles(100);
  const { inSample, outOfSample } = createOutOfSampleSplit(candles, 0.7);
  
  assert.equal(inSample.length, 70, 'In-sample should be 70% of data');
  assert.equal(outOfSample.length, 30, 'Out-of-sample should be 30% of data');
  assert.ok(
    inSample[inSample.length - 1].timestamp < outOfSample[0].timestamp,
    'Out-of-sample should come after in-sample chronologically'
  );
  
  console.log('✅ Out-of-sample split tests passed');
}

// Test 3: Degradation calculation
console.log('\n🧪 Test 3: Performance degradation calculation');
{
  const baseline = createMockMetrics({ sharpe: 2.0, hitRate: 0.6, totalReturnPct: 20 });
  
  // No degradation
  const current1 = createMockMetrics({ sharpe: 2.0, hitRate: 0.6, totalReturnPct: 20 });
  const deg1 = calculateDegradation(baseline, current1);
  assert.ok(Math.abs(deg1) < 1, 'Should show minimal degradation for identical metrics');
  
  // Moderate degradation
  const current2 = createMockMetrics({ sharpe: 1.5, hitRate: 0.5, totalReturnPct: 15 });
  const deg2 = calculateDegradation(baseline, current2);
  assert.ok(deg2 > 10, 'Should detect moderate degradation');
  
  // Severe degradation
  const current3 = createMockMetrics({ sharpe: 0.5, hitRate: 0.4, totalReturnPct: 5 });
  const deg3 = calculateDegradation(baseline, current3);
  assert.ok(deg3 > 30, 'Should detect severe degradation');
  assert.ok(deg3 > deg2, 'Severe degradation should be > moderate degradation');
  
  console.log('✅ Degradation calculation tests passed');
}

// Test 4: Win rate stability
console.log('\n🧪 Test 4: Win rate stability calculation');
{
  // Stable win rates
  const stableSegments: ValidationSegment[] = [
    { start: 0, end: 1000, type: 'test', metrics: createMockMetrics({ hitRate: 0.55 }) },
    { start: 1000, end: 2000, type: 'test', metrics: createMockMetrics({ hitRate: 0.56 }) },
    { start: 2000, end: 3000, type: 'test', metrics: createMockMetrics({ hitRate: 0.54 }) },
  ];
  const stableScore = calculateWinRateStability(stableSegments);
  assert.ok(stableScore > 0.8, 'Stable win rates should score high');
  
  // Variable win rates
  const variableSegments: ValidationSegment[] = [
    { start: 0, end: 1000, type: 'test', metrics: createMockMetrics({ hitRate: 0.7 }) },
    { start: 1000, end: 2000, type: 'test', metrics: createMockMetrics({ hitRate: 0.3 }) },
    { start: 2000, end: 3000, type: 'test', metrics: createMockMetrics({ hitRate: 0.6 }) },
  ];
  const variableScore = calculateWinRateStability(variableSegments);
  assert.ok(variableScore < 0.5, 'Variable win rates should score low');
  assert.ok(variableScore < stableScore, 'Variable score should be < stable score');
  
  console.log('✅ Win rate stability tests passed');
}

// Test 5: Overfitting detection
console.log('\n🧪 Test 5: Overfitting detection');
{
  // No overfitting - similar performance
  const train1 = createMockMetrics({ sharpe: 1.5, hitRate: 0.55, totalReturnPct: 15 });
  const test1 = createMockMetrics({ sharpe: 1.4, hitRate: 0.53, totalReturnPct: 14, trades: 30 });
  const result1 = detectOverfitting(train1, test1);
  assert.equal(result1.isOverfitted, false, 'Should not detect overfitting for similar metrics');
  assert.equal(result1.severity, 'none', 'Severity should be none');
  
  // Performance degradation
  const train2 = createMockMetrics({ sharpe: 2.5, hitRate: 0.65, totalReturnPct: 30 });
  const test2 = createMockMetrics({ sharpe: 1.0, hitRate: 0.45, totalReturnPct: 10, trades: 30 });
  const result2 = detectOverfitting(train2, test2);
  assert.equal(result2.isOverfitted, true, 'Should detect overfitting with significant degradation');
  assert.ok(result2.flags.some(f => f.type === 'performance_degradation'), 'Should flag performance degradation');
  
  // Curve fitting
  const train3 = createMockMetrics({ sharpe: 4.0, hitRate: 0.75, totalReturnPct: 50 });
  const test3 = createMockMetrics({ sharpe: 0.8, hitRate: 0.48, totalReturnPct: 5, trades: 30 });
  const result3 = detectOverfitting(train3, test3);
  assert.equal(result3.isOverfitted, true, 'Should detect curve fitting');
  assert.ok(result3.flags.some(f => f.type === 'curve_fitting'), 'Should flag curve fitting');
  assert.ok(['high', 'critical'].includes(result3.severity), 'Curve fitting should be high/critical severity');
  
  // Statistical insignificance
  const train4 = createMockMetrics({ sharpe: 1.5, trades: 100 });
  const test4 = createMockMetrics({ sharpe: 1.4, trades: 8 });
  const result4 = detectOverfitting(train4, test4);
  assert.ok(result4.flags.some(f => f.type === 'statistical_insignificance'), 'Should flag insufficient trades');
  
  // Check recommendations
  assert.ok(result2.recommendations.length > 0, 'Should provide recommendations');
  assert.ok(result2.confidence > 0 && result2.confidence <= 1, 'Confidence should be 0-1');
  
  console.log('✅ Overfitting detection tests passed');
}

// Test 6: Recalibration signal
console.log('\n🧪 Test 6: Recalibration signal detection');
{
  const historical = createMockMetrics({ sharpe: 2.0, hitRate: 0.6, maxDrawdownPct: 5, trades: 100 });
  
  // No recalibration needed
  const recent1 = createMockMetrics({ sharpe: 1.9, hitRate: 0.58, maxDrawdownPct: 6, trades: 15 });
  const signal1 = checkRecalibrationNeeded(recent1, historical);
  assert.equal(signal1.shouldRecalibrate, false, 'Should not require recalibration for minor changes');
  
  // Performance degradation
  const recent2 = createMockMetrics({ sharpe: 1.0, hitRate: 0.45, maxDrawdownPct: 8, trades: 20 });
  const signal2 = checkRecalibrationNeeded(recent2, historical);
  assert.equal(signal2.shouldRecalibrate, true, 'Should require recalibration for degradation');
  assert.ok(signal2.metrics.degradationPct > 15, 'Should report degradation percentage');
  
  // Win rate collapse
  const recent3 = createMockMetrics({ sharpe: 1.8, hitRate: 0.4, maxDrawdownPct: 6, trades: 25 });
  const signal3 = checkRecalibrationNeeded(recent3, historical);
  assert.equal(signal3.shouldRecalibrate, true, 'Should require recalibration for win rate collapse');
  assert.ok(signal3.reason.includes('Win rate'), 'Reason should mention win rate');
  
  // Drawdown increase (keep other metrics identical to avoid degradation trigger)
  const recent4 = createMockMetrics({ sharpe: 2.0, hitRate: 0.6, totalReturnPct: 20, maxDrawdownPct: 20, trades: 20 });
  const signal4 = checkRecalibrationNeeded(recent4, historical, { degradationThreshold: 70 }); // High threshold to avoid degradation trigger
  assert.equal(signal4.shouldRecalibrate, true, 'Should require recalibration for increased drawdown');
  assert.ok(signal4.reason.toLowerCase().includes('drawdown'), `Reason should mention drawdown, got: ${signal4.reason}`);
  
  // Insufficient data
  const recent5 = createMockMetrics({ sharpe: 0.5, hitRate: 0.3, trades: 5 });
  const signal5 = checkRecalibrationNeeded(recent5, historical);
  assert.equal(signal5.shouldRecalibrate, false, 'Should not recalibrate with insufficient trades');
  
  console.log('✅ Recalibration signal tests passed');
}

// Test 7: Edge cases
console.log('\n🧪 Test 7: Edge cases');
{
  // Zero trades
  const train = createMockMetrics({ trades: 0 });
  const test = createMockMetrics({ trades: 0 });
  const result = detectOverfitting(train, test);
  assert.ok(result.flags.length > 0, 'Should flag zero trades');
  
  // Extreme values
  const trainExtreme = createMockMetrics({ sharpe: 10, hitRate: 0.95, totalReturnPct: 200 });
  const testExtreme = createMockMetrics({ sharpe: -0.5, hitRate: 0.2, totalReturnPct: -50, trades: 30 });
  const resultExtreme = detectOverfitting(trainExtreme, testExtreme);
  assert.equal(resultExtreme.severity, 'critical', 'Should flag extreme divergence as critical');
  
  // Empty segments
  const emptySegments: ValidationSegment[] = [];
  const stabilityEmpty = calculateWinRateStability(emptySegments);
  assert.equal(stabilityEmpty, 1.0, 'Empty segments should return max stability (no data)');
  
  console.log('✅ Edge case tests passed');
}

console.log('\n✅ All overfitting detection tests passed!\n');
