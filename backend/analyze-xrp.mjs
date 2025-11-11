#!/usr/bin/env node

/**
 * XRP Trading Analysis Script
 * Analyzes all XRP orders, strategies, market conditions, and agent decisions
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Market data from web (November 11, 2025)
const CURRENT_XRP_MARKET = {
  price: 2.46,
  change24h: -3.2,
  change7d: 9.3,
  marketCap: 148_087_886_016,
  volume24h: 4_968_556_887,
  sentiment: 'bullish', // 95% bullish according to CoinGecko
  highATH: 3.65,
  lowATL: 0.002686,
  distanceFromATH: -32.48, // %
  rank: 4,
};

console.log('\n🔍 XRP TRADING ANALYSIS - November 11, 2025\n');
console.log('=' . repeat(80));

// 1. Current Market Context
console.log('\n📊 CURRENT MARKET CONTEXT:');
console.log(`Price: $${CURRENT_XRP_MARKET.price}`);
console.log(`24h Change: ${CURRENT_XRP_MARKET.change24h}%`);
console.log(`7d Change: ${CURRENT_XRP_MARKET.change7d}%`);
console.log(`Market Cap: $${(CURRENT_XRP_MARKET.marketCap / 1e9).toFixed(2)}B (Rank #${CURRENT_XRP_MARKET.rank})`);
console.log(`24h Volume: $${(CURRENT_XRP_MARKET.volume24h / 1e9).toFixed(2)}B`);
console.log(`Sentiment: ${CURRENT_XRP_MARKET.sentiment.toUpperCase()} (95% bullish)`);
console.log(`Distance from ATH ($${CURRENT_XRP_MARKET.highATH}): ${CURRENT_XRP_MARKET.distanceFromATH}%`);

console.log('\n📰 Recent News:');
console.log('  - First XRP ETF approved for Nasdaq listing (4h ago)');
console.log('  - XRP unaffected by crypto fund bleed ($1.17B outflow)');
console.log('  - Price lacks clear direction on weekend');

console.log('\n' + '='.repeat(80));

// 2. Fetch all XRP-related data from database
console.log('\n🔄 Fetching XRP data from database...\n');

try {
  // Get all sessions that traded XRP
  const xrpSessions = await prisma.agentSession.findMany({
    where: {
      OR: [
        { symbol: { contains: 'XRP', mode: 'insensitive' } },
        { currentSymbol: { contains: 'XRP', mode: 'insensitive' } },
      ],
    },
    include: {
      SessionKpi: true,
      positions: true,
      orders: {
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  console.log(`✅ Found ${xrpSessions.length} session(s) that traded XRP\n`);

  if (xrpSessions.length === 0) {
    console.log('⚠️ No XRP trading sessions found in database');
    process.exit(0);
  }

  // Analyze each session
  for (const session of xrpSessions) {
    console.log('─'.repeat(80));
    console.log(`\n📋 SESSION: ${session.id}`);
    console.log(`Symbol: ${session.symbol} → ${session.currentSymbol || session.symbol}`);
    console.log(`Mode: ${session.mode.toUpperCase()}`);
    console.log(`Created: ${session.createdAt ? new Date(session.createdAt).toISOString() : 'N/A'}`);
    console.log(`Started: ${session.startedAt ? new Date(session.startedAt).toISOString() : 'N/A'}`);
    console.log(`Stopped: ${session.stoppedAt ? new Date(session.stoppedAt).toISOString() : 'ACTIVE'}`);
    console.log(`Start Balance: $${Number(session.startBalanceUsd || 0).toFixed(2)}`);

    // Profile analysis
    const profile = session.profileJson || {};
    console.log(`\n⚙️ AGENT CONFIGURATION:`);
    console.log(`  Aggressiveness: ${profile.aggressiveness || 'reactive'}`);
    console.log(`  Risk per trade: ${profile.riskPerTradePct || 'N/A'}%`);
    console.log(`  Max Leverage: ${profile.maxLeverage || 'N/A'}x`);
    console.log(`  Daily Loss Limit: ${profile.dailyLossLimitPct || 'N/A'}%`);
    console.log(`  Strategy Engine: ${profile.strategyEngine || 'N/A'}`);
    
    if (profile.isIntelligent || profile.isSmartAgent) {
      console.log(`  🧠 Smart Agent: YES`);
      if (profile.analysis) {
        console.log(`  Selected At: ${profile.selectedAt}`);
        console.log(`  AI Score: ${profile.analysis.score?.toFixed(2)}`);
        console.log(`  Confidence: ${profile.analysis.confidence?.toFixed(2)}`);
        console.log(`  Reasoning: ${profile.analysis.reasoning?.summary || 'N/A'}`);
      }
    }

    // KPI Analysis
    if (session.SessionKpi) {
      const kpi = session.SessionKpi;
      console.log(`\n📈 PERFORMANCE METRICS:`);
      console.log(`  Total Trades: ${kpi.totalTrades}`);
      console.log(`  Wins: ${kpi.wins} | Losses: ${kpi.losses}`);
      console.log(`  Win Rate: ${kpi.winRate?.toFixed(1) || 0}%`);
      console.log(`  Realized PnL: $${kpi.realizedPnlUsd?.toFixed(2) || 0}`);
      console.log(`  Unrealized PnL: $${kpi.unrealizedPnlUsd?.toFixed(2) || 0}`);
      console.log(`  Total PnL: $${((kpi.realizedPnlUsd || 0) + (kpi.unrealizedPnlUsd || 0)).toFixed(2)}`);
      console.log(`  ROI: ${kpi.roiPct?.toFixed(2) || 0}%`);
      console.log(`  Avg Win: $${kpi.avgWinUsd?.toFixed(2) || 0}`);
      console.log(`  Avg Loss: $${kpi.avgLossUsd?.toFixed(2) || 0}`);
      console.log(`  Largest Win: $${kpi.largestWinUsd?.toFixed(2) || 0}`);
      console.log(`  Largest Loss: $${kpi.largestLossUsd?.toFixed(2) || 0}`);
    }

    // Current positions
    if (session.positions && session.positions.length > 0) {
      console.log(`\n💼 CURRENT POSITIONS (${session.positions.length}):`);
      for (const pos of session.positions) {
        console.log(`  ${pos.side.toUpperCase()} ${Math.abs(pos.qty)} XRP @ $${pos.entryPrice.toFixed(4)}`);
        console.log(`    Entry: ${pos.openedAt.toISOString()}`);
        console.log(`    Stop: $${pos.stopPrice?.toFixed(4) || 'N/A'}`);
        console.log(`    Leverage: ${pos.leverage || 1}x`);
        const currentPnL = (CURRENT_XRP_MARKET.price - pos.entryPrice) * pos.qty;
        console.log(`    Current PnL: $${currentPnL.toFixed(2)} (${((currentPnL / (pos.entryPrice * Math.abs(pos.qty))) * 100).toFixed(2)}%)`);
      }
    }

    // Orders analysis
    if (session.orders && session.orders.length > 0) {
      console.log(`\n📝 ORDERS (${session.orders.length} total):`);
      
      // Group by type
      const entryOrders = session.orders.filter(o => o.side === 'buy' || o.side === 'sell');
      const exitOrders = session.orders.filter(o => o.isExit);
      
      console.log(`  Entry Orders: ${entryOrders.length}`);
      console.log(`  Exit Orders: ${exitOrders.length}`);
      
      // Show last 10 orders
      console.log(`\n  Last 10 Orders:`);
      for (const order of session.orders.slice(0, 10)) {
        const timeAgo = Math.floor((Date.now() - order.createdAt.getTime()) / 1000 / 60);
        console.log(`    [${order.createdAt.toISOString()}] ${order.side.toUpperCase()} ${order.qty} @ $${order.price.toFixed(4)} - ${order.status}`);
        console.log(`      Type: ${order.type} | ${order.isExit ? 'EXIT' : 'ENTRY'} | ${timeAgo}min ago`);
        if (order.strategyId) {
          console.log(`      Strategy: ${order.strategyId}`);
        }
      }
    }

    console.log('');
  }

  // Global XRP statistics
  console.log('\n' + '='.repeat(80));
  console.log('\n📊 GLOBAL XRP STATISTICS:\n');

  const allXrpOrders = await prisma.order.findMany({
    where: {
      symbol: { contains: 'XRP', mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
  });

  const allXrpPositions = await prisma.position.findMany({
    where: {
      symbol: { contains: 'XRP', mode: 'insensitive' },
    },
  });

  console.log(`Total XRP Orders: ${allXrpOrders.length}`);
  console.log(`Active XRP Positions: ${allXrpPositions.length}`);

  // Strategy breakdown
  const strategyCount = {};
  allXrpOrders.forEach(o => {
    if (o.strategyId) {
      strategyCount[o.strategyId] = (strategyCount[o.strategyId] || 0) + 1;
    }
  });

  if (Object.keys(strategyCount).length > 0) {
    console.log(`\n🎯 Strategy Usage:`);
    Object.entries(strategyCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([strategy, count]) => {
        console.log(`  ${strategy}: ${count} orders (${((count / allXrpOrders.length) * 100).toFixed(1)}%)`);
      });
  }

  // Entry/Exit analysis
  const entryCount = allXrpOrders.filter(o => !o.isExit).length;
  const exitCount = allXrpOrders.filter(o => o.isExit).length;
  console.log(`\n📊 Order Types:`);
  console.log(`  Entries: ${entryCount}`);
  console.log(`  Exits: ${exitCount}`);

  // Recent orders timeline
  console.log(`\n⏰ Recent Order Timeline (Last 20):`);
  for (const order of allXrpOrders.slice(0, 20)) {
    const timeAgo = Math.floor((Date.now() - order.createdAt.getTime()) / 1000 / 60);
    const hours = Math.floor(timeAgo / 60);
    const mins = timeAgo % 60;
    const timeStr = hours > 0 ? `${hours}h${mins}m ago` : `${mins}m ago`;
    
    console.log(`  [${order.createdAt.toISOString()}] ${order.side.toUpperCase()} ${order.qty.toFixed(4)} @ $${order.price.toFixed(4)} - ${order.status} (${timeStr})`);
  }

  // Get symbol profile if exists (skip if model doesn't exist)
  try {
    const symbolProfile = await prisma.symbolProfile?.findFirst({
      where: {
        symbol: { contains: 'XRP', mode: 'insensitive' },
      },
    });

    if (symbolProfile) {
      console.log(`\n📋 XRP SYMBOL PROFILE:`);
      console.log(`  Symbol: ${symbolProfile.symbol}`);
      console.log(`  Tier: ${symbolProfile.tier}`);
      console.log(`  Created: ${symbolProfile.createdAt.toISOString()}`);
      console.log(`  Updated: ${symbolProfile.updatedAt.toISOString()}`);
      
      if (symbolProfile.metadata) {
        console.log(`  Metadata:`, JSON.stringify(symbolProfile.metadata, null, 2));
      }
    }
  } catch (err) {
    // Model might not exist, skip silently
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n🎯 ANALYSIS SUMMARY:\n');

  // Decision quality analysis
  const filledOrders = allXrpOrders.filter(o => o.status === 'filled');
  const avgPrice = filledOrders.reduce((sum, o) => sum + o.price, 0) / (filledOrders.length || 1);
  
  console.log(`Agent's Average Entry Price: $${avgPrice.toFixed(4)}`);
  console.log(`Current Market Price: $${CURRENT_XRP_MARKET.price}`);
  console.log(`Price Difference: ${((CURRENT_XRP_MARKET.price - avgPrice) / avgPrice * 100).toFixed(2)}%`);
  
  if (CURRENT_XRP_MARKET.price > avgPrice) {
    console.log(`✅ Agent entered at good prices (below current market)`);
  } else {
    console.log(`⚠️ Agent entered above current market price`);
  }

  // Timing analysis with 7-day trend
  console.log(`\nMarket 7-day trend: +${CURRENT_XRP_MARKET.change7d}% (bullish)`);
  console.log(`Market 24h trend: ${CURRENT_XRP_MARKET.change24h}% (slight pullback)`);
  console.log(`Community sentiment: ${CURRENT_XRP_MARKET.sentiment.toUpperCase()} (95% bullish)`);
  
  // Recent catalyst
  console.log(`\n🚀 Major Catalyst: First XRP ETF approved for Nasdaq (4h ago)`);
  console.log(`📈 This is historically bullish for crypto assets`);
  
  console.log('\n💡 RECOMMENDATION:');
  if (CURRENT_XRP_MARKET.change7d > 5 && CURRENT_XRP_MARKET.sentiment === 'bullish') {
    console.log(`  Strong bullish momentum with ETF approval catalyst`);
    console.log(`  7-day trend (+9.3%) shows healthy uptrend`);
    console.log(`  Minor 24h pullback (-3.2%) could be profit-taking`);
    console.log(`  Still 32% below ATH - room for growth`);
  }

  console.log('\n' + '='.repeat(80));

} catch (error) {
  console.error('\n❌ Error analyzing XRP:', error);
  throw error;
} finally {
  await prisma.$disconnect();
}

console.log('\n✅ Analysis complete!\n');
