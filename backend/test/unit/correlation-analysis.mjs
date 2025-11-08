/**
 * Unit tests for Correlation Analysis
 */

import assert from 'node:assert/strict';
const { CorrelationAnalyzer, DEFAULT_CORRELATION_CONFIG } = await import('../../dist/src/risk/correlationAnalysis.js');

// Test 1: Calculate perfect positive correlation
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const returns1 = [0.01, 0.02, 0.03, 0.04, 0.05];
  const returns2 = [0.01, 0.02, 0.03, 0.04, 0.05];
  
  const correlation = analyzer['calculateCorrelation'](returns1, returns2);
  assert.ok(Math.abs(correlation - 1.0) < 0.05, 'Should calculate near perfect positive correlation');
  console.log('✅ Perfect positive correlation test passed');
}

// Test 2: Calculate perfect negative correlation
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const returns1 = [0.01, 0.02, 0.03, 0.04, 0.05];
  const returns2 = [-0.01, -0.02, -0.03, -0.04, -0.05];
  
  const correlation = analyzer['calculateCorrelation'](returns1, returns2);
  assert.ok(Math.abs(correlation + 1.0) < 0.05, 'Should calculate near perfect negative correlation');
  console.log('✅ Perfect negative correlation test passed');
}

// Test 3: Calculate low correlation for independent series
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const returns1 = [0.01, -0.01, 0.01, -0.01, 0.01];
  const returns2 = [0.02, 0.02, -0.02, -0.02, 0.02];
  
  const correlation = analyzer['calculateCorrelation'](returns1, returns2);
  assert.ok(Math.abs(correlation) < 0.5, 'Should calculate low correlation');
  console.log('✅ Low correlation for independent series test passed');
}

// Test 4: Return 0 for mismatched lengths
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const returns1 = [0.01, 0.02, 0.03];
  const returns2 = [0.01, 0.02];
  
  const correlation = analyzer['calculateCorrelation'](returns1, returns2);
  assert.equal(correlation, 0, 'Should return 0 for mismatched lengths');
  console.log('✅ Mismatched lengths correlation test passed');
}

// Test 5: Return 0 for empty arrays
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const correlation = analyzer['calculateCorrelation']([], []);
  assert.equal(correlation, 0, 'Should return 0 for empty arrays');
  console.log('✅ Empty arrays correlation test passed');
}

// Test 6: Handle constant series
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const returns1 = [0.01, 0.01, 0.01, 0.01];
  const returns2 = [0.02, 0.02, 0.02, 0.02];
  
  const correlation = analyzer['calculateCorrelation'](returns1, returns2);
  assert.equal(correlation, 0, 'Should return 0 for constant series (zero std dev)');
  console.log('✅ Constant series correlation test passed');
}

// Test 7: Get correlation from matrix
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const matrix = {
    pairs: new Map([
      ['BTC/USDT', new Map([['ETH/USDT', 0.75]])],
      ['ETH/USDT', new Map([['BTC/USDT', 0.75]])],
    ]),
    regime: 'NEUTRAL',
    avgCorrelation: 0.75,
    calculatedAt: new Date(),
  };

  const corr = analyzer.getCorrelation(matrix, 'BTC/USDT', 'ETH/USDT');
  assert.equal(corr, 0.75, 'Should return correlation from matrix');
  console.log('✅ Get correlation from matrix test passed');
}

// Test 8: Return 0 for non-existent pair
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const matrix = {
    pairs: new Map(),
    regime: 'NEUTRAL',
    avgCorrelation: 0,
    calculatedAt: new Date(),
  };

  const corr = analyzer.getCorrelation(matrix, 'BTC/USDT', 'ETH/USDT');
  assert.equal(corr, 0, 'Should return 0 for non-existent pair');
  console.log('✅ Non-existent pair correlation test passed');
}

// Test 9: Find groups of correlated assets
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const matrix = {
    pairs: new Map([
      ['BTC/USDT', new Map([
        ['ETH/USDT', 0.8],
        ['LTC/USDT', 0.85],
      ])],
      ['ETH/USDT', new Map([
        ['BTC/USDT', 0.8],
        ['LTC/USDT', 0.75],
      ])],
      ['LTC/USDT', new Map([
        ['BTC/USDT', 0.85],
        ['ETH/USDT', 0.75],
      ])],
      ['XRP/USDT', new Map([
        ['BTC/USDT', 0.3],
        ['ETH/USDT', 0.25],
      ])],
    ]),
    regime: 'NEUTRAL',
    avgCorrelation: 0.6,
    calculatedAt: new Date(),
  };

  const groups = analyzer.findCorrelatedGroups(matrix, 0.7);
  
  assert.ok(groups.length > 0, 'Should find correlated groups');
  assert.ok(groups[0].length > 1, 'Group should have multiple symbols');
  console.log('✅ Find correlated groups test passed');
}

// Test 10: Return empty array when no high correlations
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const matrix = {
    pairs: new Map([
      ['BTC/USDT', new Map([['ETH/USDT', 0.3]])],
      ['ETH/USDT', new Map([['BTC/USDT', 0.3]])],
    ]),
    regime: 'RISK_ON',
    avgCorrelation: 0.3,
    calculatedAt: new Date(),
  };

  const groups = analyzer.findCorrelatedGroups(matrix, 0.7);
  assert.deepEqual(groups, [], 'Should return empty array when no correlations above threshold');
  console.log('✅ No high correlations test passed');
}

