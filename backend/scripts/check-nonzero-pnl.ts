import { prisma } from '../src/db/client.js';

async function check() {
  console.log('Checking non-zero pnl_1h evaluations...\n');
  
  // Count evaluations with non-zero pnl
  const nonZeroPnl = await prisma.$queryRaw<Array<{ symbol: string; count: bigint }>>`
    SELECT symbol, COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE "marketOutcome" IS NOT NULL
    AND "marketOutcome" != 'null'::jsonb
    AND ("marketOutcome"->>'pnl_1h')::numeric != 0
    GROUP BY symbol
    ORDER BY count DESC
  `;

  console.log('Symbols with NON-ZERO pnl_1h (ready for optimization if 50+):\n');
  
  let ready = 0;
  let total = 0;
  
  for (const row of nonZeroPnl) {
    const count = Number(row.count);
    total += count;
    if (count >= 50) {
      console.log(`  ✅ ${row.symbol.padEnd(15)} ${count} evals with pnl != 0`);
      ready++;
    } else {
      console.log(`  ⚠️  ${row.symbol.padEnd(15)} ${count} evals (need ${50-count} more)`);
    }
  }
  
  // Compare with total
  const totalWithOutcome = await prisma.$queryRaw<[{count: bigint}]>`
    SELECT COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE "marketOutcome" IS NOT NULL
    AND "marketOutcome" != 'null'::jsonb
  `;
  
  const totalCount = Number(totalWithOutcome[0].count);
  const zeroCount = totalCount - total;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Total evaluations with valid outcomes: ${totalCount}`);
  console.log(`   With pnl_1h != 0: ${total} (${((total/totalCount)*100).toFixed(1)}%)`);
  console.log(`   With pnl_1h == 0: ${zeroCount} (${((zeroCount/totalCount)*100).toFixed(1)}%)`);
  console.log(`\nReady for optimization: ${ready} symbols`);
  
  await prisma.$disconnect();
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
