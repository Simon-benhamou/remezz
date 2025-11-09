#!/usr/bin/env tsx
/**
 * Seed default regime-aware profiles for all active symbols
 * This ensures every symbol has intelligent defaults even without learned data
 */

import { prisma } from '../src/db/client.js';
import { DEFAULT_REGIME_PARAMS } from '../src/learning/personalityProfile.js';

const ACTIVE_SYMBOLS = [
  'BTC/USDT',
  'BTC/USDT:USDT',
  'ETH/USDT',
  'ETH/USDT:USDT',
  'SOL/USDT',
  'SOL/USDT:USDT',
  'BNB/USDT',
  'XRP/USDT:USDT',
  'LTC/USDT',
  'LINK/USDT',
  'ADA/USDT',
  'AVAX/USDT',
  'DOT/USDT',
  'MATIC/USDT',
  'ATOM/USDT',
];

async function seedProfiles() {
  console.log('🌱 Seeding default regime-aware profiles...\n');

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const symbol of ACTIVE_SYMBOLS) {
    try {
      // Check if profile already exists with learned data
      const existing = await prisma.cryptoPersonalityProfile.findUnique({
        where: { symbol },
      });

      if (existing) {
        const params = existing.optimalParams as any;
        // Check if it has regime-aware structure
        if (params && 'default' in params) {
          console.log(`  ⏭️  ${symbol}: Already has regime-aware profile, skipping`);
          skipped++;
          continue;
        } else if (params && 'weights' in params) {
          // Has old simple params, upgrade to regime-aware
          console.log(`  ⬆️  ${symbol}: Upgrading to regime-aware structure`);
          await prisma.cryptoPersonalityProfile.update({
            where: { symbol },
            data: {
              optimalParams: {
                ...DEFAULT_REGIME_PARAMS, // Add all regimes
                default: params, // Override default with existing learned params
              } as any,
              updatedAt: new Date(),
            },
          });
          updated++;
          continue;
        }
      }

      // Create new profile with intelligent defaults
      await prisma.cryptoPersonalityProfile.create({
        data: {
          symbol,
          optimalParams: DEFAULT_REGIME_PARAMS as any,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      console.log(`  ✅ ${symbol}: Created default regime-aware profile`);
      created++;
    } catch (error) {
      console.error(`  ❌ ${symbol}: Failed -`, error);
    }
  }

  console.log('\n📊 Summary:');
  console.log(`  ✅ Created: ${created}`);
  console.log(`  ⬆️  Updated: ${updated}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  📦 Total: ${ACTIVE_SYMBOLS.length}`);

  await prisma.$disconnect();
}

seedProfiles().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
