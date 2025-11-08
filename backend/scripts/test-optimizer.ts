/**
 * Test Script for Strategy Optimizer and Symbol Profiles
 * 
 * This script tests:
 * 1. Running the strategy optimizer on collected data
 * 2. Building symbol profiles for each symbol
 * 3. Retrieving the profiles to verify they were created
 */

import { prisma, Prisma } from '../src/db/client.js';
import { optimizeAllSymbols } from '../src/learning/strategyOptimizer.js';
import { 
  optimizeAllActiveSymbols, 
  getSymbolProfile, 
  initializeSymbolProfiles 
} from '../src/services/symbolSpecificOptimization.js';

async function main() {
  console.log('🧪 Testing Strategy Optimizer and Symbol Profiles\n');

  try {
    // Step 1: Check available data
    console.log('📊 Step 1: Checking available trade evaluation data...');
    const symbols = await prisma.tradeEvaluation.findMany({
      where: {
        marketOutcome: { not: Prisma.JsonNull },
      },
      select: { 
        symbol: true,
        timestamp: true,
      },
      orderBy: { timestamp: 'desc' },
      take: 1000,
    });

    const symbolCounts = new Map<string, number>();
    symbols.forEach(row => {
      symbolCounts.set(row.symbol, (symbolCounts.get(row.symbol) || 0) + 1);
    });

    console.log(`   Found ${symbols.length} total trade evaluations`);
    console.log(`   Unique symbols: ${symbolCounts.size}`);
    console.log('\n   Symbol breakdown:');
    Array.from(symbolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([symbol, count]) => {
        console.log(`      ${symbol}: ${count} evaluations`);
      });

    if (symbols.length === 0) {
      console.log('\n⚠️  No trade evaluation data found. Cannot run optimizer.');
      console.log('   Please collect some trading data first.');
      return;
    }

    // Step 2: Initialize symbol profiles table
    console.log('\n📋 Step 2: Initializing symbol profiles table...');
    await initializeSymbolProfiles();
    console.log('   ✅ Symbol profiles table initialized');

    // Step 3: Run strategy optimizer
    console.log('\n🔍 Step 3: Running strategy optimizer for all symbols...');
    console.log('   (Always regime-aware)');
    const optimizerResults = await optimizeAllSymbols();
    
    console.log(`\n   ✅ Strategy optimizer completed:`);
    console.log(`      Symbols optimized: ${optimizerResults.size}`);
    optimizerResults.forEach((params, symbol) => {
      console.log(`      - ${symbol}: ${Object.keys(params).length} regime parameters`);
    });

    // Step 4: Build symbol profiles
    console.log('\n🏗️  Step 4: Building symbol-specific optimization profiles...');
    const profileResults = await optimizeAllActiveSymbols(30);
    
    console.log(`\n   ✅ Symbol profiles completed:`);
    console.log(`      Optimized: ${profileResults.optimized.length}`);
    console.log(`      Skipped: ${profileResults.skipped.length}`);
    console.log(`      Failed: ${profileResults.failed.length}`);
    
    if (profileResults.optimized.length > 0) {
      console.log('\n   Optimized symbols:');
      profileResults.optimized.forEach(symbol => {
        console.log(`      - ${symbol}`);
      });
    }
    
    if (profileResults.skipped.length > 0) {
      console.log('\n   Skipped symbols (insufficient data or low Sharpe):');
      profileResults.skipped.forEach(symbol => {
        console.log(`      - ${symbol}`);
      });
    }

    // Step 5: Retrieve and verify profiles
    console.log('\n🔎 Step 5: Retrieving symbol profiles to verify creation...');
    
    const allSymbols = Array.from(new Set([
      ...Array.from(optimizerResults.keys()),
      ...profileResults.optimized,
    ]));

    console.log(`\n   Checking ${allSymbols.length} symbols...`);
    
    for (const symbol of allSymbols) {
      const profile = await getSymbolProfile(symbol);
      if (profile) {
        console.log(`\n   ✅ ${symbol}:`);
        console.log(`      Tier: ${profile.tier}`);
        console.log(`      Status: ${profile.optimizationStatus}`);
        console.log(`      Custom thresholds: ${profile.customThresholds ? 'Yes' : 'No'}`);
        if (profile.performanceMetrics) {
          console.log(`      Metrics:`);
          console.log(`         - Total trades: ${profile.performanceMetrics.totalTrades}`);
          console.log(`         - Win rate: ${(profile.performanceMetrics.winRate * 100).toFixed(1)}%`);
          console.log(`         - Sharpe ratio: ${profile.performanceMetrics.sharpeRatio?.toFixed(2) || 'N/A'}`);
          console.log(`         - Avg PnL: ${profile.performanceMetrics.avgPnlPct?.toFixed(2)}%`);
        }
      } else {
        console.log(`   ⚠️  ${symbol}: Profile not found`);
      }
    }

    // Step 6: Check personality profiles
    console.log('\n📝 Step 6: Checking CryptoPersonalityProfile table...');
    const personalityProfiles = await prisma.cryptoPersonalityProfile.findMany({
      select: {
        symbol: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    console.log(`   Found ${personalityProfiles.length} personality profiles`);
    personalityProfiles.forEach(profile => {
      console.log(`      - ${profile.symbol} (updated: ${profile.updatedAt.toISOString()})`);
    });

    console.log('\n✅ Test completed successfully!');
    console.log('\nSummary:');
    console.log(`   - Trade evaluations found: ${symbols.length}`);
    console.log(`   - Unique symbols: ${symbolCounts.size}`);
    console.log(`   - Strategy parameters optimized: ${optimizerResults.size}`);
    console.log(`   - Symbol profiles created: ${profileResults.optimized.length}`);
    console.log(`   - Personality profiles saved: ${personalityProfiles.length}`);

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
