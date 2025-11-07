/**
 * Unit test for personality profile service
 */

import { strict as assert } from 'assert';
import { 
  getPersonalityProfile,
  savePersonalityProfile,
  DEFAULT_PARAMS 
} from '../../dist/src/learning/personalityProfile.js';

console.log('🧪 Testing personality profile service...');

// Test 1: Default params structure
console.log('  ✓ Test 1: Verify DEFAULT_PARAMS structure');
assert(typeof DEFAULT_PARAMS === 'object', 'DEFAULT_PARAMS should be an object');
assert(typeof DEFAULT_PARAMS.weights === 'object', 'weights should be an object');
assert(typeof DEFAULT_PARAMS.thresholds === 'object', 'thresholds should be an object');
assert(typeof DEFAULT_PARAMS.weights.adx === 'number', 'adx weight should be a number');
assert(typeof DEFAULT_PARAMS.thresholds.minConfidence === 'number', 'minConfidence should be a number');

// Test 2: Weights sum to 1.0
console.log('  ✓ Test 2: Verify weights sum to 1.0');
const { weights } = DEFAULT_PARAMS;
const weightSum = weights.adx + weights.strength + weights.alignment + weights.slope + weights.flow;
assert(Math.abs(weightSum - 1.0) < 0.01, `Weights should sum to 1.0, got ${weightSum}`);

// Test 3: Thresholds are reasonable
console.log('  ✓ Test 3: Verify thresholds are in reasonable ranges');
const { thresholds } = DEFAULT_PARAMS;
assert(thresholds.adx > 0 && thresholds.adx < 100, 'ADX threshold should be between 0 and 100');
assert(thresholds.trendStrength > 0 && thresholds.trendStrength < 1, 'Trend strength should be between 0 and 1');
assert(thresholds.minConfidence > 0 && thresholds.minConfidence < 1, 'Min confidence should be between 0 and 1');

// Test 4: Get non-existent profile returns null
console.log('  ✓ Test 4: Get non-existent profile returns null');
const nonExistent = await getPersonalityProfile('TEST_NONEXISTENT_SYMBOL_123');
assert(nonExistent === null, 'Should return null for non-existent profile');

console.log('✅ All personality profile tests passed!');
