#!/usr/bin/env tsx
/**
 * Batch Intelligent Agent Creation Script
 * 
 * Creates multiple intelligent agents of different aggressiveness types
 * for performance comparison testing.
 * 
 * USAGE:
 *   # Create default batch (10 agents per type, maxLeverage=7):
 *   npx tsx scripts/create-batch-agents.ts
 * 
 *   # Create with custom parameters:
 *   npx tsx scripts/create-batch-agents.ts --count 5 --leverage 10 --mode live
 * 
 *   # Create only specific aggressiveness types:
 *   npx tsx scripts/create-batch-agents.ts --types conservative,reactive
 */

import { startAgentCreation, StartPayload } from '../src/services/agentCreationFlow.js';
import { prisma } from '../src/db/client.js';

// Parse command-line arguments
const COUNT_ARG = process.argv.find(arg => arg.startsWith('--count='));
const LEVERAGE_ARG = process.argv.find(arg => arg.startsWith('--leverage='));
const MODE_ARG = process.argv.find(arg => arg.startsWith('--mode='));
const TYPES_ARG = process.argv.find(arg => arg.startsWith('--types='));
const BALANCE_ARG = process.argv.find(arg => arg.startsWith('--balance='));
const USER_ARG = process.argv.find(arg => arg.startsWith('--user='));

const AGENTS_PER_TYPE = COUNT_ARG ? parseInt(COUNT_ARG.split('=')[1]) : 3;
const MAX_LEVERAGE = LEVERAGE_ARG ? parseInt(LEVERAGE_ARG.split('=')[1]) : 7;
const MODE = MODE_ARG ? MODE_ARG.split('=')[1] as 'paper' | 'live' : 'paper';
const START_BALANCE = BALANCE_ARG ? parseFloat(BALANCE_ARG.split('=')[1]) : 1000;
const USER_ID = USER_ARG ? USER_ARG.split('=')[1] : null;

// Aggressiveness types to create
const ALL_TYPES: Array<'conservative' | 'reactive' | 'aggressive'> = ['conservative', 'reactive', 'aggressive'];
const REQUESTED_TYPES = TYPES_ARG 
  ? TYPES_ARG.split('=')[1].split(',').map(t => t.trim() as 'conservative' | 'reactive' | 'aggressive')
  : ALL_TYPES;

// Aggressiveness-specific configurations
const AGGRESSIVENESS_CONFIGS = {
  conservative: {
    riskPerTradePct: 1.0,
    dailyLossLimitPct: 3.0,
  },
  reactive: {
    riskPerTradePct: 1.5,
    dailyLossLimitPct: 3.5,
  },
  aggressive: {
    riskPerTradePct: 2.0,
    dailyLossLimitPct: 4.0,
  },
};

interface BatchCreationResult {
  aggressiveness: string;
  agentNumber: number;
  sessionId?: string;
  symbol?: string;
  status: 'success' | 'failed';
  state?: string;
  error?: string;
  duration?: number;
}

interface BatchSummary {
  total: number;
  successful: number;
  failed: number;
  byType: Record<string, { success: number; failed: number }>;
  results: BatchCreationResult[];
}

async function validateUserExists(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return !!user;
}

