#!/usr/bin/env node

/**
 * Test script to verify that conflict avoidance works correctly
 * when creating new smart agents.
 */

import { prisma } from '../dist/db/client.js';
import { getActiveAgentSymbols, getBestIntelligentOpportunity, getOptimizedCryptoList } from '../dist/services/intelligentAgent.js';

async function testConflictAvoidance() {
  console.log('🧪 Testing Conflict Avoidance Logic...\n');

  try {
    // Step 0: Create a test user first
    const testUser = await prisma.user.upsert({
      where: { email: 'test@conflict-avoidance.test' },
      create: {
        email: 'test@conflict-avoidance.test',
        username: 'test-conflict-user',
        passwordHash: 'test123'
      },
      update: {}
    });

    console.log(`✅ Created/found test user: ${testUser.id.substring(0, 8)}\n`);

    // Step 1: Create mock active sessions with DOGE
    const mockSession1 = await prisma.agentSession.create({
      data: {
        symbol: 'DOGE/USDT',
        mode: 'paper',
        userId: testUser.id,
        startedAt: new Date(),
        stoppedAt: null
      }
    });

    const mockSession2 = await prisma.agentSession.create({
      data: {
        symbol: 'ETH/USDT', 
        mode: 'paper',
        userId: testUser.id,
        startedAt: new Date(),
        stoppedAt: null
      }
    });

    console.log(`✅ Created mock sessions:`);
    console.log(`   - Session 1: ${mockSession1.id.substring(0, 8)} on ${mockSession1.symbol}`);
    console.log(`   - Session 2: ${mockSession2.id.substring(0, 8)} on ${mockSession2.symbol}\n`);

    // Step 2: Test getActiveAgentSymbols without exclusion
    console.log('🔍 Testing getActiveAgentSymbols without exclusion:');
    const activeSymbols = await getActiveAgentSymbols();
    console.log(`   Active symbols: ${activeSymbols.join(', ')}\n`);

    // Step 3: Test getActiveAgentSymbols with exclusion of session 1
    console.log(`🔍 Testing getActiveAgentSymbols excluding session ${mockSession1.id.substring(0, 8)}:`);
    const activeSymbolsExcluded = await getActiveAgentSymbols(mockSession1.id);
    console.log(`   Active symbols (excluding session 1): ${activeSymbolsExcluded.join(', ')}\n`);

    // Step 4: Test getOptimizedCryptoList without exclusion
    console.log('🔍 Testing getOptimizedCryptoList without exclusion:');
    const optimizedCryptos = await getOptimizedCryptoList();
    const containsDoge = optimizedCryptos.includes('DOGE/USDT');
    console.log(`   Contains DOGE/USDT: ${containsDoge}`);
    console.log(`   Top 5 cryptos: ${optimizedCryptos.slice(0, 5).join(', ')}\n`);

    // Step 5: Test getOptimizedCryptoList with exclusion (simulating new session creation)
    console.log('🔍 Testing getOptimizedCryptoList with exclusion (simulating new session):');
    const newSessionId = 'temp-session-id-for-test';
    const optimizedCryptosExcluded = await getOptimizedCryptoList(newSessionId);
    const containsDogeExcluded = optimizedCryptosExcluded.includes('DOGE/USDT');
    console.log(`   Contains DOGE/USDT: ${containsDogeExcluded}`);
    console.log(`   Top 5 cryptos: ${optimizedCryptosExcluded.slice(0, 5).join(', ')}\n`);

    // Step 6: Test getBestIntelligentOpportunity with exclusion
    console.log('🔍 Testing getBestIntelligentOpportunity with exclusion:');
    const bestOpportunityExcluded = await getBestIntelligentOpportunity(newSessionId);
    if (bestOpportunityExcluded) {
      console.log(`   Best opportunity: ${bestOpportunityExcluded.symbol} (score: ${bestOpportunityExcluded.score})`);
      console.log(`   Is DOGE: ${bestOpportunityExcluded.symbol === 'DOGE/USDT'}`);
    } else {
      console.log(`   No opportunities found`);
    }
    console.log();

    // Results
    console.log('📊 Test Results:');
    console.log(`   ✅ Active symbols detection: ${activeSymbols.length > 0 ? 'PASS' : 'FAIL'}`);
    console.log(`   ✅ Session exclusion: ${activeSymbolsExcluded.length < activeSymbols.length ? 'PASS' : 'FAIL'}`);
    console.log(`   ✅ DOGE filtered from list: ${!containsDogeExcluded ? 'PASS' : 'FAIL'}`);
    if (bestOpportunityExcluded) {
      console.log(`   ✅ DOGE not selected as best: ${bestOpportunityExcluded.symbol !== 'DOGE/USDT' ? 'PASS' : 'FAIL'}`);
    }

    // Cleanup
    await prisma.agentSession.delete({ where: { id: mockSession1.id } });
    await prisma.agentSession.delete({ where: { id: mockSession2.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    console.log(`\n🧹 Cleaned up mock sessions and test user`);

    const allTestsPassed = !containsDogeExcluded && 
                          activeSymbolsExcluded.length < activeSymbols.length &&
                          (!bestOpportunityExcluded || bestOpportunityExcluded.symbol !== 'DOGE/USDT');

    console.log(`\n${allTestsPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'} - Conflict avoidance is ${allTestsPassed ? 'working correctly' : 'NOT working'}`);

  } catch (error) {
    console.error('❌ Error during testing:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testConflictAvoidance();