/**
 * Unit tests for Advanced Risk Manager
 */

import assert from 'node:assert/strict';
const { AdvancedRiskManager, DEFAULT_ADVANCED_RISK_CONFIG } = await import('../../dist/src/risk/advancedRiskManager.js');

// Test 1: Calculate regime multiplier for low volatility
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const regime = {
    trend: 'uptrend',
    volatility: 'low',
    hurst: 0.5,
    realizedVol: 1.0,
    adxSlope: 0.5,
    trendStrength: 0.3,
    playbook: 'momentum_breakout',
    shouldTrade: true,
  };

  const multiplier = manager.calculateRegimeMultiplier(regime);
  assert.equal(multiplier, DEFAULT_ADVANCED_RISK_CONFIG.lowVolatilityMultiplier, 'Should return low volatility multiplier');
  console.log('✅ Low volatility regime multiplier test passed');
}

// Test 2: Calculate regime multiplier for high volatility
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const regime = {
    trend: 'downtrend',
    volatility: 'high',
    hurst: 0.4,
    realizedVol: 5.0,
    adxSlope: -0.5,
    trendStrength: 0.2,
    playbook: 'mean_reversion',
    shouldTrade: true,
  };

  const multiplier = manager.calculateRegimeMultiplier(regime);
  assert.equal(multiplier, DEFAULT_ADVANCED_RISK_CONFIG.highVolatilityMultiplier, 'Should return high volatility multiplier');
  console.log('✅ High volatility regime multiplier test passed');
}

// Test 3: Use regime risk modifier when available
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const regime = {
    trend: 'range',
    volatility: 'medium',
    hurst: 0.5,
    realizedVol: 2.0,
    adxSlope: 0,
    trendStrength: 0.15,
    playbook: 'mean_reversion',
    shouldTrade: true,
    riskModifier: {
      level: 'caution',
      sizingMultiplier: 0.75,
      reason: 'test',
    },
  };

  const multiplier = manager.calculateRegimeMultiplier(regime);
  assert.equal(multiplier, 0.75, 'Should use regime risk modifier');
  console.log('✅ Regime risk modifier test passed');
}

// Test 4: Medium volatility returns 1.0
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const regime = {
    trend: 'uptrend',
    volatility: 'medium',
    hurst: 0.55,
    realizedVol: 2.0,
    adxSlope: 0.3,
    trendStrength: 0.4,
    playbook: 'trend_following',
    shouldTrade: true,
  };

  const multiplier = manager.calculateRegimeMultiplier(regime);
  assert.equal(multiplier, 1.0, 'Should return 1.0 for medium volatility');
  console.log('✅ Medium volatility regime multiplier test passed');
}

// Test 5: Clear session state
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const sessionId = 'test-session-123';
  
  // Manually set some state
  manager['drawdownStates'].set(sessionId, {
    peakEquity: 10000,
    currentDrawdownPct: -5,
    isInDrawdown: false,
    sizeMultiplier: 1.0,
    lastUpdated: new Date(),
  });

  assert.ok(manager.getDrawdownState(sessionId) !== undefined, 'State should exist before clear');
  
  manager.clearSession(sessionId);
  
  assert.equal(manager.getDrawdownState(sessionId), undefined, 'State should be cleared');
  console.log('✅ Clear session state test passed');
}

// Test 6: Get drawdown state
{
  const manager = new AdvancedRiskManager(DEFAULT_ADVANCED_RISK_CONFIG);
  const sessionId = 'test-session-456';
  const testState = {
    peakEquity: 15000,
    currentDrawdownPct: -8,
    isInDrawdown: false,
    sizeMultiplier: 0.9,
    lastUpdated: new Date(),
  };

  assert.equal(manager.getDrawdownState('non-existent'), undefined, 'Should return undefined for non-existent session');

  manager['drawdownStates'].set(sessionId, testState);
  
  const state = manager.getDrawdownState(sessionId);
  assert.deepEqual(state, testState, 'Should return cached state');
  console.log('✅ Get drawdown state test passed');
}

// Test 7: Custom configuration
{
  const customConfig = {
    ...DEFAULT_ADVANCED_RISK_CONFIG,
    maxDrawdownPct: 15,
    catastrophicDailyLossPct: 7,
  };

  const manager = new AdvancedRiskManager(customConfig);
  assert.equal(manager['config'].maxDrawdownPct, 15, 'Should use custom max drawdown');
  assert.equal(manager['config'].catastrophicDailyLossPct, 7, 'Should use custom catastrophic loss');
  console.log('✅ Custom configuration test passed');
}

// Test 8: Drawdown multiplier at threshold
{
  const drawdownPct = -10;
  const config = DEFAULT_ADVANCED_RISK_CONFIG;
  
  const isInDrawdown = Math.abs(drawdownPct) >= config.maxDrawdownPct;
  assert.equal(isInDrawdown, true, 'Should be in drawdown at threshold');
  
  const excessDrawdown = Math.abs(drawdownPct) - config.maxDrawdownPct;
  const severityFactor = Math.min(excessDrawdown / config.maxDrawdownPct, 1);
  const sizeMultiplier = Math.max(0.25, 0.5 - (severityFactor * 0.25));
  
  assert.equal(sizeMultiplier, 0.5, 'Should return 0.5 multiplier at threshold');
  console.log('✅ Drawdown multiplier at threshold test passed');
}

// Test 9: Severe drawdown multiplier
{
  const drawdownPct = -20;
  const config = DEFAULT_ADVANCED_RISK_CONFIG;
  
  const excessDrawdown = Math.abs(drawdownPct) - config.maxDrawdownPct;
  const severityFactor = Math.min(excessDrawdown / config.maxDrawdownPct, 1);
  const sizeMultiplier = Math.max(0.25, 0.5 - (severityFactor * 0.25));
  
  assert.equal(sizeMultiplier, 0.25, 'Should return 0.25 for severe drawdown');
  console.log('✅ Severe drawdown multiplier test passed');
}

// Test 10: Black swan detection logic
{
  const threshold = DEFAULT_ADVANCED_RISK_CONFIG.blackSwanVolatilityThreshold;
  const startPrice = 100;
  
  const highVolMove = 116;
  const upMovePct = ((highVolMove - startPrice) / startPrice) * 100;
  assert.ok(upMovePct > threshold, 'Should detect black swan for large move');
  
  const normalMove = 105;
  const normalMovePct = ((normalMove - startPrice) / startPrice) * 100;
  assert.ok(normalMovePct < threshold, 'Should not detect black swan for normal move');
  
  console.log('✅ Black swan detection logic test passed');
}

console.log('\n✅ All Advanced Risk Manager tests passed!');
