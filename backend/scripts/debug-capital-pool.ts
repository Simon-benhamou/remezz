/**
 * Debug Capital Pool to understand why trades aren't executing
 */
import { prisma } from '../src/db/client.js';

async function debugCapitalPool() {
  console.log('🔍 Debugging Capital Pool & Trade Execution Gap\n');
  console.log('═══════════════════════════════════════════════\n');

  // 1. Check active agents (not halted/stopped)
  const activeAgents = await prisma.agentSession.findMany({
    where: { 
      stoppedAt: null,
      haltedAt: null,
    },
    select: {
      id: true,
      symbol: true,
      startBalanceUsd: true,
      startedAt: true,
      mode: true,
    }
  });

  console.log(`📊 Active Agents: ${activeAgents.length}\n`);
  
  if (activeAgents.length === 0) {
    console.log('❌ No active agents found!');
    return;
  }

  const totalBudget = activeAgents.reduce((sum, a) => sum + (a.startBalanceUsd || 0), 0);
  console.log(`Total Budget Across Agents: $${totalBudget.toFixed(2)}`);
  console.log(`Expected Shared Budget: $1000.00\n`);

  if (Math.abs(totalBudget - 1000) > 10) {
    console.log(`⚠️  WARNING: Total budget (${totalBudget}) ≠ $1000!`);
    console.log(`Each agent should NOT have separate budget.`);
    console.log(`They should share a common pool of $1000.\n`);
  }

  // 2. Check recent "executed" evaluations
  const recentExecuted = await prisma.tradeEvaluation.findMany({
    where: {
      decision: 'executed',
      timestamp: {
        gte: new Date(Date.now() - 5 * 60 * 1000) // Last 5 minutes
      }
    },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      symbol: true,
      timestamp: true,
      confidenceScore: true,
      inputMetrics: true,
    }
  });

  console.log(`\n📈 Recent "executed" Evaluations (last 5 min): ${recentExecuted.length}\n`);
  
  if (recentExecuted.length === 0) {
    console.log('No recent "executed" evaluations. System might not be running.\n');
    return;
  }

  recentExecuted.slice(0, 5).forEach((e, i) => {
    console.log(`${i + 1}. ${e.symbol} - ${e.timestamp.toLocaleTimeString()}`);
    console.log(`   Confidence: ${e.confidenceScore.toFixed(4)}`);
  });

  // 3. Check actual orders placed
  const recentOrders = await prisma.order.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 60 * 60 * 1000) // Last hour
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      symbol: true,
      side: true,
      qty: true,
      status: true,
      createdAt: true,
    }
  });

  console.log(`\n\n💼 Actual Orders Placed (last hour): ${recentOrders.length}\n`);
  
  if (recentOrders.length === 0) {
    console.log('❌ NO ORDERS PLACED despite "executed" evaluations!\n');
    console.log('🔍 This confirms the gap between evaluation and execution.\n');
  } else {
    recentOrders.forEach((o, i) => {
      console.log(`${i + 1}. ${o.symbol} ${o.side} ${o.qty} - ${o.status}`);
      console.log(`   Time: ${o.createdAt.toLocaleTimeString()}\n`);
    });
  }

  // 4. Check for logs or errors that might explain the gap
  console.log('\n📋 Possible Reasons for Execution Gap:\n');
  console.log('1. ❌ Capital Pool Reservation Failed');
  console.log('   - All $1000 already allocated to open positions?');
  console.log('   - Not enough free capital to take new positions?');
  console.log('');
  console.log('2. ❌ Per-Symbol Cap Reached');
  console.log('   - Each symbol has a max allocation limit');
  console.log('   - Multiple agents might exhaust symbol cap');
  console.log('');
  console.log('3. ❌ Position Sizing Returns 0');
  console.log('   - Stop distance too tight');
  console.log('   - Risk per trade too small');
  console.log('');
  console.log('4. ❌ Agent Not Calling broker.place()');
  console.log('   - Logic bug between evaluation and execution');
  console.log('   - Missing connection in trade flow');
  console.log('');
  console.log('5. ❌ Broker Mode Not Configured');
  console.log('   - PaperBroker not initialized?');
  console.log('   - CapitalPoolBroker not wrapping properly?');

  // 5. Check for open positions
  const openPositions = await prisma.order.findMany({
    where: {
      status: { in: ['open', 'filled'] },
      clientOrderId: { not: { endsWith: '.exit' } }
    },
    select: {
      symbol: true,
      qty: true,
      price: true,
      createdAt: true,
    }
  });

  console.log(`\n\n📊 Open Positions: ${openPositions.length}\n`);
  
  if (openPositions.length > 0) {
    const positionValue = openPositions.reduce((sum, p) => 
      sum + (p.qty * (p.price || 0)), 0
    );
    console.log(`Total Position Value: $${positionValue.toFixed(2)}`);
    console.log(`Remaining Free Capital: $${(1000 - positionValue).toFixed(2)}\n`);
    
    openPositions.forEach(p => {
      console.log(`- ${p.symbol}: ${p.qty} @ $${p.price} = $${(p.qty * (p.price || 0)).toFixed(2)}`);
    });
  } else {
    console.log('No open positions. All $1000 should be free!\n');
  }

  // 6. Recommendation
  console.log('\n\n🎯 Next Steps:\n');
  console.log('1. Check server logs for "capital_reservation_failed"');
  console.log('2. Check if CapitalPoolBroker is being used');
  console.log('3. Verify capital.reserve() is being called');
  console.log('4. Add logging in metaAdaptiveOrchestrator.executeEntryTrade()');
  console.log('5. Check if agents are actually trying to place orders');
  
  console.log('\n✅ Debug analysis complete!');
}

debugCapitalPool()
  .catch((err) => {
    console.error('❌ Debug failed:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
