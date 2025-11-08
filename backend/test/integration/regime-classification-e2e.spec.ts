/**
 * Integration Test: Regime Classification End-to-End
 * 
 * This test demonstrates the complete flow of regime classification
 * from raw market data to parameter selection
 */

import {
  classifyVolatilityRegime,
  classifyDirectionBias,
  classifyVolumeRegime,
  classifyTrendingRanging,
  type VolatilityRegime,
  type DirectionBias,
  type VolumeRegime,
  type TrendingRanging,
} from '../../src/learning/personalityProfile.js';

console.log('\n🧪 Integration Test: Complete Regime Classification Flow\n');

// Simulate market data snapshots
const marketScenarios = [
  {
    name: 'Bull Run with High Volume',
    data: {
      atrPct: 5.2,
      ema20: 52000,
      ema50: 50000,
      adx: 32,
      volume: 15000000,
      volumeMA: 10000000,
      volumeZScore: 1.5,
    },
    expected: {
      volatility: 'medium',
      direction: 'long',
      volume: 'high',
      trending: 'trending',
    }
  },
  {
    name: 'Low Volatility Range',
    data: {
      atrPct: 2.1,
      ema20: 50000,
      ema50: 50050,
      adx: 15,
      volume: 6000000,
      volumeMA: 10000000,
      volumeZScore: -0.8,
    },
    expected: {
      volatility: 'low',
      direction: 'neutral',
      volume: 'low',
      trending: 'ranging',
    }
  },
  {
    name: 'High Volatility Bear Market',
    data: {
      atrPct: 8.5,
      ema20: 48000,
      ema50: 50000,
      adx: 28,
      volume: 12000000,
      volumeMA: 10000000,
      volumeZScore: 0.6,
    },
    expected: {
      volatility: 'high',
      direction: 'short',
      volume: 'high',
      trending: 'trending',
    }
  },
  {
    name: 'Normal Conditions',
    data: {
      atrPct: 4.0,
      ema20: 50500,
      ema50: 50000,
      adx: 22,
      volume: 10000000,
      volumeMA: 10000000,
      volumeZScore: 0.0,
    },
    expected: {
      volatility: 'medium',
      direction: 'long',
      volume: 'normal',
      trending: 'ranging', // ADX 22 with medium ATR -> ranging
    }
  },
];

// Test each scenario
let passCount = 0;
let failCount = 0;

for (const scenario of marketScenarios) {
  console.log(`\n📊 Scenario: ${scenario.name}`);
  console.log(`   Market Data:`, {
    ATR: `${scenario.data.atrPct}%`,
    EMA20: scenario.data.ema20,
    EMA50: scenario.data.ema50,
    ADX: scenario.data.adx,
    Volume: `$${(scenario.data.volume / 1000000).toFixed(1)}M`,
    VolumeMA: `$${(scenario.data.volumeMA / 1000000).toFixed(1)}M`,
    VolumeZScore: scenario.data.volumeZScore.toFixed(2),
  });

  // Classify regimes
  const volatility = classifyVolatilityRegime(scenario.data.atrPct);
  const direction = classifyDirectionBias(scenario.data.ema20, scenario.data.ema50);
  const volume = classifyVolumeRegime(
    scenario.data.volume,
    scenario.data.volumeMA,
    scenario.data.volumeZScore
  );
  const trending = classifyTrendingRanging(scenario.data.adx, scenario.data.atrPct);

  console.log(`   Classified Regimes:`, {
    volatility,
    direction,
    volume,
    trending,
  });

  // Verify expectations
  const results = {
    volatility: volatility === scenario.expected.volatility,
    direction: direction === scenario.expected.direction,
    volume: volume === scenario.expected.volume,
    trending: trending === scenario.expected.trending,
  };

  const allCorrect = Object.values(results).every(r => r);
  if (allCorrect) {
    console.log(`   ✅ All regimes classified correctly`);
    passCount++;
  } else {
    console.log(`   ❌ Some regimes misclassified:`, results);
    console.log(`   Expected:`, scenario.expected);
    failCount++;
  }

  // Simulate parameter selection priority
  console.log(`   Parameter Selection Priority:`);
  console.log(`   1. ${volatility}_volatility (volatility regime)`);
  console.log(`   2. ${volume}_volume (volume regime)`);
  console.log(`   3. ${trending} (market structure)`);
  console.log(`   4. ${direction}_bias (direction bias)`);
  console.log(`   5. default (fallback)`);
}

// Summary
console.log(`\n${'='.repeat(60)}`);
console.log(`📊 Integration Test Summary`);
console.log(`   Total Scenarios: ${marketScenarios.length}`);
console.log(`   Passed: ${passCount} ✅`);
console.log(`   Failed: ${failCount} ${failCount > 0 ? '❌' : ''}`);
console.log(`${'='.repeat(60)}\n`);

if (failCount > 0) {
  console.error('❌ Integration test failed');
  process.exit(1);
} else {
  console.log('✅ Integration test passed!\n');
  console.log('🎉 All regime classification components work correctly together');
  process.exit(0);
}