async function createAgent(
  aggressiveness: 'conservative' | 'reactive' | 'aggressive',
  agentNumber: number
): Promise<BatchCreationResult> {
  const startTime = Date.now();
  
  try {
    console.log(`   Creating ${aggressiveness} agent ${agentNumber}/${AGENTS_PER_TYPE}...`);

    const config = AGGRESSIVENESS_CONFIGS[aggressiveness];
    
    const payload: StartPayload = {
      // Smart agent settings
      smartAutoMode: true,
      
      // Performance settings
      maxLeverage: MAX_LEVERAGE,
      aggressiveness,
      riskPerTradePct: config.riskPerTradePct,
      dailyLossLimitPct: config.dailyLossLimitPct,
      
      // Account settings
      mode: MODE,
      startBalanceUsd: START_BALANCE,
      
      // Strategy settings
      strategyEngine: 'meta_adaptive',
      dynamicLeverage: true,
      minLeverage: 1,
      
      // Sizing settings
      sizingMode: 'risk',
      budgetPct: 100,
    };

    const result = await startAgentCreation(payload, USER_ID);
    const duration = Date.now() - startTime;

    if (result.state === 'ready' || result.state === 'warming') {
      return {
        aggressiveness,
        agentNumber,
        sessionId: result.sessionId,
        symbol: result.symbol,
        status: 'success',
        state: result.state,
        duration,
      };
    } else {
      return {
        aggressiveness,
        agentNumber,
        status: 'failed',
        error: `Unexpected state: ${result.state}`,
        duration,
      };
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error(`      ❌ Failed: ${error.message}`);
    
    return {
      aggressiveness,
      agentNumber,
      status: 'failed',
      error: error.message || 'Unknown error',
      duration,
    };
  }
}

async function createBatchForType(
  aggressiveness: 'conservative' | 'reactive' | 'aggressive',
  count: number
): Promise<BatchCreationResult[]> {
  console.log(`\n🚀 Creating ${count} ${aggressiveness.toUpperCase()} agents...\n`);

  const results: BatchCreationResult[] = [];

  // Create agents sequentially to avoid overwhelming the system
  for (let i = 1; i <= count; i++) {
    const result = await createAgent(aggressiveness, i);
    results.push(result);

    if (result.status === 'success') {
      console.log(`      ✅ Success: ${result.symbol} (${result.sessionId?.slice(0, 8)}...) [${result.duration}ms]`);
    }

    // Small delay between creations to prevent rate limiting
    if (i < count) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

async function displayResults(summary: BatchSummary) {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Batch Creation Summary`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  console.log(`📊 Overall Statistics:`);
  console.log(`   Total agents created:  ${summary.total}`);
  console.log(`   ✅ Successful:         ${summary.successful} (${((summary.successful / summary.total) * 100).toFixed(1)}%)`);
  console.log(`   ❌ Failed:             ${summary.failed} (${((summary.failed / summary.total) * 100).toFixed(1)}%)`);
  console.log();

  console.log(`📈 By Aggressiveness Type:\n`);
  for (const [type, stats] of Object.entries(summary.byType)) {
    const total = stats.success + stats.failed;
    const successRate = total > 0 ? ((stats.success / total) * 100).toFixed(1) : '0.0';
    console.log(`   ${type.toUpperCase().padEnd(15)} | ✅ ${stats.success.toString().padStart(2)} | ❌ ${stats.failed.toString().padStart(2)} | ${successRate}%`);
  }
  console.log();

  // Show successful agents
  const successfulAgents = summary.results.filter(r => r.status === 'success');
  if (successfulAgents.length > 0) {
    console.log(`✅ Successfully Created Agents (${successfulAgents.length}):\n`);
    
    // Group by aggressiveness
    const byType = {
      conservative: successfulAgents.filter(r => r.aggressiveness === 'conservative'),
      reactive: successfulAgents.filter(r => r.aggressiveness === 'reactive'),
      aggressive: successfulAgents.filter(r => r.aggressiveness === 'aggressive'),
    };

    for (const [type, agents] of Object.entries(byType)) {
      if (agents.length === 0) continue;
      
      console.log(`   ${type.toUpperCase()}:`);
      for (const agent of agents) {
        const sessionIdShort = agent.sessionId?.slice(0, 12) || 'N/A';
        const symbol = agent.symbol || 'Pending';
        const state = agent.state === 'ready' ? '🟢' : '🟡';
        console.log(`      ${state} ${sessionIdShort}... | ${symbol.padEnd(12)} | ${agent.duration}ms`);
      }
      console.log();
    }
  }

  // Show failed agents
  const failedAgents = summary.results.filter(r => r.status === 'failed');
  if (failedAgents.length > 0) {
    console.log(`❌ Failed Agents (${failedAgents.length}):\n`);
    for (const agent of failedAgents) {
      console.log(`   ${agent.aggressiveness.toUpperCase()} #${agent.agentNumber}: ${agent.error}`);
    }
    console.log();
  }

  // Export results to JSON
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const exportPath = `./batch-agents-${timestamp}.json`;
  
  const exportData = {
    timestamp: new Date().toISOString(),
    config: {
      agentsPerType: AGENTS_PER_TYPE,
      maxLeverage: MAX_LEVERAGE,
      mode: MODE,
      startBalance: START_BALANCE,
      types: REQUESTED_TYPES,
      userId: USER_ID,
    },
    summary,
    agents: successfulAgents.map(r => ({
      sessionId: r.sessionId,
      symbol: r.symbol,
      aggressiveness: r.aggressiveness,
      state: r.state,
      config: AGGRESSIVENESS_CONFIGS[r.aggressiveness as keyof typeof AGGRESSIVENESS_CONFIGS],
    })),
  };

  const fs = await import('fs');
  fs.writeFileSync(exportPath, JSON.stringify(exportData, null, 2));
  console.log(`💾 Results exported to: ${exportPath}\n`);

  // Show database verification
  const dbCount = await prisma.agentSession.count({
    where: { 
      mode: MODE,
      stoppedAt: null,
    },
  });
  console.log(`📊 Database Verification:`);
  console.log(`   Active ${MODE} sessions in DB: ${dbCount}\n`);
}

async function main() {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Batch Intelligent Agent Creation`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  console.log(`⚙️  Configuration:`);
  console.log(`   Agents per type:  ${AGENTS_PER_TYPE}`);
  console.log(`   Max leverage:     ${MAX_LEVERAGE}x`);
  console.log(`   Mode:             ${MODE}`);
  console.log(`   Start balance:    $${START_BALANCE}`);
  console.log(`   Types:            ${REQUESTED_TYPES.join(', ')}`);
  console.log(`   User ID:          ${USER_ID || 'None (system)'}\\n`);

  // Validate user if specified
  if (USER_ID) {
    const userExists = await validateUserExists(USER_ID);
    if (!userExists) {
      console.error(`❌ Error: User with ID '${USER_ID}' does not exist in database.\n`);
      console.log(`   Available options:`);
      console.log(`   1. Remove --user flag to create system agents`);
      console.log(`   2. Provide a valid user ID\n`);
      await prisma.$disconnect();
      process.exit(1);
    }
    console.log(`✅ User validated\n`);
  }

  // Validate leverage
  if (MAX_LEVERAGE < 1 || MAX_LEVERAGE > 10) {
    console.error(`❌ Error: Max leverage must be between 1 and 10 (got ${MAX_LEVERAGE})\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  // Validate aggressiveness types
  const invalidTypes = REQUESTED_TYPES.filter(t => !ALL_TYPES.includes(t));
  if (invalidTypes.length > 0) {
    console.error(`❌ Error: Invalid aggressiveness types: ${invalidTypes.join(', ')}\n`);
    console.log(`   Valid types: ${ALL_TYPES.join(', ')}\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  const totalAgents = AGENTS_PER_TYPE * REQUESTED_TYPES.length;
  console.log(`📝 Planning to create ${totalAgents} total agents...\n`);

  const allResults: BatchCreationResult[] = [];
  const summary: BatchSummary = {
    total: totalAgents,
    successful: 0,
    failed: 0,
    byType: {},
    results: [],
  };

  // Initialize type stats
  for (const type of REQUESTED_TYPES) {
    summary.byType[type] = { success: 0, failed: 0 };
  }

  // Create agents for each type
  for (const aggressiveness of REQUESTED_TYPES) {
    const results = await createBatchForType(aggressiveness, AGENTS_PER_TYPE);
    allResults.push(...results);

    const successCount = results.filter(r => r.status === 'success').length;
    const failCount = results.filter(r => r.status === 'failed').length;

    summary.byType[aggressiveness].success = successCount;
    summary.byType[aggressiveness].failed = failCount;
    summary.successful += successCount;
    summary.failed += failCount;

    console.log(`\n   ✅ ${aggressiveness.toUpperCase()}: ${successCount}/${AGENTS_PER_TYPE} successful\n`);
  }

  summary.results = allResults;

  // Display final results
  await displayResults(summary);

  if (summary.failed > 0) {
    console.log(`⚠️  Some agents failed to create. Review errors above.\n`);
  } else {
    console.log(`✅ All agents created successfully!\n`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
