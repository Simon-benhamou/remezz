#!/usr/bin/env node
/**
 * Test script: Create multiple smart agents sequentially with small delays
 * to verify they select different symbols
 */

import { startAgentCreation } from './dist/src/services/agentCreationFlow.js';
import { prisma } from './dist/src/db/client.js';

const TEST_USER_ID = 'cmhhhwem70000pe65r748lnlu';
const AGENT_COUNT = 3;
const DELAY_MS = 100; // Small delay between creations

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSequentialAgentCreation() {
  console.log(`🧪 Testing sequential smart agent creation (${AGENT_COUNT} agents)\n`);
  console.log(`⏱️  Delay between creations: ${DELAY_MS}ms\n`);

  const payload = {
    mode: 'paper',
    smartAuto: true,
    aggressiveness: 'moderate',
    maxLeverage: 7,
    startBalanceUsd: 1000,
  };

  const results = [];
  const symbols = [];
  const sessionIds = [];

  try {
    console.log('Step 1: Creating agents sequentially...\n');
    
    for (let i = 0; i < AGENT_COUNT; i++) {
      console.log(`   Creating agent ${i + 1}/${AGENT_COUNT}...`);
      
      try {
        const result = await startAgentCreation(payload, TEST_USER_ID);
        results.push(result);
        symbols.push(result.symbol);
        sessionIds.push(result.sessionId);
        
        console.log(`      ✅ Success: ${result.symbol}`);
        console.log(`         Session: ${result.sessionId.slice(0, 12)}...`);
        console.log(`         State: ${result.state}`);
      } catch (error) {
        console.log(`      ❌ Error: ${error.message}`);
        if (error.details) {
          console.log(`         Details:`, JSON.stringify(error.details, null, 2));
        }
        results.push({ error: error.message });
      }
      
      if (i < AGENT_COUNT - 1) {
        await delay(DELAY_MS);
      }
      console.log();
    }

    console.log('Step 2: Analyzing symbol distribution...\n');

    const successCount = symbols.length;
    const uniqueSymbols = new Set(symbols);
    const uniqueCount = uniqueSymbols.size;
    
    console.log(`   Total agents created: ${successCount}/${AGENT_COUNT}`);
    console.log(`   Unique symbols: ${uniqueCount}`);
    console.log();

    if (successCount > 0) {
      console.log(`   Symbols selected:`);
      symbols.forEach((sym, idx) => {
        const isDuplicate = symbols.indexOf(sym) !== idx;
        const marker = isDuplicate ? '⚠️  DUPLICATE' : '✅';
        console.log(`      ${marker} Agent ${idx + 1}: ${sym}`);
      });
      console.log();
    }

    console.log('Step 3: Database verification...\n');

    if (sessionIds.length > 0) {
      const dbSessions = await prisma.agentSession.findMany({
        where: { id: { in: sessionIds } },
        select: { id: true, symbol: true, stoppedAt: true },
      });

      console.log(`   Found ${dbSessions.length} sessions in database:`);
      dbSessions.forEach((session) => {
        const status = session.stoppedAt ? '🔴' : '🟢';
        console.log(`      ${status} ${session.symbol} (${session.id.slice(0, 8)}...)`);
      });
      console.log();
    }

    console.log('Step 4: Cleanup...\n');

    for (const sessionId of sessionIds) {
      try {
        await prisma.agentSession.update({
          where: { id: sessionId },
          data: { stoppedAt: new Date() },
        });
        console.log(`   ✅ Stopped ${sessionId.slice(0, 12)}...`);
      } catch (err) {
        console.log(`   ⚠️  Failed to stop ${sessionId.slice(0, 12)}...`);
      }
    }

    console.log();
    console.log('═'.repeat(70));
    
    if (successCount === 0) {
      console.log('⚠️  NO AGENTS CREATED - Cannot test symbol distribution');
      console.log('   Possible reasons:');
      console.log('   - No trading opportunities found');
      console.log('   - All symbols already have active agents');
      console.log('   - Market conditions not suitable for smart auto');
    } else if (uniqueCount === successCount) {
      console.log('✅ TEST PASSED: All agents selected different symbols!');
      console.log(`   ${successCount} agents created with ${uniqueCount} unique symbols`);
    } else {
      console.log('❌ TEST FAILED: Duplicate symbols detected!');
      console.log(`   ${successCount} agents created but only ${uniqueCount} unique symbols`);
      const duplicates = symbols.filter((sym, idx) => symbols.indexOf(sym) !== idx);
      console.log(`   Duplicates: ${[...new Set(duplicates)].join(', ')}`);
    }
    
    console.log('═'.repeat(70));

  } catch (error) {
    console.error('\n❌ Fatal test error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testSequentialAgentCreation();
