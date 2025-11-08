/**
 * Manual Script to Run Strategy Optimizer and Build Symbol Profiles
 * 
 * This script can be run manually to:
 * 1. Check available trade evaluation data
 * 2. Run the strategy optimizer
 * 3. Build symbol profiles
 * 4. Display results
 * 
 * Usage:
 *   npm run tsx scripts/run-optimizer-manual.ts
 * or:
 *   node --loader tsx scripts/run-optimizer-manual.ts
 */

import { prisma, Prisma } from '../src/db/client.js';
import { optimizeAllSymbols } from '../src/learning/strategyOptimizer.js';
import { 
  optimizeAllActiveSymbols, 
  getSymbolProfile, 
  initializeSymbolProfiles 
} from '../src/services/symbolSpecificOptimization.js';

async function main() {
  console.log('=' .repeat(80));
  console.log('🚀 RUNNING STRATEGY OPTIMIZER AND BUILDING SYMBOL PROFILES');
  console.log('=' .repeat(80));
  console.log('');

  try {
    // Step 1: Check data availability
    console.log('📊 STEP 1: Checking available trade evaluation data...\n');
    
    const evaluationCount = await prisma.tradeEvaluation.count({
      where: {
        marketOutcome: { not: Prisma.JsonNull },
      },
    });

    console.log(`   Total trade evaluations with outcomes: ${evaluationCount}`);

    if (evaluationCount === 0) {
      console.log('\n⚠️  WARNING: No trade evaluation data found!');
      console.log('   Cannot run optimizer without historical data.');
      console.log('   Please run the system for a while to collect data first.\n');
      return;
    }

    // Get symbol breakdown
    const symbolCounts = await prisma.$queryRaw<Array<{ symbol: string; count: bigint }>>`
      SELECT symbol, COUNT(*) as count
      FROM "TradeEvaluation"
      WHERE "marketOutcome" IS NOT NULL
      GROUP BY symbol
      ORDER BY count DESC
    `;

    console.log(`\n   Symbols with data:`);
    symbolCounts.forEach(row => {
      console.log(`      - ${row.symbol}: ${row.count} evaluations`);
    });

    // Step 2: Initialize symbol profiles table
    console.log('\n📋 STEP 2: Initializing symbol profiles table...\n');
    await initializeSymbolProfiles();
    console.log('   ✅ Symbol profiles table ready\n');

    // Step 3: Run strategy optimizer
    console.log('🔍 STEP 3: Running strategy optimizer (regime-aware)...\n');
    console.log('   This may take a few minutes depending on the amount of data...\n');
    
    const startTime = Date.now();
    const optimizerResults = await optimizeAllSymbols({ regimeAware: true });
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\n   ✅ Strategy optimizer completed in ${duration}s`);
    console.log(`      Symbols optimized: ${optimizerResults.size}\n`);
    
    if (optimizerResults.size > 0) {
      console.log('   Optimized symbols:');
      optimizerResults.forEach((params, symbol) => {
        const regimeCount = Object.keys(params).length;
        console.log(`      - ${symbol}: ${regimeCount} regime parameter sets`);
      });
    }

    // Step 4: Build symbol profiles
    console.log('\n🏗️  STEP 4: Building symbol-specific optimization profiles...\n');
    
    const profileStartTime = Date.now();
    const profileResults = await optimizeAllActiveSymbols(30); // 30 days lookback
    const profileDuration = ((Date.now() - profileStartTime) / 1000).toFixed(2);
    
    console.log(`\n   ✅ Symbol profiles completed in ${profileDuration}s`);
    console.log(`      Optimized: ${profileResults.optimized.length}`);
    console.log(`      Skipped: ${profileResults.skipped.length} (insufficient data or low Sharpe)`);
    console.log(`      Failed: ${profileResults.failed.length}\n`);
    
    if (profileResults.optimized.length > 0) {
      console.log('   Successfully optimized profiles:');
      profileResults.optimized.forEach(symbol => {
        console.log(`      - ${symbol}`);
      });
    }
    
    if (profileResults.skipped.length > 0) {
      console.log('\n   Skipped symbols:');
      profileResults.skipped.forEach(symbol => {
        console.log(`      - ${symbol}`);
      });
    }

    if (profileResults.failed.length > 0) {
      console.log('\n   Failed symbols:');
      profileResults.failed.forEach(symbol => {
        console.log(`      - ${symbol}`);
      });
    }

    // Step 5: Verify profiles
    console.log('\n🔎 STEP 5: Verifying created profiles...\n');
    
    const allOptimizedSymbols = Array.from(new Set([
      ...Array.from(optimizerResults.keys()),
      ...profileResults.optimized,
    ]));

    let profilesFound = 0;
    let profilesMissing = 0;

    for (const symbol of allOptimizedSymbols) {
      const profile = await getSymbolProfile(symbol);
      if (profile) {
        profilesFound++;
        console.log(`   ✅ ${symbol}:`);
        console.log(`      Status: ${profile.optimizationStatus}`);
        console.log(`      Tier: ${profile.tier}`);
        if (profile.customThresholds) {
          console.log(`      Custom thresholds: confidence=${profile.customThresholds.confidence}, atr=${profile.customThresholds.atr}`);
        }
        if (profile.performanceMetrics) {
          console.log(`      Performance: ${profile.performanceMetrics.totalTrades} trades, ` +
                     `${(profile.performanceMetrics.winRate * 100).toFixed(1)}% win rate, ` +
                     `Sharpe ${profile.performanceMetrics.sharpeRatio?.toFixed(2) || 'N/A'}`);
        }
      } else {
        profilesMissing++;
        console.log(`   ⚠️  ${symbol}: Profile not found`);
      }
    }

    // Step 6: Summary
    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log(`   Trade evaluations found: ${evaluationCount}`);
    console.log(`   Unique symbols in data: ${symbolCounts.length}`);
    console.log(`   Strategy parameters optimized: ${optimizerResults.size}`);
    console.log(`   Symbol profiles created: ${profileResults.optimized.length}`);
    console.log(`   Profiles verified: ${profilesFound}/${allOptimizedSymbols.length}`);
    console.log(`   Total time: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
    console.log('');

    if (profilesMissing > 0) {
      console.log(`⚠️  Warning: ${profilesMissing} profiles could not be retrieved`);
    }

    console.log('✅ ALL DONE!\n');
    console.log('You can now:');
    console.log('   1. View profiles in the database: SELECT * FROM symbol_profiles;');
    console.log('   2. Check personality profiles: SELECT * FROM "CryptoPersonalityProfile";');
    console.log('   3. Use the frontend to view and manage profiles\n');

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    if (error instanceof Error) {
      console.error('   Message:', error.message);
      console.error('   Stack:', error.stack);
    }
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
main()
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
