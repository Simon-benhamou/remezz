/**
 * Unit test for re-optimization scheduler
 */

import { strict as assert } from 'assert';

console.log('🧪 Testing re-optimization scheduler...');

// Test 1: Import scheduler modules
console.log('  ✓ Test 1: Import scheduler modules');
let schedulerModule;
try {
  schedulerModule = await import('../../dist/src/learning/reoptimizationScheduler.js');
  assert(typeof schedulerModule.registerReoptimizationJobHandler === 'function', 'registerReoptimizationJobHandler should be a function');
  assert(typeof schedulerModule.initializeReoptimizationScheduling === 'function', 'initializeReoptimizationScheduling should be a function');
  assert(typeof schedulerModule.scheduleSymbolReoptimization === 'function', 'scheduleSymbolReoptimization should be a function');
  assert(typeof schedulerModule.triggerSymbolReoptimization === 'function', 'triggerSymbolReoptimization should be a function');
} catch (error) {
  console.error('Failed to import scheduler:', error);
  throw error;
}

// Test 2: Verify function signatures
console.log('  ✓ Test 2: Verify function signatures');
assert(schedulerModule.registerReoptimizationJobHandler.length === 0, 'registerReoptimizationJobHandler should take 0 parameters');
assert(schedulerModule.initializeReoptimizationScheduling.length === 0, 'initializeReoptimizationScheduling should take 0 parameters');
assert(schedulerModule.scheduleSymbolReoptimization.length === 2, 'scheduleSymbolReoptimization should take 2 parameters');
assert(schedulerModule.triggerSymbolReoptimization.length === 1, 'triggerSymbolReoptimization should take 1 parameter');

// Test 3: Verify module exports are functions
console.log('  ✓ Test 3: Verify all exported functions');
const exportedFunctions = [
  'registerReoptimizationJobHandler',
  'initializeReoptimizationScheduling',
  'scheduleSymbolReoptimization',
  'triggerSymbolReoptimization'
];

for (const funcName of exportedFunctions) {
  assert(
    typeof schedulerModule[funcName] === 'function',
    `${funcName} should be exported as a function`
  );
}

console.log('✅ All re-optimization scheduler tests passed!');
