#!/usr/bin/env node
/**
 * Comprehensive Agent Flow Analysis
 * 
 * This script performs a thorough investigation of agent behavior, state transitions,
 * and configuration quality from a trader's perspective.
 */

import { prisma } from '../dist/src/db/client.js';
import { getConfig } from '../dist/src/utils/env.js';

const ANALYSIS_REPORT = {
  timestamp: new Date().toISOString(),
  sections: [],
  summary: {
    totalIssues: 0,
    criticalIssues: 0,
    warnings: 0,
    recommendations: []
  }
};

function addSection(title, data) {
  ANALYSIS_REPORT.sections.push({ title, data, timestamp: new Date().toISOString() });
}

function addIssue(severity, category, description, data = {}) {
  const issue = { severity, category, description, data, timestamp: new Date().toISOString() };
  ANALYSIS_REPORT.summary.totalIssues++;
  if (severity === 'critical') ANALYSIS_REPORT.summary.criticalIssues++;
  if (severity === 'warning') ANALYSIS_REPORT.summary.warnings++;
  return issue;
}

function addRecommendation(text, priority = 'medium') {
  ANALYSIS_REPORT.summary.recommendations.push({ text, priority, timestamp: new Date().toISOString() });
}

async function analyzeAgentStates() {
  console.log('\n📊 PHASE 1: Agent State Analysis\n');
  
  const sessions = await prisma.agentSession.findMany({
    include: {
      kpi: true,
      positions: true,
      orders: {
        orderBy: { createdAt: 'desc' },
        take: 10
      },
      opsTelemetry: true
    },
    orderBy: { startedAt: 'desc' },
    take: 50
  });

  const stateDistribution = {
    active: 0,
    stopped: 0,
    halted: 0,
    total: sessions.length
  };

  const issues = [];

  for (const session of sessions) {
    const isActive = !session.stoppedAt;
    const isHalted = session.haltedAt && !session.stoppedAt;
    
    if (isActive) stateDistribution.active++;
    if (session.stoppedAt) stateDistribution.stopped++;
    if (isHalted) stateDistribution.halted++;

    // Check for stuck agents
    const lastOrderAt = session.orders[0]?.createdAt;
    const sessionAge = Date.now() - session.startedAt.getTime();
    const hoursSinceLastOrder = lastOrderAt 
      ? (Date.now() - lastOrderAt.getTime()) / (1000 * 60 * 60)
      : sessionAge / (1000 * 60 * 60);

    if (isActive && hoursSinceLastOrder > 24) {
      issues.push(addIssue('warning', 'inactivity', 
        `Agent ${session.id} (${session.symbol}) has been inactive for ${hoursSinceLastOrder.toFixed(1)} hours`,
        { sessionId: session.id, symbol: session.symbol, hoursSinceLastOrder }
      ));
    }

    // Check for halted agents that should be recovered
    if (isHalted) {
      const haltDuration = (Date.now() - session.haltedAt.getTime()) / (1000 * 60);
      if (haltDuration > 60) { // Halted for more than 1 hour
        issues.push(addIssue('warning', 'prolonged_halt',
          `Agent ${session.id} (${session.symbol}) has been halted for ${haltDuration.toFixed(0)} minutes`,
          { sessionId: session.id, symbol: session.symbol, haltReason: session.haltReason, haltDuration }
        ));
      }
    }

    // Check for position/order inconsistencies
    const hasPosition = session.positions.some(p => p.qty && Number(p.qty) > 0);
    const hasOpenOrders = session.orders.some(o => 
      ['open', 'created', 'new', 'partially_filled'].includes(o.status || '')
    );

    if (hasPosition && !isActive) {
      issues.push(addIssue('critical', 'position_leak',
        `Stopped agent ${session.id} (${session.symbol}) still has an open position`,
        { sessionId: session.id, symbol: session.symbol, positions: session.positions.filter(p => p.qty && Number(p.qty) > 0) }
      ));
    }

    if (hasOpenOrders && !isActive) {
      issues.push(addIssue('warning', 'order_leak',
        `Stopped agent ${session.id} (${session.symbol}) still has open orders`,
        { sessionId: session.id, symbol: session.symbol, openOrderCount: session.orders.filter(o => ['open', 'created', 'new'].includes(o.status || '')).length }
      ));
    }
  }

  addSection('Agent State Distribution', {
    ...stateDistribution,
    activePercentage: ((stateDistribution.active / stateDistribution.total) * 100).toFixed(1) + '%',
    haltedPercentage: ((stateDistribution.halted / stateDistribution.total) * 100).toFixed(1) + '%',
    issues
  });

  console.log(`✅ Analyzed ${sessions.length} sessions`);
  console.log(`   Active: ${stateDistribution.active}, Stopped: ${stateDistribution.stopped}, Halted: ${stateDistribution.halted}`);
  console.log(`   Issues found: ${issues.length}`);
}

