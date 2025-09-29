import { getBestIntelligentOpportunity, scanIntelligentOpportunities, getActiveAgentCountForSymbol } from './dist/src/services/intelligentAgent.js';

console.log('🧪 TESTING PHASE 2 & PHASE 3 IMPROVEMENTS');
console.log('=' .repeat(60));

async function testImprovements() {
  try {
    // Test 1: High volatility detection (simulated based on opportunities)
    console.log('\n📊 Test 1: High Volatility Mode Detection (Simulated)');
    console.log('-'.repeat(40));
    console.log('Note: Testing enhanced opportunity detection logic');
    
    // Test 2: Multi-agent count for popular symbols
    console.log('\n👥 Test 2: Multi-Agent Count Testing');
    console.log('-'.repeat(40));
    const testSymbols = ['BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'SOL/USDT'];
    for (const symbol of testSymbols) {
      try {
        const count = await getActiveAgentCountForSymbol(symbol);
        console.log(`${symbol}: ${count} active agents`);
      } catch (error) {
        console.log(`${symbol}: Error getting count - ${error.message}`);
      }
    }
    
    // Test 3: Enhanced opportunity scanning
    console.log('\n🎯 Test 3: Enhanced Opportunity Scanning');
    console.log('-'.repeat(40));
    
    const opportunities = await scanIntelligentOpportunities();
    console.log(`Found ${opportunities.length} total opportunities`);
    
    if (opportunities.length > 0) {
      console.log('\n📈 Top 5 opportunities with enhanced scoring:');
      opportunities.slice(0, 5).forEach((opp, i) => {
        console.log(`  ${i+1}. ${opp.symbol}:`);
        console.log(`     Score: ${opp.score.toFixed(2)}, Confidence: ${(opp.confidence * 100).toFixed(1)}%`);
        console.log(`     Momentum: ${opp.metrics.momentum.toFixed(2)}%, Volume: $${(opp.metrics.volume24h/1000000).toFixed(1)}M`);
        console.log(`     Volatility: ${opp.metrics.volatility.toFixed(3)}, Trend: ${opp.metrics.trend.toFixed(2)}`);
      });
    }
    
    // Test 4: Priority system for strong movements
    console.log('\n🚀 Test 4: Strong Movement Priority System');
    console.log('-'.repeat(40));
    
    const strongMovers = opportunities.filter(o => Math.abs(o.metrics.momentum) > 3.0);
    console.log(`Strong movements (>3%): ${strongMovers.length} found`);
    
    strongMovers.forEach(opp => {
      console.log(`  🔥 ${opp.symbol}: ${opp.metrics.momentum.toFixed(2)}% momentum (${opp.opportunity.direction})`);
    });
    
    // Test 5: Best opportunity selection with new logic
    console.log('\n🎯 Test 5: Best Opportunity Selection');
    console.log('-'.repeat(40));
    
    const bestOpp = await getBestIntelligentOpportunity();
    if (bestOpp) {
      console.log(`✅ Selected: ${bestOpp.symbol}`);
      console.log(`   Score: ${bestOpp.score.toFixed(2)}`);
      console.log(`   Confidence: ${(bestOpp.confidence * 100).toFixed(1)}%`);
      console.log(`   Momentum: ${bestOpp.metrics.momentum.toFixed(2)}%`);
      console.log(`   Volume: $${(bestOpp.metrics.volume24h/1000000).toFixed(1)}M`);
      console.log(`   Reasoning: ${bestOpp.reasoning.summary}`);
      console.log(`   Direction: ${bestOpp.opportunity.direction}`);
      console.log(`   Expected Return: ${bestOpp.opportunity.expectedReturn.toFixed(2)}%`);
    } else {
      console.log('❌ No opportunity selected');
    }
    
    // Test 6: Performance comparison
    console.log('\n📊 Test 6: Performance Analysis');
    console.log('-'.repeat(40));
    
    const majorCryptos = opportunities.filter(o => 
      ['BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'SOL/USDT', 'ADA/USDT', 'AVAX/USDT', 'DOT/USDT'].includes(o.symbol)
    );
    
    console.log('Major crypto performance:');
    majorCryptos.forEach(crypto => {
      const eligible = crypto.metrics.volume24h >= 100000000; // $100M minimum
      console.log(`  ${crypto.symbol}: ${crypto.metrics.momentum.toFixed(2)}% | $${(crypto.metrics.volume24h/1000000).toFixed(1)}M | ${eligible ? '✅ Eligible' : '❌ Low Volume'}`);
    });
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Stack:', error.stack);
  }
}

testImprovements();