/**
 * Test script to verify symbol profiles are created automatically
 */
import { prisma } from '../src/db/client.js';
import { ensureSymbolProfile } from '../src/services/symbolSpecificOptimization.js';

async function testProfileCreation() {
  console.log('🧪 Testing automatic profile creation...\n');

  const testSymbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT'];

  for (const symbol of testSymbols) {
    console.log(`\n📊 Testing ${symbol}...`);
    
    // Check if profile exists before
    const before = await prisma.$queryRaw<any[]>`
      SELECT symbol, tier, optimization_status 
      FROM symbol_profiles 
      WHERE symbol = ${symbol}
    `;
    
    console.log(`Before: ${before.length > 0 ? 'EXISTS' : 'DOES NOT EXIST'}`);
    if (before.length > 0) {
      console.log(`  Tier: ${before[0].tier}, Status: ${before[0].optimization_status}`);
    }

    // Call ensureSymbolProfile
    await ensureSymbolProfile(symbol);

    // Check after
    const after = await prisma.$queryRaw<any[]>`
      SELECT symbol, tier, optimization_status, created_at, notes 
      FROM symbol_profiles 
      WHERE symbol = ${symbol}
    `;

    console.log(`After: ${after.length > 0 ? '✅ EXISTS' : '❌ DOES NOT EXIST'}`);
    if (after.length > 0) {
      console.log(`  Tier: ${after[0].tier}`);
      console.log(`  Status: ${after[0].optimization_status}`);
      console.log(`  Created: ${after[0].created_at}`);
      console.log(`  Notes: ${after[0].notes || 'none'}`);
    }
  }

  console.log('\n✅ Test complete!');
}

testProfileCreation()
  .catch((err) => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
