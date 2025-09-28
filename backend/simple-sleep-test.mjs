import { prisma } from './src/db/client.js';

async function simpleSleepTest() {
  console.log('🧪 Simple sleep mode test...');

  // Get one smart agent
  const session = await prisma.agentSession.findFirst({
    where: {
      stoppedAt: null,
      OR: [
        { isSmartAgent: true },
        { profileJson: { path: ['isIntelligent'], equals: true } },
        { profileJson: { path: ['isSmartAgent'], equals: true } }
      ]
    }
  });

  if (!session) {
    console.log('No smart agents found');
    return;
  }

  console.log(`Testing session ${session.id} (${session.symbol})`);

  // Modify selectedAt to be 13 hours ago
  const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000);
  const config = session.profileJson || {};
  config.selectedAt = thirteenHoursAgo.toISOString();

  await prisma.agentSession.update({
    where: { id: session.id },
    data: { profileJson: config }
  });

  console.log(`Modified selectedAt to ${config.selectedAt}`);

  // Test getBestIntelligentOpportunity directly
  console.log('Testing getBestIntelligentOpportunity...');
  const { getBestIntelligentOpportunity } = await import('./src/services/intelligentAgent.js');

  const result = await getBestIntelligentOpportunity(session.id);
  console.log(`Result: ${result ? `Found ${result.symbol}` : 'No opportunities found'}`);

  console.log('✅ Simple test completed');
}

simpleSleepTest().catch(console.error);