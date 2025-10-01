#!/usr/bin/env node
/**
 * Test du nouveau système AI Ranking
 * Pipeline: Volume Filter → AI Analysis → Ranked Opportunities
 */

import { getAIRankedOpportunities } from './dist/ai/cryptoRanking.js';

async function main() {
  try {
    console.log('🚀 Testing AI-Powered Crypto Ranking System\n');
    console.log('=' .repeat(80));
    
    // Force refresh to get real-time data
    const opportunities = await getAIRankedOpportunities({ 
      forceRefresh: true,
      useCache: false 
    });
    
    if (opportunities.length === 0) {
      console.log('❌ No opportunities found');
      return;
    }
    
    console.log('\n📊 AI RANKING RESULTS');
    console.log('='.repeat(80));
    console.log(`Found ${opportunities.length} ranked opportunities\n`);
    
    // Display top 10
    console.log('🏆 TOP 10 OPPORTUNITIES FOR NEXT 24H:\n');
    
    opportunities.slice(0, 10).forEach((opp, index) => {
      console.log(`${index + 1}. ${opp.symbol}`);
      console.log(`   Score: ${opp.score.toFixed(2)} | Confidence: ${(opp.opportunity.confidence * 100).toFixed(0)}%`);
      console.log(`   Type: ${opp.opportunity.type} | Direction: ${opp.opportunity.direction}`);
      console.log(`   Volume: $${(opp.volumeUsd24h / 1_000_000).toFixed(2)}M | Change 24h: ${opp.change24h > 0 ? '+' : ''}${opp.change24h.toFixed(2)}%`);
      console.log(`   Technical: RSI ${opp.technical.rsi.toFixed(1)} | ADX ${opp.technical.adx.toFixed(1)} | ATR ${opp.technical.atrPct.toFixed(2)}%`);
      console.log(`   Trend: ${opp.technical.trend}`);
      console.log(`   AI Reasoning:`);
      opp.aiReasoning.forEach(reason => {
        console.log(`      • ${reason}`);
      });
      console.log('');
    });
    
    console.log('='.repeat(80));
    console.log('\n✅ Best opportunity for auto-select agent:');
    const best = opportunities[0];
    console.log(`   ${best.symbol} - Score: ${best.score.toFixed(2)}`);
    console.log(`   Direction: ${best.opportunity.direction} ${best.opportunity.type}`);
    console.log(`   Confidence: ${(best.opportunity.confidence * 100).toFixed(0)}%`);
    console.log(`   Primary reason: ${best.aiReasoning[0]}`);
    
    console.log('\n🎯 SYSTEM PERFORMANCE:');
    console.log(`   Total opportunities: ${opportunities.length}`);
    console.log(`   High confidence (>70%): ${opportunities.filter(o => o.opportunity.confidence > 0.7).length}`);
    console.log(`   Long opportunities: ${opportunities.filter(o => o.opportunity.direction === 'long').length}`);
    console.log(`   Short opportunities: ${opportunities.filter(o => o.opportunity.direction === 'short').length}`);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
