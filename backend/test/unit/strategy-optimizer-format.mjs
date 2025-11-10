/**
 * Unit test for strategy optimizer format consistency
 * Tests that optimized strategies have all required meta-adaptive thresholds
 */

import { strict as assert } from 'assert';

console.log('🧪 Testing strategy optimizer format consistency...\n');

// Test 1: Import required modules
console.log('Test 1: Import modules');
let personalityModule;
try {
  personalityModule = await import('../../dist/src/learning/personalityProfile.js');
  assert(typeof personalityModule.DEFAULT_PARAMS === 'object', 'DEFAULT_PARAMS should be an object');
  assert(typeof personalityModule.getDefaultParamsByRegime === 'function', 'getDefaultParamsByRegime should be a function');
  console.log('  ✓ Modules imported successfully\n');
} catch (error) {
  console.error('  ❌ Failed to import modules:', error);
  throw error;
}

// Test 2: Verify DEFAULT_PARAMS structure
console.log('Test 2: Verify DEFAULT_PARAMS structure');
const DEFAULT_PARAMS = personalityModule.DEFAULT_PARAMS;

assert(typeof DEFAULT_PARAMS === 'object', 'DEFAULT_PARAMS should be an object');
assert(typeof DEFAULT_PARAMS.weights === 'object', 'DEFAULT_PARAMS should have weights');
assert(typeof DEFAULT_PARAMS.thresholds === 'object', 'DEFAULT_PARAMS should have thresholds');

// Check all required weight fields
const requiredWeights = ['adx', 'strength', 'alignment', 'slope', 'flow'];
requiredWeights.forEach(field => {
  assert(field in DEFAULT_PARAMS.weights, `DEFAULT_PARAMS.weights should have ${field}`);
  assert(typeof DEFAULT_PARAMS.weights[field] === 'number', `DEFAULT_PARAMS.weights.${field} should be a number`);
});

// Check all required threshold fields (including meta-adaptive ones)
const requiredThresholds = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
requiredThresholds.forEach(field => {
  assert(field in DEFAULT_PARAMS.thresholds, `DEFAULT_PARAMS.thresholds should have ${field}`);
  assert(typeof DEFAULT_PARAMS.thresholds[field] === 'number', `DEFAULT_PARAMS.thresholds.${field} should be a number`);
});

console.log('  ✓ DEFAULT_PARAMS has all required fields');
console.log(`    - ${requiredWeights.length} weight fields: ${requiredWeights.join(', ')}`);
console.log(`    - ${requiredThresholds.length} threshold fields: ${requiredThresholds.join(', ')}\n`);

// Test 3: Verify regime-specific defaults
console.log('Test 3: Verify regime-specific defaults');
const regimes = [
  'default',
  'low_volatility',
  'medium_volatility', 
  'high_volatility',
  'long_bias',
  'short_bias',
  'low_volume',
  'normal_volume',
  'high_volume',
  'trending',
  'ranging',
];

const getDefaultParamsByRegime = personalityModule.getDefaultParamsByRegime;

regimes.forEach(regime => {
  const regimeParams = getDefaultParamsByRegime(regime);
  
  assert(typeof regimeParams === 'object', `${regime} params should be an object`);
  assert(typeof regimeParams.weights === 'object', `${regime} should have weights`);
  assert(typeof regimeParams.thresholds === 'object', `${regime} should have thresholds`);
  
  // Verify all required fields exist
  requiredWeights.forEach(field => {
    assert(field in regimeParams.weights, `${regime}.weights should have ${field}`);
  });
  
  requiredThresholds.forEach(field => {
    assert(field in regimeParams.thresholds, `${regime}.thresholds should have ${field}`);
  });
  
  console.log(`  ✓ ${regime}: all fields present`);
});

console.log('\n');

// Test 4: Verify format consistency function
console.log('Test 4: Test format consistency helper');

function hasCompleteThresholds(params) {
  const required = ['adx', 'trendStrength', 'minConfidence', 'atr', 'cmf', 'eligibility', 'rrMin', 'minAtrPct', 'maxAtrPct'];
  return required.every(key => key in params.thresholds && params.thresholds[key] !== undefined);
}

// Test with complete params
assert(hasCompleteThresholds(DEFAULT_PARAMS), 'DEFAULT_PARAMS should be complete');
console.log('  ✓ DEFAULT_PARAMS is complete');

// Test with incomplete params (old format)
const incompleteParams = {
  weights: DEFAULT_PARAMS.weights,
  thresholds: {
    adx: 18,
    trendStrength: 0.25,
    minConfidence: 0.45,
  },
};

assert(!hasCompleteThresholds(incompleteParams), 'Incomplete params should fail check');
console.log('  ✓ Incomplete params correctly detected');