async function analyzeEntryExitBehavior() {
  console.log('\n📈 PHASE 2: Entry/Exit Behavior Analysis\n');
  
  // Analyze recent orders and fills
  const recentOrders = await prisma.order.findMany({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
      }
    },
    include: {
      fills: true,
      session: {
        include: {
          kpi: true
        }
      }
    },
    orderBy: { createdAt: 'desc' },
    take: 500
  });

  const entryStats = {
    totalOrders: recentOrders.length,
    filled: 0,
    partiallyFilled: 0,
    rejected: 0,
    cancelled: 0,
    avgLatencyMs: 0,
    avgSlippageBps: 0,
    avgFillRatio: 0
  };

  let latencySum = 0, latencyCount = 0;
  let slippageSum = 0, slippageCount = 0;
  let fillRatioSum = 0, fillRatioCount = 0;

  const issues = [];

  for (const order of recentOrders) {
    if (order.status === 'filled') entryStats.filled++;
    if (order.status === 'partially_filled') entryStats.partiallyFilled++;
    if (order.status === 'rejected') entryStats.rejected++;
    if (order.status === 'canceled' || order.status === 'cancelled') entryStats.cancelled++;

    // Analyze latency
    if (order.latencyMs && Number.isFinite(order.latencyMs)) {
      latencySum += order.latencyMs;
      latencyCount++;
      
      if (order.latencyMs > 5000) { // > 5 seconds
        issues.push(addIssue('warning', 'high_latency',
          `Order ${order.id} had high latency: ${order.latencyMs}ms`,
          { orderId: order.id, latencyMs: order.latencyMs, symbol: order.symbol }
        ));
      }
    }

    // Analyze slippage
    if (order.slippageBps && Number.isFinite(order.slippageBps)) {
      slippageSum += order.slippageBps;
      slippageCount++;

      if (Math.abs(order.slippageBps) > 50) { // > 0.5% slippage
        issues.push(addIssue('warning', 'high_slippage',
          `Order ${order.id} had high slippage: ${order.slippageBps} bps`,
          { orderId: order.id, slippageBps: order.slippageBps, symbol: order.symbol }
        ));
      }
    }

    // Analyze fill ratio
    if (order.fillRatio && Number.isFinite(order.fillRatio)) {
      fillRatioSum += order.fillRatio;
      fillRatioCount++;

      if (order.fillRatio < 0.8) { // < 80% filled
        issues.push(addIssue('info', 'partial_fill',
          `Order ${order.id} only ${(order.fillRatio * 100).toFixed(1)}% filled`,
          { orderId: order.id, fillRatio: order.fillRatio, symbol: order.symbol }
        ));
      }
    }

    // Check for multiple cancellations
    if (order.cancelCount && order.cancelCount > 2) {
      issues.push(addIssue('warning', 'excessive_cancellations',
        `Order ${order.id} was cancelled ${order.cancelCount} times`,
        { orderId: order.id, cancelCount: order.cancelCount, symbol: order.symbol }
      ));
    }
  }

  entryStats.avgLatencyMs = latencyCount > 0 ? (latencySum / latencyCount).toFixed(2) : 0;
  entryStats.avgSlippageBps = slippageCount > 0 ? (slippageSum / slippageCount).toFixed(2) : 0;
  entryStats.avgFillRatio = fillRatioCount > 0 ? ((fillRatioSum / fillRatioCount) * 100).toFixed(2) + '%' : 'N/A';

  addSection('Entry/Exit Execution Quality', {
    ...entryStats,
    fillRate: entryStats.totalOrders > 0 ? ((entryStats.filled / entryStats.totalOrders) * 100).toFixed(1) + '%' : 'N/A',
    rejectionRate: entryStats.totalOrders > 0 ? ((entryStats.rejected / entryStats.totalOrders) * 100).toFixed(1) + '%' : 'N/A',
    issues
  });

  console.log(`✅ Analyzed ${recentOrders.length} orders`);
  console.log(`   Fill rate: ${entryStats.totalOrders > 0 ? ((entryStats.filled / entryStats.totalOrders) * 100).toFixed(1) : 0}%`);
  console.log(`   Avg latency: ${entryStats.avgLatencyMs}ms`);
  console.log(`   Issues found: ${issues.length}`);
}

