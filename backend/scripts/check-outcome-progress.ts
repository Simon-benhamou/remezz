import { prisma, Prisma } from '../src/db/client.js';

async function checkProgress() {
  const total = await prisma.tradeEvaluation.count();
  const withOutcome = await prisma.tradeEvaluation.count({
    where: { marketOutcome: { not: Prisma.JsonNull } }
  });
  const withNull = await prisma.tradeEvaluation.count({
    where: { marketOutcome: { equals: Prisma.JsonNull } }
  });

  console.log(`Total evaluations: ${total}`);
  console.log(`With outcomes: ${withOutcome}`);
  console.log(`Still null: ${withNull}`);
  console.log(`Progress: ${((withOutcome / total) * 100).toFixed(1)}%`);

  await prisma.$disconnect();
}

checkProgress();
