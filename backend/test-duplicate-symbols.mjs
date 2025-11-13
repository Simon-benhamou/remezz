#!/usr/bin/env node
/**
 * Test script to verify that creating multiple smart agents in parallel
 * results in different symbols being selected (no duplicates)
 */

import { startAgentCreation } from './dist/src/services/agentCreationFlow.js';
import { prisma } from './dist/src/db/client.js';

const TEST_USER_ID = 'cmhhhwem70000pe65r748lnlu';

async function testParallelAgentCreation() {
  console.log('🧪 Testing parallel smart agent creation to prevent duplicate symbols\n');

  const payload = {
    mode: 'paper',
    smartAuto: true,
    aggressiveness: 'moderate',
    maxLeverage: 7,
    startBalanceUsd: 1000,
  };

  try {
    console.log('Step 1: Creating 3 smart agents simultaneously...\n');
    
    const startTime = Date.now();
    
    // Launch 3 agent creations in parallel
    const results = await Promise.all([
      startAgentCreation(payload, TEST_USER_ID).catch(err => ({ error: err.message || String(err), fullError: err })),
      startAgentCreation(payload, TEST_USER_ID).catch(err => ({ error: err.message || String(err), fullError: err })),
      startAgentCreation(payload, TEST_USER_ID).catch(err => ({ error: err.message || String(err), fullError: err })),
    ]);

    const duration = Date.now() - startTime;
    console.log(`⏱️  Total time: ${duration}ms\n`);

    console.log('Step 2: Analyzing results...\n');

    const symbols = [];
    const sessionIds = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.error) {
        console.log(`   Agent ${i + 1}: ❌ Error - ${result.error}`);
        if (result.fullError && result.fullError.details) {
          console.log(`      Details:`, JSON.stringify(result.fullError.details, null, 2));
        }
      } else {
        console.log(`   Agent ${i + 1}: ✅ Created`);
        console.log(`      Symbol: ${result.symbol}`);
        console.log(`      Session ID: ${result.sessionId}`);
        console.log(`      State: ${result.state}`);
        symbols.push(result.symbol);
        sessionIds.push(result.sessionId);
      }
      console.log();
    }

    console.log('Step 3: Checking for duplicates...\n');

    const uniqueSymbols = new Set(symbols);
    
    if (uniqueSymbols.size === symbols.length) {
      console.log(`   ✅ SUCCESS! All ${symbols.length} agents have different symbols:`);
      symbols.forEach((sym, idx) => {
        console.log(`      Agent ${idx + 1}: ${sym}`);
      });
    } else {
      console.log(`   ❌ FAILURE! Found duplicate symbols:`);
      const duplicates = symbols.filter((sym, idx) => symbols.indexOf(sym) !== idx);
      console.log(`      Duplicates: ${[...new Set(duplicates)].join(', ')}`);
      console.log(`      Unique: ${uniqueSymbols.size}/${symbols.length}`);
    }

    console.log('\nStep 4: Verifying database state...\n');

    const dbSessions = await prisma.agentSession.findMany({
      where: {
        id: { in: sessionIds },
      },
      select: {
        id: true,
        symbol: true,
        stoppedAt: true,
      },
    });

    console.log(`   Found ${dbSessions.length} sessions in database:`);
    dbSessions.forEach((session, idx) => {
      const status = session.stoppedAt ? '🔴 Stopped' : '🟢 Active';
      console.log(`      ${status} ${session.symbol} (${session.id.slice(0, 8)}...)`);
    });

    console.log('\nStep 5: Cleanup - stopping test agents...\n');

    for (const sessionId of sessionIds) {
      try {
        await prisma.agentSession.update({
          where: { id: sessionId },
          data: { stoppedAt: new Date() },
        });
        console.log(`   ✅ Stopped session ${sessionId.slice(0, 8)}...`);
      } catch (err) {
        console.log(`   ⚠️  Failed to stop session ${sessionId.slice(0, 8)}...: ${err.message}`);
      }
    }

    console.log('\n' + '═'.repeat(70));
    if (uniqueSymbols.size === symbols.length && symbols.length > 0) {
      console.log('✅ TEST PASSED: No duplicate symbols detected!');
    } else {
      console.log('❌ TEST FAILED: Duplicate symbols were created!');
    }
    console.log('═'.repeat(70) + '\n');

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testParallelAgentCreation();
