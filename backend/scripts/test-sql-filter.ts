import { prisma } from '../src/db/client.js';

async function testQuery() {
  const result = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE symbol = 'BTC/USDT'
      AND "marketOutcome" IS NOT NULL
      AND "marketOutcome" != 'null'::jsonb
  `;

  console.log('Count with SQL filter:', result[0].count);

  // Get a sample
  const samples = await prisma.$queryRaw<any[]>`
    SELECT id, symbol, "marketOutcome"
    FROM "TradeEvaluation"
    WHERE symbol = 'BTC/USDT'
      AND "marketOutcome" IS NOT NULL
      AND "marketOutcome" != 'null'::jsonb
    LIMIT 5
  `;

  console.log('\nSamples:');
  samples.forEach((s, i) => {
    console.log(`${i + 1}. marketOutcome:`, JSON.stringify(s.marketOutcome));
  });

  await prisma.$disconnect();
}

testQuery();
