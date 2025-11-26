import { PrismaClient } from '@prisma/client';
import https from 'https';

const prisma = new PrismaClient();

// Fetch current prices from CoinGecko
async function fetchMarketData(symbols) {
  const symbolMap = {
    'AERO': 'aerodrome-finance',
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'COAI': 'coai',
    'ICP': 'internet-computer'
  };

  const ids = symbols.map(s => symbolMap[s]).filter(Boolean).join(',');
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.coingecko.com',
      path: `/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24h_change=true&include_7d_change=true`,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({});
        }
      });
    }).on('error', () => resolve({}));
  });
}

async function analyzeSymbol(symbol) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 ANALYZING ${symbol}`);
  console.log('='.repeat(80));

  // Get all sessions for this symbol
  const sessions = await prisma.agentSession.findMany({
    where: {
      symbol: { contains: symbol, mode: 'insensitive' }
    },
    include: {
      orders: {
        orderBy: { createdAt: 'asc' }
      },
      positions: {
        orderBy: { openedAt: 'desc' }
      },
      SessionKpi: true
    }
  });

  if (sessions.length === 0) {
    console.log(`❌ No sessions found for ${symbol}\n`);
    return null;
  }

  console.log(`\n📋 Found ${sessions.length} session(s) for ${symbol}\n`);

  const analysis = {
    symbol,
    sessions: [],
    issues: [],
    recommendations: []
  };

  for (const session of sessions) {
    console.log(`\n🔍 Session: ${session.id}`);
    console.log(`   Symbol: ${session.symbol}`);
    console.log(`   Status: ${session.status || 'unknown'}`);
    console.log(`   Agent Type: ${session.agentType || 'unknown'}`);
    console.log(`   Started: ${session.startedAt?.toISOString() || 'unknown'}`);
    console.log(`   Initial Balance: $${session.initialBalance || 'unknown'}`);

    const sessionAnalysis = {
      sessionId: session.id,
      symbol: session.symbol,
      status: session.status,
      agentType: session.agentType,
      orders: session.orders.length,
      positions: session.positions.length,
      issues: [],
      data: {}
    };

    // ===== 1. VALIDATE PROFILE DATA =====
    console.log(`\n   📝 PROFILE VALIDATION:`);
    let profile = null;
    try {
      profile = typeof session.profileJson === 'string' 
        ? JSON.parse(session.profileJson) 
        : session.profileJson;
    } catch (e) {
      console.log(`   ❌ Invalid profileJson: ${e.message}`);
      sessionAnalysis.issues.push('Invalid or corrupted profileJson');
      analysis.issues.push(`${session.id}: Invalid profileJson`);
    }

    if (profile) {
      console.log(`   ✅ Profile loaded successfully`);
      
      // Check required fields
      const requiredFields = ['symbol', 'side', 'entry', 'stop', 'targets'];
      const missingFields = requiredFields.filter(f => !(f in profile));
      
      if (missingFields.length > 0) {
        console.log(`   ⚠️  Missing profile fields: ${missingFields.join(', ')}`);
        sessionAnalysis.issues.push(`Missing fields: ${missingFields.join(', ')}`);
      } else {
        console.log(`   ✅ All required fields present`);
      }

      // Validate numeric values
      if (profile.entry && profile.stop) {
        const stopDistance = Math.abs(profile.entry - profile.stop);
        const stopPct = (stopDistance / profile.entry) * 100;
        console.log(`   📊 Stop distance: ${stopPct.toFixed(2)}% from entry`);
        
        if (stopPct > 10) {
          console.log(`   ⚠️  WIDE STOP: ${stopPct.toFixed(2)}% is unusual`);
          sessionAnalysis.issues.push(`Wide stop: ${stopPct.toFixed(2)}%`);
        }
        if (stopPct < 0.1) {
          console.log(`   ⚠️  TIGHT STOP: ${stopPct.toFixed(2)}% may trigger prematurely`);
          sessionAnalysis.issues.push(`Tight stop: ${stopPct.toFixed(2)}%`);
        }
      }

      // Validate targets
      if (profile.targets && Array.isArray(profile.targets)) {
        console.log(`   🎯 Targets: ${profile.targets.length} configured`);
        profile.targets.forEach((target, i) => {
          const targetDist = Math.abs(target - profile.entry) / profile.entry * 100;
          console.log(`      T${i+1}: $${target.toFixed(4)} (+${targetDist.toFixed(2)}%)`);
        });
      }

      sessionAnalysis.data.profile = {
        entry: profile.entry,
        stop: profile.stop,
        targets: profile.targets,
        side: profile.side,
        stopPct: profile.entry && profile.stop ? ((Math.abs(profile.entry - profile.stop) / profile.entry) * 100).toFixed(2) : null
      };
    }

    // ===== 2. ANALYZE ORDERS =====
    console.log(`\n   📦 ORDERS ANALYSIS:`);
    console.log(`   Total orders: ${session.orders.length}`);

    if (session.orders.length === 0) {
      console.log(`   ⚠️  No orders found for this session`);
      sessionAnalysis.issues.push('No orders placed');
    } else {
      const buyOrders = session.orders.filter(o => o.side === 'buy');
      const sellOrders = session.orders.filter(o => o.side === 'sell');
      
      console.log(`   BUY orders: ${buyOrders.length}`);
      console.log(`   SELL orders: ${sellOrders.length}`);

      // Analyze order sequence
      session.orders.forEach((order, idx) => {
        const time = order.createdAt.toISOString().substring(11, 19);
        console.log(`   [${idx+1}] ${time} ${order.side.toUpperCase()} ${order.qty} @ $${order.price} - ${order.status}`);
      });

      // Check for entry/exit pairs
      if (buyOrders.length > 0 && sellOrders.length > 0) {
        const firstBuy = buyOrders[0];
        const firstSell = sellOrders[0];
        
        const holdDuration = (firstSell.createdAt - firstBuy.createdAt) / 1000 / 60;
        const pnl = (firstSell.price - firstBuy.price) * firstBuy.qty;
        const pnlPct = ((firstSell.price - firstBuy.price) / firstBuy.price) * 100;

        console.log(`\n   💰 First Trade Performance:`);
        console.log(`      Entry: $${firstBuy.price} → Exit: $${firstSell.price}`);
        console.log(`      Hold time: ${holdDuration.toFixed(1)} minutes`);
        console.log(`      PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

        sessionAnalysis.data.firstTrade = {
          entry: firstBuy.price,
          exit: firstSell.price,
          holdMinutes: holdDuration.toFixed(1),
          pnl: pnl.toFixed(2),
          pnlPct: pnlPct.toFixed(2)
        };

        // Check if exit was premature
        if (holdDuration < 30 && pnlPct < 0) {
          console.log(`   🚨 PREMATURE EXIT: Closed at loss after only ${holdDuration.toFixed(1)} minutes`);
          sessionAnalysis.issues.push(`Premature exit: ${holdDuration.toFixed(1)}min at ${pnlPct.toFixed(2)}%`);
          analysis.issues.push(`${symbol}: Premature exit at ${pnlPct.toFixed(2)}%`);
        }

        if (holdDuration < 60 && Math.abs(pnlPct) < 0.5) {
          console.log(`   ⚠️  QUICK EXIT WITH MINIMAL MOVE: ${pnlPct.toFixed(2)}% in ${holdDuration.toFixed(1)}min`);
          sessionAnalysis.issues.push(`Quick exit: ${pnlPct.toFixed(2)}% in ${holdDuration.toFixed(1)}min`);
        }
      }

      // Check order consistency
      const priceRange = {
        min: Math.min(...session.orders.map(o => o.price)),
        max: Math.max(...session.orders.map(o => o.price))
      };
      const priceSpread = ((priceRange.max - priceRange.min) / priceRange.min) * 100;
      
      console.log(`\n   📊 Order price range: $${priceRange.min.toFixed(4)} - $${priceRange.max.toFixed(4)} (${priceSpread.toFixed(2)}%)`);
      
      sessionAnalysis.data.orderStats = {
        count: session.orders.length,
        buyOrders: buyOrders.length,
        sellOrders: sellOrders.length,
        priceRange: priceRange,
        priceSpread: priceSpread.toFixed(2)
      };
    }

    // ===== 3. ANALYZE POSITIONS =====
    console.log(`\n   🎯 POSITIONS ANALYSIS:`);
    
    if (session.positions.length === 0) {
      console.log(`   ℹ️  No positions tracked (may be using legacy system)`);
    } else {
      console.log(`   Total positions: ${session.positions.length}`);
      
      session.positions.forEach((pos, idx) => {
        console.log(`\n   Position ${idx + 1}:`);
        console.log(`      Side: ${pos.side}`);
        console.log(`      Entry: $${pos.entryPrice}`);
        console.log(`      Qty: ${pos.qty}`);
        console.log(`      Stop: $${pos.stopPrice || 'N/A'}`);
        console.log(`      Status: ${pos.status}`);
        
        if (pos.closedAt) {
          const holdTime = (pos.closedAt - pos.openedAt) / 1000 / 60;
          console.log(`      Hold time: ${holdTime.toFixed(1)} minutes`);
          console.log(`      Exit: $${pos.exitPrice || 'N/A'}`);
          
          if (pos.exitPrice) {
            const posPnl = (pos.exitPrice - pos.entryPrice) * pos.qty;
            const posPnlPct = ((pos.exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
            console.log(`      PnL: $${posPnl.toFixed(2)} (${posPnlPct.toFixed(2)}%)`);
          }
        }
      });

      sessionAnalysis.data.positions = session.positions.map(p => ({
        side: p.side,
        entry: p.entryPrice,
        qty: p.qty,
        stop: p.stopPrice,
        status: p.status
      }));
    }

    // ===== 4. CHECK KPIs =====
    console.log(`\n   📈 KPI VALIDATION:`);
    
    if (!session.SessionKpi || session.SessionKpi.length === 0) {
      console.log(`   ⚠️  No KPIs recorded`);
      sessionAnalysis.issues.push('No KPIs tracked');
    } else {
      const kpi = session.SessionKpi[0]; // Latest KPI
      console.log(`   ✅ KPIs tracked (${session.SessionKpi.length} snapshots)`);
      
      if (kpi && typeof kpi === 'object') {
        console.log(`      Win Rate: ${(kpi.winRate * 100).toFixed(1)}%`);
        console.log(`      Realized PnL: $${kpi.realizedPnlUsd.toFixed(2)}`);
        console.log(`      Unrealized PnL: $${kpi.unrealizedPnlUsd.toFixed(2)}`);
        console.log(`      Max Drawdown: ${(kpi.maxDrawdownPct * 100).toFixed(2)}%`);
        console.log(`      ROI: ${(kpi.roiPct * 100).toFixed(2)}%`);

        sessionAnalysis.data.kpi = {
          winRate: (kpi.winRate * 100).toFixed(1),
          realizedPnl: kpi.realizedPnlUsd.toFixed(2),
          unrealizedPnl: kpi.unrealizedPnlUsd.toFixed(2),
          maxDrawdown: (kpi.maxDrawdownPct * 100).toFixed(2),
          roi: (kpi.roiPct * 100).toFixed(2)
        };

        // Check for anomalies
        if (kpi.maxDrawdownPct > 0.15) {
          console.log(`   🚨 HIGH DRAWDOWN: ${(kpi.maxDrawdownPct * 100).toFixed(2)}% exceeds 15%`);
          sessionAnalysis.issues.push(`High drawdown: ${(kpi.maxDrawdownPct * 100).toFixed(2)}%`);
        }

        if (kpi.roiPct < -0.10) {
          console.log(`   🚨 SIGNIFICANT LOSS: ${(kpi.roiPct * 100).toFixed(2)}% ROI`);
          sessionAnalysis.issues.push(`Significant loss: ${(kpi.roiPct * 100).toFixed(2)}%`);
        }
      } else {
        console.log(`   ⚠️  KPI data structure invalid`);
        sessionAnalysis.issues.push('Invalid KPI data');
      }
    }

    // ===== 5. DATA CONSISTENCY CHECKS =====
    console.log(`\n   🔍 DATA CONSISTENCY:`);
    
    // Check profile vs actual orders
    if (profile && profile.symbol && session.orders.length > 0) {
      const profileSymbol = profile.symbol.replace(/[:/]/g, '');
      const sessionSymbol = session.symbol.replace(/[:/]/g, '');
      
      if (!profileSymbol.includes(sessionSymbol) && !sessionSymbol.includes(profileSymbol)) {
        console.log(`   ❌ SYMBOL MISMATCH: Profile=${profile.symbol}, Session=${session.symbol}`);
        sessionAnalysis.issues.push(`Symbol mismatch: ${profile.symbol} vs ${session.symbol}`);
        analysis.issues.push(`${session.id}: Symbol mismatch`);
      } else {
        console.log(`   ✅ Symbol consistency verified`);
      }
    }

    // Check if orders match position records
    if (session.orders.length > 0 && session.positions.length > 0) {
      const firstOrderPrice = session.orders[0].price;
      const firstPosEntry = session.positions[0].entryPrice;
      
      if (Math.abs(firstOrderPrice - firstPosEntry) / firstOrderPrice > 0.01) {
        console.log(`   ⚠️  ORDER/POSITION MISMATCH: Order=$${firstOrderPrice}, Position=$${firstPosEntry}`);
        sessionAnalysis.issues.push('Order/Position price mismatch');
      } else {
        console.log(`   ✅ Order/Position data consistent`);
      }
    }

    analysis.sessions.push(sessionAnalysis);
  }

  return analysis;
}

