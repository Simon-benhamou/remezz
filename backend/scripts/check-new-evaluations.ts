import { prisma } from '../src/db/client.js';

async function checkNewData() {
  const count = await prisma.tradeEvaluation.count();
  console.log(`📊 Total TradeEvaluation records: ${count}\n`);
  
  if (count === 0) {
    console.log('⚠️  No evaluations yet. Wait for the system to create some.\n');
    await prisma.$disconnect();
    return;
  }
  
  const recent = await prisma.tradeEvaluation.findMany({
    take: 3,
    orderBy: { createdAt: 'desc' },
    select: {
      symbol: true,
      createdAt: true,
      inputMetrics: true,
      marketOutcome: true,
    }
  });
  
  console.log('Most recent evaluations:\n');
  
  for (let i = 0; i < recent.length; i++) {
    const r = recent[i];
    const metrics = r.inputMetrics as any;
    
    console.log(`[${i+1}] ${r.symbol} - ${r.createdAt.toISOString()}`);
    console.log('    inputMetrics keys:', metrics ? Object.keys(metrics).join(', ') : 'null');
    
    // Check critical fields
    const hasEma20 = metrics?.ema20 !== undefined;
    const hasEma50 = metrics?.ema50 !== undefined;
    const hasVolume = metrics?.volume !== undefined;
    const hasVolumeMA = metrics?.volumeMA !== undefined;
    const hasTrendStrength = metrics?.trendStrength !== undefined;
    const hasAdx = metrics?.adx !== undefined;
    const hasAtrPct = metrics?.atrPct !== undefined;
    
    console.log('    ✅ Critical fields:');
    console.log(`       ema20: ${hasEma20 ? '✅' : '❌'} ${metrics?.ema20 ?? 'missing'}`);
    console.log(`       ema50: ${hasEma50 ? '✅' : '❌'} ${metrics?.ema50 ?? 'missing'}`);
    console.log(`       volume: ${hasVolume ? '✅' : '❌'} ${metrics?.volume ?? 'missing'}`);
    console.log(`       volumeMA: ${hasVolumeMA ? '✅' : '❌'} ${metrics?.volumeMA ?? 'missing'}`);
    console.log(`       trendStrength: ${hasTrendStrength ? '✅' : '❌'} ${metrics?.trendStrength ?? 'missing'}`);
    console.log(`       adx: ${hasAdx ? '✅' : '❌'} ${metrics?.adx ?? 'missing'}`);
    console.log(`       atrPct: ${hasAtrPct ? '✅' : '❌'} ${metrics?.atrPct ?? 'missing'}`);
    console.log('');
  }
  
  // Count how many have all required fields
  const allEvals = await prisma.tradeEvaluation.findMany({
    select: { inputMetrics: true }
  });
  
  let completeCount = 0;
  for (const ev of allEvals) {
    const m = ev.inputMetrics as any;
    if (m?.ema20 !== undefined && m?.ema50 !== undefined && m?.volume !== undefined) {
      completeCount++;
    }
  }
  
  console.log(`${'='.repeat(60)}`);
  console.log(`Complete evaluations: ${completeCount}/${count} (${((completeCount/count)*100).toFixed(1)}%)`);
  console.log(`${completeCount >= 50 ? '✅' : '⚠️'} ${completeCount >= 50 ? 'Ready to optimize!' : `Need ${50-completeCount} more complete evaluations`}`);
  
  await prisma.$disconnect();
}

checkNewData().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
