import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Get recent ADA and SEI trades with details
const trades = await prisma.trade.findMany({
  where: {
    symbol: { in: ['ADA/USDT:USDT', 'SEI/USDT:USDT'] },
    exitTs: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  },
  orderBy: { exitTs: 'desc' }
});

for (const t of trades) {
  const sym = t.symbol.replace('/USDT:USDT', '');
  const entryTs = t.entryTs.getTime();
  const exitTs = t.exitTs.getTime();
  const holdMin = Math.round((exitTs - entryTs) / 60000);
  const holdBars = (holdMin / 15).toFixed(1);
  
  console.log(`\n${sym} | ${t.positionSide.toUpperCase()}`);
  console.log(`  Entry:  ${t.entryTs.toISOString()}`);
  console.log(`  Exit:   ${t.exitTs.toISOString()}`);
  console.log(`  Reason: ${t.exitReason}`);
  console.log(`  Hold:   ${holdMin}m (${holdBars} bars)`);
  console.log(`  PnL:    ${t.roiPct?.toFixed(3)}%`);
  console.log(`  MaxPnL: ${t.maxPnlPct?.toFixed(3) ?? 'N/A'}%`);
  
  // STAGNANT timing logic:
  // - Triggers at 45m (3 bars) if maxPnlPct < 0.8%
  // - Then observation window of 60m (4 bars)
  // - Total = 105m (7 bars) before SL tightens to 0.8%
  // - Exit happens when tightened SL is hit
  console.log(`  --- Expected STAGNANT timing ---`);
  console.log(`    Trigger at: 45m (bar 3) if maxPnl < 0.8%`);
  console.log(`    Confirm at: 105m (bar 7) after observation`);
  console.log(`    Then SL tightens to 0.8% and waits for SL hit`);
}

await prisma.$disconnect();
