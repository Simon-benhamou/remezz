/**
 * 🔍 SYSTEM DIAGNOSTIC TOOL
 * 
 * Audits the entire trading pipeline to identify bugs and bottlenecks
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function diagnose() {
  console.log('🔍 ===== SYSTEM DIAGNOSTIC REPORT =====\n');
  
  // 1. Check Active Sessions
  console.log('📊 1. ACTIVE SESSIONS');
  const sessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: { 
      id: true, 
      currentSymbol: true, 
      mode: true,
      startedAt: true, 
      startBalanceUsd: true 
    }
  });
  
  console.log(`Total active: ${sessions.length}`);
  sessions.forEach(s => {
    const age = ((Date.now() - s.startedAt.getTime()) / 3600000).toFixed(1);
    const status = s.currentSymbol ? '✅' : '❌ NULL';
    console.log(`  ${status} ${s.id.slice(0,8)} | ${s.currentSymbol || 'NO SYMBOL'} | ${s.mode} | ${age}h ago`);
  });
  
  const brokenSessions = sessions.filter(s => !s.currentSymbol).length;
  if (brokenSessions > 0) {
    console.log(`\n⚠️  CRITICAL: ${brokenSessions} sessions have NULL currentSymbol - CANNOT TRADE!`);
  }
  
  // 2. Check Recent Trade Evaluations
  console.log('\n📊 2. TRADE EVALUATIONS (Last Hour)');
  const hourAgo = new Date(Date.now() - 3600000);
  const evals = await prisma.tradeEvaluation.findMany({
    where: { timestamp: { gte: hourAgo } },
    orderBy: { timestamp: 'desc' }
  });
  
  console.log(`Total evaluations: ${evals.length}`);
  
  const byDecision = {};
  evals.forEach(e => {
    byDecision[e.decision] = (byDecision[e.decision] || 0) + 1;
  });
  
  console.log('  Distribution:');
  Object.entries(byDecision).forEach(([decision, count]) => {
    console.log(`    ${decision}: ${count}`);
  });
  
  // 3. Check Pipeline Flow
  console.log('\n📊 3. PIPELINE FLOW ANALYSIS');
  const passed = evals.filter(e => e.decision === 'filter_passed').length;
  const orderPlaced = evals.filter(e => e.decision === 'order_placed').length;
  const orderBlocked = evals.filter(e => e.decision.startsWith('order_blocked')).length;
  
  console.log(`  filter_passed: ${passed}`);
  console.log(`  order_placed: ${orderPlaced}`);
  console.log(`  order_blocked_*: ${orderBlocked}`);
  
  if (passed > 0 && orderPlaced === 0 && orderBlocked === 0) {
    console.log(`\n🚨 CRITICAL BUG: ${passed} signals passed strategy but NONE reached order stage!`);
    console.log('   This means orchestrator is NOT processing passed signals.');
    console.log('   Likely cause: Sessions have NULL currentSymbol so executeEntryTrade never called.');
  }
  
  // 4. Check Predictor Decisions
  console.log('\n📊 4. PREDICTOR DECISION TRACKING');
  const predictorDecisions = await prisma.predictorDecision.findMany({
    where: { createdAt: { gte: hourAgo } }
  });
  
  console.log(`Total predictor decisions logged: ${predictorDecisions.length}`);
  
  if (predictorDecisions.length === 0) {
    console.log('⚠️  WARNING: No predictor decisions in last hour.');
    console.log('   Predictor might be running but not changing decisions (stays "none").');
    console.log('   Or storePredictorDecisionIfChanged() not being called.');
  }
  
  // 5. Check Recent Orders
  console.log('\n📊 5. EXCHANGE ORDERS (Last Hour)');
  const orders = await prisma.order.findMany({
    where: { createdAt: { gte: hourAgo } },
    select: { id: true, symbol: true, side: true, status: true, createdAt: true }
  });
  
  console.log(`Total orders: ${orders.length}`);
  if (orders.length === 0) {
    console.log('❌ NO ORDERS placed in last hour despite market activity!');
  } else {
    orders.slice(0, 5).forEach(o => {
      const mins = ((Date.now() - o.createdAt.getTime()) / 60000).toFixed(0);
      console.log(`  ${o.symbol} ${o.side} ${o.status} (${mins}min ago)`);
    });
  }
  
  // 6. Sample Blocked Reasons
  console.log('\n📊 6. TOP BLOCKING REASONS');
  const blocked = evals.filter(e => e.decision.includes('blocked')).slice(0, 10);
  const reasonCounts = {};
  
  blocked.forEach(e => {
    const reason = e.blockedReason?.split(';')[0] || 'unknown';
    const key = reason.substring(0, 50);
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  });
  
  Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([reason, count]) => {
      console.log(`  [${count}x] ${reason}`);
    });
  
  // 7. System Health Summary
  console.log('\n📊 7. SYSTEM HEALTH SUMMARY');
  console.log(`  ✅ Strategy evaluations: ${evals.length > 0 ? 'WORKING' : '❌ NOT WORKING'}`);
  console.log(`  ${orderPlaced > 0 ? '✅' : '❌'} Order placement: ${orderPlaced > 0 ? 'WORKING' : 'BROKEN'}`);
  console.log(`  ${brokenSessions === 0 ? '✅' : '❌'} Active sessions: ${brokenSessions === 0 ? 'HEALTHY' : `${brokenSessions} BROKEN`}`);
  console.log(`  ⚠️  Predictor tracking: ${predictorDecisions.length > 0 ? 'OK' : 'NO DATA (by design)'}`);
  
  // 8. Critical Issues
  console.log('\n🚨 CRITICAL ISSUES FOUND:');
  let issueCount = 0;
  
  if (brokenSessions > 0) {
    issueCount++;
    console.log(`  [P0] ${brokenSessions} sessions have NULL currentSymbol - cannot execute trades`);
    console.log(`       FIX: Set currentSymbol for active sessions or restart them`);
  }
  
  if (passed > 0 && orderPlaced === 0 && orderBlocked === 0) {
    issueCount++;
    console.log(`  [P0] Pipeline broken: ${passed} filter_passed signals but 0 order attempts`);
    console.log(`       FIX: Orchestrator not processing signals (likely due to NULL currentSymbol)`);
  }
  
  if (predictorDecisions.length === 0) {
    issueCount++;
    console.log(`  [P1] No predictor decision tracking in last hour`);
    console.log(`       IMPACT: No visibility in dashboard, but trades might still work`);
  }
  
  if (orders.length === 0) {
    issueCount++;
    console.log(`  [P0] Zero orders placed despite ${evals.length} strategy evaluations`);
    console.log(`       IMPACT: System completely unable to trade`);
  }
  
  if (issueCount === 0) {
    console.log('  ✅ No critical issues detected!');
  } else {
    console.log(`\n  Total P0/P1 issues: ${issueCount}`);
  }
  
  console.log('\n===== END OF DIAGNOSTIC =====\n');
  
  await prisma.$disconnect();
}

diagnose().catch(console.error);