async function compareWithMarketData(analysis, marketData) {
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('🌐 MARKET DATA COMPARISON');
  console.log('='.repeat(80));

  const symbolMap = {
    'AERO': 'aerodrome-finance',
    'BTC': 'bitcoin',
    'ETH': 'ethereum',
    'COAI': 'coai',
    'ICP': 'internet-computer'
  };

  for (const symbolAnalysis of analysis) {
    if (!symbolAnalysis) continue;

    const geckoId = symbolMap[symbolAnalysis.symbol];
    const marketInfo = marketData[geckoId];

    if (!marketInfo) {
      console.log(`\n${symbolAnalysis.symbol}: ⚠️  No market data available`);
      continue;
    }

    console.log(`\n\n📊 ${symbolAnalysis.symbol} MARKET CONTEXT:`);
    console.log(`   Current Price: $${marketInfo.usd}`);
    console.log(`   24h Change: ${marketInfo.usd_24h_change?.toFixed(2) || 'N/A'}%`);
    console.log(`   7d Change: ${marketInfo.usd_7d_change?.toFixed(2) || 'N/A'}%`);

    // Compare with trading decisions
    for (const session of symbolAnalysis.sessions) {
      if (!session.data.firstTrade) continue;

      const entryPrice = parseFloat(session.data.firstTrade.entry);
      const exitPrice = parseFloat(session.data.firstTrade.exit);
      const currentPrice = marketInfo.usd;

      console.log(`\n   📈 Trade vs Market:`);
      console.log(`      Agent Entry: $${entryPrice}`);
      console.log(`      Agent Exit: $${exitPrice}`);
      console.log(`      Current Price: $${currentPrice}`);

      // Calculate what would have happened if held
      const actualPnl = parseFloat(session.data.firstTrade.pnl);
      const potentialPnl = (currentPrice - entryPrice) * 100; // Rough estimate
      const missedGains = currentPrice > exitPrice ? ((currentPrice - exitPrice) / exitPrice * 100) : 0;

      if (missedGains > 1) {
        console.log(`   💸 MISSED GAINS: Price went up ${missedGains.toFixed(2)}% after exit`);
        symbolAnalysis.recommendations.push(`Consider holding ${symbolAnalysis.symbol} longer - missed ${missedGains.toFixed(2)}% gains`);
      }

      if (currentPrice < entryPrice * 0.95 && actualPnl > 0) {
        console.log(`   ✅ GOOD EXIT: Avoided ${((entryPrice - currentPrice) / entryPrice * 100).toFixed(2)}% drop`);
      }

      if (currentPrice < exitPrice * 0.98 && actualPnl < 0) {
        console.log(`   ✅ EXIT PREVENTED BIGGER LOSS: Price dropped ${((exitPrice - currentPrice) / exitPrice * 100).toFixed(2)}% more`);
      }
    }
  }
}

