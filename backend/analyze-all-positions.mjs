#!/usr/bin/env node
/**
 * 🔍 COMPREHENSIVE TRADING ANALYSIS
 * 
 * Analyzes all current positions and orders to understand:
 * 1. Are losses due to bad strategy or temporary market pullback?
 * 2. What would happen if we held until now?
 * 3. Is the strategy long-term or short-term?
 * 4. Are exits too aggressive causing premature losses?
 */

import { PrismaClient } from '@prisma/client';
import https from 'https';

const prisma = new PrismaClient();

console.log('🔍 COMPREHENSIVE TRADING ANALYSIS');
console.log('=' .repeat(80));
console.log('Analyzing all orders and comparing with current market prices...\n');

// ============================================================================
// MARKET DATA FETCHER
// ============================================================================

async function fetchCurrentPrices(symbols) {
  const uniqueSymbols = [...new Set(symbols.map(s => s.replace(/[:/]/g, '').replace('USDT', '').replace('USD', '').toLowerCase()))];
  
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${uniqueSymbols.join(',')}&vs_currencies=usd&include_24h_change=true&include_7d_change=true`;
  
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// Symbol mapping for CoinGecko
const SYMBOL_MAP = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'XRP': 'ripple',
  'AERO': 'aerodrome-finance',
  'COAI': 'coai',
  'ICP': 'internet-computer',
  'ZEC': 'zcash',
  'PENGU': 'pudgy-penguins',
  'SOL': 'solana',
  'ADA': 'cardano',
  'DOGE': 'dogecoin',
  'SHIB': 'shiba-inu',
};

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function main() {
  try {
    // 1. Get all active sessions
    const sessions = await prisma.agentSession.findMany({
      where: {
        // Get both active and recent sessions (last 24h)
        startedAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
        }
      },
      include: {
        orders: {
          where: { status: 'filled' },
          orderBy: { createdAt: 'asc' }
        },
        positions: true,
        SessionKpi: true,
      },
      orderBy: { startedAt: 'desc' }
    });

    if (sessions.length === 0) {
      console.log('❌ No sessions found in last 24h');
      return;
    }

    console.log(`📊 Found ${sessions.length} sessions in last 24h\n`);

    // 2. Group orders by actual symbol (not session symbol!)
    // Smart agents change symbols, so we need to group by order.symbol
    const allOrders = [];
    for (const session of sessions) {
      for (const order of session.orders) {
        allOrders.push({
          ...order,
          sessionId: session.id,
          sessionStartBalance: session.startBalanceUsd,
          sessionMode: session.mode,
        });
      }
    }

    console.log(`📦 Found ${allOrders.length} total filled orders\n`);

    // Group orders by actual trading symbol
    const ordersBySymbol = {};
    for (const order of allOrders) {
      const symbol = order.symbol.replace(/[:/]/g, '').replace('USDT', '').replace('USD', '');
      if (!ordersBySymbol[symbol]) {
        ordersBySymbol[symbol] = [];
      }
      ordersBySymbol[symbol].push(order);
    }

    // 3. Fetch current market prices
    console.log('📡 Fetching current market prices...\n');
    const symbolIds = Object.keys(ordersBySymbol).map(s => SYMBOL_MAP[s] || s.toLowerCase());
    const marketPrices = await fetchCurrentPrices(symbolIds);

    // 4. Analyze each symbol
    const analysis = {
      totalSymbols: 0,
      totalTrades: 0,
      totalRealizedPnL: 0,
      totalUnrealizedPnL: 0,
      totalMissedGains: 0,
      totalAvoidedLosses: 0,
      goodExits: 0,
      badExits: 0,
      prematureExits: 0,
      bySymbol: {}
    };

    for (const [symbol, orderList] of Object.entries(ordersBySymbol)) {
      console.log('='.repeat(80));
      console.log(`\n📈 ${symbol}/USDT ANALYSIS\n`);
      
      const coinGeckoId = SYMBOL_MAP[symbol] || symbol.toLowerCase();
      const marketData = marketPrices[coinGeckoId];
      
      if (!marketData) {
        console.log(`⚠️  Market data not available for ${symbol}\n`);
        continue;
      }

      const currentPrice = marketData.usd;
      const change24h = marketData.usd_24h_change || 0;
      const change7d = marketData.usd_7d_change || 0;

      console.log(`📊 MARKET DATA:`);
      console.log(`   Current Price: $${currentPrice.toFixed(4)}`);
      console.log(`   24h Change: ${change24h.toFixed(2)}%`);
      console.log(`   7d Change: ${change7d.toFixed(2)}%`);
      console.log(`   Trend: ${change24h > 0 ? '📈 Bullish' : '📉 Bearish'} (24h), ${change7d > 0 ? '📈 Bullish' : '📉 Bearish'} (7d)`);

      const symbolAnalysis = {
        currentPrice,
        change24h,
        change7d,
        totalRealizedPnL: 0,
        totalUnrealizedPnL: 0,
        totalMissedGains: 0,
        totalAvoidedLosses: 0,
        goodExits: 0,
        badExits: 0,
      };

      console.log(`\n   📊 Total Orders: ${orderList.length} on ${symbol}`);

      // Analyze trades by pairing buy/sell orders
      const trades = [];
      let currentTrade = null;

      for (const order of orderList.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))) {
        if (order.side === 'buy' || order.side === 'long') {
          // New entry
          currentTrade = {
            entryOrder: order,
            entryPrice: order.price,
            entryQty: order.qty,
            entryTime: order.createdAt,
            sessionId: order.sessionId,
            exitOrder: null,
          };
        } else if ((order.side === 'sell' || order.side === 'short') && currentTrade) {
          // Exit
          currentTrade.exitOrder = order;
          currentTrade.exitPrice = order.price;
          currentTrade.exitQty = order.qty;
          currentTrade.exitTime = order.createdAt;
          trades.push(currentTrade);
          currentTrade = null;
        }
      }

      // Handle open position
      if (currentTrade) {
        trades.push(currentTrade);
      }

      console.log(`   📊 Total Trades: ${trades.length} (${trades.filter(t => t.exitOrder).length} closed, ${trades.filter(t => !t.exitOrder).length} open)`);

      // Analyze each trade
      for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        const isOpen = !trade.exitOrder;

        console.log(`\n   📍 Trade ${i + 1} (Session: ${trade.sessionId.slice(0, 8)}...):`);
        
        if (isOpen) {
          // OPEN POSITION - Compare with current price
          const unrealizedPnL = (currentPrice - trade.entryPrice) * trade.entryQty;
          const unrealizedPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
          
          console.log(`      Status: 🟢 OPEN`);
          console.log(`      Current: $${currentPrice.toFixed(4)}`);
          console.log(`      Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${unrealizedPct.toFixed(2)}%)`);
          
          if (unrealizedPnL > 0) {
            console.log(`      ✅ Currently in PROFIT`);
          } else {
            console.log(`      ⚠️  Currently in LOSS`);
          }

          symbolAnalysis.totalUnrealizedPnL += unrealizedPnL;
          analysis.totalUnrealizedPnL += unrealizedPnL;

        } else {
          // CLOSED POSITION - Compare actual exit vs holding
          const holdDuration = (trade.exitTime - trade.entryTime) / 60000; // minutes
          const actualPnL = (trade.exitPrice - trade.entryPrice) * trade.entryQty;
          const actualPct = ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100;
          
          // What if held until now?
          const potentialPnL = (currentPrice - trade.entryPrice) * trade.entryQty;
          const potentialPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
          const difference = potentialPnL - actualPnL;

          console.log(`      Exit: $${trade.exitPrice.toFixed(4)} @ ${trade.exitTime.toISOString()}`);
          console.log(`      Hold: ${holdDuration.toFixed(1)} minutes`);
          console.log(`      Realized PnL: $${actualPnL.toFixed(2)} (${actualPct.toFixed(2)}%)`);
          console.log(`      `);
          console.log(`      🔮 What if held until now ($${currentPrice.toFixed(4)})?`);
          console.log(`         Potential PnL: $${potentialPnL.toFixed(2)} (${potentialPct.toFixed(2)}%)`);
          console.log(`         Difference: $${difference.toFixed(2)} (${(difference > 0 ? '+' : '')}${((difference / Math.abs(actualPnL || 1)) * 100).toFixed(1)}%)`);

          // Categorize the exit
          let exitQuality = '';
          if (difference > 0.5) {
            // Missed gains
            if (actualPnL < 0) {
              exitQuality = '❌ BAD EXIT: Exited at loss, recovered to profit';
              symbolAnalysis.badExits++;
              analysis.badExits++;
              analysis.prematureExits++;
            } else {
              exitQuality = '⚠️  EARLY EXIT: Missed additional gains';
              analysis.prematureExits++;
            }
            symbolAnalysis.totalMissedGains += difference;
            analysis.totalMissedGains += difference;
          } else if (difference < -0.5) {
            // Avoided losses
            exitQuality = '✅ GOOD EXIT: Avoided bigger loss';
            symbolAnalysis.goodExits++;
            analysis.goodExits++;
            symbolAnalysis.totalAvoidedLosses += Math.abs(difference);
            analysis.totalAvoidedLosses += Math.abs(difference);
          } else {
            // Neutral
            exitQuality = '➡️  NEUTRAL: Exit was optimal';
            symbolAnalysis.goodExits++;
            analysis.goodExits++;
          }

          console.log(`      ${exitQuality}`);

          symbolAnalysis.totalRealizedPnL += actualPnL;
          analysis.totalRealizedPnL += actualPnL;
          analysis.totalTrades++;
        }
      }

      // Symbol summary
      console.log(`\n   📊 ${symbol} SUMMARY:`);
      console.log(`      Total Realized PnL: $${symbolAnalysis.totalRealizedPnL.toFixed(2)}`);
      console.log(`      Total Unrealized PnL: $${symbolAnalysis.totalUnrealizedPnL.toFixed(2)}`);
      console.log(`      Combined PnL: $${(symbolAnalysis.totalRealizedPnL + symbolAnalysis.totalUnrealizedPnL).toFixed(2)}`);
      console.log(`      Good Exits: ${symbolAnalysis.goodExits}`);
      console.log(`      Bad Exits: ${symbolAnalysis.badExits}`);
      console.log(`      Missed Gains: $${symbolAnalysis.totalMissedGains.toFixed(2)}`);
      console.log(`      Avoided Losses: $${symbolAnalysis.totalAvoidedLosses.toFixed(2)}`);
      console.log(`      Net Exit Quality: $${(symbolAnalysis.totalAvoidedLosses - symbolAnalysis.totalMissedGains).toFixed(2)}`);

      analysis.bySymbol[symbol] = symbolAnalysis;
      analysis.totalSymbols++;
    }

    // ========================================================================
    // GLOBAL SUMMARY
    // ========================================================================

    console.log('\n' + '='.repeat(80));
    console.log('\n🎯 GLOBAL ANALYSIS SUMMARY\n');
    console.log('='.repeat(80));

    console.log(`\n📊 TRADING STATISTICS:`);
    console.log(`   Symbols Traded: ${analysis.totalSymbols}`);
    console.log(`   Total Closed Trades: ${analysis.totalTrades}`);
    console.log(`   Total Open Positions: ${sessions.reduce((sum, s) => sum + s.positions.filter(p => p.qty > 0).length, 0)}`);

    console.log(`\n💰 PROFIT & LOSS:`);
    console.log(`   Total Realized PnL: $${analysis.totalRealizedPnL.toFixed(2)}`);
    console.log(`   Total Unrealized PnL: $${analysis.totalUnrealizedPnL.toFixed(2)}`);
    console.log(`   Combined PnL: $${(analysis.totalRealizedPnL + analysis.totalUnrealizedPnL).toFixed(2)}`);

    console.log(`\n📉 EXIT QUALITY ANALYSIS:`);
    console.log(`   Good Exits: ${analysis.goodExits} (avoided losses or optimal timing)`);
    console.log(`   Bad Exits: ${analysis.badExits} (exited at loss then recovered)`);
    console.log(`   Premature Exits: ${analysis.prematureExits} (missed additional gains)`);
    console.log(`   Total Missed Gains: $${analysis.totalMissedGains.toFixed(2)}`);
    console.log(`   Total Avoided Losses: $${analysis.totalAvoidedLosses.toFixed(2)}`);
    console.log(`   Net Exit Impact: $${(analysis.totalAvoidedLosses - analysis.totalMissedGains).toFixed(2)}`);

    console.log(`\n🎯 VERDICT:\n`);

    // Determine if strategy is the problem or just temporary
    const netExitImpact = analysis.totalAvoidedLosses - analysis.totalMissedGains;
    const unrealizedVsRealized = analysis.totalUnrealizedPnL / (Math.abs(analysis.totalRealizedPnL) || 1);

    if (analysis.totalRealizedPnL < 0 && analysis.totalUnrealizedPnL > 0) {
      console.log(`✅ TEMPORARY DRAWDOWN:`);
      console.log(`   • Realized losses: $${analysis.totalRealizedPnL.toFixed(2)}`);
      console.log(`   • But unrealized gains: $${analysis.totalUnrealizedPnL.toFixed(2)}`);
      console.log(`   • Market is recovering - open positions are in profit!`);
      console.log(`   • The strategy sees LONGER TERM than exits allow`);
      console.log(`   • Consider: Wider stops or longer hold times`);
    } else if (analysis.badExits > analysis.goodExits) {
      console.log(`❌ EXIT STRATEGY PROBLEM:`);
      console.log(`   • Too many bad exits (${analysis.badExits}) vs good (${analysis.goodExits})`);
      console.log(`   • Exiting at losses that later recover`);
      console.log(`   • Missed gains: $${analysis.totalMissedGains.toFixed(2)}`);
      console.log(`   • The exits are TOO AGGRESSIVE`);
      console.log(`   • Recommendation: Implement adaptive exits (already done!)`);
    } else if (netExitImpact > 0) {
      console.log(`✅ EXIT STRATEGY WORKING:`);
      console.log(`   • Net exit impact positive: $${netExitImpact.toFixed(2)}`);
      console.log(`   • Avoiding more losses than missing gains`);
      console.log(`   • Good exits (${analysis.goodExits}) > Bad exits (${analysis.badExits})`);
      console.log(`   • Strategy is protecting capital well`);
    } else if (analysis.totalUnrealizedPnL < -10 && analysis.totalRealizedPnL < 0) {
      console.log(`⚠️  MARKET CORRECTION / BAD TIMING:`);
      console.log(`   • Both realized AND unrealized losses`);
      console.log(`   • Market trend against positions`);
      console.log(`   • This is a MARKET PROBLEM, not strategy`);
      console.log(`   • Wait for market recovery or adjust selection`);
    } else {
      console.log(`➡️  MIXED RESULTS:`);
      console.log(`   • Some good exits, some bad exits`);
      console.log(`   • Net impact: $${netExitImpact.toFixed(2)}`);
      console.log(`   • Strategy needs more data to evaluate`);
      console.log(`   • Continue monitoring`);
    }

    // Recommendations
    console.log(`\n💡 RECOMMENDATIONS:\n`);

    if (analysis.prematureExits > analysis.totalTrades * 0.3) {
      console.log(`   1. ✅ ADAPTIVE EXITS IMPLEMENTED - Should reduce premature exits`);
      console.log(`      • Volatile cryptos now get wider thresholds (0.75R vs 0.5R)`);
      console.log(`      • Dynamic trailing tightens at higher R-multiples`);
      console.log(`      • Earlier profit lock for volatile assets (0.67R vs 1R)`);
    }

    if (analysis.totalUnrealizedPnL > Math.abs(analysis.totalRealizedPnL) * 0.5) {
      console.log(`   2. 🕐 HOLD POSITIONS LONGER`);
      console.log(`      • Open positions showing good unrealized gains`);
      console.log(`      • Strategy has good long-term vision`);
      console.log(`      • Let winners run with dynamic trailing stops`);
    }

    if (analysis.badExits > 2) {
      console.log(`   3. 📊 REVIEW EXIT TIMING`);
      console.log(`      • ${analysis.badExits} trades exited at loss then recovered`);
      console.log(`      • Consider: Higher minHold (45min+ for volatile assets)`);
      console.log(`      • Consider: Peak drawdown protection instead of fixed stops`);
    }

    const worstSymbols = Object.entries(analysis.bySymbol)
      .filter(([_, data]) => data.totalRealizedPnL + data.totalUnrealizedPnL < -5)
      .sort((a, b) => (a[1].totalRealizedPnL + a[1].totalUnrealizedPnL) - (b[1].totalRealizedPnL + b[1].totalUnrealizedPnL))
      .slice(0, 3);

    if (worstSymbols.length > 0) {
      console.log(`   4. ⚠️  AVOID THESE SYMBOLS (consistent losses):`);
      worstSymbols.forEach(([symbol, data]) => {
        console.log(`      • ${symbol}: $${(data.totalRealizedPnL + data.totalUnrealizedPnL).toFixed(2)} (${data.badExits} bad exits)`);
      });
    }

    const bestSymbols = Object.entries(analysis.bySymbol)
      .filter(([_, data]) => data.totalRealizedPnL + data.totalUnrealizedPnL > 5)
      .sort((a, b) => (b[1].totalRealizedPnL + b[1].totalUnrealizedPnL) - (a[1].totalRealizedPnL + a[1].totalUnrealizedPnL))
      .slice(0, 3);

    if (bestSymbols.length > 0) {
      console.log(`   5. ✅ FOCUS ON THESE SYMBOLS (consistent profits):`);
      bestSymbols.forEach(([symbol, data]) => {
        console.log(`      • ${symbol}: $${(data.totalRealizedPnL + data.totalUnrealizedPnL).toFixed(2)} (${data.goodExits} good exits)`);
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('\n✅ Analysis complete!\n');

  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main();
