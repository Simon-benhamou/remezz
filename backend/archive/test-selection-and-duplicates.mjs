#!/usr/bin/env node
/**
 * Test: Vérifier sélection crypto avec nouveau user + bug doublons
 */

import { prepareAgentCreation, createSessionFromPrepared, activatePreparedAgent } from './dist/src/services/agentCreationFlow.js';
import { prisma } from './dist/src/db/client.js';

// Use existing test user
const TEST_USER_ID = 'cmhhhwem70000pe65r748lnlu';

async function cleanupTestSessions() {
  // Delete only sessions created by this test (identified by recent creation)
  const recentSessions = await prisma.tradingSession.findMany({
    where: {
      userId: TEST_USER_ID,
      createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } // Last 5 minutes
    }
  });
  
  if (recentSessions.length > 0) {
    await prisma.tradingSession.deleteMany({
      where: { id: { in: recentSessions.map(s => s.id) } }
    });
    console.log(`🧹 Cleaned up ${recentSessions.length} recent test sessions`);
  }
}

async function testCryptoSelection() {
  console.log('\n' + '═'.repeat(80));
  console.log('🧪 TEST: Sélection Crypto + Bug Doublons');
  console.log('═'.repeat(80) + '\n');

  try {
    console.log(`\n📋 Using test user: ${TEST_USER_ID}`);
    console.log(`   (Existing user - will test selection only)\n`);

    console.log('\n📊 Test 1: Création de 8 agents AUTO pour nouveau user');
    console.log('-'.repeat(80));

    const payload = {
      mode: 'paper',
      smartAutoMode: true,
      isSmartAgent: true,
      aggressiveness: 'reactive',
      riskPerTradePct: 1.0,
      maxLeverage: 7,
      dailyLossLimitPct: 3.0,
      startBalanceUsd: 2000,
      budgetPct: 50,
      strategyEngine: 'meta_adaptive',
    };

    const symbols = [];
    const creationIds = [];

    for (let i = 0; i < 8; i++) {
      console.log(`\n[Agent ${i+1}/8] Creating...`);
      
      try {
        // Prepare with excluded symbols
        const prepared = await prepareAgentCreation({
          ...payload,
          excludedSymbols: symbols, // Pass already used symbols
        }, TEST_USER_ID);

        const creationId = prepared.creationId;
        const selectedSymbol = prepared.selection?.symbol;

        console.log(`   ✓ Prepared: ${creationId.slice(0, 8)}...`);
        console.log(`   📊 Symbol: ${selectedSymbol}`);
        console.log(`   🔍 Source: ${prepared.selection?.source}`);
        console.log(`   🎯 Score: ${prepared.selection?.candidates?.[0]?.score?.toFixed(3) || 'N/A'}`);

        if (!selectedSymbol) {
          console.log(`   ❌ ERROR: No symbol selected!`);
          continue;
        }

        // Check for duplicate
        if (symbols.includes(selectedSymbol)) {
          console.log(`   🚨 DUPLICATE DETECTED: ${selectedSymbol} already used!`);
          console.log(`   Previous symbols: ${symbols.join(', ')}`);
        }

        // Create session
        const created = await createSessionFromPrepared(creationId);
        console.log(`   ✓ Session created: ${created.sessionId.slice(0, 8)}...`);

        // Activate
        await activatePreparedAgent(creationId);
        console.log(`   ✓ Agent activated`);

        symbols.push(selectedSymbol);
        creationIds.push(creationId);

        // Small delay
        if (i < 7) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        if (error.details) {
          console.log(`   Details:`, JSON.stringify(error.details, null, 2));
        }
      }
    }

    // Analyze results
    console.log('\n' + '═'.repeat(80));
    console.log('📊 RESULTS ANALYSIS');
    console.log('═'.repeat(80) + '\n');

    console.log(`Total agents created: ${symbols.length}/8`);
    console.log(`Unique symbols: ${new Set(symbols).size}/${symbols.length}`);
    console.log();

    // Check for BTC/ETH/SOL
    const majors = symbols.filter(s => ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'].includes(s));
    const tier2 = symbols.filter(s => ['XRP/USDT', 'BNB/USDT', 'ADA/USDT', 'AVAX/USDT'].includes(s));
    const others = symbols.filter(s => !majors.includes(s) && !tier2.includes(s));

    console.log('Symbols by tier:');
    console.log(`   🏆 Tier 1 (BTC/ETH/SOL): ${majors.length}`);
    majors.forEach(s => console.log(`      - ${s}`));
    console.log(`   🥈 Tier 2 (XRP/BNB/ADA/AVAX): ${tier2.length}`);
    tier2.forEach(s => console.log(`      - ${s}`));
    console.log(`   🥉 Others: ${others.length}`);
    others.forEach(s => console.log(`      - ${s}`));

    console.log();

    // Check for duplicates
    const duplicates = symbols.filter((s, idx) => symbols.indexOf(s) !== idx);
    if (duplicates.length > 0) {
      console.log('🚨 DUPLICATE BUG DETECTED!');
      console.log(`   Duplicates: ${[...new Set(duplicates)].join(', ')}`);
      console.log();
    } else {
      console.log('✅ NO DUPLICATES - Bug fixed!');
      console.log();
    }

    // Check tier1 presence
    if (majors.length === 0) {
      console.log('⚠️  WARNING: No tier1 cryptos (BTC/ETH/SOL) selected!');
      console.log('   Expected: At least 2-3 tier1 cryptos in top 8');
    } else if (majors.length >= 3) {
      console.log('🎯 EXCELLENT: 3+ tier1 cryptos selected!');
    } else if (majors.length >= 1) {
      console.log('✅ GOOD: Tier1 cryptos present');
    }

    console.log();

    // Final verdict
    const hasDuplicates = new Set(symbols).size < symbols.length;
    const hasMajors = majors.length >= 1;
    const hasGoodDistribution = majors.length + tier2.length >= 5;

    console.log('═'.repeat(80));
    if (!hasDuplicates && hasMajors && hasGoodDistribution) {
      console.log('🎉 TEST PASSED!');
      console.log('   ✅ No duplicates');
      console.log('   ✅ Tier1 cryptos present');
      console.log('   ✅ Good tier distribution');
    } else {
      console.log('⚠️  TEST ISSUES DETECTED:');
      if (hasDuplicates) console.log('   ❌ Duplicates found');
      if (!hasMajors) console.log('   ❌ No tier1 cryptos');
      if (!hasGoodDistribution) console.log('   ⚠️  Poor tier distribution');
    }
    console.log('═'.repeat(80));

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    console.error(error.stack);
  } finally {
    await cleanupTestSessions();
    await prisma.$disconnect();
  }
}

testCryptoSelection();
