#!/usr/bin/env tsx
/**
 * Upgrade ALL existing profiles to regime-aware structure
 * Processes every profile in the database, not just active ones
 */

import { prisma } from '../src/db/client.js';
import { DEFAULT_REGIME_PARAMS } from '../src/learning/personalityProfile.js';

async function upgradeAllProfiles() {
  console.log('🔄 Upgrading ALL profiles to regime-aware structure...\n');

  // Get all existing profiles
  const allProfiles = await prisma.cryptoPersonalityProfile.findMany({
    select: {
      symbol: true,
      optimalParams: true,
    },
  });

  console.log(`📦 Found ${allProfiles.length} total profiles\n`);

  let alreadyRegimeAware = 0;
  let upgraded = 0;
  let failed = 0;

  for (const profile of allProfiles) {
    try {
      const params = profile.optimalParams as any;

      // Check if already regime-aware
      if (params && typeof params === 'object' && 'default' in params) {
        console.log(`  ⏭️  ${profile.symbol}: Already regime-aware, skipping`);
        alreadyRegimeAware++;
        continue;
      }

      // Has old simple params, upgrade to regime-aware
      if (params && typeof params === 'object' && 'weights' in params) {
        console.log(`  ⬆️  ${profile.symbol}: Upgrading to regime-aware structure`);
        
        await prisma.cryptoPersonalityProfile.update({
          where: { symbol: profile.symbol },
          data: {
            optimalParams: {
              ...DEFAULT_REGIME_PARAMS, // All regime defaults
              default: params, // Keep learned params as default
            } as any,
            updatedAt: new Date(),
          },
        });
        
        upgraded++;
      } else {
        // Invalid or empty params, replace with full defaults
        console.log(`  🔧 ${profile.symbol}: Invalid params, replacing with defaults`);
        
        await prisma.cryptoPersonalityProfile.update({
          where: { symbol: profile.symbol },
          data: {
            optimalParams: DEFAULT_REGIME_PARAMS as any,
            updatedAt: new Date(),
          },
        });
        
        upgraded++;
      }
    } catch (error) {
      console.error(`  ❌ ${profile.symbol}: Failed -`, error);
      failed++;
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  ⏭️  Already regime-aware: ${alreadyRegimeAware}`);
  console.log(`  ⬆️  Upgraded: ${upgraded}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📦 Total: ${allProfiles.length}`);

  await prisma.$disconnect();
}

upgradeAllProfiles().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
