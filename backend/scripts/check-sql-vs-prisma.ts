import { prisma } from '../src/db/client.js';

async function checkSql() {
  // Direct SQL query
  const sqlResult = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE symbol = 'BTC/USDT'
      AND "marketOutcome" IS NOT NULL
  `;

  console.log('SQL: COUNT with marketOutcome IS NOT NULL:', sqlResult[0].count);

  // Sample with SQL
  const samples = await prisma.$queryRaw<any[]>`
    SELECT id, symbol, decision, "marketOutcome"
    FROM "TradeEvaluation"  
    WHERE symbol = 'BTC/USDT'
      AND "marketOutcome" IS NOT NULL
    LIMIT 5
  `;

  console.log('\nSQL samples:');
  samples.forEach((s, i) => {
    console.log(`${i + 1}. marketOutcome:`, JSON.stringify(s.marketOutcome));
  });

  await prisma.$disconnect();
}

checkSql();
