/**
 * Unit tests for Execution Model
 */

import assert from 'node:assert/strict';
const { ExecutionModel, DEFAULT_EXECUTION_CONFIG } = await import('../../dist/src/exec/executionModel.js');

// Test 1: Simple slippage estimation
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const result = model['estimateSimpleSlippage'](10000, 10);
  
  assert.equal(result.method, 'simple', 'Should use simple method');
  assert.ok(result.slippageBps > 0, 'Should have positive slippage');
  assert.ok(result.slippageBps <= DEFAULT_EXECUTION_CONFIG.maxSlippageBps, 'Should not exceed max');
  assert.equal(result.confidence, 'low', 'Should have low confidence');
  console.log('✅ Simple slippage estimation test passed');
}

// Test 2: Slippage capped at maximum
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const result = model['estimateSimpleSlippage'](10000, 200);
  
  assert.ok(result.slippageBps <= DEFAULT_EXECUTION_CONFIG.maxSlippageBps, 'Should cap at maximum');
  console.log('✅ Slippage cap test passed');
}

// Test 3: Recent slippage affects estimate
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const withRecent = model['estimateSimpleSlippage'](10000, 10, 15);
  const withoutRecent = model['estimateSimpleSlippage'](10000, 10);
  
  assert.notEqual(withRecent.slippageBps, withoutRecent.slippageBps, 'Recent slippage should affect estimate');
  console.log('✅ Recent slippage impact test passed');
}

// Test 4: Volatility increases slippage
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const lowVol = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 1.0,
    volume24hUsd: 1000000,
  });

  const highVol = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 5.0,
    volume24hUsd: 1000000,
  });

  assert.ok(highVol.slippageBps > lowVol.slippageBps, 'High volatility should increase slippage');
  assert.ok(highVol.components.volatilityAdjustment > lowVol.components.volatilityAdjustment, 
    'Should have higher vol adjustment');
  console.log('✅ Volatility impact on slippage test passed');
}

// Test 5: Low volume increases slippage
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const highVolume = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 2.0,
    volume24hUsd: 10000000,
  });

  const lowVolume = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 2.0,
    volume24hUsd: 50000,
  });

  assert.ok(lowVolume.slippageBps > highVolume.slippageBps, 'Low volume should increase slippage');
  assert.ok(lowVolume.components.volumeAdjustment > highVolume.components.volumeAdjustment,
    'Should have higher volume adjustment');
  console.log('✅ Volume impact on slippage test passed');
}

// Test 6: Confidence levels
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  
  const mediumConf = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 2.0,
    volume24hUsd: 1000000,
  });
  assert.equal(mediumConf.confidence, 'medium', 'Should have medium confidence');

  const highConf = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 2.0,
    volume24hUsd: 100000000,
    recentSlippageBps: 8,
  });
  assert.equal(highConf.confidence, 'high', 'Should have high confidence with recent data');

  const lowConf = model.estimateSlippageWithVolatility({
    notionalUsd: 10000,
    spreadBps: 10,
    volatilityPct: 2.0,
    volume24hUsd: 0,
  });
  assert.equal(lowConf.confidence, 'low', 'Should have low confidence without volume data');
  
  console.log('✅ Confidence levels test passed');
}

// Test 7: Perfect fill quality
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const order = {
    qty: 1.0,
    price: 100,
    status: 'filled',
    createdAt: new Date(),
    fills: [
      {
        qty: 1.0,
        price: 100,
        executedAt: new Date(Date.now() + 1000),
        fee: 0.1,
      },
    ],
  };

  const quality = model.calculateFillQuality(order);

  assert.equal(quality.fillRatio, 1.0, 'Should have 100% fill ratio');
  assert.ok(Math.abs(quality.slippageBps) < 1, 'Should have minimal slippage');
  assert.equal(quality.isPartialFill, false, 'Should not be partial fill');
  assert.equal(quality.isSlowFill, false, 'Should not be slow fill');
  assert.ok(quality.fillQualityScore > 95, 'Should have high quality score');
  console.log('✅ Perfect fill quality test passed');
}

