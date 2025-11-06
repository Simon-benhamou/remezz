/**
 * Unit test for confidence-based leverage scaling
 * 
 * Tests that leverage is properly scaled based on trade confidence:
 * - Low confidence (0.0-0.5): 20-50% of base leverage (min 2x)
 * - Medium confidence (0.5-0.75): 50-85% of base leverage
 * - High confidence (0.75-0.9): 85-100% of base leverage
 * - Very high confidence (0.9-1.0): 100% base leverage
 */

// Simulates the confidence factor calculation from the implementation
function computeConfidenceFactor(confidenceScore: number): number {
  const conf = Math.max(0, Math.min(1, confidenceScore));
  if (conf < 0.5) {
    // Low confidence: 0.2 to 0.5 (20% to 50% of base leverage)
    return 0.2 + (conf / 0.5) * 0.3;
  } else if (conf < 0.75) {
    // Medium confidence: 0.5 to 0.85
    return 0.5 + ((conf - 0.5) / 0.25) * 0.35;
  } else if (conf < 0.9) {
    // High confidence: 0.85 to 1.0
    return 0.85 + ((conf - 0.75) / 0.15) * 0.15;
  } else {
    // Very high confidence: full leverage
    return 1.0;
  }
}

// Test cases
const tests = [
  // Low confidence range
  { confidence: 0.0, expectedRange: [0.20, 0.20], description: 'Zero confidence (minimum)' },
  { confidence: 0.25, expectedRange: [0.35, 0.35], description: 'Low confidence (25%)' },
  { confidence: 0.5, expectedRange: [0.50, 0.50], description: 'Medium-low confidence (50%)' },
  
  // Medium confidence range
  { confidence: 0.625, expectedRange: [0.675, 0.675], description: 'Medium confidence (62.5%)' },
  { confidence: 0.75, expectedRange: [0.85, 0.85], description: 'Medium-high confidence (75%)' },
  
  // High confidence range
  { confidence: 0.825, expectedRange: [0.925, 0.925], description: 'High confidence (82.5%)' },
  { confidence: 0.9, expectedRange: [1.0, 1.0], description: 'Very high confidence (90%)' },
  { confidence: 1.0, expectedRange: [1.0, 1.0], description: 'Maximum confidence (100%)' },
];

console.log('Testing confidence-based leverage scaling...\n');

let passed = 0;
let failed = 0;

for (const test of tests) {
  const factor = computeConfidenceFactor(test.confidence);
  const [minExpected, maxExpected] = test.expectedRange;
  const tolerance = 0.001;
  
  const isValid = Math.abs(factor - minExpected) < tolerance;
  
  if (isValid) {
    console.log(`✅ ${test.description}: confidence=${test.confidence.toFixed(2)} → factor=${factor.toFixed(3)} (expected ${minExpected.toFixed(3)})`);
    passed++;
  } else {
    console.log(`❌ ${test.description}: confidence=${test.confidence.toFixed(2)} → factor=${factor.toFixed(3)} (expected ${minExpected.toFixed(3)})`);
    failed++;
  }
}

// Test realistic leverage scenarios
console.log('\nTesting realistic leverage scenarios with 10x max leverage:\n');

const baseLeverage = 10;
const scenarios = [
  { confidence: 0.3, expectedLevMin: 2.0, expectedLevMax: 4.0, description: 'Low confidence trade' },
  { confidence: 0.6, expectedLevMin: 5.5, expectedLevMax: 6.5, description: 'Medium confidence trade' },
  { confidence: 0.8, expectedLevMin: 9.0, expectedLevMax: 9.5, description: 'High confidence trade' },
  { confidence: 0.95, expectedLevMin: 10.0, expectedLevMax: 10.0, description: 'Very high confidence trade' },
];

for (const scenario of scenarios) {
  const factor = computeConfidenceFactor(scenario.confidence);
  const effectiveLeverage = Math.max(2, baseLeverage * factor); // Enforce minimum 2x
  
  const isValid = effectiveLeverage >= scenario.expectedLevMin && effectiveLeverage <= scenario.expectedLevMax;
  
  if (isValid) {
    console.log(`✅ ${scenario.description}: confidence=${scenario.confidence.toFixed(2)} → ${effectiveLeverage.toFixed(2)}x leverage`);
    passed++;
  } else {
    console.log(`❌ ${scenario.description}: confidence=${scenario.confidence.toFixed(2)} → ${effectiveLeverage.toFixed(2)}x leverage (expected ${scenario.expectedLevMin}-${scenario.expectedLevMax}x)`);
    failed++;
  }
}

console.log(`\n${passed} tests passed, ${failed} tests failed`);

if (failed > 0) {
  process.exit(1);
}
