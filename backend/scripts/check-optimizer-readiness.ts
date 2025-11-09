import { prisma } from '../src/db/client.js';

async function check() {
  console.log('Checking optimizer readiness...\n');
  
  // Get symbols with evaluation counts
  const symbolCounts = await prisma.$queryRaw<Array<{ symbol: string; count: bigint }>>`
    SELECT symbol, COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE "marketOutcome" IS NOT NULL
    AND "marketOutcome" != 'null'::jsonb
    GROUP BY symbol
    ORDER BY count DESC
  `;

  console.log('Symbols with valid outcomes:\n');
  
  let readyCount = 0;
  let notReadyCount = 0;
  
  for (const row of symbolCounts) {
    const count = Number(row.count);
    const status = count >= 50 ? '✅' : '⚠️';
    const readiness = count >= 50 ? 'READY' : `Need ${50 - count} more`;
    
    if (count >= 50) readyCount++;
    else notReadyCount++;
    
    console.log(`   ${status} ${row.symbol.padEnd(15)} ${count.toString().padStart(3)} evals  [${readiness}]`);
  }
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Ready for optimization: ${readyCount} symbols`);
  console.log(`Need more data: ${notReadyCount} symbols`);
  console.log(`Total: ${symbolCounts.length} symbols`);
  
  // Check some sample evaluations to see if they have all required fields
  console.log(`\n${'='.repeat(60)}`);
  console.log('Checking data completeness...\n');
  
  const samples = await prisma.$queryRaw<Array<{
    symbol: string,
    inputMetrics: any,
    marketOutcome: any
  }>>`
    SELECT symbol, "inputMetrics", "marketOutcome"
    FROM "TradeEvaluation"
    WHERE "marketOutcome" IS NOT NULL
    AND "marketOutcome" != 'null'::jsonb
    LIMIT 5
  `;
  
  for (const sample of samples) {
    console.log(`${sample.symbol}:`);
    console.log(`   inputMetrics: ${JSON.stringify(sample.inputMetrics).substring(0, 100)}...`);
    console.log(`   marketOutcome: ${JSON.stringify(sample.marketOutcome)}`);
    
    // Check if marketOutcome has pnl_1h
    if (sample.marketOutcome && typeof sample.marketOutcome === 'object') {
      const pnl1h = (sample.marketOutcome as any).pnl_1h;
      console.log(`   pnl_1h: ${pnl1h !== undefined ? pnl1h : 'MISSING!'}`);
    }
    console.log('');
  }
  
  await prisma.$disconnect();
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
