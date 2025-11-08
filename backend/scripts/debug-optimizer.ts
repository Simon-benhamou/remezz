import { prisma, Prisma } from '../src/db/client.js';

async function debugOptimizer() {
  console.log('🔍 Debug: Why BTC/USDT shows insufficient data\n');

  // Step 1: Get raw evaluations
  const rawEvaluations = await prisma.tradeEvaluation.findMany({
    where: {
      symbol: 'BTC/USDT',
      marketOutcome: { not: Prisma.JsonNull },
    },
    orderBy: { timestamp: 'desc' },
    take: 1000,
  });

  console.log(`Step 1: Raw evaluations with outcomes: ${rawEvaluations.length}`);

  // Step 2: Filter complete data
  const evaluations = rawEvaluations
    .filter((e) => e.marketOutcome && typeof e.marketOutcome === 'object')
    .map((e) => ({
      inputMetrics: e.inputMetrics as any,
      marketOutcome: e.marketOutcome as any,
    }));

  console.log(`Step 2: Evaluations with complete data: ${evaluations.length}`);

  if (evaluations.length > 0) {
    console.log('\nSample inputMetrics:', JSON.stringify(evaluations[0].inputMetrics, null, 2));
    console.log('\nSample marketOutcome:', JSON.stringify(evaluations[0].marketOutcome, null, 2));
  }

  await prisma.$disconnect();
}

debugOptimizer();
