/**
 * Debug script to trace the gap between "executed" evaluations and actual trades
 */
import { prisma } from '../src/db/client.js';

async function debugExecutionGap() {
  console.log('🔍 Debugging: Why "executed" evaluations don\'t become real trades\n');

  // Get recent executed evaluations
  const executedEvals = await prisma.tradeEvaluation.findMany({
    where: { decision: 'executed' },
    orderBy: { timestamp: 'desc' },
    take: 10,
    select: {
      id: true,
      symbol: true,
      timestamp: true,
      confidenceScore: true,
    }
  });

  console.log(`Found ${executedEvals.length} recent "executed" evaluations:`);
  executedEvals.forEach((ev, idx) => {
    console.log(`${idx + 1}. ${ev.symbol} at ${ev.timestamp.toISOString()} (confidence: ${ev.confidenceScore.toFixed(4)})`);
  });

  // Check actual trades in Order table
  const recentTrades = await prisma.order.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24h
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      symbol: true,
      createdAt: true,
      price: true,
      side: true,
      type: true,
      status: true,
    }
  });

  console.log(`\n\n📊 Actual trades placed in last 24h: ${recentTrades.length}`);
  if (recentTrades.length > 0) {
    recentTrades.forEach((trade, idx) => {
      console.log(`${idx + 1}. ${trade.symbol} ${trade.side} at ${trade.createdAt.toISOString()} (${trade.type}, status: ${trade.status})`);
    });
  } else {
    console.log('❌ NO TRADES PLACED!');
  }

  // Check agent sessions
  const activeSessions = await prisma.agentSession.findMany({
    where: {
      stoppedAt: null, // Not stopped = active
    },
    select: {
      id: true,
      symbol: true,
      currentSymbol: true,
      startBalanceUsd: true,
      startedAt: true,
    }
  });

  console.log(`\n\n👤 Active Agent Sessions: ${activeSessions.length}`);
  activeSessions.forEach((session, idx) => {
    console.log(`${idx + 1}. Session ${session.id.substring(0, 8)}...`);
    console.log(`   Symbol: ${session.symbol || session.currentSymbol || 'N/A'}`);
    console.log(`   Budget: $${session.startBalanceUsd || 0}`);
    console.log(`   Started: ${session.startedAt.toISOString()}`);
  });

  // Check balances - budget is per agent session
  const totalBudget = activeSessions.reduce(
    (sum, session) => sum + (session.startBalanceUsd || 0),
    0
  );

  console.log(`\n\n💰 Total Budget Across All Agents: $${totalBudget}`);
  console.log(`   (Each agent has its own $${activeSessions[0]?.startBalanceUsd || 0} budget)`);

  // Look for errors/blocks in logs
  console.log(`\n\n🎯 Key Points to Check:\n`);
  console.log(`1. TradeEvaluation "executed" = Entry filters PASSED`);
  console.log(`   ├─ Confidence ≥ threshold ✅`);
  console.log(`   ├─ ADX ≥ threshold ✅`);
  console.log(`   └─ Risk/reward acceptable ✅\n`);
  
  console.log(`2. But actual trade requires MORE checks:`);
  console.log(`   ├─ Is agent active?`);
  console.log(`   ├─ Is there sufficient balance?`);
  console.log(`   ├─ Are position limits respected?`);
  console.log(`   ├─ Is agent in cooldown?`);
  console.log(`   ├─ Does signal have .active = true?`);
  console.log(`   ├─ Is guardrail null?`);
  console.log(`   ├─ Is effectiveScore ≥ 0.25?`);
  console.log(`   └─ No fundamental negative alerts?\n`);
  
  console.log(`3. The gap happens BETWEEN evaluation and execution`);
  console.log(`   TradeEvaluation logs happen INSIDE evaluate()`);
  console.log(`   Actual trade placement happens in a DIFFERENT place\n`);

  console.log(`\n🔧 To find the real blocker, check server logs for:`);
  console.log(`   - "guardrail" mentions`);
  console.log(`   - "active: false" in signals`);
  console.log(`   - Agent cooldown messages`);
  console.log(`   - Balance insufficient warnings`);
  console.log(`   - Position limit messages`);
}

debugExecutionGap()
  .catch((err) => {
    console.error('❌ Debug failed:', err);
    process.exit(1);
  })
  .finally(() => {
    prisma.$disconnect();
  });