// Test upgrade function
function upgradeOptimalParams(params, regimeName) {
  const regimeDefaults = getDefaultParamsByRegime(regimeName);
  
  return {
    weights: params.weights,
    thresholds: {
      adx: params.thresholds.adx,
      trendStrength: params.thresholds.trendStrength,
      minConfidence: params.thresholds.minConfidence,
      atr: params.thresholds.atr ?? regimeDefaults.thresholds.atr,
      cmf: params.thresholds.cmf ?? regimeDefaults.thresholds.cmf,
      eligibility: params.thresholds.eligibility ?? regimeDefaults.thresholds.eligibility,
      rrMin: params.thresholds.rrMin ?? regimeDefaults.thresholds.rrMin,
      minAtrPct: params.thresholds.minAtrPct ?? regimeDefaults.thresholds.minAtrPct,
      maxAtrPct: params.thresholds.maxAtrPct ?? regimeDefaults.thresholds.maxAtrPct,
    },
  };
}

const upgradedParams = upgradeOptimalParams(incompleteParams, 'default');
assert(hasCompleteThresholds(upgradedParams), 'Upgraded params should be complete');
console.log('  ✓ Upgrade function works correctly\n');

// Test 5: Verify threshold values are reasonable
console.log('Test 5: Verify threshold value ranges');

function validateThresholdRanges(params) {
  const t = params.thresholds;
  
  // ADX should be between 10 and 30
  assert(t.adx >= 10 && t.adx <= 30, `ADX should be 10-30, got ${t.adx}`);
  
  // TrendStrength should be between 0.1 and 0.5
  assert(t.trendStrength >= 0.1 && t.trendStrength <= 0.5, `trendStrength should be 0.1-0.5, got ${t.trendStrength}`);
  
  // minConfidence should be between 0.3 and 0.7
  assert(t.minConfidence >= 0.3 && t.minConfidence <= 0.7, `minConfidence should be 0.3-0.7, got ${t.minConfidence}`);
  
  // atr should be between 0.3 and 1.0
  assert(t.atr >= 0.3 && t.atr <= 1.0, `atr should be 0.3-1.0, got ${t.atr}`);
  
  // cmf should be between 0.01 and 0.15
  assert(t.cmf >= 0.01 && t.cmf <= 0.15, `cmf should be 0.01-0.15, got ${t.cmf}`);
  
  // eligibility should be between 0.4 and 0.8
  assert(t.eligibility >= 0.4 && t.eligibility <= 0.8, `eligibility should be 0.4-0.8, got ${t.eligibility}`);
  
  // rrMin should be between 1.0 and 3.0
  assert(t.rrMin >= 1.0 && t.rrMin <= 3.0, `rrMin should be 1.0-3.0, got ${t.rrMin}`);
  
  // minAtrPct should be between 1.0 and 5.0
  assert(t.minAtrPct >= 1.0 && t.minAtrPct <= 5.0, `minAtrPct should be 1.0-5.0, got ${t.minAtrPct}`);
  
  // maxAtrPct should be between 3.0 and 15.0 and greater than minAtrPct
  assert(t.maxAtrPct >= 3.0 && t.maxAtrPct <= 15.0, `maxAtrPct should be 3.0-15.0, got ${t.maxAtrPct}`);
  assert(t.maxAtrPct > t.minAtrPct, `maxAtrPct (${t.maxAtrPct}) should be greater than minAtrPct (${t.minAtrPct})`);
}

// Validate default params
validateThresholdRanges(DEFAULT_PARAMS);
console.log('  ✓ DEFAULT_PARAMS thresholds are within valid ranges');

// Validate all regime params
regimes.forEach(regime => {
  const regimeParams = getDefaultParamsByRegime(regime);
  validateThresholdRanges(regimeParams);
});
console.log(`  ✓ All ${regimes.length} regime params have valid threshold ranges\n`);

// Test 6: Verify weights sum to approximately 1.0
console.log('Test 6: Verify weights sum to 1.0');

function validateWeightsSum(params) {
  const w = params.weights;
  const sum = w.adx + w.strength + w.alignment + w.slope + w.flow;
  const tolerance = 0.01;
  
  assert(Math.abs(sum - 1.0) <= tolerance, `Weights should sum to 1.0 ± ${tolerance}, got ${sum}`);
  
  return sum;
}

const defaultSum = validateWeightsSum(DEFAULT_PARAMS);
console.log(`  ✓ DEFAULT_PARAMS weights sum to ${defaultSum.toFixed(4)}`);

regimes.forEach(regime => {
  const regimeParams = getDefaultParamsByRegime(regime);
  const sum = validateWeightsSum(regimeParams);
  console.log(`  ✓ ${regime} weights sum to ${sum.toFixed(4)}`);
});

console.log('\n');

// Summary
console.log('📊 Summary:');
console.log(`  - DEFAULT_PARAMS: ${requiredWeights.length} weights, ${requiredThresholds.length} thresholds`);
console.log(`  - Tested ${regimes.length} regimes`);
console.log(`  - All format validations passed`);
console.log(`  - All threshold ranges validated`);
console.log(`  - All weight sums verified\n`);

console.log('✅ All strategy optimizer format tests passed!');
