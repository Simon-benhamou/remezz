// Test crypto ranking with predictor filter
import { rankCryptosWithAI, getTop50CryptosByVolume } from './dist/src/ai/cryptoRanking.js';
import { isPythonPredictorAvailable } from './dist/src/quantai/pythonPredictor.js';

async function testCryptoRanking() {
  console.log('='.repeat(80));
  console.log('🧪 CRYPTO RANKING WITH PREDICTOR FILTER TEST');
  console.log('='.repeat(80));
  
  // Check predictor availability
  const predictorAvailable = isPythonPredictorAvailable();
  console.log(`\n🤖 Python Predictor: ${predictorAvailable ? '✅ Available' : '❌ Not Available'}`);
  
  if (!predictorAvailable) {
    console.error('⚠️ Warning: Predictor not available, filter will be skipped!');
  }
  
  console.log('\n📊 STEP 1: Getting top 50 cryptos by volume...');
  const top50 = await getTop50CryptosByVolume();
  console.log(`✅ Found ${top50.length} cryptos with sufficient volume`);
  console.log('\nTop 10 by volume:');
  top50.slice(0, 10).forEach((crypto, idx) => {
    console.log(`  ${idx + 1}. ${crypto.symbol.padEnd(15)} | $${(crypto.volumeUsd24h / 1e6).toFixed(2)}M | ${crypto.change24h >= 0 ? '+' : ''}${crypto.change24h.toFixed(2)}%`);
  });
  
  console.log('\n📊 STEP 2: Running AI ranking with predictor filter...');
  console.log('(This will take ~30-60 seconds)\n');
  
  const startTime = Date.now();
  const ranked = await rankCryptosWithAI(top50, { useCache: false, forceRefresh: true });
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '='.repeat(80));
  console.log(`✅ RANKING COMPLETE (${duration}s)`);
  console.log('='.repeat(80));
  
  console.log(`\n📈 Total ranked: ${ranked.length}/${top50.length} cryptos`);
  console.log(`   Filtered out: ${top50.length - ranked.length} cryptos (${((top50.length - ranked.length) / top50.length * 100).toFixed(1)}%)`);
  
  if (ranked.length === 0) {
    console.error('\n❌ No cryptos passed the filters!');
    return;
  }
  
  // Analyze predictor decisions
  const longDecisions = ranked.filter(r => r.opportunity.direction === 'long');
  const shortDecisions = ranked.filter(r => r.opportunity.direction === 'short');
  const neutralDecisions = ranked.filter(r => r.opportunity.direction === 'neutral');
  
  console.log(`\n🎯 Predictor Decisions:`);
  console.log(`   - LONG:    ${longDecisions.length} (${(longDecisions.length / ranked.length * 100).toFixed(1)}%)`);
  console.log(`   - SHORT:   ${shortDecisions.length} (${(shortDecisions.length / ranked.length * 100).toFixed(1)}%)`);
  console.log(`   - NEUTRAL: ${neutralDecisions.length} (${(neutralDecisions.length / ranked.length * 100).toFixed(1)}%)`);
  
  // Show top 20 ranked cryptos with predictor predictions
  console.log('\n' + '='.repeat(80));
  console.log('TOP 20 RANKED CRYPTOS WITH PREDICTOR PREDICTIONS');
  console.log('='.repeat(80));
  console.log('\nRank | Symbol         | Score | Direction | Confidence | Volume     | Change  | Reasoning');
  console.log('-'.repeat(100));
  
  ranked.slice(0, 20).forEach(crypto => {
    const symbol = crypto.symbol.padEnd(14);
    const score = crypto.score.toFixed(2).padStart(5);
    const direction = crypto.opportunity.direction.toUpperCase().padEnd(8);
    const confidence = `${(crypto.opportunity.confidence * 100).toFixed(1)}%`.padStart(6);
    const volume = `$${(crypto.volumeUsd24h / 1e6).toFixed(0)}M`.padStart(10);
    const change = `${crypto.change24h >= 0 ? '+' : ''}${crypto.change24h.toFixed(1)}%`.padStart(7);
    const reasoning = crypto.aiReasoning[0] || 'N/A';
    
    console.log(`${crypto.rank.toString().padStart(4)} | ${symbol} | ${score} | ${direction} | ${confidence} | ${volume} | ${change} | ${reasoning.substring(0, 50)}${reasoning.length > 50 ? '...' : ''}`);
  });
  
  // Export detailed results
  console.log('\n' + '='.repeat(80));
  console.log('📄 DETAILED RESULTS (First 10)');
  console.log('='.repeat(80));
  
  ranked.slice(0, 10).forEach(crypto => {
    console.log(`\n🔹 ${crypto.symbol} (Rank #${crypto.rank})`);
    console.log(`   Score: ${crypto.score.toFixed(3)}`);
    console.log(`   Volume 24h: $${(crypto.volumeUsd24h / 1e6).toFixed(2)}M`);
    console.log(`   Change 24h: ${crypto.change24h >= 0 ? '+' : ''}${crypto.change24h.toFixed(2)}%`);
    console.log(`   Technical:`);
    console.log(`      - RSI: ${crypto.technical.rsi.toFixed(1)}`);
    console.log(`      - ADX: ${crypto.technical.adx.toFixed(1)}`);
    console.log(`      - ATR%: ${crypto.technical.atrPct.toFixed(2)}%`);
    console.log(`      - Trend: ${crypto.technical.trend}`);
    console.log(`   Opportunity:`);
    console.log(`      - Type: ${crypto.opportunity.type}`);
    console.log(`      - Direction: ${crypto.opportunity.direction.toUpperCase()}`);
    console.log(`      - Confidence: ${(crypto.opportunity.confidence * 100).toFixed(1)}%`);
    console.log(`   AI Reasoning:`);
    crypto.aiReasoning.forEach((reason, idx) => {
      console.log(`      ${idx + 1}. ${reason}`);
    });
  });
  
  // Summary statistics
  console.log('\n' + '='.repeat(80));
  console.log('📊 SUMMARY STATISTICS');
  console.log('='.repeat(80));
  
  const avgScore = ranked.reduce((sum, c) => sum + c.score, 0) / ranked.length;
  const avgConfidence = ranked.reduce((sum, c) => sum + c.opportunity.confidence, 0) / ranked.length;
  const avgVolume = ranked.reduce((sum, c) => sum + c.volumeUsd24h, 0) / ranked.length;
  const avgRsi = ranked.reduce((sum, c) => sum + c.technical.rsi, 0) / ranked.length;
  const avgAdx = ranked.reduce((sum, c) => sum + c.technical.adx, 0) / ranked.length;
  
  console.log(`\nAverage Score: ${avgScore.toFixed(3)}`);
  console.log(`Average Confidence: ${(avgConfidence * 100).toFixed(1)}%`);
  console.log(`Average Volume: $${(avgVolume / 1e6).toFixed(2)}M`);
  console.log(`Average RSI: ${avgRsi.toFixed(1)}`);
  console.log(`Average ADX: ${avgAdx.toFixed(1)}`);
  
  // Export to JSON for further analysis
  const exportData = {
    timestamp: new Date().toISOString(),
    duration: `${duration}s`,
    totalCandidates: top50.length,
    totalRanked: ranked.length,
    filterRate: `${((top50.length - ranked.length) / top50.length * 100).toFixed(1)}%`,
    decisions: {
      long: longDecisions.length,
      short: shortDecisions.length,
      neutral: neutralDecisions.length,
    },
    statistics: {
      avgScore,
      avgConfidence,
      avgVolume,
      avgRsi,
      avgAdx,
    },
    top20: ranked.slice(0, 20).map(c => ({
      rank: c.rank,
      symbol: c.symbol,
      score: c.score,
      direction: c.opportunity.direction,
      confidence: c.opportunity.confidence,
      volumeUsd24h: c.volumeUsd24h,
      change24h: c.change24h,
      technical: c.technical,
      reasoning: c.aiReasoning,
    })),
  };
  
  const fs = await import('fs');
  const outputPath = './crypto-ranking-test-results.json';
  fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
  console.log(`\n💾 Results exported to: ${outputPath}`);
  
  console.log('\n' + '='.repeat(80));
  console.log('✅ TEST COMPLETE');
  console.log('='.repeat(80));
}

// Run test
testCryptoRanking().catch(error => {
  console.error('\n❌ TEST FAILED:', error);
  console.error(error.stack);
  process.exit(1);
});
