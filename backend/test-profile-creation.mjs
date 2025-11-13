#!/usr/bin/env node
/**
 * Test script to verify symbol profile creation when starting an agent
 */

import { prisma } from './dist/src/db/client.js';
import { ensureSymbolProfile } from './dist/src/services/symbolSpecificOptimization.js';

const TEST_SYMBOL = 'TEST/USDT:USDT';

async function testProfileCreation() {
  console.log('🧪 Testing symbol profile creation during agent startup\n');

  try {
    // Step 1: Check if profile exists before
    console.log(`Step 1: Checking if profile exists for ${TEST_SYMBOL}...`);
    const beforeQuery = await prisma.$queryRaw`
      SELECT * FROM symbol_profiles WHERE symbol = ${TEST_SYMBOL}
    `.catch(err => {
      console.log(`   ⚠️  Query failed: ${err.message}`);
      return [];
    });

    console.log(`   Result: ${beforeQuery.length > 0 ? 'EXISTS' : 'DOES NOT EXIST'}`);
    
    if (beforeQuery.length > 0) {
      console.log(`\n🗑️  Cleaning up existing profile for clean test...`);
      await prisma.$executeRaw`
        DELETE FROM symbol_profiles WHERE symbol = ${TEST_SYMBOL}
      `;
      console.log(`   ✅ Cleaned up`);
    }

    // Step 2: Call ensureSymbolProfile (simulating agent creation)
    console.log(`\nStep 2: Calling ensureSymbolProfile('${TEST_SYMBOL}')...`);
    await ensureSymbolProfile(TEST_SYMBOL);

    // Step 3: Check if profile was created
    console.log(`\nStep 3: Verifying profile was created...`);
    const afterQuery = await prisma.$queryRaw`
      SELECT * FROM symbol_profiles WHERE symbol = ${TEST_SYMBOL}
    `.catch(err => {
      console.log(`   ❌ Query failed: ${err.message}`);
      return [];
    });

    if (afterQuery.length > 0) {
      console.log(`   ✅ SUCCESS! Profile was created:`);
      const profile = afterQuery[0];
      console.log(`      Symbol: ${profile.symbol}`);
      console.log(`      Tier: ${profile.tier}`);
      console.log(`      Status: ${profile.optimization_status}`);
      console.log(`      Notes: ${profile.notes}`);
    } else {
      console.log(`   ❌ FAILURE! Profile was NOT created`);
      console.log(`   This indicates a problem with ensureSymbolProfile()`);
    }

    // Step 4: Test with a real crypto symbol
    console.log(`\n\nStep 4: Testing with real symbol (BTC/USDT:USDT)...`);
    await ensureSymbolProfile('BTC/USDT:USDT');
    
    const btcProfile = await prisma.$queryRaw`
      SELECT * FROM symbol_profiles WHERE symbol = 'BTC/USDT:USDT'
    `.catch(() => []);
    
    if (btcProfile.length > 0) {
      console.log(`   ✅ BTC profile ${btcProfile[0].created_at ? 'exists' : 'created'}`);
    } else {
      console.log(`   ❌ BTC profile creation failed`);
    }

    console.log(`\n✅ Test completed!`);

  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

testProfileCreation();
