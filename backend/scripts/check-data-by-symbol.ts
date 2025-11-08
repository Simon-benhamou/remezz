import { prisma, Prisma } from '../src/db/client.js';

async function checkBySymbol() {
  const bySymbol = await prisma.$queryRaw<Array<{ symbol: string; total: bigint; with_outcome: bigint }>>`
    SELECT 
      symbol, 
      COUNT(*) as total,
      COUNT(CASE WHEN "marketOutcome" IS NOT NULL THEN 1 END) as with_outcome
    FROM "TradeEvaluation"
    GROUP BY symbol
    ORDER BY with_outcome DESC
  `;

  console.log('📊 Data by symbol:\n');
  bySymbol.forEach(row => {
    const pct = (Number(row.with_outcome) / Number(row.total) * 100).toFixed(1);
    const status = Number(row.with_outcome) >= 50 ? '✅' : '⏳';
    console.log(`${status} ${row.symbol.padEnd(15)} ${row.with_outcome.toString().padStart(4)}/${row.total.toString().padStart(4)} (${pct}%)`);
  });

  const readyCount = bySymbol.filter(r => Number(r.with_outcome) >= 50).length;
  console.log(`\n${readyCount}/${bySymbol.length} symbols ready for optimization (≥50 outcomes)`);

  await prisma.$disconnect();
}

checkBySymbol();
