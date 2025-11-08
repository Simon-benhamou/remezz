#!/usr/bin/env tsx
/**
 * Generate Base Personality Profiles Script
 * 
 * Creates initial personality profiles for all active trading symbols.
 * This serves as a starting point for the learning system.
 * 
 * Usage: npm run init-profiles
 */

import { prisma } from '../src/db/client.js';
import { savePersonalityProfile, DEFAULT_PARAMS } from '../src/learning/personalityProfile.js';

async function getActiveSymbols(): Promise<string[]> {
  try {
    // Get symbols from active agent sessions
    const sessions = await prisma.agentSession.findMany({
      where: {
        stoppedAt: null,
        haltedAt: null,
      },
      select: {
        symbol: true,
      },
      distinct: ['symbol'],
    });

    return sessions.map((s) => s.symbol).filter(Boolean);
  } catch (error) {
    console.error('Failed to fetch active symbols:', error);
    return [];
  }
}

async function generateBaseProfiles(): Promise<void> {
  console.log('🚀 Generating base personality profiles...\n');

  try {
    // Get all active symbols
    const symbols = await getActiveSymbols();

    if (symbols.length === 0) {
      console.log('⚠️ No active agent sessions found. No profiles to generate.');
      return;
    }

    console.log(`Found ${symbols.length} active symbols: ${symbols.join(', ')}\n`);

    let created = 0;
    let skipped = 0;

    for (const symbol of symbols) {
      try {
        // Check if profile already exists
        const existing = await prisma.cryptoPersonalityProfile.findUnique({
          where: { symbol },
        });

        if (existing) {
          console.log(`⏭️  ${symbol}: Profile already exists, skipping`);
          skipped++;
          continue;
        }

        // Create base profile with default parameters
        const success = await savePersonalityProfile(symbol, DEFAULT_PARAMS);

        if (success) {
          console.log(`✅ ${symbol}: Created base profile`);
          created++;
        } else {
          console.log(`❌ ${symbol}: Failed to create profile`);
        }
      } catch (error) {
        console.error(`❌ ${symbol}: Error creating profile:`, error);
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Created: ${created}`);
    console.log(`   Skipped (already exists): ${skipped}`);
    console.log(`   Total: ${symbols.length}`);

    if (created > 0) {
      console.log(`\n✅ Successfully initialized ${created} base personality profile(s)`);
      console.log('💡 These profiles will be automatically optimized as trade data accumulates.');
    }
  } catch (error) {
    console.error('❌ Failed to generate base profiles:', error);
    process.exit(1);
  }
}

// Run the script
generateBaseProfiles()
  .then(() => {
    console.log('\n✨ Done!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });
