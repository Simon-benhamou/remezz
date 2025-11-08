import { prisma, Prisma } from '../src/db/client.js';

async function test() {
  const data = await prisma.tradeEvaluation.findMany({
    where: {
      symbol: 'BTC/USDT',
      marketOutcome: { not: Prisma.JsonNull }
    },
    take: 3,
    orderBy: { timestamp: 'desc' }
  });

  console.log('Found with `not: Prisma.JsonNull`:', data.length);
  
  if (data.length > 0) {
    console.log('\nSample:');
    console.log('- ID:', data[0].id);
    console.log('- Symbol:', data[0].symbol);
    console.log('- Decision:', data[0].decision);
    console.log('- marketOutcome:', JSON.stringify(data[0].marketOutcome, null, 2));
  }

  await prisma.$disconnect();
}

test();
