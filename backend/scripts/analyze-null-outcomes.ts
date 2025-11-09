import { prisma } from '../src/db/client.js';

async function analyze() {
  console.log('Analyzing records with JSON null marketOutcome...\n');
  
  // Check age of these records
  const ageAnalysis = await prisma.$queryRaw<Array<{
    age_hours: number,
    count: bigint
  }>>`
    SELECT 
      FLOOR(EXTRACT(EPOCH FROM (NOW() - "createdAt")) / 3600) as age_hours,
      COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE "marketOutcome" = 'null'::jsonb
    GROUP BY age_hours
    ORDER BY age_hours DESC
    LIMIT 10
  `;
  
  console.log('Age distribution of records with null outcome:');
  ageAnalysis.forEach(row => {
    console.log(`   ${row.age_hours}h old: ${row.count} records`);
  });
  
  // Check symbols
  const symbolAnalysis = await prisma.$queryRaw<Array<{
    symbol: string,
    count: bigint
  }>>`
    SELECT 
      symbol,
      COUNT(*) as count
    FROM "TradeEvaluation"
    WHERE "marketOutcome" = 'null'::jsonb
    GROUP BY symbol
    ORDER BY count DESC
    LIMIT 10
  `;
  
  console.log('\nSymbols with most null outcomes:');
  symbolAnalysis.forEach(row => {
    console.log(`   ${row.symbol}: ${row.count} records`);
  });
  
  // Check a sample record
  const sample = await prisma.$queryRaw<Array<{
    id: number,
    symbol: string,
    createdAt: Date,
    evaluatedAt: Date,
    action: string,
    marketOutcome: any
  }>>`
    SELECT id, symbol, "createdAt", "evaluatedAt", action, "marketOutcome"
    FROM "TradeEvaluation"
    WHERE "marketOutcome" = 'null'::jsonb
    ORDER BY "createdAt" DESC
    LIMIT 3
  `;
  
  console.log('\nSample records with null outcome:');
  sample.forEach(rec => {
    console.log(`   ID ${rec.id} - ${rec.symbol}`);
    console.log(`   Created: ${rec.createdAt.toISOString()}`);
    console.log(`   Action: ${rec.action}`);
    console.log(`   marketOutcome: ${JSON.stringify(rec.marketOutcome)}`);
    console.log('');
  });
  
  // Check oldest record with null
  const oldest = await prisma.$queryRaw<Array<{
    createdAt: Date,
    age_hours: number
  }>>`
    SELECT 
      "createdAt",
      EXTRACT(EPOCH FROM (NOW() - "createdAt")) / 3600 as age_hours
    FROM "TradeEvaluation"
    WHERE "marketOutcome" = 'null'::jsonb
    ORDER BY "createdAt" ASC
    LIMIT 1
  `;
  
  if (oldest.length > 0) {
    console.log(`Oldest record with null outcome: ${oldest[0].createdAt.toISOString()} (${Math.floor(oldest[0].age_hours)}h ago)`);
  }
  
  await prisma.$disconnect();
}

analyze().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
