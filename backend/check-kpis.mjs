import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  console.log('🔍 Checking SessionKpi data...\n');
  
  // Check total KPIs
  const totalKpis = await prisma.sessionKpi.count();
  console.log(`Total SessionKpi records: ${totalKpis}\n`);
  
  if (totalKpis === 0) {
    console.log('❌ NO KPIs FOUND - This is the problem!\n');
    console.log('SessionKpiService is not writing KPIs to database.\n');
    return;
  }
  
  // Get all KPIs
  const kpis = await prisma.sessionKpi.findMany({
    take: 10,
    orderBy: { lastUpdated: 'desc' }
  });
  
  console.log(`Found ${kpis.length} KPIs:\n`);
  
  for (const kpi of kpis) {
    console.log(`Session: ${kpi.sessionId}`);
    console.log(`  Win Rate: ${(kpi.winRate * 100).toFixed(1)}%`);
    console.log(`  Realized PnL: $${kpi.realizedPnlUsd.toFixed(2)}`);
    console.log(`  Unrealized PnL: $${kpi.unrealizedPnlUsd.toFixed(2)}`);
    console.log(`  ROI: ${(kpi.roiPct * 100).toFixed(2)}%`);
    console.log(`  Last Updated: ${kpi.lastUpdated.toISOString()}\n`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
