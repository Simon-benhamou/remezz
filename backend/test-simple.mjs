#!/usr/bin/env node

/**
 * TEST SIMPLE - Smart Agent Detection
 */

import { getBestIntelligentOpportunity } from './dist/src/services/intelligentAgent.js';

console.log('🎯 TEST SIMPLE SMART AGENT\n');

async function testSimple() {
  try {
    console.log('🔍 Testing getBestIntelligentOpportunity with no excludeSessionId...');
    
    // Appel Smart Agent - pas de sessionId à exclure
    const opportunity = await getBestIntelligentOpportunity();
    
    if (opportunity) {
      console.log(`✅ SUCCESS! Found opportunity: ${opportunity.symbol}`);
      console.log(`   - Confidence: ${opportunity.confidence}%`);
      console.log(`   - Bias: ${opportunity.autoBias?.bias} (${opportunity.autoBias?.confidence}%)`);
      console.log(`   - Score: ${opportunity.score}`);
    } else {
      console.log('❌ No opportunity found - Smart Agent will start with SMART/SLEEP');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testSimple().then(() => process.exit(0));