async function generateReport(analysisResults) {
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('📋 COMPREHENSIVE ANALYSIS REPORT');
  console.log('='.repeat(80));

  let totalIssues = 0;
  let criticalIssues = 0;
  let totalSessions = 0;

  for (const result of analysisResults) {
    if (!result) continue;

    totalSessions += result.sessions.length;
    totalIssues += result.issues.length;

    if (result.issues.length > 0) {
      console.log(`\n⚠️  ${result.symbol}: ${result.issues.length} issue(s)`);
      result.issues.forEach(issue => {
        console.log(`   - ${issue}`);
        if (issue.includes('MISMATCH') || issue.includes('Invalid') || issue.includes('PREMATURE')) {
          criticalIssues++;
        }
      });
    }
  }

  console.log(`\n\n${'='.repeat(80)}`);
  console.log('📊 SUMMARY STATISTICS');
  console.log('='.repeat(80));
  console.log(`Total Sessions Analyzed: ${totalSessions}`);
  console.log(`Total Issues Found: ${totalIssues}`);
  console.log(`Critical Issues: ${criticalIssues}`);
  console.log(`Symbols with Issues: ${analysisResults.filter(r => r && r.issues.length > 0).length}`);

  if (totalIssues === 0) {
    console.log(`\n✅ ALL SYSTEMS NORMAL - No issues detected`);
  } else if (criticalIssues > 0) {
    console.log(`\n🚨 ATTENTION REQUIRED - ${criticalIssues} critical issue(s) need immediate review`);
  } else {
    console.log(`\n⚠️  MINOR ISSUES DETECTED - Review recommended but not urgent`);
  }

  console.log('\n' + '='.repeat(80));
}

async function main() {
  console.log('🔍 MULTI-CRYPTO ANALYSIS STARTING...\n');
  console.log('Analyzing: AERO, BTC, ETH, COAI, ICP\n');

  const symbols = ['AERO', 'BTC', 'ETH', 'COAI', 'ICP'];

  // Fetch market data first
  console.log('📡 Fetching current market data...');
  const marketData = await fetchMarketData(symbols);
  console.log('✅ Market data fetched\n');

  const analysisResults = [];

  // Analyze each symbol
  for (const symbol of symbols) {
    try {
      const result = await analyzeSymbol(symbol);
      analysisResults.push(result);
    } catch (error) {
      console.error(`\n❌ Error analyzing ${symbol}:`, error.message);
      analysisResults.push(null);
    }
  }

  // Compare with market data
  await compareWithMarketData(analysisResults, marketData);

  // Generate final report
  await generateReport(analysisResults);

  console.log('\n✅ Analysis complete!\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
