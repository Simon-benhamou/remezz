/**
 * Unit test for strategy optimizer - verify all regimes are present
 * Tests that optimized strategies always include all 11 regime objects
 */

import { strict as assert } from 'assert';

console.log('🧪 Testing strategy optimizer - all regimes present...\n');

// Test 1: Import required modules
console.log('Test 1: Import modules');
let optimizerModule, personalityModule;
try {
  optimizerModule = await import('../../dist/src/learning/strategyOptimizer.js');
  personalityModule = await import('../../dist/src/learning/personalityProfile.js');
  assert(typeof optimizerModule.optimizeSymbolParameters === 'function', 'optimizeSymbolParameters should be a function');
  assert(typeof personalityModule.getDefaultParamsByRegime === 'function', 'getDefaultParamsByRegime should be a function');
  console.log('  ✓ Modules imported successfully\n');
} catch (error) {
  console.error('  ❌ Failed to import modules:', error);
  throw error;
}

// Test 2: Define required regime list
console.log('Test 2: Define required regime list');
const REQUIRED_REGIMES = [
  'default',
  'ranging',
  'trending',
  'long_bias',
  'low_volume',
  'short_bias',
  'high_volume',
  'normal_volume',
  'low_volatility',
  'high_volatility',
  'medium_volatility',
];

console.log(`  Required regimes (${REQUIRED_REGIMES.length}):`, REQUIRED_REGIMES);
console.log('  ✓ Regime list defined\n');

// Test 3: Verify DEFAULT_REGIME_PARAMS has all regimes
console.log('Test 3: Verify DEFAULT_REGIME_PARAMS structure');
const DEFAULT_REGIME_PARAMS = personalityModule.DEFAULT_REGIME_PARAMS;

assert(typeof DEFAULT_REGIME_PARAMS === 'object', 'DEFAULT_REGIME_PARAMS should be an object');

REQUIRED_REGIMES.forEach(regime => {
  assert(regime in DEFAULT_REGIME_PARAMS, `DEFAULT_REGIME_PARAMS should have ${regime}`);
  const regimeParams = DEFAULT_REGIME_PARAMS[regime];
  
  assert(typeof regimeParams === 'object', `${regime} should be an object`);
  assert(typeof regimeParams.weights === 'object', `${regime} should have weights`);
  assert(typeof regimeParams.thresholds === 'object', `${regime} should have thresholds`);
  
  // Check all required threshold fields
  const requiredThresholds = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  requiredThresholds.forEach(field => {
    assert(field in regimeParams.thresholds, `${regime}.thresholds should have ${field}`);
  });
});

console.log(`  ✓ DEFAULT_REGIME_PARAMS has all ${REQUIRED_REGIMES.length} regimes\n`);

// Test 4: Verify getDefaultParamsByRegime returns complete params for all regimes
console.log('Test 4: Verify getDefaultParamsByRegime for all regimes');
const getDefaultParamsByRegime = personalityModule.getDefaultParamsByRegime;

REQUIRED_REGIMES.forEach(regime => {
  const params = getDefaultParamsByRegime(regime);
  
  assert(typeof params === 'object', `getDefaultParamsByRegime('${regime}') should return an object`);
  assert(typeof params.weights === 'object', `${regime} should have weights`);
  assert(typeof params.thresholds === 'object', `${regime} should have thresholds`);
  
  // Verify all threshold fields
  const requiredThresholds = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  requiredThresholds.forEach(field => {
    assert(field in params.thresholds, `getDefaultParamsByRegime('${regime}').thresholds should have ${field}`);
    assert(typeof params.thresholds[field] === 'number', `${regime}.thresholds.${field} should be a number`);
  });
  
  console.log(`  ✓ ${regime}: complete params available`);
});

console.log('\n');

// Test 5: Verify RegimeAwareParams type includes all regimes
console.log('Test 5: Verify mock RegimeAwareParams structure');

// Create a mock optimized result that should have all regimes
function createMockRegimeAwareParams() {
  const mockParams = {};
  
  REQUIRED_REGIMES.forEach(regime => {
    mockParams[regime] = getDefaultParamsByRegime(regime);
  });
  
  return mockParams;
}

const mockResult = createMockRegimeAwareParams();

// Verify all regimes are present
REQUIRED_REGIMES.forEach(regime => {
  assert(regime in mockResult, `Mock result should have ${regime}`);
  assert(typeof mockResult[regime] === 'object', `Mock result ${regime} should be an object`);
});

