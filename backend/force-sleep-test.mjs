import { prisma } from './src/db/client.js';

async function forceSleepModeTest() {
  console.log('🧪 Testing sleep mode by forcing opportunity scan...');

  // Get all smart agents
  const sessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null,
      OR: [
        { isSmartAgent: true },
        { profileJson: { path: ['isIntelligent'], equals: true } },
        { profileJson: { path: ['isSmartAgent'], equals: true } }
      ]
    }
  });

  console.log(`Found ${sessions.length} smart agents`);

  if (sessions.length === 0) {
    console.log('No smart agents found, exiting');
    return;
  }

  for (const session of sessions) {
    console.log(`\n🧪 Testing session ${session.id} (${session.symbol})`);

    // Temporarily modify the selectedAt to be 13 hours ago to bypass hold period
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
    const config = session.profileJson || {};

    const oldSelectedAt = config.selectedAt;
    config.selectedAt = thirteenHoursAgo.toISOString();

    console.log(`Modified selectedAt from ${oldSelectedAt} to ${config.selectedAt}`);

    await prisma.agentSession.update({
      where: { id: session.id },
      data: { profileJson: config }
    });

    console.log(`Updated database for session ${session.id}`);
  }

  console.log('All sessions updated, now running opportunity check...');

  // Now run the check
  const { checkSmartOpportunities } = await import('./src/services/smartAgent.js');
  await checkSmartOpportunities();

  console.log('\n✅ Sleep mode test completed');
}

forceSleepModeTest().catch(console.error);