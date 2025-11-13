#!/usr/bin/env tsx
/**
 * Paper Trading Cleanup Script
 * 
 * Deletes all paper trading session data while preserving:
 * - User accounts
 * - API keys
 * 
 * Deletes from tables:
 * - Position
 * - Order
 * - Fill
 * - AgentSession (and cascading relations: SessionKpi, Trigger, etc.)
 * 
 * USAGE:
 *   # Dry run (default - shows what would be deleted):
 *   npx tsx scripts/cleanup-paper-sessions.ts
 * 
 *   # Execute deletion:
 *   npx tsx scripts/cleanup-paper-sessions.ts --execute
 * 
 *   # Delete specific mode (paper or live):
 *   npx tsx scripts/cleanup-paper-sessions.ts --mode paper --execute
 * 
 *   # Exclude sessions owned by specific user:
 *   npx tsx scripts/cleanup-paper-sessions.ts --exclude-user cmhhhwem70000pe65r748lnlu --execute
 * 
 *   # Only delete stopped sessions (preserve active ones):
 *   npx tsx scripts/cleanup-paper-sessions.ts --stopped-only --execute
 */

import { prisma } from '../src/db/client.js';
import readline from 'readline';

const DRY_RUN = !process.argv.includes('--execute');
const MODE_ARG = process.argv.find(arg => arg.startsWith('--mode='));
const TARGET_MODE = MODE_ARG ? MODE_ARG.split('=')[1] : 'paper';
const EXCLUDE_USER_ARG = process.argv.find(arg => arg.startsWith('--exclude-user='));
const EXCLUDE_USER_ID = EXCLUDE_USER_ARG ? EXCLUDE_USER_ARG.split('=')[1] : null;
const STOPPED_ONLY = process.argv.includes('--stopped-only');

interface CleanupStats {
  positions: number;
  orders: number;
  fills: number;
  strategies: number;
  sessionKpis: number;
  triggers: number;
  alerts: number;
  reports: number;
  opsTelemetry: number;
  marginSnapshots: number;
  adaptiveThresholds: number;
  decisionMemory: number;
  sentimentSnapshots: number;
  improvementItems: number;
  aiCalls: number;
  tradeEvaluations: number;
  agentSessions: number;
}

async function promptConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

async function analyzeSessions(): Promise<{ sessionIds: string[]; stats: CleanupStats }> {
  console.log(`\n🔍 Analyzing ${TARGET_MODE} trading sessions...\n`);

  // Build where clause based on options
  const whereClause: any = { mode: TARGET_MODE };
  
  // Exclude specific user's sessions
  if (EXCLUDE_USER_ID) {
    whereClause.NOT = { userId: EXCLUDE_USER_ID };
    console.log(`   🔒 Excluding sessions owned by user: ${EXCLUDE_USER_ID}\n`);
  }
  
  // Only include stopped sessions
  if (STOPPED_ONLY) {
    whereClause.stoppedAt = { not: null };
    console.log(`   ⏹️  Only targeting stopped sessions (preserving active agents)\n`);
  }

  // Find all paper trading sessions matching criteria
  const sessions = await prisma.agentSession.findMany({
    where: whereClause,
    select: { 
      id: true, 
      symbol: true, 
      startedAt: true,
      stoppedAt: true,
      startBalanceUsd: true,
      userId: true
    },
    orderBy: { startedAt: 'desc' }
  });

  const sessionIds = sessions.map(s => s.id);

  if (sessionIds.length === 0) {
    console.log(`✅ No ${TARGET_MODE} sessions found. Nothing to clean up.\n`);
    return { sessionIds: [], stats: {} as CleanupStats };
  }

  console.log(`📊 Found ${sessions.length} ${TARGET_MODE} sessions:\n`);
  
  // Show sample sessions (first 10)
  const sampleSessions = sessions.slice(0, 10);
  for (const session of sampleSessions) {
    const status = session.stoppedAt ? '🔴 Stopped' : '🟢 Running';
    const balance = session.startBalanceUsd ? `$${session.startBalanceUsd}` : 'N/A';
    const userTag = session.userId ? `[User: ${session.userId.slice(0, 8)}...]` : '[No User]';
    console.log(`   ${status} ${session.symbol.padEnd(12)} | ${balance.padEnd(10)} | ${userTag} | ${session.startedAt.toISOString().split('T')[0]}`);
  }
  
  if (sessions.length > 10) {
    console.log(`   ... and ${sessions.length - 10} more sessions`);
  }
  console.log();

  // Count related records
  console.log(`📈 Counting related records...\n`);

  const [
    positions,
    orders,
    fills,
    strategies,
    sessionKpis,
    triggers,
    alerts,
    reports,
    opsTelemetry,
    decisionMemory
  ] = await Promise.all([
    prisma.position.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.order.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.fill.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.strategy.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.sessionKpi.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.triggerLog.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.alert.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.dailyReport.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.agentOpsTelemetry.count({ where: { sessionId: { in: sessionIds } } }),
    prisma.decisionMemory.count({ where: { sessionId: { in: sessionIds } } })
  ]);

  const stats: CleanupStats = {
    positions,
    orders,
    fills,
    strategies,
    sessionKpis,
    triggers,
    alerts,
    reports,
    opsTelemetry,
    marginSnapshots: 0, // Not in schema
    adaptiveThresholds: 0, // No sessionId field
    decisionMemory,
    sentimentSnapshots: 0, // Not in schema
    improvementItems: 0, // No sessionId field
    aiCalls: 0, // Not in schema
    tradeEvaluations: 0, // Not in schema
    agentSessions: sessions.length
  };

  console.log(`   Positions:        ${positions}`);
  console.log(`   Orders:           ${orders}`);
  console.log(`   Fills:            ${fills}`);
  console.log(`   Strategies:       ${strategies}`);
  console.log(`   Session KPIs:     ${sessionKpis}`);
  console.log(`   Triggers:         ${triggers}`);
  console.log(`   Alerts:           ${alerts}`);
  console.log(`   Reports:          ${reports}`);
  console.log(`   Ops Telemetry:    ${opsTelemetry}`);
  console.log(`   Decision Memory:  ${decisionMemory}`);
  console.log(`   Agent Sessions:   ${sessions.length}`);
  console.log();

  const totalRecords = Object.values(stats).reduce((sum, count) => sum + count, 0);
  console.log(`💥 Total records to delete: ${totalRecords}\n`);

  return { sessionIds, stats };
}

