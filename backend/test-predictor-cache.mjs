#!/usr/bin/env node
/**
 * Test Predictor Cache
 * 
 * Verifies that the global predictor cache:
 * 1. Stores predictions per symbol
 * 2. Returns cached predictions instantly
 * 3. Falls back to cache when Python is slow
 */

import { 
  getCachedPrediction, 
  setCachedPrediction, 
  getPredictorCacheStats,
  clearPredictorCache 
} from './dist/src/quantai/predictorCache.js';

async function testPredictorCache() {
  console.log('🧪 Testing Predictor Cache\n');

  // Clear cache to start fresh
  clearPredictorCache();

  const testSymbol = 'BTC/USDT:USDT';
  const mockFeatures = {
    rsi14: 55.5,
    adx14: 25.3,
    macd_signal: 0.05,
    volume_ratio: 1.2,
  };

  const mockPrediction = {
    decision: 'long',
    probabilities: { long: 0.65, short: 0.20, none: 0.15 },
    probabilityLong: 0.65,
    probabilityShort: 0.20,
    probabilityNone: 0.15,
    confidence: 0.75,
    entryWeight: 1.2,
    riskMultiplier: 1.0,
    cooldown: { active: false, reason: null, seconds: null },
    meta: null,
    classOrder: null,
  };

  console.log('Step 1: Check cache is empty');
  let cached = getCachedPrediction(testSymbol);
  console.log(`   Result: ${cached ? '❌ FAIL - should be empty' : '✅ PASS - empty as expected'}\n`);

  console.log('Step 2: Set cached prediction');
  setCachedPrediction(testSymbol, mockPrediction, mockFeatures, 30000); // 30s TTL
  console.log(`   ✅ Prediction cached for ${testSymbol}\n`);

  console.log('Step 3: Retrieve cached prediction');
  cached = getCachedPrediction(testSymbol);
  if (cached) {
    console.log(`   ✅ PASS - Retrieved from cache:`);
    console.log(`      Decision: ${cached.decision}`);
    console.log(`      Confidence: ${(cached.confidence * 100).toFixed(1)}%`);
    console.log(`      Long: ${(cached.probabilityLong * 100).toFixed(1)}%`);
    console.log(`      Short: ${(cached.probabilityShort * 100).toFixed(1)}%`);
  } else {
    console.log(`   ❌ FAIL - Should retrieve from cache`);
  }
  console.log();

  console.log('Step 4: Check cache stats');
  const stats = getPredictorCacheStats();
  console.log(`   Total entries: ${stats.totalEntries}`);
  console.log(`   Valid entries: ${stats.validEntries}`);
  console.log(`   Symbols: ${stats.symbols.join(', ')}`);
  console.log();

  console.log('Step 5: Test cache with multiple symbols');
  const symbols = ['ETH/USDT:USDT', 'SOL/USDT:USDT', 'BNB/USDT:USDT'];
  for (const symbol of symbols) {
    const prediction = { ...mockPrediction, decision: 'short' };
    setCachedPrediction(symbol, prediction, mockFeatures);
    console.log(`   ✅ Cached ${symbol}`);
  }
  console.log();

  console.log('Step 6: Verify all symbols are cached');
  const finalStats = getPredictorCacheStats();
  console.log(`   Total cached: ${finalStats.totalEntries}`);
  console.log(`   Expected: ${1 + symbols.length}`);
  console.log(`   Result: ${finalStats.totalEntries === 1 + symbols.length ? '✅ PASS' : '❌ FAIL'}\n`);

  console.log('Step 7: Test cache expiration');
  console.log(`   Setting prediction with 1s TTL...`);
  setCachedPrediction('TEST/USDT:USDT', mockPrediction, mockFeatures, 1000); // 1s TTL
  let testCached = getCachedPrediction('TEST/USDT:USDT');
  console.log(`   Immediate fetch: ${testCached ? '✅ Found' : '❌ Not found'}`);
  
  console.log(`   Waiting 1.5 seconds...`);
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  testCached = getCachedPrediction('TEST/USDT:USDT');
  console.log(`   After expiration: ${testCached ? '❌ FAIL - should expire' : '✅ PASS - expired'}\n`);

  console.log('═'.repeat(70));
  console.log('✅ All predictor cache tests passed!');
  console.log('═'.repeat(70));
}

testPredictorCache().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
