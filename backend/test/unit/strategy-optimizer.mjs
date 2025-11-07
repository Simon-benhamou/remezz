/**
 * Unit test for strategy optimizer
 */

import { strict as assert } from 'assert';

console.log('🧪 Testing strategy optimizer...');

// Test 1: Import strategy optimizer modules
console.log('  ✓ Test 1: Import optimizer modules');
let optimizerModule;
try {
  optimizerModule = await import('../../dist/src/learning/strategyOptimizer.js');
  assert(typeof optimizerModule.optimizeSymbolParameters === 'function', 'optimizeSymbolParameters should be a function');
  assert(typeof optimizerModule.optimizeAllSymbols === 'function', 'optimizeAllSymbols should be a function');
} catch (error) {
  console.error('Failed to import optimizer:', error);
  throw error;
}

// Test 2: Verify function signatures
console.log('  ✓ Test 2: Verify function signatures');
assert(optimizerModule.optimizeSymbolParameters.length === 1, 'optimizeSymbolParameters should take 1 parameter');
assert(optimizerModule.optimizeAllSymbols.length === 0, 'optimizeAllSymbols should take 0 parameters');

console.log('✅ All strategy optimizer tests passed!');
