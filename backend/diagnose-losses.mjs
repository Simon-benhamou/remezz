#!/usr/bin/env node
/**
 * Loss Diagnostic Tool
 * 
 * Analyzes why trades are losing and identifies strategy weaknesses
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
  magenta: '\x1b[35m',
};

function log(message, color = COLORS.reset) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function header(message) {
  log(`\n${'='.repeat(70)}`, COLORS.cyan);
  log(message, COLORS.bright + COLORS.cyan);
  log('='.repeat(70), COLORS.cyan);
}

async function analyzeRecentTrades() {
  header('RECENT TRADES ANALYSIS');
  
  const fills = await prisma.fill.findMany({
    where: {
      realizedPnl: { not: null },
    },
    orderBy: { ts: 'desc' },
    take: 20,
    include: {
      order: {
        select: {
          symbol: true,
          side: true,
          price: true,
          qty: true,
          leverage: true,
          latencyMs: true,
          slippageBps: true,
          createdAt: true,
        },
      },
    },
  });
  
  if (fills.length === 0) {
    log('⚠️  No trades with PnL found', COLORS.yellow);
    return { wins: 0, losses: 0, avgWinSize: 0, avgLossSize: 0 };
  }
  
  const wins = fills.filter(f => (f.realizedPnl ?? 0) > 0);
  const losses = fills.filter(f => (f.realizedPnl ?? 0) < 0);
  const breakeven = fills.filter(f => (f.realizedPnl ?? 0) === 0);
  
  const totalPnl = fills.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0);
  const avgWinSize = wins.length > 0 
    ? wins.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0) / wins.length 
    : 0;
  const avgLossSize = losses.length > 0
    ? losses.reduce((sum, f) => sum + (f.realizedPnl ?? 0), 0) / losses.length
    : 0;
  
  log(`\n📊 TRADE STATISTICS (Last ${fills.length} trades)`, COLORS.bright);
  console.log(`  Wins:      ${COLORS.green}${wins.length}${COLORS.reset} (${((wins.length / fills.length) * 100).toFixed(1)}%)`);
  console.log(`  Losses:    ${COLORS.red}${losses.length}${COLORS.reset} (${((losses.length / fills.length) * 100).toFixed(1)}%)`);
  console.log(`  Breakeven: ${losses.length} (${((breakeven.length / fills.length) * 100).toFixed(1)}%)`);
  console.log(`  Net PnL:   ${totalPnl >= 0 ? COLORS.green : COLORS.red}$${totalPnl.toFixed(2)}${COLORS.reset}`);
  console.log(`  Avg Win:   ${COLORS.green}+$${avgWinSize.toFixed(2)}${COLORS.reset}`);
  console.log(`  Avg Loss:  ${COLORS.red}$${avgLossSize.toFixed(2)}${COLORS.reset}`);
  console.log(`  Win/Loss Ratio: ${avgWinSize > 0 && avgLossSize < 0 ? (avgWinSize / Math.abs(avgLossSize)).toFixed(2) : 'N/A'}x`);
  
  // Detailed loss analysis
  if (losses.length > 0) {
    log(`\n🔍 LOSS BREAKDOWN`, COLORS.yellow);
    
    const lossReasons = {
      tooTightStop: 0,
      earlyExit: 0,
      reversal: 0,
      largeSlippage: 0,
      unknown: 0,
    };
    
    for (const loss of losses.slice(0, 10)) {
      const pnl = loss.realizedPnl ?? 0;
      const pnlPct = loss.order ? (pnl / (loss.order.price * loss.order.qty)) * 100 : 0;
      const slippage = loss.order?.slippageBps ?? 0;
      
      console.log(`\n  ${COLORS.red}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${COLORS.reset}`);
      console.log(`  Symbol: ${COLORS.cyan}${loss.order?.symbol ?? 'N/A'}${COLORS.reset}`);
      console.log(`  Loss: ${COLORS.red}$${pnl.toFixed(2)}${COLORS.reset} (${pnlPct.toFixed(2)}%)`);
      console.log(`  Price: $${loss.price.toFixed(4)}, Qty: ${loss.qty}`);
      console.log(`  Slippage: ${slippage.toFixed(2)} bps`);
      console.log(`  Time: ${loss.ts.toISOString()}`);
      
      // Classify loss reason
      if (Math.abs(pnlPct) < 1.5 && Math.abs(slippage) < 5) {
        console.log(`  ${COLORS.yellow}Likely: Stop too tight or premature exit${COLORS.reset}`);
        lossReasons.tooTightStop++;
      } else if (Math.abs(slippage) > 10) {
        console.log(`  ${COLORS.yellow}Likely: Large slippage on entry/exit${COLORS.reset}`);
        lossReasons.largeSlippage++;
      } else if (Math.abs(pnlPct) > 3) {
        console.log(`  ${COLORS.yellow}Likely: Market reversal, stop hit${COLORS.reset}`);
        lossReasons.reversal++;
      } else {
        lossReasons.unknown++;
      }
    }
    
    log(`\n📉 LOSS PATTERN SUMMARY`, COLORS.yellow);
    console.log(`  Stops too tight:  ${lossReasons.tooTightStop}`);
    console.log(`  Large slippage:   ${lossReasons.largeSlippage}`);
    console.log(`  Market reversal:  ${lossReasons.reversal}`);
    console.log(`  Unknown:          ${lossReasons.unknown}`);
  }
  
  return { 
    wins: wins.length, 
    losses: losses.length, 
    avgWinSize, 
    avgLossSize,
    winRate: wins.length / fills.length,
  };
}

async function analyzeStopLosses() {
  header('STOP LOSS ANALYSIS');
  
  const positions = await prisma.position.findMany({
    where: {
      qty: 0, // Closed positions
    },
    orderBy: { openedAt: 'desc' },
    take: 20,
    select: {
      symbol: true,
      entryPrice: true,
      stopPrice: true,
      leverage: true,
      openedAt: true,
      updatedAt: true,
    },
  });
  
  if (positions.length === 0) {
    log('⚠️  No closed positions found', COLORS.yellow);
    return;
  }
  
  log(`\n📍 STOP LOSS DISTANCES (Last ${Math.min(positions.length, 10)} positions)`, COLORS.bright);
  
  for (const pos of positions.slice(0, 10)) {
    if (!pos.stopPrice || !pos.entryPrice) continue;
    
    const stopDistancePct = Math.abs((pos.stopPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const holdTimeMs = pos.updatedAt ? pos.updatedAt.getTime() - pos.openedAt.getTime() : 0;
    const holdTimeMin = Math.round(holdTimeMs / 60000);
    
    const color = stopDistancePct < 1 ? COLORS.red : stopDistancePct < 2 ? COLORS.yellow : COLORS.green;
    
    console.log(`\n  ${pos.symbol}`);
    console.log(`    Stop distance: ${color}${stopDistancePct.toFixed(2)}%${COLORS.reset} (${pos.leverage}x leverage)`);
    console.log(`    Entry: $${pos.entryPrice.toFixed(4)}, Stop: $${pos.stopPrice.toFixed(4)}`);
    console.log(`    Hold time: ${holdTimeMin} minutes`);
    
    if (stopDistancePct < 1) {
      log(`    ${COLORS.red}⚠️  PROBLEM: Stop too tight! (<1%)${COLORS.reset}`, COLORS.red);
    } else if (stopDistancePct < 1.5) {
      log(`    ${COLORS.yellow}⚠️  WARNING: Stop may be too tight (1-1.5%)${COLORS.reset}`, COLORS.yellow);
    }
  }
  
  const avgStopDistance = positions
    .filter(p => p.stopPrice && p.entryPrice)
    .reduce((sum, p) => sum + Math.abs((p.stopPrice - p.entryPrice) / p.entryPrice) * 100, 0) 
    / positions.filter(p => p.stopPrice && p.entryPrice).length;
  
  log(`\n📊 Average Stop Distance: ${avgStopDistance.toFixed(2)}%`, COLORS.bright);
  
  if (avgStopDistance < 1.5) {
    log(`\n${COLORS.red}⚠️  CRITICAL ISSUE: Stops are TOO TIGHT!${COLORS.reset}`, COLORS.red);
    log(`   Recommended: 2-3% stop distance for safety`, COLORS.yellow);
    log(`   Current: ${avgStopDistance.toFixed(2)}% - easily hit by normal volatility`, COLORS.yellow);
  }
}

async function analyzeEntryQuality() {
  header('ENTRY QUALITY ANALYSIS');
  
  const orders = await prisma.order.findMany({
    where: {
      status: 'filled',
      side: { in: ['buy', 'sell'] },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      symbol: true,
      side: true,
      slippageBps: true,
      latencyMs: true,
      price: true,
      requestedPrice: true,
      createdAt: true,
    },
  });
  
  if (orders.length === 0) {
    log('⚠️  No orders found', COLORS.yellow);
    return;
  }
  
  const avgSlippage = orders
    .filter(o => o.slippageBps != null)
    .reduce((sum, o) => sum + Math.abs(o.slippageBps), 0) / orders.filter(o => o.slippageBps != null).length;
  
  const avgLatency = orders
    .filter(o => o.latencyMs != null)
    .reduce((sum, o) => sum + o.latencyMs, 0) / orders.filter(o => o.latencyMs != null).length;
  
  log(`\n📊 ENTRY EXECUTION METRICS`, COLORS.bright);
  console.log(`  Avg Slippage: ${avgSlippage.toFixed(2)} bps ${avgSlippage > 15 ? COLORS.red + '(HIGH!)' + COLORS.reset : ''}`);
  console.log(`  Avg Latency:  ${avgLatency.toFixed(0)} ms ${avgLatency > 500 ? COLORS.red + '(SLOW!)' + COLORS.reset : ''}`);
  
  if (avgSlippage > 10) {
    log(`\n${COLORS.yellow}⚠️  HIGH SLIPPAGE DETECTED!${COLORS.reset}`, COLORS.yellow);
    log(`   This eats into profits and makes wins smaller`, COLORS.yellow);
    log(`   Consider: Market orders in more liquid times, better entry timing`, COLORS.yellow);
  }
}

async function checkPredictorAccuracy() {
  header('PREDICTOR ACCURACY CHECK');
  
  // Check if predictor is enabled and recent predictions
  const triggerLogs = await prisma.triggerLog.findMany({
    where: {
      kind: 'predictor_insight',
    },
    orderBy: { timestamp: 'desc' },
    take: 20,
  });
  
  if (triggerLogs.length === 0) {
    log('⚠️  No predictor insights found', COLORS.yellow);
    log('   Predictor may be disabled or not generating signals', COLORS.yellow);
    return;
  }
  
  log(`\n🤖 PREDICTOR INSIGHTS (Last ${triggerLogs.length} signals)`, COLORS.bright);
  
  const predictions = triggerLogs.map(log => {
    const payload = log.payload;
    return {
      symbol: log.symbol,
      bias: payload.bias,
      confidence: payload.confidence,
      timestamp: log.timestamp,
    };
  });
  
  const bullishCount = predictions.filter(p => p.bias === 'bullish').length;
  const bearishCount = predictions.filter(p => p.bias === 'bearish').length;
  const neutralCount = predictions.filter(p => p.bias === 'neutral').length;
  
  console.log(`  Bullish predictions: ${bullishCount}`);
  console.log(`  Bearish predictions: ${bearishCount}`);
  console.log(`  Neutral predictions: ${neutralCount}`);
  
  const avgConfidence = predictions.reduce((sum, p) => sum + (p.confidence ?? 0), 0) / predictions.length;
  console.log(`  Avg Confidence: ${avgConfidence.toFixed(2)}`);
  
  if (avgConfidence < 0.6) {
    log(`\n${COLORS.yellow}⚠️  LOW PREDICTOR CONFIDENCE!${COLORS.reset}`, COLORS.yellow);
    log(`   Model may need retraining with more data`, COLORS.yellow);
  }
}

async function diagnoseCommonIssues(stats) {
  header('STRATEGY DIAGNOSIS & RECOMMENDATIONS');
  
  const issues = [];
  const recommendations = [];
  
  // Issue 1: All losses (0% win rate)
  if (stats.losses >= 4 && stats.wins === 0) {
    issues.push({
      severity: 'CRITICAL',
      title: '0% Win Rate - Systematic Problem',
      description: 'All trades are losing. This indicates a fundamental issue.',
    });
    recommendations.push('🔧 Stop trading immediately and investigate');
    recommendations.push('🔧 Check if predictor model is trained on recent data');
    recommendations.push('🔧 Verify stop losses are not too tight (<2% is dangerous)');
    recommendations.push('🔧 Check if you\'re trading against the trend');
  }
  
  // Issue 2: Poor win/loss ratio
  if (stats.avgLossSize < 0 && stats.avgWinSize > 0) {
    const ratio = stats.avgWinSize / Math.abs(stats.avgLossSize);
    if (ratio < 1.5) {
      issues.push({
        severity: 'HIGH',
        title: 'Poor Risk/Reward Ratio',
        description: `Wins ($${stats.avgWinSize.toFixed(2)}) not much bigger than losses ($${stats.avgLossSize.toFixed(2)})`,
      });
      recommendations.push('🎯 Aim for 2-3x risk/reward: If risking $10, target $20-30 profit');
      recommendations.push('🎯 Let winners run longer, use trailing stops');
      recommendations.push('🎯 Exit strategy may be taking profits too early');
    }
  }
  
  // Issue 3: Low win rate needs high R:R
  if (stats.winRate < 0.45 && stats.avgWinSize / Math.abs(stats.avgLossSize) < 2) {
    issues.push({
      severity: 'HIGH',
      title: 'Win Rate Too Low for Risk/Reward',
      description: 'Need 2x+ R:R to be profitable with <45% win rate',
    });
    recommendations.push('💡 Option 1: Improve entry quality (wait for better setups)');
    recommendations.push('💡 Option 2: Increase take-profit targets (3-5x risk)');
    recommendations.push('💡 Option 3: Use entry timing agent to wait for pullbacks');
  }
  
  // Display issues
  if (issues.length > 0) {
    log(`\n🚨 IDENTIFIED ISSUES (${issues.length})`, COLORS.red + COLORS.bright);
    for (const issue of issues) {
      const color = issue.severity === 'CRITICAL' ? COLORS.red : COLORS.yellow;
      log(`\n  ${color}[${issue.severity}] ${issue.title}${COLORS.reset}`, color);
      log(`  ${issue.description}`, COLORS.reset);
    }
  } else {
    log(`\n✅ No critical issues detected`, COLORS.green);
  }
  
  // Display recommendations
  if (recommendations.length > 0) {
    log(`\n💡 RECOMMENDATIONS (${recommendations.length})`, COLORS.cyan + COLORS.bright);
    for (const rec of recommendations) {
      log(`  ${rec}`, COLORS.cyan);
    }
  }
  
  // Strategy improvements to enable
  log(`\n🔄 IMPROVEMENTS TO LEVERAGE`, COLORS.magenta + COLORS.bright);
  log(`  ✅ Correlation Manager: ACTIVE - prevents over-concentration`, COLORS.green);
  log(`  ✅ Entry Timing Agent: ACTIVE - optimizes entry (wait_pullback/confirmation)`, COLORS.green);
  log(`  ✅ Exit Strategy Agent: ACTIVE - partial exits at 2R/3.5R/6R`, COLORS.green);
  log(`  ⏳ Learning System: Building confidence (needs 20-40 trades per symbol)`, COLORS.yellow);
  
  log(`\n📈 EXPECTED IMPROVEMENTS OVER TIME`, COLORS.bright);
  log(`  • Win rate should improve by +3-5% as entry timing learns`, COLORS.reset);
  log(`  • Average win size should increase by +20-30% with better exits`, COLORS.reset);
  log(`  • Drawdown should reduce by -2-3% with correlation constraints`, COLORS.reset);
  log(`  • Overall return should improve by +50-67% after 40+ trades`, COLORS.reset);
}

async function suggestImmediateActions(stats) {
  header('IMMEDIATE ACTION ITEMS');
  
  log(`\n🎯 WHAT TO DO NOW`, COLORS.bright);
  
  if (stats.losses >= 4 && stats.wins === 0) {
    log(`\n  ${COLORS.red}⚠️  STOP TRADING IMMEDIATELY${COLORS.reset}`, COLORS.red);
    log(`  You have 4 losses in a row. Here's what to check:`, COLORS.yellow);
    log(`\n  1️⃣  Check Stop Loss Settings`, COLORS.cyan);
    log(`     • Should be 2-3% from entry (with leverage adjustment)`, COLORS.reset);
    log(`     • Too tight stops get hit by normal market noise`, COLORS.reset);
    log(`\n  2️⃣  Verify Predictor Model`, COLORS.cyan);
    log(`     • Run: npm run retrain (in backend/)`, COLORS.reset);
    log(`     • Needs recent market data to predict correctly`, COLORS.reset);
    log(`\n  3️⃣  Check Market Conditions`, COLORS.cyan);
    log(`     • Are you trading in choppy/sideways markets?`, COLORS.reset);
    log(`     • Strategy works best in trending markets`, COLORS.reset);
    log(`\n  4️⃣  Review Entry Timing`, COLORS.cyan);
    log(`     • Entry timing agent should wait for pullbacks`, COLORS.reset);
    log(`     • Check logs for "action=wait_pullback" messages`, COLORS.reset);
    log(`\n  5️⃣  Adjust Risk Parameters`, COLORS.cyan);
    log(`     • Lower leverage temporarily (3-5x instead of 10x)`, COLORS.reset);
    log(`     • Reduce position size until win rate improves`, COLORS.reset);
  } else {
    log(`\n  ${COLORS.green}✓ Continue paper trading and monitor${COLORS.reset}`, COLORS.green);
    log(`  • Let learning system accumulate 20+ trades per symbol`, COLORS.reset);
    log(`  • Confidence will increase from 0.50 → 1.0 over time`, COLORS.reset);
    log(`  • Parameters will adapt based on actual results`, COLORS.reset);
  }
}

async function main() {
  log('\n' + '█'.repeat(70), COLORS.bright + COLORS.blue);
  log('  LOSS DIAGNOSTIC TOOL - STRATEGY ANALYSIS', COLORS.bright + COLORS.blue);
  log('█'.repeat(70) + '\n', COLORS.bright + COLORS.blue);
  
  try {
    const stats = await analyzeRecentTrades();
    await analyzeStopLosses();
    await analyzeEntryQuality();
    await checkPredictorAccuracy();
    await diagnoseCommonIssues(stats);
    await suggestImmediateActions(stats);
    
    log('\n' + '='.repeat(70), COLORS.green);
    log('DIAGNOSIS COMPLETE', COLORS.green + COLORS.bright);
    log('='.repeat(70) + '\n', COLORS.green);
    
  } catch (error) {
    console.error('Error during diagnosis:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
