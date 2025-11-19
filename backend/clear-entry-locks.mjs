/**
 * Clear all entry locks from agent sessions
 * This fixes the "Risk governor requires hedge" blocking issue
 */

import { prisma } from './src/db/client.js';

async function clearAllEntryLocks() {
  console.log('🔓 Clearing all entry locks...\n');

  const sessions = await prisma.agentSession.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      symbol: true,
      mode: true,
      profileJson: true,
    },
  });

  console.log(`Found ${sessions.length} active sessions\n`);

  let clearedCount = 0;
  let alreadyClearCount = 0;

  for (const session of sessions) {
    const profile = session.profileJson || {};
    const entryLock = profile.entryLock;

    if (entryLock && entryLock.active) {
      console.log(`  ⚠️  ${session.symbol} (${session.mode}) - LOCKED`);
      console.log(`      Reason: ${entryLock.reason || 'unknown'}`);
      console.log(`      Since: ${entryLock.since || 'unknown'}`);

      // Clear the lock
      profile.entryLock = {
        active: false,
        since: entryLock.since || new Date().toISOString(),
        reason: `${entryLock.reason || 'unknown'} [cleared by script]`,
        releasedAt: new Date().toISOString(),
        expiresAt: null,
        meta: entryLock.meta || null,
      };

      await prisma.agentSession.update({
        where: { id: session.id },
        data: { profileJson: profile },
      });

      console.log(`      ✅ CLEARED\n`);
      clearedCount++;
    } else {
      console.log(`  ✅ ${session.symbol} (${session.mode}) - No lock`);
      alreadyClearCount++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Locks cleared: ${clearedCount}`);
  console.log(`Already clear: ${alreadyClearCount}`);
  console.log(`Total sessions: ${sessions.length}`);

  await prisma.$disconnect();
}

clearAllEntryLocks()
  .then(() => {
    console.log('\n✅ Done! All entry locks cleared.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });
