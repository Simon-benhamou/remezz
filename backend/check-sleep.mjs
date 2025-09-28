import { prisma } from './src/db/client.js';

async function checkAgentSleepStatus() {
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: {
      id: true,
      symbol: true,
      currentSymbol: true,
      profileJson: true,
      planJson: true
    }
  });

  console.log('=== ÉTAT DES AGENTS ===');
  sessions.forEach(s => {
    const profile = s.profileJson;
    const plan = s.planJson;
    console.log(`${s.id}: ${s.symbol} | Sleep: ${profile?.sleepMode ? 'YES' : 'NO'} | NextScan: ${profile?.nextScanDue || 'N/A'}`);
    if (profile?.sleepMode) {
      console.log(`  Reason: ${profile.sleepReason}`);
    }
    if (plan?.intelligentHistory) {
      const lastAction = plan.intelligentHistory[plan.intelligentHistory.length - 1];
      console.log(`  Last action: ${lastAction?.action} at ${lastAction?.timestamp}`);
    }
  });
}

checkAgentSleepStatus().catch(console.error);