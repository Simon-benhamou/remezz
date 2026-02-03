#!/usr/bin/env npx tsx
/**
 * Clean Trading Data Script
 *
 * Wipes all trading data to start fresh:
 * - Agent sessions
 * - Positions
 * - Fills
 * - Trades
 * - Orders
 * - Session KPIs
 * - Trigger logs
 * - Daily reports
 * - Action intents
 * - Pending intents
 * - Trade parity results
 *
 * Usage: npx tsx scripts/clean-trading-data.ts
 *
 * WARNING: This is destructive and cannot be undone!
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function cleanTradingData() {
  console.log('🧹 Starting trading data cleanup...\n');

  try {
    // Get counts before deletion
    const beforeCounts = {
      sessions: await prisma.agentSession.count(),
      positions: await prisma.position.count(),
      fills: await prisma.fill.count(),
      trades: await prisma.trade.count(),
      orders: await prisma.order.count(),
      sessionKpis: await prisma.sessionKpi.count(),
      triggerLogs: await prisma.triggerLog.count(),
      dailyReports: await prisma.dailyReport.count(),
      actionIntents: await prisma.agentActionIntent.count(),
      pendingIntents: await prisma.pendingIntent.count(),
      parityResults: await prisma.tradeParityResult.count(),
    };

    console.log('📊 Current data counts:');
    console.log(`   Sessions:       ${beforeCounts.sessions}`);
    console.log(`   Positions:      ${beforeCounts.positions}`);
    console.log(`   Fills:          ${beforeCounts.fills}`);
    console.log(`   Trades:         ${beforeCounts.trades}`);
    console.log(`   Orders:         ${beforeCounts.orders}`);
    console.log(`   Session KPIs:   ${beforeCounts.sessionKpis}`);
    console.log(`   Trigger Logs:   ${beforeCounts.triggerLogs}`);
    console.log(`   Daily Reports:  ${beforeCounts.dailyReports}`);
    console.log(`   Action Intents: ${beforeCounts.actionIntents}`);
    console.log(`   Pending Intents:${beforeCounts.pendingIntents}`);
    console.log(`   Parity Results: ${beforeCounts.parityResults}`);
    console.log('');

    // Delete in correct order (respecting foreign keys)
    console.log('🗑️  Deleting data...');

    // 1. Delete dependent records first (no FK dependencies)
    const deletedParityResults = await prisma.tradeParityResult.deleteMany({});
    console.log(`   ✓ Deleted ${deletedParityResults.count} parity results`);

    const deletedSessionKpis = await prisma.sessionKpi.deleteMany({});
    console.log(`   ✓ Deleted ${deletedSessionKpis.count} session KPIs`);

    const deletedTriggerLogs = await prisma.triggerLog.deleteMany({});
    console.log(`   ✓ Deleted ${deletedTriggerLogs.count} trigger logs`);

    const deletedDailyReports = await prisma.dailyReport.deleteMany({});
    console.log(`   ✓ Deleted ${deletedDailyReports.count} daily reports`);

    const deletedActionIntents = await prisma.agentActionIntent.deleteMany({});
    console.log(`   ✓ Deleted ${deletedActionIntents.count} action intents`);

    const deletedPendingIntents = await prisma.pendingIntent.deleteMany({});
    console.log(`   ✓ Deleted ${deletedPendingIntents.count} pending intents`);

    // 2. Delete fills (depends on orders and trades)
    const deletedFills = await prisma.fill.deleteMany({});
    console.log(`   ✓ Deleted ${deletedFills.count} fills`);

    // 3. Delete trades (depends on sessions)
    const deletedTrades = await prisma.trade.deleteMany({});
    console.log(`   ✓ Deleted ${deletedTrades.count} trades`);

    // 4. Delete orders (depends on sessions)
    const deletedOrders = await prisma.order.deleteMany({});
    console.log(`   ✓ Deleted ${deletedOrders.count} orders`);

    // 5. Delete positions (depends on sessions)
    const deletedPositions = await prisma.position.deleteMany({});
    console.log(`   ✓ Deleted ${deletedPositions.count} positions`);

    // 6. Delete sessions last (parent table)
    const deletedSessions = await prisma.agentSession.deleteMany({});
    console.log(`   ✓ Deleted ${deletedSessions.count} sessions`);

    console.log('\n✅ Trading data cleanup complete!');
    console.log('\n📝 Note: User accounts and API keys were preserved.');

  } catch (error) {
    console.error('\n❌ Cleanup failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the cleanup
cleanTradingData();