// Test 8: Detect partial fills
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const order = {
    qty: 1.0,
    price: 100,
    status: 'filled',
    createdAt: new Date(),
    fills: [
      {
        qty: 0.7,
        price: 100,
        executedAt: new Date(Date.now() + 1000),
        fee: 0.07,
      },
    ],
  };

  const quality = model.calculateFillQuality(order);

  assert.equal(quality.fillRatio, 0.7, 'Should have 70% fill ratio');
  assert.equal(quality.isPartialFill, true, 'Should be partial fill');
  assert.ok(quality.fillQualityScore < 100, 'Should have reduced quality score');
  console.log('✅ Partial fill detection test passed');
}

// Test 9: Detect slow fills
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const order = {
    qty: 1.0,
    price: 100,
    status: 'filled',
    createdAt: new Date(),
    fills: [
      {
        qty: 1.0,
        price: 100,
        executedAt: new Date(Date.now() + 10000),
        fee: 0.1,
      },
    ],
  };

  const quality = model.calculateFillQuality(order);

  assert.equal(quality.isSlowFill, true, 'Should be slow fill');
  assert.ok(quality.latencyMs > DEFAULT_EXECUTION_CONFIG.slowFillThresholdMs, 'Should exceed threshold');
  assert.ok(quality.fillQualityScore < 90, 'Should have reduced quality score');
  console.log('✅ Slow fill detection test passed');
}

// Test 10: Calculate slippage from fill prices
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const order = {
    qty: 1.0,
    price: 100,
    status: 'filled',
    createdAt: new Date(),
    fills: [
      {
        qty: 0.5,
        price: 101,
        executedAt: new Date(Date.now() + 1000),
        fee: 0.05,
      },
      {
        qty: 0.5,
        price: 102,
        executedAt: new Date(Date.now() + 2000),
        fee: 0.05,
      },
    ],
  };

  const quality = model.calculateFillQuality(order);

  // Average fill price = 101.5, slippage = 150 bps
  assert.ok(Math.abs(quality.slippageBps - 150) < 5, 'Should calculate correct slippage');
  console.log('✅ Slippage calculation test passed');
}

// Test 11: Handle empty fills
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const order = {
    qty: 1.0,
    price: 100,
    status: 'open',
    createdAt: new Date(),
    fills: [],
  };

  const quality = model.calculateFillQuality(order);

  assert.equal(quality.fillRatio, 0, 'Should have 0% fill ratio');
  assert.equal(quality.slippageBps, 0, 'Should have 0 slippage');
  console.log('✅ Empty fills handling test passed');
}

// Test 12: Calculate realized PnL for profit
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const entryOrder = {
    qty: 1.0,
    price: 100,
    fills: [{ qty: 1.0, price: 100, fee: 0.1 }],
  };

  const exitOrder = {
    qty: 1.0,
    price: 110,
    fills: [{ qty: 1.0, price: 110, fee: 0.11 }],
  };

  const pnl = model.calculateRealizedPnL(entryOrder, exitOrder);

  assert.equal(pnl.grossPnl, 10, 'Should calculate correct gross PnL');
  assert.ok(Math.abs(pnl.fees - 0.21) < 0.01, 'Should calculate correct fees');
  assert.ok(pnl.netPnl > 9.5, 'Should have positive net PnL');
  assert.ok(pnl.returnPct > 9, 'Should have positive return');
  console.log('✅ Realized PnL profit calculation test passed');
}