async function analyzeRiskManagement() {
  console.log('\n🛡️ PHASE 3: Risk Management Analysis\n');
  
  const activeSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    include: {
      kpi: true,
      positions: true,
      orders: {
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24h
          }
        }
      },
      opsTelemetry: true
    }
  });

  const riskMetrics = {
    totalActiveSessions: activeSessions.length,
    sessionsWithPositions: 0,
    dailyLossLimitBreaches: 0,
    tradeLimitBreaches: 0,
    leverageIssues: 0
  };

  const issues = [];

  for (const session of activeSessions) {
    const profile = session.profileJson as any || {};
    const hasPosition = session.positions.some(p => p.qty && Number(p.qty) > 0);
    
    if (hasPosition) riskMetrics.sessionsWithPositions++;

    // Check daily loss limit
    const dailyLossLimitPct = profile.dailyLossLimitPct || 3.5;
    const startBalance = session.startBalanceUsd || 0;
    const realizedPnl = session.kpi?.realizedPnlUsd || 0;
    const unrealizedPnl = session.kpi?.unrealizedPnlUsd || 0;
    const totalPnl = realizedPnl + unrealizedPnl;
    const lossPct = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;

    if (lossPct < -dailyLossLimitPct) {
      riskMetrics.dailyLossLimitBreaches++;
      issues.push(addIssue('critical', 'daily_loss_limit_breach',
        `Agent ${session.id} (${session.symbol}) exceeded daily loss limit: ${lossPct.toFixed(2)}% < -${dailyLossLimitPct}%`,
        { sessionId: session.id, symbol: session.symbol, lossPct, limit: dailyLossLimitPct }
      ));
    }

    // Check trade frequency (last 24h)
    const tradesLast24h = session.orders.length;
    const maxTradesPerDay = 7; // Default limit
    
    if (tradesLast24h > maxTradesPerDay) {
      riskMetrics.tradeLimitBreaches++;
      issues.push(addIssue('warning', 'excessive_trading',
        `Agent ${session.id} (${session.symbol}) executed ${tradesLast24h} trades in last 24h (limit: ${maxTradesPerDay})`,
        { sessionId: session.id, symbol: session.symbol, tradesLast24h, limit: maxTradesPerDay }
      ));
    }

    // Check leverage configuration
    const maxLeverage = profile.maxLeverage || 1;
    const requestedMaxLeverage = profile.requestedMaxLeverage || maxLeverage;
    
    if (maxLeverage < requestedMaxLeverage) {
      riskMetrics.leverageIssues++;
      issues.push(addIssue('info', 'leverage_capped',
        `Agent ${session.id} (${session.symbol}) leverage capped: ${maxLeverage} < ${requestedMaxLeverage} (requested)`,
        { sessionId: session.id, symbol: session.symbol, maxLeverage, requestedMaxLeverage }
      ));
    }

    // Check circuit breaker state
    if (session.opsTelemetry?.blockedByVos) {
      issues.push(addIssue('warning', 'circuit_breaker_active',
        `Agent ${session.id} (${session.symbol}) is blocked by circuit breaker`,
        { 
          sessionId: session.id, 
          symbol: session.symbol, 
          lastBlockedAt: session.opsTelemetry.lastBlockedAt,
          circuitState: session.opsTelemetry.circuitState 
        }
      ));
    }
  }

  addSection('Risk Management Metrics', {
    ...riskMetrics,
    positionUtilization: activeSessions.length > 0 
      ? ((riskMetrics.sessionsWithPositions / activeSessions.length) * 100).toFixed(1) + '%'
      : 'N/A',
    issues
  });

  console.log(`✅ Analyzed ${activeSessions.length} active sessions`);
  console.log(`   With positions: ${riskMetrics.sessionsWithPositions}`);
  console.log(`   Risk issues found: ${issues.length}`);
}

