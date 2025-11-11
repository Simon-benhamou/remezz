import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeXRPExit() {
  console.log('\n🔍 Analyzing XRP Premature Exit...\n');

  // Get XRP session
  const session = await prisma.agentSession.findFirst({
    where: {
      symbol: { contains: 'XRP', mode: 'insensitive' }
    },
    include: {
      orders: {
        orderBy: { createdAt: 'asc' }
      }
    }
  });

  if (!session) {
    console.log('❌ No XRP session found');
    return;
  }

  // Get KPIs separately
  const kpis = await prisma.sessionKpi.findMany({
    where: { sessionId: session.id },
    orderBy: { lastUpdated: 'asc' },
    take: 10
  });

  console.log(`📊 Session: ${session.symbol} (${session.id})`);
  console.log(`   Agent: ${session.agentType}`);
  console.log(`   Initial Balance: $${session.initialBalance}`);
  console.log(`   Status: ${session.status}\n`);

  // Analyze the exit sequence
  const orders = session.orders;
  console.log(`📝 Total Orders: ${orders.length}\n`);

  const buyOrder = orders[0]; // First BUY
  const sellOrder = orders[1]; // SELL (exit)
  const reBuyOrder = orders[2]; // Second BUY

  if (buyOrder && sellOrder) {
    console.log('🔴 PREMATURE EXIT DETAILS:');
    console.log(`   Entry: ${buyOrder.createdAt.toISOString()}`);
    console.log(`   Entry Price: $${buyOrder.price}`);
    console.log(`   Entry Size: ${buyOrder.qty} ${session.symbol}`);
    console.log(`   Entry Value: $${(buyOrder.price * buyOrder.qty).toFixed(2)}\n`);

    console.log(`   Exit: ${sellOrder.createdAt.toISOString()}`);
    console.log(`   Exit Price: $${sellOrder.price}`);
    console.log(`   Exit Size: ${sellOrder.qty} ${session.symbol}`);
    console.log(`   Exit Value: $${(sellOrder.price * sellOrder.qty).toFixed(2)}\n`);

    const holdDuration = (sellOrder.createdAt - buyOrder.createdAt) / 1000 / 60;
    const pnl = (sellOrder.price - buyOrder.price) * sellOrder.qty;
    const pnlPercent = ((sellOrder.price - buyOrder.price) / buyOrder.price * 100).toFixed(2);

    console.log(`   ⏱️  Hold Duration: ${holdDuration.toFixed(1)} minutes`);
    console.log(`   💰 PnL: $${pnl.toFixed(2)} (${pnlPercent}%)`);
    console.log(`   📉 Exit Reason: ${sellOrder.orderType || 'UNKNOWN'}\n`);
  }

  // Analyze KPIs around exit time
  console.log('📈 SESSION KPIs:');
  
  if (kpis.length === 0) {
    console.log('   ⚠️  No KPIs recorded\n');
  } else {
    console.log(`   Found ${kpis.length} KPI snapshots\n`);
    kpis.forEach((kpi, i) => {
      console.log(`   [${i+1}] Updated: ${kpi.lastUpdated.toISOString()}`);
      console.log(`      Win Rate: ${(kpi.winRate * 100).toFixed(1)}%`);
      console.log(`      Realized PnL: $${kpi.realizedPnlUsd.toFixed(2)}`);
      console.log(`      Unrealized PnL: $${kpi.unrealizedPnlUsd.toFixed(2)}`);
      console.log(`      Max Drawdown: ${(kpi.maxDrawdownPct * 100).toFixed(2)}%`);
      console.log(`      ROI: ${(kpi.roiPct * 100).toFixed(2)}%\n`);
    });
  }

  // Check if re-entry happened
  if (reBuyOrder) {
    console.log('🔄 RE-ENTRY DETECTED:');
    console.log(`   Time: ${reBuyOrder.createdAt.toISOString()}`);
    console.log(`   Price: $${reBuyOrder.price}`);
    console.log(`   Size: ${reBuyOrder.qty} ${session.symbol}`);
    
    const reEntryDelay = (reBuyOrder.createdAt - sellOrder.createdAt) / 1000 / 60;
    console.log(`   Delay after exit: ${reEntryDelay.toFixed(1)} minutes\n`);

    const missedGains = (reBuyOrder.price - sellOrder.price) * sellOrder.qty;
    const missedPercent = ((reBuyOrder.price - sellOrder.price) / sellOrder.price * 100).toFixed(2);
    console.log(`   ⚠️  Exited at $${sellOrder.price}, re-entered at $${reBuyOrder.price}`);
    console.log(`   💸 Missed gains during gap: $${missedGains.toFixed(2)} (${missedPercent}%)\n`);
  }

  console.log('✅ Analysis complete!');
}

analyzeXRPExit()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
