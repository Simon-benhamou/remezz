/**
 * Unit test for adaptive cryptocurrency category scoring system
 * 
 * Tests that different crypto categories (Major, LargeCap, Altcoin, Exotic)
 * receive appropriate parameter tuning for trend confidence scoring:
 * - Major: Conservative approach with high confidence requirements
 * - LargeCap: Balanced approach with moderate requirements
 * - Altcoin: Relaxed thresholds, momentum-focused
 * - Exotic: Very relaxed, heavily momentum-driven
 */

type CryptoCategory = 'Major' | 'LargeCap' | 'Altcoin' | 'Exotic';

type CategoryParameters = {
  weights: {
    adx: number;
    strength: number;
    alignment: number;
    slope: number;
    flow: number;
  };
  thresholds: {
    adx: number;
    trendStrength: number;
    cmf: number;
  };
  minConfidence: number;
};

/**
 * Determine cryptocurrency category based on symbol
 */
function getCryptoCategory(symbol: string): CryptoCategory {
  const majors = new Set(['BTC/USDT', 'ETH/USDT']);
  const largeCaps = new Set(['SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOT/USDT']);
  const exotics = new Set(['PEPE/USDT', 'SHIB/USDT', 'DOGE/USDT', 'FLOKI/USDT', 'WIF/USDT']);

  if (majors.has(symbol)) return 'Major';
  if (largeCaps.has(symbol)) return 'LargeCap';
  if (exotics.has(symbol)) return 'Exotic';
  
  return 'Altcoin'; // Default category
}

/**
 * Category-specific adaptive parameters
 */
const categoryParams: Record<CryptoCategory, CategoryParameters> = {
  Major: {
    weights: { adx: 0.3, strength: 0.3, alignment: 0.2, slope: 0.1, flow: 0.1 },
    thresholds: { adx: 18, trendStrength: 0.25, cmf: 0.05 },
    minConfidence: 0.70
  },
  LargeCap: {
    weights: { adx: 0.3, strength: 0.25, alignment: 0.2, slope: 0.15, flow: 0.1 },
    thresholds: { adx: 18, trendStrength: 0.25, cmf: 0.05 },
    minConfidence: 0.68
  },
  Altcoin: {
    weights: { adx: 0.25, strength: 0.2, alignment: 0.15, slope: 0.3, flow: 0.1 },
    thresholds: { adx: 15, trendStrength: 0.20, cmf: 0.0 },
    minConfidence: 0.65
  },
  Exotic: {
    weights: { adx: 0.1, strength: 0.1, alignment: 0.1, slope: 0.5, flow: 0.2 },
    thresholds: { adx: 12, trendStrength: 0.15, cmf: -0.05 },
    minConfidence: 0.60
  }
};

// Test category classification
console.log('Testing cryptocurrency category classification...\n');

const categoryTests = [
  { symbol: 'BTC/USDT', expected: 'Major', description: 'Bitcoin is Major' },
  { symbol: 'ETH/USDT', expected: 'Major', description: 'Ethereum is Major' },
  { symbol: 'SOL/USDT', expected: 'LargeCap', description: 'Solana is LargeCap' },
  { symbol: 'BNB/USDT', expected: 'LargeCap', description: 'BNB is LargeCap' },
  { symbol: 'XRP/USDT', expected: 'LargeCap', description: 'XRP is LargeCap' },
  { symbol: 'ADA/USDT', expected: 'LargeCap', description: 'Cardano is LargeCap' },
  { symbol: 'PEPE/USDT', expected: 'Exotic', description: 'PEPE is Exotic' },
  { symbol: 'SHIB/USDT', expected: 'Exotic', description: 'SHIB is Exotic' },
  { symbol: 'DOGE/USDT', expected: 'Exotic', description: 'DOGE is Exotic' },
  { symbol: 'MATIC/USDT', expected: 'Altcoin', description: 'MATIC is Altcoin (default)' },
  { symbol: 'LINK/USDT', expected: 'Altcoin', description: 'LINK is Altcoin (default)' },
];

let passed = 0;
let failed = 0;

for (const test of categoryTests) {
  const category = getCryptoCategory(test.symbol);
  const isValid = category === test.expected;
  
  if (isValid) {
    console.log(`✅ ${test.description}: ${test.symbol} → ${category}`);
    passed++;
  } else {
    console.log(`❌ ${test.description}: ${test.symbol} → ${category} (expected ${test.expected})`);
    failed++;
  }
}

// Test parameter adaptation
console.log('\nTesting category-specific parameter adaptation...\n');