async function analyzePerformanceMetrics() {
  console.log('\n💰 PHASE 4: Performance Metrics Analysis\n');
  
  const allSessions = await prisma.agentSession.findMany({
    include: {
      kpi: true
    },
    take: 100
  });

  const perfMetrics = {
    totalSessions: allSessions.length,
    profitableSessions: 0,
    totalPnlUsd: 0,
    totalRoiPct: 0,
    avgWinRate: 0,
    totalAiCalls: 0,
    totalAiCostUsd: 0
  };

  const winRates = [];
  const issues = [];

  for (const session of allSessions) {
    if (!session.kpi) continue;

    const pnl = (session.kpi.realizedPnlUsd || 0) + (session.kpi.unrealizedPnlUsd || 0);
    const roi = session.kpi.roiPct || 0;
    const winRate = session.kpi.winRate || 0;

    perfMetrics.totalPnlUsd += pnl;
    if (pnl > 0) perfMetrics.profitableSessions++;
    if (roi !== 0) perfMetrics.totalRoiPct += roi;
    if (winRate > 0) winRates.push(winRate);

    // AI usage metrics
    perfMetrics.totalAiCalls += session.kpi.aiCallsTotal || 0;
    perfMetrics.totalAiCostUsd += session.kpi.aiCostUsd || 0;

    // Check for poor performance
    if (winRate < 40 && (session.kpi.stats as any)?.trades > 10) {
      issues.push(addIssue('warning', 'low_win_rate',
        `Agent ${session.id} (${session.symbol}) has low win rate: ${winRate.toFixed(1)}%`,
        { sessionId: session.id, symbol: session.symbol, winRate, trades: (session.kpi.stats as any)?.trades }
      ));
    }

    // Check for excessive AI costs
    const aiCostPerTrade = (session.kpi.stats as any)?.trades > 0 
      ? (session.kpi.aiCostUsd || 0) / (session.kpi.stats as any).trades 
      : 0;
    
    if (aiCostPerTrade > 0.5) { // More than $0.50 per trade
      issues.push(addIssue('warning', 'high_ai_cost',
        `Agent ${session.id} (${session.symbol}) has high AI cost per trade: $${aiCostPerTrade.toFixed(3)}`,
        { sessionId: session.id, symbol: session.symbol, aiCostPerTrade, totalAiCost: session.kpi.aiCostUsd }
      ));
    }
  }

  perfMetrics.avgWinRate = winRates.length > 0 
    ? (winRates.reduce((a, b) => a + b, 0) / winRates.length).toFixed(2) + '%'
    : 'N/A';

  perfMetrics.profitableRate = allSessions.length > 0
    ? ((perfMetrics.profitableSessions / allSessions.length) * 100).toFixed(1) + '%'
    : 'N/A';

  addSection('Performance Metrics', {
    ...perfMetrics,
    totalPnlUsd: perfMetrics.totalPnlUsd.toFixed(2),
    avgRoiPct: allSessions.length > 0 ? (perfMetrics.totalRoiPct / allSessions.length).toFixed(2) + '%' : 'N/A',
    totalAiCostUsd: perfMetrics.totalAiCostUsd.toFixed(2),
    issues
  });

  console.log(`✅ Analyzed ${allSessions.length} sessions for performance`);
  console.log(`   Total PnL: $${perfMetrics.totalPnlUsd.toFixed(2)}`);
  console.log(`   Avg win rate: ${perfMetrics.avgWinRate}`);
  console.log(`   Issues found: ${issues.length}`);
}

async function analyzeConfiguration() {
  console.log('\n⚙️ PHASE 5: Configuration Analysis\n');
  
  const config = getConfig();
  const activeSessions = await prisma.agentSession.findMany({
    where: { stoppedAt: null },
    select: {
      id: true,
      symbol: true,
      profileJson: true,
      rrFloor: true,
      rrCeil: true,
      rrBaseMin: true,
      rrExpectancy: true
    }
  });

  const configAnalysis = {
    globalConfig: {
      MIN_TP_PCT: config.MIN_TP_PCT,
      MIN_STOP_PCT: config.MIN_STOP_PCT,
      DEFAULT_RISK_PCT: config.DEFAULT_RISK_PCT,
      MAX_LEVERAGE_GLOBAL: config.MAX_LEVERAGE_GLOBAL
    },
    sessionConfigs: [],
    issues: []
  };

  for (const session of activeSessions) {
    const profile = session.profileJson as any || {};
    
    const sessionConfig = {
      sessionId: session.id,
      symbol: session.symbol,
      aggressiveness: profile.aggressiveness || 'reactive',
      riskPerTradePct: profile.riskPerTradePct,
      maxLeverage: profile.maxLeverage,
      dailyLossLimitPct: profile.dailyLossLimitPct,
      budgetFraction: profile.budgetFraction,
      rrFloor: session.rrFloor,
      rrCeil: session.rrCeil,
      rrBaseMin: session.rrBaseMin,
      rrExpectancy: session.rrExpectancy
    };

    configAnalysis.sessionConfigs.push(sessionConfig);

    // Validate RR expectancy configuration
    if (session.rrFloor && session.rrCeil && session.rrFloor >= session.rrCeil) {
      configAnalysis.issues.push(addIssue('critical', 'invalid_rr_config',
        `Agent ${session.id} (${session.symbol}) has invalid RR config: rrFloor (${session.rrFloor}) >= rrCeil (${session.rrCeil})`,
        { sessionId: session.id, symbol: session.symbol, rrFloor: session.rrFloor, rrCeil: session.rrCeil }
      ));
    }

    // Check for overly conservative settings
    if (profile.riskPerTradePct && profile.riskPerTradePct < 0.5) {
      configAnalysis.issues.push(addIssue('info', 'very_conservative',
        `Agent ${session.id} (${session.symbol}) has very conservative risk: ${profile.riskPerTradePct}% per trade`,
        { sessionId: session.id, symbol: session.symbol, riskPerTradePct: profile.riskPerTradePct }
      ));
    }

    // Check for overly aggressive settings
    if (profile.riskPerTradePct && profile.riskPerTradePct > 3) {
      configAnalysis.issues.push(addIssue('warning', 'aggressive_risk',
        `Agent ${session.id} (${session.symbol}) has aggressive risk: ${profile.riskPerTradePct}% per trade`,
        { sessionId: session.id, symbol: session.symbol, riskPerTradePct: profile.riskPerTradePct }
      ));
    }
  }

  addSection('Configuration Analysis', configAnalysis);

  console.log(`✅ Analyzed configuration for ${activeSessions.length} active sessions`);
  console.log(`   Configuration issues: ${configAnalysis.issues.length}`);
}

