#!/usr/bin/env tsx
/**
 * Trace Execution Flow: Entry Filter Pass → Order Placement
 * 
 * Identifies where trades get blocked AFTER entry filters pass.
 * Checks for blocks in:
 * 1. registerAdaptiveTradeEntry (predictor, cooldowns)
 * 2. Position sizing (returns qty=0)
 * 3. Capital reservation (pool exhausted, symbol cap)
 * 4. Broker placement (exchange errors)
 */

import { prisma } from '../src/db/client.js';

console.log('🔍 Tracing Execution Flow: Filter Pass → Order\n');
console.log('═'.repeat(80) + '\n');

async function trace() {
  // 1. Get recent "executed" evaluations (filters passed)
  const executedEvals = await prisma.tradeEvaluation.findMany({
    where: {
      decision: 'executed',
      timestamp: {
        gte: new Date(Date.now() - 60 * 60 * 1000), // Last hour
      },
    },
    select: {
      id: true,
      symbol: true,
      timestamp: true,
      confidenceScore: true,
      inputMetrics: true, // Contains bias info
    },
    orderBy: { timestamp: 'desc' },
  });

  console.log(`📊 "Executed" Evaluations (last hour): ${executedEvals.length}`);
  
  if (executedEvals.length === 0) {
    console.log('No recent "executed" evaluations - system idle or all blocked by filters\n');
    await prisma.$disconnect();
    return;
  }

  // 2. For each executed evaluation, check if corresponding order exists
  console.log('\n🔗 Correlation: Evaluation → Order\n');

  let foundOrders = 0;
  let missingOrders = 0;

  for (const eval_ of executedEvals) {
    const timeWindow = 60000; // 60 seconds after evaluation
    
    // Look for orders placed around the same time for same symbol
    const matchingOrders = await prisma.order.findMany({
      where: {
        symbol: eval_.symbol,
        createdAt: {
          gte: new Date(eval_.timestamp.getTime() - 5000), // 5s before
          lte: new Date(eval_.timestamp.getTime() + timeWindow), // 60s after
        },
      },
      select: {
        id: true,
        side: true,
        status: true,
        qty: true,
        createdAt: true,
        error: true,
      },
    });

    if (matchingOrders.length > 0) {
      foundOrders++;
      const order = matchingOrders[0];
      const delayMs = order.createdAt.getTime() - eval_.timestamp.getTime();
      console.log(`✅ ${eval_.symbol} - Order placed ${delayMs}ms after eval`);
      console.log(`   Eval: ${eval_.timestamp.toLocaleTimeString()}, confidence=${eval_.confidenceScore?.toFixed(3)}`);
      console.log(`   Order: ${order.id}, status=${order.status}, qty=${order.qty}`);
      if (order.status === 'rejected' && order.error) {
        console.log(`   ❌ Rejected: ${order.error}`);
      }
    } else {
      missingOrders++;
      const metrics = eval_.inputMetrics as any;
      console.log(`❌ ${eval_.symbol} - NO ORDER FOUND`);
      console.log(`   Eval: ${eval_.timestamp.toLocaleTimeString()}`);
      console.log(`   Confidence: ${eval_.confidenceScore?.toFixed(3)}`);
    }
    console.log('');
  }

  // 3. Summary
  console.log('═'.repeat(80));
  console.log('📈 EXECUTION FLOW ANALYSIS:\n');
  console.log(`Total "executed" evaluations: ${executedEvals.length}`);
  console.log(`  ✅ Orders placed: ${foundOrders} (${((foundOrders/executedEvals.length)*100).toFixed(1)}%)`);
  console.log(`  ❌ Missing orders: ${missingOrders} (${((missingOrders/executedEvals.length)*100).toFixed(1)}%)`);

  if (missingOrders > 0) {
    console.log('\n🚨 EXECUTION GAP DETECTED!\n');
    console.log('Possible blocking points AFTER entry filters:');
    console.log('');
    console.log('1. registerAdaptiveTradeEntry():');
    console.log('   - returns "predictor_blocked" if ML prediction < threshold');
    console.log('   - returns "skipped" if cooldown active');
    console.log('   - Check: Are predictor confidence thresholds too strict?');
    console.log('   - Check: Are cooldowns preventing consecutive trades?');
    console.log('');
    console.log('2. Position Sizing:');
    console.log('   - computeSize() returns qty=0 if risk too small');
    console.log('   - Check: Is equityUsd sufficient? Is stopDistance too large?');
    console.log('   - Formula: qty = (equity * riskPct) / stopDistance');
    console.log('');
    console.log('3. Capital Reservation:');
    console.log('   - reserve() returns null if pool exhausted');
    console.log('   - Check: Are all $1000 already reserved/in positions?');
    console.log('   - Check: Per-symbol cap exceeded (default 30% of pool)?');
    console.log('');
    console.log('4. Backend Not Running:');
    console.log('   - executeEntryTrade() never called');
    console.log('   - Check: Is backend server active? (npm run dev)');
    console.log('   - Check: Are agents auto-activating from database?');
    console.log('');
    console.log('📝 NEXT STEPS:');
    console.log('  1. Start backend: cd backend && npm run dev');
    console.log('  2. Monitor logs for these messages:');
    console.log('     - [MetaOrchestrator.executeEntryTrade] START');
    console.log('     - [MetaOrchestrator.executeEntryTrade] ABORTED (if blocked)');
    console.log('     - [CapitalPoolBroker] Attempting reserve');
    console.log('     - [CapitalPoolBroker] REJECTED (if failed)');
    console.log('  3. Check cooldown status: query TradeAttempt table');
    console.log('  4. Check capital pool: /api/capital/paper/snapshot');
  } else if (foundOrders === executedEvals.length) {
    console.log('\n✅ ALL EVALUATIONS RESULTED IN ORDERS!');
    console.log('');
    console.log('Check order statuses for rejection patterns.');
    
    // Analyze order statuses
    const allOrders = await prisma.order.findMany({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 60 * 60 * 1000),
        },
      },
      select: {
        status: true,
        error: true,
      },
    });

    const statusCounts = allOrders.reduce((acc, o) => {
      if (o.status) {
        acc[o.status] = (acc[o.status] || 0) + 1;
      }
      return acc;
    }, {} as Record<string, number>);

    console.log('\nOrder Status Distribution:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      console.log(`  ${status}: ${count}`);
    });

    const rejected = allOrders.filter(o => o.status === 'rejected');
    if (rejected.length > 0) {
      console.log('\nRejection Reasons:');
      const reasonCounts = rejected.reduce((acc, o) => {
        const reason = o.error || 'unknown';
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      Object.entries(reasonCounts)
        .sort((a, b) => b[1] - a[1])
        .forEach(([reason, count]) => {
          console.log(`  ${reason}: ${count}`);
        });
    }
  }

  await prisma.$disconnect();
}

trace().catch(console.error);
