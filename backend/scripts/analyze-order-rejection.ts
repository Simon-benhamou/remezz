#!/usr/bin/env tsx
/**
 * CLI Script: Analyze Why Orders Were Not Placed
 * 
 * Usage:
 *   npm run analyze-rejection XRP/USDT
 *   npm run analyze-rejection XRP/USDT --session-id <id>
 *   npm run analyze-rejection XRP/USDT --mode live --aggressiveness aggressive
 */

import { orderRejectionAnalyzer } from '../src/diagnostics/orderRejectionAnalyzer.js';
import { AgentHub } from '../src/agent/hub.js';
import { prisma } from '../src/db/client.js';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
📊 Order Rejection Analyzer

Analyzes why an agent didn't place orders despite price movements.

Usage:
  npm run analyze-rejection <SYMBOL> [OPTIONS]

Examples:
  npm run analyze-rejection XRP/USDT
  npm run analyze-rejection BTC/USDT --session-id abc123
  npm run analyze-rejection ETH/USDT --mode live --aggressiveness aggressive

Options:
  --session-id <id>       Analyze specific agent session
  --mode <paper|live>     Trading mode (default: paper)
  --aggressiveness <mode> Agent aggressiveness (conservative|reactive|aggressive)
  --json                  Output in JSON format
  --export <file>         Export analysis to file

Exit codes:
  0 - Agent can trade (no blocking conditions)
  1 - Agent cannot trade (blocking conditions found)
  2 - Analysis error
    `);
    process.exit(0);
  }

  const symbol = args[0];
  let sessionId: string | undefined;
  let mode: 'paper' | 'live' = 'paper';
  let aggressiveness: 'conservative' | 'reactive' | 'aggressive' = 'reactive';
  let jsonOutput = false;
  let exportFile: string | undefined;

  // Parse options
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--session-id' && i + 1 < args.length) {
      sessionId = args[++i];
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      const modeArg = args[++i].toLowerCase();
      if (modeArg === 'live' || modeArg === 'paper') {
        mode = modeArg;
      }
    } else if (args[i] === '--aggressiveness' && i + 1 < args.length) {
      const aggArg = args[++i].toLowerCase();
      if (aggArg === 'conservative' || aggArg === 'reactive' || aggArg === 'aggressive') {
        aggressiveness = aggArg;
      }
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (args[i] === '--export' && i + 1 < args.length) {
      exportFile = args[++i];
    }
  }

  try {
    console.error(`🔍 Analyzing order rejection for ${symbol}...`);
    console.error(`   Mode: ${mode}`);
    console.error(`   Aggressiveness: ${aggressiveness}`);
    if (sessionId) {
      console.error(`   Session ID: ${sessionId}`);
    }
    console.error('');

    let plan: any = null;
    let agentState: any = null;

    // If session ID provided, get agent state
    if (sessionId) {
      const agent = AgentHub.get(sessionId);
      if (agent) {
        plan = (agent as any).plan;
        agentState = {
          state: agent.state,
          cooldownContext: (agent as any).cooldownContext,
          killSwitchContext: (agent as any).killSwitchContext,
          consecutiveStops: (agent as any).consecutiveStops,
          tradesToday: (agent as any).tradesToday,
          pos: agent.pos,
          qualityThresholdAdjustment: (agent as any).qualityThresholdAdjustment,
          recentTrades: (agent as any).recentTrades,
        };
        console.error(`✓ Found active agent session`);
        console.error(`  State: ${agent.state}`);
        console.error(`  Symbol: ${(agent as any).profile?.symbol || 'unknown'}`);
        console.error('');
      } else {
        // Try to load from database
        const session = await prisma.agentSession.findUnique({
          where: { id: sessionId },
          select: {
            symbol: true,
            mode: true,
            stoppedAt: true,
            haltedAt: true,
            haltReason: true,
            planJson: true,
          }
        });

        if (session) {
          console.error(`✓ Found session in database`);
          console.error(`  Symbol: ${session.symbol}`);
          console.error(`  Mode: ${session.mode}`);
          console.error(`  Status: ${session.stoppedAt ? 'stopped' : session.haltedAt ? 'halted' : 'active'}`);
          if (session.haltReason) {
            console.error(`  Halt Reason: ${session.haltReason}`);
          }
          console.error('');

          plan = session.planJson as any;
          agentState = {
            state: session.stoppedAt ? 'EXIT' : session.haltedAt ? 'HALT' : 'SCAN',
            killSwitchContext: session.haltReason ? { reason: session.haltReason } : null,
          };
        } else {
          console.error(`⚠️  Session ${sessionId} not found`);
          console.error('');
        }
      }
    }

    // Run analysis
    const analysis = await orderRejectionAnalyzer.analyze(symbol, {
      mode,
      aggressiveness,
      plan,
      agentState,
    });

    // Output results
    if (jsonOutput) {
      console.log(orderRejectionAnalyzer.exportAnalysis(analysis));
    } else {
      console.log(orderRejectionAnalyzer.formatAnalysis(analysis));
    }

    // Export to file if requested
    if (exportFile) {
      const fs = await import('fs');
      const path = await import('path');
      const fullPath = path.resolve(exportFile);
      fs.writeFileSync(fullPath, orderRejectionAnalyzer.exportAnalysis(analysis), 'utf-8');
      console.error(`\n✓ Analysis exported to: ${fullPath}`);
    }

    // Exit with appropriate code
    if (analysis.canTrade) {
      console.error('\n✅ Result: Agent CAN trade (no blocking conditions)');
      process.exit(0);
    } else {
      const blockingCount = analysis.rejections.filter(r => r.severity === 'blocking').length;
      console.error(`\n❌ Result: Agent CANNOT trade (${blockingCount} blocking condition(s))`);
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ Analysis failed:');
    console.error(error);
    process.exit(2);
  } finally {
    await prisma.$disconnect();
  }
}

main();