const paramTests = [
  {
    category: 'Major' as CryptoCategory,
    description: 'Major cryptos have conservative parameters',
    checks: [
      { param: 'minConfidence', expected: 0.70, description: 'High confidence threshold (0.70)' },
      { param: 'adxThreshold', expected: 18, description: 'ADX threshold at 18' },
      { param: 'slopeWeight', expected: 0.1, description: 'Low slope weight (trend-focused)' },
    ]
  },
  {
    category: 'LargeCap' as CryptoCategory,
    description: 'LargeCap cryptos have balanced parameters',
    checks: [
      { param: 'minConfidence', expected: 0.68, description: 'Balanced confidence threshold (0.68)' },
      { param: 'slopeWeight', expected: 0.15, description: 'Moderate slope weight' },
    ]
  },
  {
    category: 'Altcoin' as CryptoCategory,
    description: 'Altcoins have relaxed, momentum-focused parameters',
    checks: [
      { param: 'minConfidence', expected: 0.65, description: 'Relaxed confidence threshold (0.65)' },
      { param: 'adxThreshold', expected: 15, description: 'Lower ADX threshold (15)' },
      { param: 'slopeWeight', expected: 0.3, description: 'High slope weight (momentum-focused)' },
      { param: 'trendStrengthThreshold', expected: 0.20, description: 'Relaxed trend strength (0.20)' },
    ]
  },
  {
    category: 'Exotic' as CryptoCategory,
    description: 'Exotic cryptos have very relaxed, heavily momentum-driven parameters',
    checks: [
      { param: 'minConfidence', expected: 0.60, description: 'Very relaxed confidence (0.60)' },
      { param: 'adxThreshold', expected: 12, description: 'Very low ADX threshold (12)' },
      { param: 'slopeWeight', expected: 0.5, description: 'Very high slope weight (0.5)' },
      { param: 'flowWeight', expected: 0.2, description: 'High flow weight (0.2)' },
      { param: 'cmfThreshold', expected: -0.05, description: 'Very relaxed CMF threshold (-0.05)' },
    ]
  },
];

for (const paramTest of paramTests) {
  const params = categoryParams[paramTest.category];
  console.log(`\n${paramTest.description}:`);
  
  for (const check of paramTest.checks) {
    let actual: number;
    switch (check.param) {
      case 'minConfidence':
        actual = params.minConfidence;
        break;
      case 'adxThreshold':
        actual = params.thresholds.adx;
        break;
      case 'trendStrengthThreshold':
        actual = params.thresholds.trendStrength;
        break;
      case 'cmfThreshold':
        actual = params.thresholds.cmf;
        break;
      case 'slopeWeight':
        actual = params.weights.slope;
        break;
      case 'flowWeight':
        actual = params.weights.flow;
        break;
      default:
        throw new Error(`Unknown parameter name: ${check.param}`);
    }
    
    const isValid = Math.abs(actual - check.expected) < 0.001;
    
    if (isValid) {
      console.log(`  ✅ ${check.description}`);
      passed++;
    } else {
      console.log(`  ❌ ${check.description}: got ${actual} (expected ${check.expected})`);
      failed++;
    }
  }
}

// Test weight sum validation (should equal 1.0)
console.log('\nTesting weight sum validation (should equal 1.0)...\n');

for (const [category, params] of Object.entries(categoryParams)) {
  const weightSum = params.weights.adx + params.weights.strength + params.weights.alignment + 
                    params.weights.slope + params.weights.flow;
  const isValid = Math.abs(weightSum - 1.0) < 0.001;
  
  if (isValid) {
    console.log(`✅ ${category}: weight sum = ${weightSum.toFixed(3)}`);
    passed++;
  } else {
    console.log(`❌ ${category}: weight sum = ${weightSum.toFixed(3)} (expected 1.0)`);
    failed++;
  }
}

// Test momentum vs trend balance
console.log('\nTesting momentum vs trend balance...\n');

const balanceTests = [
  {
    category: 'Major' as CryptoCategory,
    description: 'Major: trend-focused (high adx+strength)',
    expectedTrendWeight: 0.6, // adx + strength
    expectedMomentumWeight: 0.1, // slope
  },
  {
    category: 'Altcoin' as CryptoCategory,
    description: 'Altcoin: momentum-focused (higher slope)',
    expectedTrendWeight: 0.45, // adx + strength
    expectedMomentumWeight: 0.3, // slope
  },
  {
    category: 'Exotic' as CryptoCategory,
    description: 'Exotic: heavily momentum-driven (very high slope)',
    expectedTrendWeight: 0.2, // adx + strength
    expectedMomentumWeight: 0.5, // slope
  },
];

for (const balanceTest of balanceTests) {
  const params = categoryParams[balanceTest.category];
  const trendWeight = params.weights.adx + params.weights.strength;
  const momentumWeight = params.weights.slope;
  
  const trendValid = Math.abs(trendWeight - balanceTest.expectedTrendWeight) < 0.001;
  const momentumValid = Math.abs(momentumWeight - balanceTest.expectedMomentumWeight) < 0.001;
  
  if (trendValid && momentumValid) {
    console.log(`✅ ${balanceTest.description}: trend=${trendWeight.toFixed(2)}, momentum=${momentumWeight.toFixed(2)}`);
    passed++;
  } else {
    console.log(`❌ ${balanceTest.description}: trend=${trendWeight.toFixed(2)} (expected ${balanceTest.expectedTrendWeight}), momentum=${momentumWeight.toFixed(2)} (expected ${balanceTest.expectedMomentumWeight})`);
    failed++;
  }
}

console.log(`\n${passed} tests passed, ${failed} tests failed`);

if (failed > 0) {
  process.exit(1);
}
