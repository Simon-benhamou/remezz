import { prisma } from '../src/db/client.js';

async function clearTradeEvaluations() {
  console.log('⚠️  WARNING: About to delete ALL TradeEvaluation records!\n');
  
  // Count current records
  const count = await prisma.tradeEvaluation.count();
  console.log(`📊 Current records in database: ${count}\n`);
  
  if (count === 0) {
    console.log('✅ No records to delete.\n');
    await prisma.$disconnect();
    return;
  }
  
  console.log('🗑️  Deleting all records...\n');
  
  const result = await prisma.tradeEvaluation.deleteMany({});
  
  console.log(`✅ Deleted ${result.count} TradeEvaluation records\n`);
  console.log('The system will now create new evaluations with complete metrics.');
  console.log('Run the optimizer again after some new data has been collected.\n');
  
  await prisma.$disconnect();
}

clearTradeEvaluations().catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