async function executeCleanup(sessionIds: string[]): Promise<void> {
  console.log(`\n🗑️  Executing deletion...\n`);

  try {
    // Delete in order to respect foreign key constraints
    // Child records first, then parent records

    console.log(`   Deleting positions...`);
    await prisma.position.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting fills...`);
    await prisma.fill.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting orders...`);
    await prisma.order.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting strategies...`);
    await prisma.strategy.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting session KPIs...`);
    await prisma.sessionKpi.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting triggers...`);
    await prisma.triggerLog.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting alerts...`);
    await prisma.alert.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting reports...`);
    await prisma.dailyReport.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting ops telemetry...`);
    await prisma.agentOpsTelemetry.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting decision memory...`);
    await prisma.decisionMemory.deleteMany({ where: { sessionId: { in: sessionIds } } });

    console.log(`   Deleting agent sessions...`);
    await prisma.agentSession.deleteMany({ where: { id: { in: sessionIds } } });

    console.log();
    console.log(`✅ Cleanup complete!\n`);
  } catch (error: any) {
    console.error(`\n❌ Error during cleanup:`, error.message);
    throw error;
  }
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Paper Trading Cleanup Script`);
  console.log(`═══════════════════════════════════════════════════════\n`);
  
  if (DRY_RUN) {
    console.log(`⚠️  DRY RUN MODE - No data will be deleted\n`);
    console.log(`   To execute deletion, run with: --execute\n`);
  } else {
    console.log(`🔥 EXECUTION MODE - Data WILL be permanently deleted!\n`);
  }

  console.log(`📍 Target mode: ${TARGET_MODE}`);
  if (EXCLUDE_USER_ID) {
    console.log(`🔒 Excluding user: ${EXCLUDE_USER_ID}`);
  }
  if (STOPPED_ONLY) {
    console.log(`⏹️  Stopped sessions only: ${STOPPED_ONLY}`);
  }
  console.log();

  // Analyze what will be deleted
  const { sessionIds, stats } = await analyzeSessions();

  if (sessionIds.length === 0) {
    await prisma.$disconnect();
    return;
  }

  if (DRY_RUN) {
    console.log(`\n✅ Dry run complete. Review the counts above.\n`);
    console.log(`   To execute deletion, run:`);
    console.log(`   npx tsx scripts/cleanup-paper-sessions.ts --execute\n`);
    await prisma.$disconnect();
    return;
  }

  // Execution mode - require confirmation
  console.log(`\n⚠️  WARNING: This action is IRREVERSIBLE!\n`);
  console.log(`   Before proceeding, ensure you have:`);
  console.log(`   1. ✅ Backed up the database (pg_dump)`);
  console.log(`   2. ✅ Verified you want to delete ${TARGET_MODE} mode sessions`);
  console.log(`   3. ✅ Confirmed no active agents are running\n`);

  const confirmed = await promptConfirmation(`   Type 'yes' to confirm deletion of ${stats.agentSessions} ${TARGET_MODE} sessions and all related records`);

  if (!confirmed) {
    console.log(`\n❌ Cleanup cancelled by user.\n`);
    await prisma.$disconnect();
    return;
  }

  // Execute cleanup
  await executeCleanup(sessionIds);

  // Verify cleanup
  const remainingSessions = await prisma.agentSession.count({ where: { mode: TARGET_MODE } });
  
  if (remainingSessions === 0) {
    console.log(`✅ Verification passed: No ${TARGET_MODE} sessions remain.\n`);
  } else {
    console.log(`⚠️  Warning: ${remainingSessions} ${TARGET_MODE} sessions still exist.\n`);
  }

  // Show preserved data
  console.log(`\n📊 Preserved data:\n`);
  const [userCount, apiKeyCount] = await Promise.all([
    prisma.user.count(),
    prisma.userApiKey.count()
  ]);
  console.log(`   Users:     ${userCount}`);
  console.log(`   API Keys:  ${apiKeyCount}\n`);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