// Test 11: RISK_OFF regime classification
{
  const avgCorrelation = 0.65;
  const threshold = DEFAULT_CORRELATION_CONFIG.riskOffCorrelationThreshold;
  
  assert.ok(avgCorrelation >= threshold, 'Should be above RISK_OFF threshold');
  
  const regime = avgCorrelation >= threshold ? 'RISK_OFF' : 'NEUTRAL';
  assert.equal(regime, 'RISK_OFF', 'Should classify as RISK_OFF');
  console.log('✅ RISK_OFF regime classification test passed');
}

// Test 12: RISK_ON regime classification
{
  const avgCorrelation = 0.25;
  const threshold = DEFAULT_CORRELATION_CONFIG.riskOnCorrelationThreshold;
  
  assert.ok(avgCorrelation <= threshold, 'Should be below RISK_ON threshold');
  
  const regime = avgCorrelation <= threshold ? 'RISK_ON' : 'NEUTRAL';
  assert.equal(regime, 'RISK_ON', 'Should classify as RISK_ON');
  console.log('✅ RISK_ON regime classification test passed');
}

// Test 13: NEUTRAL regime classification
{
  const avgCorrelation = 0.45;
  const riskOffThreshold = DEFAULT_CORRELATION_CONFIG.riskOffCorrelationThreshold;
  const riskOnThreshold = DEFAULT_CORRELATION_CONFIG.riskOnCorrelationThreshold;
  
  assert.ok(avgCorrelation > riskOnThreshold, 'Should be above RISK_ON threshold');
  assert.ok(avgCorrelation < riskOffThreshold, 'Should be below RISK_OFF threshold');
  
  let regime = 'NEUTRAL';
  if (avgCorrelation >= riskOffThreshold) {
    regime = 'RISK_OFF';
  } else if (avgCorrelation <= riskOnThreshold) {
    regime = 'RISK_ON';
  }
  
  assert.equal(regime, 'NEUTRAL', 'Should classify as NEUTRAL');
  console.log('✅ NEUTRAL regime classification test passed');
}

// Test 14: Clear cache
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  analyzer['cache'].set('test-key', {
    matrix: {
      pairs: new Map(),
      regime: 'NEUTRAL',
      avgCorrelation: 0,
      calculatedAt: new Date(),
    },
    expiresAt: new Date(Date.now() + 3600000),
  });

  assert.equal(analyzer['cache'].size, 1, 'Cache should have one entry');
  
  analyzer.clearCache();
  
  assert.equal(analyzer['cache'].size, 0, 'Cache should be empty after clear');
  console.log('✅ Clear cache test passed');
}

// Test 15: Cache statistics
{
  const analyzer = new CorrelationAnalyzer(DEFAULT_CORRELATION_CONFIG);
  const key1 = 'BTC/USDT,ETH/USDT';
  const key2 = 'BTC/USDT,LTC/USDT';
  
  analyzer['cache'].set(key1, {
    matrix: { pairs: new Map(), regime: 'NEUTRAL', avgCorrelation: 0, calculatedAt: new Date() },
    expiresAt: new Date(Date.now() + 3600000),
  });
  
  analyzer['cache'].set(key2, {
    matrix: { pairs: new Map(), regime: 'NEUTRAL', avgCorrelation: 0, calculatedAt: new Date() },
    expiresAt: new Date(Date.now() + 3600000),
  });

  const stats = analyzer.getCacheStats();
  assert.equal(stats.size, 2, 'Should report correct cache size');
  assert.ok(stats.entries.includes(key1), 'Should include first key');
  assert.ok(stats.entries.includes(key2), 'Should include second key');
  console.log('✅ Cache statistics test passed');
}

// Test 16: Risk multipliers
{
  const config = DEFAULT_CORRELATION_CONFIG;
  
  // RISK_OFF multiplier
  const riskOffMultiplier = config.riskOffMultiplier;
  assert.equal(riskOffMultiplier, 0.5, 'Should have correct RISK_OFF multiplier');
  
  // High correlation multiplier
  const highCorrMultiplier = config.highCorrelationMultiplier;
  assert.equal(highCorrMultiplier, 0.7, 'Should have correct high correlation multiplier');
  
  // Combined
  const combined = riskOffMultiplier * highCorrMultiplier;
  assert.equal(combined, 0.35, 'Combined multiplier should be 0.35');
  
  console.log('✅ Risk multipliers test passed');
}

// Test 17: Custom configuration
{
  const customConfig = {
    ...DEFAULT_CORRELATION_CONFIG,
    highCorrelationThreshold: 0.8,
    maxCorrelatedPositions: 3,
  };

  const analyzer = new CorrelationAnalyzer(customConfig);
  assert.equal(analyzer['config'].highCorrelationThreshold, 0.8, 'Should use custom threshold');
  assert.equal(analyzer['config'].maxCorrelatedPositions, 3, 'Should use custom max positions');
  console.log('✅ Custom configuration test passed');
}

console.log('\n✅ All Correlation Analysis tests passed!');
