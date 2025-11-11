import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking active sessions...\n');
  
  const sessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null
    },
    include: {
      SessionKpi: true,
      orders: { take: 3 },
      positions: { take: 1 }
    },
    take: 10
  });

  console.log(`Found ${sessions.length} active sessions\n`);

  for (const s of sessions) {
    console.log(`\n${s.symbol} (${s.id.substring(0, 10)}...)`);
    console.log(`  Status: ${s.status}`);
    console.log(`  Agent Type: ${s.agentType}`);
    console.log(`  Initial Balance: ${s.initialBalance}`);
    console.log(`  Orders: ${s.orders.length}`);
    console.log(`  Positions: ${s.positions.length}`);
    console.log(`  KPIs: ${s.SessionKpi.length}`);
    console.log(`  ProfileJson type: ${typeof s.profileJson}`);
    
    if (s.profileJson) {
      const profile = typeof s.profileJson === 'string' ? JSON.parse(s.profileJson) : s.profileJson;
      console.log(`  Profile keys: ${Object.keys(profile).join(', ')}`);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