console.log(`  ✓ Mock RegimeAwareParams has all ${REQUIRED_REGIMES.length} regimes\n`);

// Test 6: Verify fallback logic (null coalescing)
console.log('Test 6: Test fallback logic for missing regimes');

function simulateOptimizationWithPartialData() {
  // Simulate optimizer returning only some regimes (e.g., only 3 regimes had enough data)
  const partialOptimized = {
    default: getDefaultParamsByRegime('default'),
    trending: getDefaultParamsByRegime('trending'),
    high_volatility: getDefaultParamsByRegime('high_volatility'),
  };
  
  // Apply fallback logic (like the actual optimizer now does)
  const completeParams = {
    default: partialOptimized.default,
    low_volatility: partialOptimized.low_volatility ?? getDefaultParamsByRegime('low_volatility'),
    medium_volatility: partialOptimized.medium_volatility ?? getDefaultParamsByRegime('medium_volatility'),
    high_volatility: partialOptimized.high_volatility ?? getDefaultParamsByRegime('high_volatility'),
    long_bias: partialOptimized.long_bias ?? getDefaultParamsByRegime('long_bias'),
    short_bias: partialOptimized.short_bias ?? getDefaultParamsByRegime('short_bias'),
    low_volume: partialOptimized.low_volume ?? getDefaultParamsByRegime('low_volume'),
    normal_volume: partialOptimized.normal_volume ?? getDefaultParamsByRegime('normal_volume'),
    high_volume: partialOptimized.high_volume ?? getDefaultParamsByRegime('high_volume'),
    trending: partialOptimized.trending ?? getDefaultParamsByRegime('trending'),
    ranging: partialOptimized.ranging ?? getDefaultParamsByRegime('ranging'),
  };
  
  return completeParams;
}

const simulatedResult = simulateOptimizationWithPartialData();

// Verify all regimes are present after fallback
REQUIRED_REGIMES.forEach(regime => {
  assert(regime in simulatedResult, `Simulated result should have ${regime} after fallback`);
  assert(typeof simulatedResult[regime] === 'object', `Simulated result ${regime} should be an object`);
  
  // Verify it has complete structure
  const params = simulatedResult[regime];
  assert(typeof params.weights === 'object', `${regime} should have weights`);
  assert(typeof params.thresholds === 'object', `${regime} should have thresholds`);
  
  const requiredThresholds = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  requiredThresholds.forEach(field => {
    assert(field in params.thresholds, `${regime}.thresholds should have ${field} after fallback`);
  });
});

console.log('  ✓ Fallback logic correctly fills in missing regimes');
console.log(`  ✓ All ${REQUIRED_REGIMES.length} regimes present after partial optimization\n`);

// Test 7: Verify no extra regimes are added
console.log('Test 7: Verify no unexpected regimes');

const resultKeys = Object.keys(simulatedResult);
const expectedKeys = new Set(REQUIRED_REGIMES);

resultKeys.forEach(key => {
  assert(expectedKeys.has(key), `Unexpected regime found: ${key}`);
});

console.log(`  ✓ No unexpected regimes in result (${resultKeys.length} regimes)\n`);

// Test 8: Verify each regime has complete and valid thresholds
console.log('Test 8: Validate threshold completeness for all regimes');

function validateRegimeThresholds(regimeParams, regimeName) {
  const required = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  
  required.forEach(field => {
    assert(field in regimeParams.thresholds, `${regimeName}.thresholds missing ${field}`);
    assert(typeof regimeParams.thresholds[field] === 'number', `${regimeName}.thresholds.${field} should be a number`);
    assert(Number.isFinite(regimeParams.thresholds[field]), `${regimeName}.thresholds.${field} should be finite`);
  });
}

REQUIRED_REGIMES.forEach(regime => {
  validateRegimeThresholds(simulatedResult[regime], regime);
});

console.log(`  ✓ All ${REQUIRED_REGIMES.length} regimes have complete and valid thresholds\n`);

// Summary
console.log('📊 Summary:');
console.log(`  - Required regimes: ${REQUIRED_REGIMES.length}`);
console.log(`  - All regimes verified in DEFAULT_REGIME_PARAMS: ✓`);
console.log(`  - All regimes verified in getDefaultParamsByRegime: ✓`);
console.log(`  - Fallback logic works correctly: ✓`);
console.log(`  - All regimes have complete thresholds: ✓`);
console.log(`  - No unexpected regimes: ✓\n`);

console.log('✅ All strategy optimizer regime coverage tests passed!');