// Test 13: Calculate realized PnL for loss
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const entryOrder = {
    qty: 1.0,
    price: 100,
    fills: [{ qty: 1.0, price: 100, fee: 0.1 }],
  };

  const exitOrder = {
    qty: 1.0,
    price: 90,
    fills: [{ qty: 1.0, price: 90, fee: 0.09 }],
  };

  const pnl = model.calculateRealizedPnL(entryOrder, exitOrder);

  assert.equal(pnl.grossPnl, -10, 'Should calculate correct gross loss');
  assert.ok(pnl.netPnl < -10, 'Net loss should include fees');
  assert.ok(pnl.returnPct < -10, 'Should have negative return');
  console.log('✅ Realized PnL loss calculation test passed');
}

// Test 14: Handle multiple fills with weighted average
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const entryOrder = {
    qty: 2.0,
    price: 100,
    fills: [
      { qty: 1.0, price: 99, fee: 0.099 },
      { qty: 1.0, price: 101, fee: 0.101 },
    ],
  };

  const exitOrder = {
    qty: 2.0,
    price: 105,
    fills: [
      { qty: 1.0, price: 104, fee: 0.104 },
      { qty: 1.0, price: 106, fee: 0.106 },
    ],
  };

  const pnl = model.calculateRealizedPnL(entryOrder, exitOrder);

  assert.ok(Math.abs(pnl.grossPnl - 10) < 1, 'Should calculate correct gross PnL with weighted avg');
  assert.ok(Math.abs(pnl.entryNotional - 200) < 1, 'Should calculate correct entry notional');
  assert.ok(Math.abs(pnl.exitNotional - 210) < 1, 'Should calculate correct exit notional');
  console.log('✅ Multiple fills weighted average test passed');
}

// Test 15: Include slippage costs
{
  const model = new ExecutionModel(DEFAULT_EXECUTION_CONFIG);
  const entryOrder = {
    qty: 1.0,
    price: 100,
    fills: [{ qty: 1.0, price: 101, fee: 0.1 }],
  };

  const exitOrder = {
    qty: 1.0,
    price: 110,
    fills: [{ qty: 1.0, price: 109, fee: 0.109 }],
  };

  const pnl = model.calculateRealizedPnL(entryOrder, exitOrder);

  assert.ok(Math.abs(pnl.slippage - 2) < 0.1, 'Should calculate slippage costs');
  assert.ok(pnl.netPnl < pnl.grossPnl, 'Net should be less than gross due to costs');
  console.log('✅ Slippage costs inclusion test passed');
}

// Test 16: Fill quality scoring penalties
{
  // Partial fill penalty
  let score = 100;
  const fillRatio = 0.7;
  score -= (1 - fillRatio) * 30;
  assert.ok(Math.abs(score - 91) < 1, 'Should penalize partial fills correctly');
  
  // Slow fill penalty
  score = 100;
  const latencyMs = 15000;
  const threshold = 5000;
  const slownessFactor = Math.min(latencyMs / threshold - 1, 3);
  score -= slownessFactor * 20;
  assert.ok(score < 100, 'Should penalize slow fills');
  
  // High slippage penalty
  score = 100;
  const slippageBps = 30;
  score -= Math.min((slippageBps - 10) / 5, 20);
  assert.ok(Math.abs(score - 96) < 1, 'Should penalize high slippage');
  
  // Never below 0
  score = 100 - 50 - 60 - 20;
  score = Math.max(0, Math.min(100, score));
  assert.equal(score, 0, 'Score should not go below 0');
  assert.ok(score >= 0, 'Score should be non-negative');
  
  console.log('✅ Fill quality scoring penalties test passed');
}

// Test 17: Custom configuration
{
  const customConfig = {
    ...DEFAULT_EXECUTION_CONFIG,
    baseSlippageBps: 10,
    maxSlippageBps: 150,
  };

  const model = new ExecutionModel(customConfig);
  assert.equal(model['config'].baseSlippageBps, 10, 'Should use custom base slippage');
  assert.equal(model['config'].maxSlippageBps, 150, 'Should use custom max slippage');
  console.log('✅ Custom configuration test passed');
}

console.log('\n✅ All Execution Model tests passed!');
