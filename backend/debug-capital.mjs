import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Check users
  const users = await prisma.user.findMany({ select: { id: true, username: true } });
  console.log('Users:', users);
  
  const user = users[0];
  if (!user) {
    console.log('No users found');
    return;
  }
  
  // Check sessions for this user
  const sessions = await prisma.agentSession.findMany({
    where: { userId: user.id, mode: 'paper' },
    select: { id: true, symbol: true, mode: true }
  });
  console.log('\nPaper sessions:', sessions.length);
  
  // Check KPIs
  const kpis = await prisma.sessionKpi.findMany({
    where: {
      session: {
        userId: user.id,
        mode: 'paper'
      }
    },
    select: { sessionId: true, realizedPnlUsd: true }
  });
  console.log('KPIs found:', kpis.length);
  
  let total = 0;
  kpis.forEach(k => {
    console.log('  Session', k.sessionId.slice(0,8), ': $' + (k.realizedPnlUsd || 0).toFixed(2));
    total += k.realizedPnlUsd || 0;
  });
  console.log('\nTOTAL PNL:', total.toFixed(2));
  
  // Check user setting
  const setting = await prisma.userSetting.findUnique({
    where: {
      userId_key: {
        userId: user.id,
        key: 'paperTradingCapital'
      }
    }
  });
  console.log('\nPaper Capital Setting:', setting?.value || 'NOT SET (default 10000)');
  
  const paperBalance = parseFloat(setting?.value || '10000');
  console.log('\n=== EXPECTED ===');
  console.log('Initial:', paperBalance);
  console.log('PnL:', total.toFixed(2));
  console.log('Actual Balance:', (paperBalance + total).toFixed(2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
