#!/usr/bin/env node
/**
 * Simple Subagent Test
 * 
 * Tests that all 7 subagent types are registered and working:
 * 1. risk_governor - Capital allocation, leverage limits
 * 2. execution - Order execution strategy
 * 3. predictor - ML-based direction prediction
 * 4. sentiment - News analysis, market sentiment
 * 5. market_quality - Liquidity, spread, depth
 * 6. entry_timing - Entry optimization
 * 7. exit_strategy - Partial exits, trailing stops
 */

import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

config();

const prisma = new PrismaClient();

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = COLORS.reset) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function header(message) {
  log(`\n${'='.repeat(70)}`, COLORS.cyan);
  log(message, COLORS.bright + COLORS.cyan);
  log('='.repeat(70), COLORS.cyan);
}

function success(message) {
  log(`✓ ${message}`, COLORS.green);
}

function error(message) {
  log(`✗ ${message}`, COLORS.red);
}

function info(message) {
  log(`ℹ ${message}`, COLORS.blue);
}

async function testSubagentCoverage() {
  header('Testing All 7 Subagent Types');
  
  const expectedSubagents = [
    'risk_governor',
    'execution',
    'predictor',
    'sentiment',
    'market_quality',
    'entry_timing',
    'exit_strategy',
  ];
  
  info(`Expected ${expectedSubagents.length} subagent types`);
  
  // Query database for subagent learning records
  const records = await prisma.subagentLearningState.findMany({
    select: {
      subagent: true,
      symbol: true,
      updatedAt: true,
    },
    orderBy: {
      updatedAt: 'desc',
    },
  });
  
  if (records.length === 0) {
    error('No subagent learning records found in database');
    log('\nℹ This is normal if no trades have been executed yet.', COLORS.yellow);
    log('  Subagents will be created automatically when trading starts.', COLORS.yellow);
    return false;
  }
  
  log(`\nFound ${records.length} total learning records`);
  
  // Group by subagent type
  const typeGroups = new Map();
  for (const record of records) {
    if (!typeGroups.has(record.subagent)) {
      typeGroups.set(record.subagent, []);
    }
    typeGroups.get(record.subagent).push(record);
  }
  
  log(`\nSubagent Coverage:`);
  log('─'.repeat(70));
  
  let allFound = true;
  for (const type of expectedSubagents) {
    const count = typeGroups.get(type)?.length || 0;
    if (count > 0) {
      success(`${type.padEnd(20)} - ${count} records`);
    } else {
      error(`${type.padEnd(20)} - NOT FOUND`);
      allFound = false;
    }
  }
  
  // Check for unexpected types
  for (const [type, records] of typeGroups) {
    if (!expectedSubagents.includes(type)) {
      log(`⚠ Unexpected type: ${type} (${records.length} records)`, COLORS.yellow);
    }
  }
  
  if (allFound) {
    log('');
    success('✓ ALL 7 SUBAGENTS HAVE LEARNING RECORDS');
    return true;
  } else {
    log('');
    error('✗ MISSING SUBAGENT TYPES');
    log('\nℹ Missing subagents will be created automatically when:', COLORS.yellow);
    log('  - Their first trade is executed', COLORS.yellow);
    log('  - Learning system refreshes after fills', COLORS.yellow);
    return false;
  }
}

async function testSubagentDetails() {
  header('Subagent Learning Details');
  
  // Get recent learning state with recommendations
  const recentStates = await prisma.subagentLearningState.findMany({
    take: 10,
    orderBy: {
      updatedAt: 'desc',
    },
  });
  
  if (recentStates.length === 0) {
    error('No learning states found');
    return;
  }
  
  log(`\nRecent Learning States (last 10):`);
  log('─'.repeat(70));
  
  for (const state of recentStates) {
    const tuning = state.tuning;
    log(`\n${state.subagent} (${state.symbol}):`, COLORS.bright);
    log(`  Score: ${state.score?.toFixed(2) || 'N/A'}`);
    log(`  Sample Count: ${state.sampleCount}`);
    log(`  Updated: ${state.updatedAt.toISOString()}`);
    
    // Show type-specific tuning
    if (state.subagent === 'risk_governor' && tuning) {
      log(`  Max Leverage: ${tuning.recommendedMaxLeverage?.toFixed(1) || 'N/A'}x`);
      log(`  Position Size: ${(tuning.recommendedMaxPositionPct * 100)?.toFixed(0) || 'N/A'}%`);
    } else if (state.subagent === 'execution' && tuning) {
      log(`  Slippage Tolerance: ${(tuning.slippageTolerance * 100)?.toFixed(1) || 'N/A'}%`);
    } else if (state.subagent === 'entry_timing' && tuning) {
      log(`  Patience: ${tuning.patience || 'N/A'}`);
    }
  }
  
  log('');
  success('Subagent details retrieved successfully');
}

async function testPerformanceLedger() {
  header('Performance Ledger Quality');
  
  // Check if we have trade data feeding the learning system
  const ledgerEntries = await prisma.agentPerformanceLedger.findMany({
    take: 10,
    orderBy: {
      createdAt: 'desc',
    },
  });
  
  if (ledgerEntries.length === 0) {
    error('No performance ledger entries found');
    log('\nℹ This is normal if no trades have been closed yet.', COLORS.yellow);
    log('  The learning system needs closed positions to learn from.', COLORS.yellow);
    return false;
  }
  
  log(`\nFound ${ledgerEntries.length} recent ledger entries`);
  log('─'.repeat(70));
  
  let winCount = 0;
  let lossCount = 0;
  
  for (const entry of ledgerEntries) {
    const pnl = Number(entry.pnl);
    if (pnl > 0) winCount++;
    else if (pnl < 0) lossCount++;
    
    const pnlStr = pnl >= 0 
      ? `+$${pnl.toFixed(2)}` 
      : `-$${Math.abs(pnl).toFixed(2)}`;
    
    const color = pnl >= 0 ? COLORS.green : COLORS.red;
    log(`${entry.symbol.padEnd(12)} ${pnlStr.padStart(10)}`, color);
  }
  
  const winRate = winCount / (winCount + lossCount);
  log('');
  log(`Win Rate: ${(winRate * 100).toFixed(1)}% (${winCount}W / ${lossCount}L)`);
  
  success('Performance ledger has quality data');
  return true;
}

async function main() {
  try {
    log('\n' + '═'.repeat(70), COLORS.bright + COLORS.cyan);
    log('   SUBAGENT SYSTEM TEST', COLORS.bright + COLORS.cyan);
    log('   Validating all 7 subagent types are operational', COLORS.cyan);
    log('═'.repeat(70) + '\n', COLORS.bright + COLORS.cyan);
    
    const coverageOk = await testSubagentCoverage();
    await testSubagentDetails();
    const ledgerOk = await testPerformanceLedger();
    
    // Final summary
    header('TEST SUMMARY');
    
    if (coverageOk) {
      success('✓ All 7 subagents have learning records');
    } else {
      error('✗ Some subagents missing (will be created on first trade)');
    }
    
    if (ledgerOk) {
      success('✓ Performance ledger has trade history');
    } else {
      error('✗ No performance data yet (need closed positions)');
    }
    
    log('');
    log('Next Steps:', COLORS.bright);
    log('  1. Restart backend to apply stop loss fixes', COLORS.cyan);
    log('  2. Start paper trading session', COLORS.cyan);
    log('  3. Let system execute 10+ trades', COLORS.cyan);
    log('  4. Check learning progression over 20-40 trades', COLORS.cyan);
    log('');
    
  } catch (err) {
    error(`Test failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
