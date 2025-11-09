#!/usr/bin/env tsx
/**
 * Analyze Execution Flow with New Status Tracking
 * 
 * Shows the complete journey from filter evaluation to order placement:
 * 1. Filter stage: filter_passed vs filter_blocked
 * 2. Execution stage: order_placed vs order_blocked_* vs order_rejected
 */

import { prisma } from '../src/db/client.js';

console.log('📊 Execution Flow Analysis\n');
console.log('═'.repeat(80) + '\n');

async function analyze() {
  const total = await prisma.tradeEvaluation.count();
  
  // Filter stage
  const filterPassed = await prisma.tradeEvaluation.count({ where: { decision: 'filter_passed' } });
  const filterBlocked = await prisma.tradeEvaluation.count({ where: { decision: 'filter_blocked' } });
  
  // Execution stage
  const orderPlaced = await prisma.tradeEvaluation.count({ where: { decision: 'order_placed' } });
  const orderBlockedCapital = await prisma.tradeEvaluation.count({ where: { decision: 'order_blocked_capital' } });
  const orderBlockedSizing = await prisma.tradeEvaluation.count({ where: { decision: 'order_blocked_sizing' } });
  const orderBlockedRegistration = await prisma.tradeEvaluation.count({ where: { decision: 'order_blocked_registration' } });
  const orderRejected = await prisma.tradeEvaluation.count({ where: { decision: 'order_rejected' } });

  console.log(`Total Evaluations: ${total}\n`);
  
  console.log(`📋 FILTER STAGE:`);
  console.log(`  ✅ filter_passed: ${filterPassed} (${((filterPassed/total)*100).toFixed(1)}%)`);
  console.log(`  ❌ filter_blocked: ${filterBlocked} (${((filterBlocked/total)*100).toFixed(1)}%)\n`);
  
  console.log(`💼 EXECUTION STAGE (requires filter_passed):`);
  console.log(`  ✅ order_placed: ${orderPlaced} (${((orderPlaced/total)*100).toFixed(1)}%)`);
  console.log(`  ❌ order_blocked_capital: ${orderBlockedCapital} (${((orderBlockedCapital/total)*100).toFixed(1)}%)`);
  console.log(`  ❌ order_blocked_sizing: ${orderBlockedSizing} (${((orderBlockedSizing/total)*100).toFixed(1)}%)`);
  console.log(`  ❌ order_blocked_registration: ${orderBlockedRegistration} (${((orderBlockedRegistration/total)*100).toFixed(1)}%)`);
  console.log(`  ❌ order_rejected: ${orderRejected} (${((orderRejected/total)*100).toFixed(1)}%)\n`);
  
  // Calculate execution gaps
  const executionAttempts = orderPlaced + orderBlockedCapital + orderBlockedSizing + orderBlockedRegistration + orderRejected;
  const executionGap = filterPassed - executionAttempts;
  
  console.log('═'.repeat(80));
  console.log('📈 EXECUTION FUNNEL:\n');
  console.log(`1. Signals evaluated: ${total}`);
  console.log(`2. Passed filters: ${filterPassed} (${((filterPassed/total)*100).toFixed(1)}%)`);
  console.log(`3. Execution attempted: ${executionAttempts} (${((executionAttempts/filterPassed)*100).toFixed(1)}% of passed)`);
  console.log(`4. Orders placed: ${orderPlaced} (${((orderPlaced/filterPassed)*100).toFixed(1)}% of passed)\n`);
  
  if (executionGap > 0) {
    console.log(`⚠️  EXECUTION GAP: ${executionGap} evaluations passed filters but never attempted execution`);
    console.log(`   This means:`);
    console.log(`   - Backend may have been offline`);
    console.log(`   - Orchestrator not processing ticks`);
    console.log(`   - Evaluations logged but executeEntryTrade() never called\n`);
  }
  
  if (executionAttempts > 0) {
    const conversionRate = (orderPlaced / executionAttempts) * 100;
    console.log(`✅ EXECUTION SUCCESS RATE: ${conversionRate.toFixed(1)}%`);
    
    const blocked = orderBlockedCapital + orderBlockedSizing + orderBlockedRegistration;
    if (blocked > 0) {
      console.log(`\nTop Blocking Reasons:`);
      if (orderBlockedCapital > 0) {
        console.log(`  - Capital exhausted: ${orderBlockedCapital} (${((orderBlockedCapital/blocked)*100).toFixed(1)}% of blocks)`);
      }
      if (orderBlockedSizing > 0) {
        console.log(`  - Position sizing qty=0: ${orderBlockedSizing} (${((orderBlockedSizing/blocked)*100).toFixed(1)}% of blocks)`);
      }
      if (orderBlockedRegistration > 0) {
        console.log(`  - Predictor/cooldown: ${orderBlockedRegistration} (${((orderBlockedRegistration/blocked)*100).toFixed(1)}% of blocks)`);
      }
      if (orderRejected > 0) {
        console.log(`  - Broker rejected: ${orderRejected} (${((orderRejected/blocked)*100).toFixed(1)}% of blocks)`);
      }
    }
  } else if (filterPassed > 0) {
    console.log(`❌ NO EXECUTION ATTEMPTS - Backend likely offline or not processing ticks`);
  }
  
  // Recent samples
  console.log('\n' + '═'.repeat(80));
  console.log('📋 Recent Evaluations (last 10):\n');
  
  const recent = await prisma.tradeEvaluation.findMany({
    take: 10,
    orderBy: { timestamp: 'desc' },
    select: {
      symbol: true,
      decision: true,
      blockedReason: true,
      confidenceScore: true,
      timestamp: true,
    },
  });
  
  recent.forEach((r, idx) => {
    const time = r.timestamp.toLocaleTimeString();
    const emoji = r.decision === 'order_placed' ? '✅' : r.decision.startsWith('filter') ? '🔍' : '❌';
    console.log(`${idx + 1}. ${emoji} ${r.symbol} - ${r.decision}`);
    console.log(`   Time: ${time}, Confidence: ${r.confidenceScore.toFixed(3)}`);
    if (r.blockedReason) {
      console.log(`   Reason: ${r.blockedReason}`);
    }
    console.log('');
  });

  await prisma.$disconnect();
}

analyze().catch(console.error);
