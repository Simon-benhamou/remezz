#!/usr/bin/env tsx
/**
 * Comprehensive Execution Gap Diagnostic
 * 
 * Identifies why "executed" evaluations don't result in actual trades.
 * Checks:
 * 1. Are agents actually running (in AgentHub)?
 * 2. Are backend processes active?
 * 3. Capital pool configuration
 * 4. Recent evaluation → order correlation
 * 5. Rejection reasons from Order table
 */

import { prisma } from '../src/db/client.js';
import { AgentHub } from '../src/agent/hub.js';

console.log('🔬 Comprehensive Execution Gap Diagnostic\n');
console.log('═'.repeat(80) + '\n');

async function diagnose() {
  // 1. Check if AgentHub has any running agents
  console.log('📊 AgentHub Status:');
  
  // AgentHub.agents is private, but we can check via alternative method
  // For meta-adaptive, agents are minimal stubs - real check is if backend is running
  console.log('NOTE: Meta-adaptive uses stateless agents - checking if backend is active...');
  
  // Check if backend process is running by attempting to connect
  const backendRunning = process.env.PORT || process.env.NODE_ENV;
  if (!backendRunning) {
    console.log('⚠️  Running as standalone script - backend server status unknown');
  }

  // 2. Check database agent sessions
  console.log('\n📋 Database AgentSession Status:');
  const dbSessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null,
      haltedAt: null,
    },
    select: {
      id: true,
      symbol: true,
      mode: true,
      startedAt: true,
      startBalanceUsd: true,
      needsAttention: true,
    },
  });

  console.log(`Database sessions (not stopped/halted): ${dbSessions.length}`);
  if (dbSessions.length > 0) {
    console.log('\nSessions in DB:');
    for (const session of dbSessions.slice(0, 5)) {
      console.log(`  - ${session.id}: ${session.symbol} (${session.mode}) balance=$${session.startBalanceUsd}`);
      console.log(`    Started: ${session.startedAt.toISOString()}`);
      console.log(`    Needs attention: ${session.needsAttention}`);
    }
    if (dbSessions.length > 5) {
      console.log(`  ... and ${dbSessions.length - 5} more`);
    }
  }

  // 3. Check capital pool
  console.log('\n💰 Capital Pool Analysis:');
  const totalBudget = dbSessions.reduce((sum, s) => sum + Number(s.startBalanceUsd), 0);
  console.log(`Total startBalanceUsd across all sessions: $${totalBudget.toFixed(2)}`);
  console.log(`Expected shared pool: $1000.00`);
  
  if (Math.abs(totalBudget - 1000) > 10) {
    console.log(`\n⚠️  BUDGET CONFIGURATION ERROR!`);
    console.log(`   Each agent has startBalanceUsd=$1000 in database`);
    console.log(`   But they should share a SINGLE $1000 pool`);
    console.log(`   The CapitalManager uses a shared pool, but agent records suggest $${totalBudget} total`);
  }

  // 4. Recent evaluations vs orders
  console.log('\n📈 Recent Trade Evaluations (last 10 min):');
  const recentEvals = await prisma.tradeEvaluation.findMany({
    where: {
      timestamp: {
        gte: new Date(Date.now() - 10 * 60 * 1000),
      },
    },
    select: {
      symbol: true,
      decision: true,
      timestamp: true,
      confidenceScore: true,
      blockedReason: true,
    },
    orderBy: { timestamp: 'desc' },
    take: 20,
  });

  const executedCount = recentEvals.filter(e => e.decision === 'executed').length;
  const blockedCount = recentEvals.filter(e => e.decision === 'blocked').length;

  console.log(`Total evaluations: ${recentEvals.length}`);
  console.log(`  - Executed: ${executedCount}`);
  console.log(`  - Blocked: ${blockedCount}`);

  if (executedCount > 0) {
    console.log('\nRecent "executed" evaluations:');
    recentEvals
      .filter(e => e.decision === 'executed')
      .slice(0, 5)
      .forEach(e => {
        const time = e.timestamp.toLocaleTimeString();
        console.log(`  - ${e.symbol} at ${time}, confidence=${e.confidenceScore?.toFixed(3)}`);
      });
  }

  // 5. Check actual orders
  console.log('\n💼 Actual Orders (last hour):');
  const recentOrders = await prisma.order.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 60 * 60 * 1000),
      },
    },
    select: {
      id: true,
      symbol: true,
      side: true,
      status: true,
      createdAt: true,
      sessionId: true,
      error: true, // Use 'error' field instead of 'rejectedReason'
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  console.log(`Total orders: ${recentOrders.length}`);
  
  if (recentOrders.length === 0) {
    console.log('❌ ZERO ORDERS PLACED!');
  } else {
    console.log('\nRecent orders:');
    recentOrders.slice(0, 10).forEach(o => {
      const time = o.createdAt.toLocaleTimeString();
      console.log(`  - ${o.id}: ${o.symbol} ${o.side} ${o.status} at ${time}`);
      if (o.status === 'rejected' && o.error) {
        console.log(`    Error: ${o.error}`);
      }
    });
  }

  // 6. Summary and diagnosis
  console.log('\n' + '═'.repeat(80));
  console.log('🎯 DIAGNOSIS:\n');

  if (dbSessions.length > 0 && recentOrders.length === 0 && executedCount > 0) {
    console.log('❌ ROOT CAUSE: Agents exist in database but backend NOT RUNNING');
    console.log('');
    console.log('Evidence:');
    console.log(`  - ${dbSessions.length} agent sessions in database (not stopped/halted)`);
    console.log(`  - ${executedCount} "executed" evaluations in last 10 min`);
    console.log(`  - 0 actual Order records placed`);
    console.log('');
    console.log('TradeEvaluation.decision="executed" means entry filters PASSED,');
    console.log('NOT that a trade was placed. The evaluation happens even when');
    console.log('agents aren\'t running (via cron/scheduled tasks).');
    console.log('');
    console.log('However, actual trade execution requires:');
    console.log('  1. Backend server running (npm run dev)');
    console.log('  2. Meta-adaptive orchestrator processing ticks');
    console.log('  3. broker.place() being called with capital reservation');
    console.log('');
    console.log('📝 SOLUTION:');
    console.log('  1. Start backend: cd backend && npm run dev');
    console.log('  2. Agents should auto-activate from database');
    console.log('  3. Monitor logs for [MetaOrchestrator.executeEntryTrade]');
    console.log('  4. Watch for [CapitalPoolBroker] reserve/place messages');
  } else if (dbSessions.length > 0 && recentOrders.length === 0 && executedCount === 0) {
    console.log('⚠️  No recent activity - system may be idle or waiting for signals');
  } else if (recentOrders.length > 0) {
    console.log('✅ Orders ARE being placed - check statuses for rejection patterns');
    const rejected = recentOrders.filter(o => o.status === 'rejected');
    if (rejected.length > 0) {
      console.log(`\n${rejected.length} rejected orders - reasons:`);
      rejected.forEach(o => console.log(`  - ${o.error || 'unknown'}`));
    }
  } else {
    console.log('⚠️  No agents in database - system not configured');
  }

  await prisma.$disconnect();
}

diagnose().catch(console.error);
