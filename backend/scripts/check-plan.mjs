import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const s = await prisma.agentSession.findFirst({
  where: { symbol: 'BTC/USDT', stoppedAt: null },
  select: { symbol: true, planJson: true }
});

console.log('BTC planJson:', JSON.stringify(s?.planJson, null, 2));
console.log('typeof:', typeof s?.planJson);
console.log('is null?:', s?.planJson === null);
console.log('is object?:', typeof s?.planJson === 'object');
if (s?.planJson && typeof s?.planJson === 'object') {
  console.log('keys:', Object.keys(s.planJson));
  console.log('keys.length:', Object.keys(s.planJson).length);
}

await prisma.$disconnect();