async function generateRecommendations() {
  console.log('\n💡 PHASE 6: Generating Recommendations\n');

  const criticalCount = ANALYSIS_REPORT.summary.criticalIssues;
  const warningCount = ANALYSIS_REPORT.summary.warnings;

  // Based on analysis, provide recommendations
  if (criticalCount > 0) {
    addRecommendation(
      `Address ${criticalCount} critical issue(s) immediately - these may cause financial loss or system instability`,
      'critical'
    );
  }

  if (warningCount > 5) {
    addRecommendation(
      `Review and address ${warningCount} warnings to improve system reliability`,
      'high'
    );
  }

  // Configuration recommendations
  addRecommendation(
    'Consider implementing adaptive threshold tuning based on market regime (trending vs ranging)',
    'medium'
  );

  addRecommendation(
    'Monitor ATR requirements - current 0.70% minimum may be too strict for major pairs in low-volatility periods',
    'medium'
  );

  addRecommendation(
    'Review confidence threshold of 0.72 (72%) - may be preventing good trades in stable market conditions',
    'medium'
  );

  addRecommendation(
    'Implement regime-aware entry filters that adjust based on market conditions',
    'low'
  );

  console.log(`✅ Generated ${ANALYSIS_REPORT.summary.recommendations.length} recommendations`);
}

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🔍 COMPREHENSIVE AGENT FLOW ANALYSIS');
  console.log('='.repeat(80));

  try {
    await analyzeAgentStates();
    await analyzeEntryExitBehavior();
    await analyzeRiskManagement();
    await analyzePerformanceMetrics();
    await analyzeConfiguration();
    await generateRecommendations();

    console.log('\n' + '='.repeat(80));
    console.log('📋 ANALYSIS SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total Issues: ${ANALYSIS_REPORT.summary.totalIssues}`);
    console.log(`  - Critical: ${ANALYSIS_REPORT.summary.criticalIssues}`);
    console.log(`  - Warnings: ${ANALYSIS_REPORT.summary.warnings}`);
    console.log(`\nRecommendations: ${ANALYSIS_REPORT.summary.recommendations.length}`);

    // Save report to file
    const fs = await import('fs/promises');
    const reportPath = '/tmp/agent-flow-analysis-report.json';
    await fs.writeFile(reportPath, JSON.stringify(ANALYSIS_REPORT, null, 2));
    
    console.log(`\n✅ Full report saved to: ${reportPath}`);
    console.log('='.repeat(80) + '\n');

    // Print critical issues
    if (ANALYSIS_REPORT.summary.criticalIssues > 0) {
      console.log('\n🚨 CRITICAL ISSUES:\n');
      ANALYSIS_REPORT.sections.forEach(section => {
        if (section.data.issues) {
          section.data.issues
            .filter(i => i.severity === 'critical')
            .forEach(issue => {
              console.log(`   ❌ [${issue.category}] ${issue.description}`);
            });
        }
      });
    }

    // Print top recommendations
    console.log('\n💡 TOP RECOMMENDATIONS:\n');
    ANALYSIS_REPORT.summary.recommendations
      .filter(r => r.priority === 'critical' || r.priority === 'high')
      .slice(0, 5)
      .forEach((rec, i) => {
        console.log(`   ${i + 1}. [${rec.priority.toUpperCase()}] ${rec.text}`);
      });

    console.log('\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Analysis failed:', error);
    process.exit(1);
  }
}

main();
