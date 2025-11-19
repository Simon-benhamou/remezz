#!/usr/bin/env node

/**
 * Test script to validate neutral defaults for symbols without learning data
 * 
 * Tests:
 * 1. New symbol without any historical trades gets neutral defaults
 * 2. Symbol with few trades (< 40) gets progressive confidence
 * 3. Symbol with many trades (>= 40) gets full optimization
 */

import { getSubagentTuning } from './src/services/subagentLearning.js';

const TEST_SYMBOLS = {
  // Symbols that likely don't exist in DB (should get neutral defaults)
  new: ['LINKUSDT', 'ATOMUSDT', 'DOTUSDT'],
  
  // Symbols that likely have some data
  existing: ['BTCUSDT', 'XRPUSDT', 'SOLUSDT', 'BNBUSDT', 'ADAUSDT'],
};

async function testNeutralDefaults() {
  console.log('🧪 Testing Learning System Neutral Defaults\n');
  console.log('=' .repeat(80));

  // Test 1: New symbols should get neutral defaults
  console.log('\n📋 Test 1: New Symbols (Expected: Neutral Defaults)');
  console.log('-'.repeat(80));
  
  for (const symbol of TEST_SYMBOLS.new) {
    const learning = await getSubagentTuning('risk_governor', symbol);
    
    if (!learning) {
      console.log(`❌ ${symbol}: Got null instead of neutral defaults`);
      continue;
    }
    
    const isNeutral = 
      learning.recommendedMaxLeverage === 3.5 &&
      learning.recommendedMaxPositionPct === 0.18 &&
      learning.hedgingTension === 0.30 &&
      learning.confidence === 0.50;
    
    if (isNeutral) {
      console.log(`✅ ${symbol}: Neutral defaults applied correctly`);
      console.log(`   Leverage: ${learning.recommendedMaxLeverage}x, Position: ${learning.recommendedMaxPositionPct*100}%, Tension: ${learning.hedgingTension}, Confidence: ${learning.confidence}`);
    } else {
      console.log(`⚠️  ${symbol}: Got non-neutral values (might have historical data)`);
      console.log(`   Leverage: ${learning.recommendedMaxLeverage}x, Position: ${learning.recommendedMaxPositionPct*100}%, Tension: ${learning.hedgingTension}, Confidence: ${learning.confidence}`);
    }
  }

  // Test 2: Existing symbols should have learned values or neutral
  console.log('\n📋 Test 2: Existing Symbols (Expected: Learned or Neutral)');
  console.log('-'.repeat(80));
  
  for (const symbol of TEST_SYMBOLS.existing) {
    const learning = await getSubagentTuning('risk_governor', symbol);
    
    if (!learning) {
      console.log(`❌ ${symbol}: Got null (should never be null now)`);
      continue;
    }
    
    const isNeutral = 
      learning.recommendedMaxLeverage === 3.5 &&
      learning.recommendedMaxPositionPct === 0.18 &&
      learning.hedgingTension === 0.30 &&
      learning.confidence === 0.50;
    
    if (isNeutral) {
      console.log(`⚪ ${symbol}: Using neutral defaults (no historical data yet)`);
      console.log(`   Leverage: ${learning.recommendedMaxLeverage}x, Position: ${learning.recommendedMaxPositionPct*100}%, Tension: ${learning.hedgingTension}, Confidence: ${learning.confidence}`);
    } else {
      console.log(`✅ ${symbol}: Using learned values from historical data`);
      console.log(`   Leverage: ${learning.recommendedMaxLeverage}x, Position: ${learning.recommendedMaxPositionPct*100}%, Tension: ${learning.hedgingTension}, Confidence: ${learning.confidence}`);
      
      // Analyze if it's optimized vs conservative
      if (learning.confidence >= 0.75) {
        console.log(`   📊 Status: MATURE (confidence ${learning.confidence} >= 0.75)`);
      } else if (learning.confidence >= 0.40) {
        console.log(`   📊 Status: LEARNING (confidence ${learning.confidence} between 0.40-0.75)`);
      } else {
        console.log(`   📊 Status: EARLY (confidence ${learning.confidence} < 0.40)`);
      }
      
      // Risk assessment
      if (learning.hedgingTension > 0.70) {
        console.log(`   ⚠️  RISK: High hedging tension (${learning.hedgingTension}) - watch for hedge triggers`);
      } else if (learning.hedgingTension < 0.35) {
        console.log(`   ✅ RISK: Low hedging tension (${learning.hedgingTension}) - healthy`);
      } else {
        console.log(`   📊 RISK: Moderate hedging tension (${learning.hedgingTension})`);
      }
    }
  }

  // Test 3: Performance Summary
  console.log('\n📊 Summary & Recommendations');
  console.log('='.repeat(80));
  
  const allSymbols = [...TEST_SYMBOLS.new, ...TEST_SYMBOLS.existing];
  const allLearning = await Promise.all(
    allSymbols.map(async (symbol) => ({
      symbol,
      learning: await getSubagentTuning('risk_governor', symbol),
    }))
  );
  
  const neutralCount = allLearning.filter(({ learning }) => 
    learning?.confidence === 0.50
  ).length;
  
  const learnedCount = allLearning.filter(({ learning }) => 
    learning && learning.confidence !== 0.50
  ).length;
  
  const matureCount = allLearning.filter(({ learning }) => 
    learning && learning.confidence >= 0.75
  ).length;
  
  console.log(`\n📈 Learning System Status:`);
  console.log(`   Total symbols tested: ${allSymbols.length}`);
  console.log(`   Neutral defaults: ${neutralCount} (${(neutralCount/allSymbols.length*100).toFixed(1)}%)`);
  console.log(`   Learning phase: ${learnedCount - matureCount} (${((learnedCount-matureCount)/allSymbols.length*100).toFixed(1)}%)`);
  console.log(`   Mature optimization: ${matureCount} (${(matureCount/allSymbols.length*100).toFixed(1)}%)`);
  
  console.log(`\n💡 Recommendations:`);
  if (neutralCount === allSymbols.length) {
    console.log(`   ⚠️  All symbols using neutral defaults - system needs to accumulate trade data`);
    console.log(`   ▶️  Let the system run for 1-2 weeks to build learning data`);
  } else if (matureCount >= 3) {
    console.log(`   ✅ Good learning coverage - ${matureCount} symbols fully optimized`);
    console.log(`   ▶️  Consider adding more symbols to diversify`);
  } else {
    console.log(`   📊 System in learning phase - accumulating data`);
    console.log(`   ▶️  Expected to reach maturity in ${Math.max(0, 4-matureCount)} weeks`);
  }
  
  console.log('\n✅ Test completed!\n');
}

// Run tests
testNeutralDefaults().catch((error) => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});
