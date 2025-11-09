#!/usr/bin/env tsx
/**
 * Migrate existing TradeEvaluation records from old to new decision values
 * Old: "executed" → New: "filter_passed"
 * Old: "blocked" → New: "filter_blocked"
 */

import { prisma } from '../src/db/client.js';

async function migrateDecisions() {
  console.log('🔄 Migrating TradeEvaluation decision values...\n');

  // Count existing records
  const total = await prisma.tradeEvaluation.count();
  const executed = await prisma.tradeEvaluation.count({ where: { decision: 'executed' } });
  const blocked = await prisma.tradeEvaluation.count({ where: { decision: 'blocked' } });

  console.log(`Current state:`);
  console.log(`  Total: ${total}`);
  console.log(`  "executed": ${executed}`);
  console.log(`  "blocked": ${blocked}\n`);

  // Migrate "executed" → "filter_passed"
  console.log('Migrating "executed" → "filter_passed"...');
  const executedUpdate = await prisma.tradeEvaluation.updateMany({
    where: { decision: 'executed' },
    data: { decision: 'filter_passed' }
  });
  console.log(`✅ Updated ${executedUpdate.count} records\n`);

  // Migrate "blocked" → "filter_blocked"
  console.log('Migrating "blocked" → "filter_blocked"...');
  const blockedUpdate = await prisma.tradeEvaluation.updateMany({
    where: { decision: 'blocked' },
    data: { decision: 'filter_blocked' }
  });
  console.log(`✅ Updated ${blockedUpdate.count} records\n`);

  // Verify final state
  const filterPassed = await prisma.tradeEvaluation.count({ where: { decision: 'filter_passed' } });
  const filterBlocked = await prisma.tradeEvaluation.count({ where: { decision: 'filter_blocked' } });

  console.log('Final state:');
  console.log(`  "filter_passed": ${filterPassed}`);
  console.log(`  "filter_blocked": ${filterBlocked}\n`);

  console.log('✅ Migration complete!');
  console.log('\nNew decision values now track full execution flow:');
  console.log('  filter_passed  - Entry filters passed');
  console.log('  filter_blocked - Entry filters failed');
  console.log('  order_placed   - Order successfully placed (ACTUAL TRADE)');
  console.log('  order_blocked_capital - Capital reservation failed');
  console.log('  order_blocked_sizing - Position sizing qty=0');
  console.log('  order_blocked_registration - Predictor/cooldown block');
  console.log('  order_rejected - Broker rejected order');

  await prisma.$disconnect();
}

migrateDecisions().catch(console.error);
