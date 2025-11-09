import { prisma, Prisma } from '../src/db/client.js';

async function check() {
  const sample = await prisma.tradeEvaluation.findFirst({
    where: {
      symbol: 'BTC/USDT',
      marketOutcome: { not: Prisma.JsonNull }
    },
    select: {
      inputMetrics: true,
      marketOutcome: true
    }
  });

  console.log('Sample BTC/USDT evaluation:\n');
  console.log('inputMetrics:');
  console.log(JSON.stringify(sample?.inputMetrics, null, 2));
  console.log('\nmarketOutcome:');
  console.log(JSON.stringify(sample?.marketOutcome, null, 2));
  
  // Check specific fields
  const metrics = sample?.inputMetrics as any;
  console.log('\nKey fields check:');
  console.log(`  ema20: ${metrics?.ema20}`);
  console.log(`  ema50: ${metrics?.ema50}`);
  console.log(`  atrPct: ${metrics?.atrPct}`);
  console.log(`  adx: ${metrics?.adx}`);
  console.log(`  volume: ${metrics?.volume}`);
  console.log(`  volumeMA: ${metrics?.volumeMA}`);

  await prisma.$disconnect();
}

check().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
