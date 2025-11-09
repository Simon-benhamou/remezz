import { prisma, Prisma } from '../src/db/client.js';

async function check() {
  console.log('Checking TradeEvaluation counts...\n');
  
  // Total
  const total = await prisma.tradeEvaluation.count();
  console.log('1. Total records:', total);
  
  // With marketOutcome not null (Prisma)
  const withOutcomePrisma = await prisma.tradeEvaluation.count({
    where: { marketOutcome: { not: Prisma.JsonNull } }
  });
  console.log('2. With marketOutcome (Prisma.JsonNull check):', withOutcomePrisma);
  
  // With marketOutcome not null (raw SQL)
  const withOutcomeSQL = await prisma.$queryRaw<[{count: bigint}]>`
    SELECT COUNT(*) as count 
    FROM "TradeEvaluation" 
    WHERE "marketOutcome" IS NOT NULL
  `;
  console.log('3. With marketOutcome (SQL IS NOT NULL):', Number(withOutcomeSQL[0].count));
  
  // With marketOutcome not null and not 'null' string
  const withValidOutcome = await prisma.$queryRaw<[{count: bigint}]>`
    SELECT COUNT(*) as count 
    FROM "TradeEvaluation" 
    WHERE "marketOutcome" IS NOT NULL 
    AND "marketOutcome" != 'null'::jsonb
  `;
  console.log('4. With valid marketOutcome (not null/"null"):', Number(withValidOutcome[0].count));
  
  // Check for null vs 'null'
  const nullValues = await prisma.$queryRaw<[{count: bigint}]>`
    SELECT COUNT(*) as count 
    FROM "TradeEvaluation" 
    WHERE "marketOutcome" = 'null'::jsonb
  `;
  console.log('5. With marketOutcome = "null" (JSON null):', Number(nullValues[0].count));
  
  // Show sample of what marketOutcome looks like
  const samples = await prisma.$queryRaw<Array<{symbol: string, marketOutcome: any}>>`
    SELECT symbol, "marketOutcome"
    FROM "TradeEvaluation"
    WHERE "marketOutcome" IS NOT NULL
    ORDER BY "createdAt" DESC
    LIMIT 5
  `;
  console.log('\n6. Sample marketOutcome values (recent):');
  samples.forEach((s, i) => {
    console.log(`   [${i+1}] ${s.symbol}: ${JSON.stringify(s.marketOutcome)}`);
  });
  
  await prisma.$disconnect();
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
