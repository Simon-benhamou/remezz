import { PrismaClient } from '@prisma/client';
import https from 'https';

const prisma = new PrismaClient();

// Fetch detailed AERO data
async function fetchAeroMarketData() {
  console.log('📡 Fetching AERO market data from CoinGecko...\n');
  
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.coingecko.com',
      path: '/api/v3/coins/aerodrome-finance?localization=false&tickers=true&market_data=true&community_data=true&developer_data=false',
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

async function analyzeAeroDecisions() {
  console.log('🔍 DEEP ANALYSIS: AERO TRADING DECISIONS\n');
  console.log('='.repeat(80));
  
  // Get AERO session with all data
  const session = await prisma.agentSession.findFirst({
    where: {
      symbol: { contains: 'AERO', mode: 'insensitive' }
    },
    include: {
      orders: {
        orderBy: { createdAt: 'asc' }
      },
      positions: true,
      SessionKpi: true,
      strategies: {
        orderBy: { createdAt: 'desc' },
        take: 5
      }
    }
  });

  if (!session) {
    console.log('❌ No AERO session found');
    return;
  }

  console.log(`\n📊 SESSION OVERVIEW`);
  console.log(`ID: ${session.id}`);
  console.log(`Symbol: ${session.symbol}`);
  console.log(`Started: ${session.startedAt.toISOString()}`);
  console.log(`Mode: ${session.mode}`);
  console.log(`Smart Agent: ${session.isSmartAgent}`);

  // Parse profile
  const profile = typeof session.profileJson === 'string' 
    ? JSON.parse(session.profileJson) 
    : session.profileJson;

  console.log(`\n📋 SMART SELECTION ANALYSIS`);
  console.log('='.repeat(80));

  if (profile.analysis) {
    console.log(`\n🤖 AI Analysis at Selection Time:`);
    console.log(`\nReasoning:\n${profile.analysis.reasoning || 'N/A'}`);
    
    if (profile.analysis.marketContext) {
      console.log(`\nMarket Context:`);
      console.log(JSON.stringify(profile.analysis.marketContext, null, 2));
    }

    if (profile.analysis.metrics) {
      console.log(`\nMetrics Evaluated:`);
      Object.entries(profile.analysis.metrics).forEach(([key, value]) => {
        console.log(`  ${key}: ${JSON.stringify(value)}`);
      });
    }
  }

  if (profile.strategy) {
    console.log(`\n📈 STRATEGY DETAILS:`);
    console.log(JSON.stringify(profile.strategy, null, 2));
  }

  // Analyze timing of selection
  console.log(`\n⏰ TIMING ANALYSIS`);
  console.log('='.repeat(80));
  console.log(`Selected at: ${profile.selectedAt || profile.timestamp || 'unknown'}`);
  console.log(`Session started: ${session.startedAt.toISOString()}`);
  
  if (session.orders.length > 0) {
    const firstOrder = session.orders[0];
    console.log(`First order: ${firstOrder.createdAt.toISOString()}`);
    console.log(`Time from selection to first order: ${((firstOrder.createdAt - session.startedAt) / 1000 / 60).toFixed(1)} minutes`);
  }

  // Analyze each trade
  console.log(`\n\n💼 TRADE-BY-TRADE ANALYSIS`);
  console.log('='.repeat(80));

  const trades = [];
  const buyOrders = session.orders.filter(o => o.side === 'buy');
  const sellOrders = session.orders.filter(o => o.side === 'sell');

  for (let i = 0; i < Math.min(buyOrders.length, sellOrders.length); i++) {
    const buy = buyOrders[i];
    const sell = sellOrders[i];
    
    trades.push({
      entry: buy,
      exit: sell,
      holdMinutes: (sell.createdAt - buy.createdAt) / 1000 / 60,
      pnl: (sell.price - buy.price) * buy.qty,
      pnlPct: ((sell.price - buy.price) / buy.price) * 100
    });
  }

  trades.forEach((trade, idx) => {
    console.log(`\n🔹 Trade ${idx + 1}:`);
    console.log(`   Entry Time: ${trade.entry.createdAt.toISOString()}`);
    console.log(`   Entry Price: $${trade.entry.price.toFixed(4)}`);
    console.log(`   Entry Size: ${trade.entry.qty.toFixed(2)} AERO`);
    console.log(`   Entry Value: $${(trade.entry.price * trade.entry.qty).toFixed(2)}`);
    
    console.log(`\n   Exit Time: ${trade.exit.createdAt.toISOString()}`);
    console.log(`   Exit Price: $${trade.exit.price.toFixed(4)}`);
    console.log(`   Hold Duration: ${trade.holdMinutes.toFixed(1)} minutes`);
    
    console.log(`\n   💰 Performance:`);
    console.log(`   PnL: $${trade.pnl.toFixed(2)}`);
    console.log(`   PnL %: ${trade.pnlPct.toFixed(2)}%`);
    console.log(`   Per minute: ${(trade.pnlPct / trade.holdMinutes).toFixed(4)}%/min`);
  });

  // Get market data
  console.log(`\n\n🌐 MARKET DATA COMPARISON`);
  console.log('='.repeat(80));

  const marketData = await fetchAeroMarketData();
  
  if (marketData.market_data) {
    const md = marketData.market_data;
    console.log(`\nCurrent Price: $${md.current_price?.usd || 'N/A'}`);
    console.log(`24h Change: ${md.price_change_percentage_24h?.toFixed(2) || 'N/A'}%`);
    console.log(`7d Change: ${md.price_change_percentage_7d?.toFixed(2) || 'N/A'}%`);
    console.log(`30d Change: ${md.price_change_percentage_30d?.toFixed(2) || 'N/A'}%`);
    
    console.log(`\nVolume 24h: $${md.total_volume?.usd?.toLocaleString() || 'N/A'}`);
    console.log(`Market Cap: $${md.market_cap?.usd?.toLocaleString() || 'N/A'}`);
    console.log(`Market Cap Rank: #${md.market_cap_rank || 'N/A'}`);
    
    console.log(`\nATH: $${md.ath?.usd?.toFixed(4) || 'N/A'}`);
    console.log(`ATH Change: ${md.ath_change_percentage?.usd?.toFixed(2) || 'N/A'}%`);
    console.log(`ATH Date: ${md.ath_date?.usd || 'N/A'}`);
    
    console.log(`\nATL: $${md.atl?.usd?.toFixed(4) || 'N/A'}`);
    console.log(`ATL Change: ${md.atl_change_percentage?.usd?.toFixed(2) || 'N/A'}%`);
  }

  // Technical analysis at time of trades
  console.log(`\n\n📊 TECHNICAL ANALYSIS RETROSPECTIVE`);
  console.log('='.repeat(80));

  if (session.strategies && session.strategies.length > 0) {
    console.log(`\nStrategies evaluated: ${session.strategies.length}`);
    
    session.strategies.forEach((strat, idx) => {
      console.log(`\n[${idx + 1}] ${strat.name} at ${strat.createdAt.toISOString()}`);
      console.log(`    Confidence: ${strat.confidence}`);
      console.log(`    Signal: ${strat.signal}`);
      console.log(`    Status: ${strat.status}`);
      
      if (strat.reasoningJson) {
        const reasoning = typeof strat.reasoningJson === 'string' 
          ? JSON.parse(strat.reasoningJson) 
          : strat.reasoningJson;
        console.log(`    Reasoning: ${reasoning.summary || reasoning.reason || 'N/A'}`);
      }
    });
  } else {
    console.log(`\n⚠️  No strategy records found`);
  }

  // Calculate what would have happened with different strategies
  console.log(`\n\n🎯 ALTERNATIVE SCENARIOS`);
  console.log('='.repeat(80));

  const currentPrice = marketData.market_data?.current_price?.usd || 1.25;

  trades.forEach((trade, idx) => {
    console.log(`\n📈 Trade ${idx + 1} - What if...`);
    
    // Scenario 1: Hold until now
    const holdPnl = (currentPrice - trade.entry.price) * trade.entry.qty;
    const holdPnlPct = ((currentPrice - trade.entry.price) / trade.entry.price) * 100;
    console.log(`\n   Scenario 1: HOLD until now ($${currentPrice.toFixed(4)})`);
    console.log(`   Result: $${holdPnl.toFixed(2)} (${holdPnlPct.toFixed(2)}%)`);
    console.log(`   vs Actual: $${trade.pnl.toFixed(2)} (${trade.pnlPct.toFixed(2)}%)`);
    console.log(`   Difference: $${(holdPnl - trade.pnl).toFixed(2)}`);
    
    // Scenario 2: Exit at 1% profit
    const target1pct = trade.entry.price * 1.01;
    const target1pctPnl = (target1pct - trade.entry.price) * trade.entry.qty;
    console.log(`\n   Scenario 2: Exit at +1% ($${target1pct.toFixed(4)})`);
    console.log(`   Result: $${target1pctPnl.toFixed(2)} (+1.00%)`);
    console.log(`   Was this reached? ${currentPrice >= target1pct ? '✅ YES' : '❌ NO'}`);
    
    // Scenario 3: Stop loss at -1%
    const stop1pct = trade.entry.price * 0.99;
    console.log(`\n   Scenario 3: Stop at -1% ($${stop1pct.toFixed(4)})`);
    console.log(`   Was stop hit? ${trade.exit.price <= stop1pct ? '✅ YES - Exit was stop loss' : '❌ NO - Exit was different reason'}`);
  });

  // Final verdict
  console.log(`\n\n⚖️  FINAL VERDICT`);
  console.log('='.repeat(80));

  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const avgHoldTime = trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length;
  const allLosses = trades.every(t => t.pnl < 0);

  console.log(`\n📊 Summary Statistics:`);
  console.log(`   Total Trades: ${trades.length}`);
  console.log(`   Win Rate: ${trades.filter(t => t.pnl > 0).length}/${trades.length} (${(trades.filter(t => t.pnl > 0).length / trades.length * 100).toFixed(0)}%)`);
  console.log(`   Total PnL: $${totalPnl.toFixed(2)}`);
  console.log(`   Avg Hold Time: ${avgHoldTime.toFixed(1)} minutes`);
  console.log(`   Current Price vs Avg Entry: ${((currentPrice / (trades.reduce((sum, t) => sum + t.entry.price, 0) / trades.length) - 1) * 100).toFixed(2)}%`);

  console.log(`\n🎯 Decision Quality Assessment:\n`);

  // 1. Was selection good?
  const priceChange24h = marketData.market_data?.price_change_percentage_24h || 0;
  const priceChange7d = marketData.market_data?.price_change_percentage_7d || 0;
  
  if (priceChange24h < -5 || priceChange7d < -10) {
    console.log(`   ❌ SELECTION: Poor - AERO was in downtrend`);
    console.log(`      24h: ${priceChange24h.toFixed(2)}%, 7d: ${priceChange7d.toFixed(2)}%`);
    console.log(`      → Should not have selected AERO`);
  } else if (priceChange24h > 0 && priceChange7d > 0) {
    console.log(`   ✅ SELECTION: Good - AERO showed positive momentum`);
    console.log(`      24h: ${priceChange24h.toFixed(2)}%, 7d: ${priceChange7d.toFixed(2)}%`);
  } else {
    console.log(`   ⚠️  SELECTION: Neutral - Mixed signals`);
    console.log(`      24h: ${priceChange24h.toFixed(2)}%, 7d: ${priceChange7d.toFixed(2)}%`);
  }

  // 2. Was entry timing good?
  const avgEntryPrice = trades.reduce((sum, t) => sum + t.entry.price, 0) / trades.length;
  const entryVsNow = ((currentPrice - avgEntryPrice) / avgEntryPrice) * 100;
  
  if (entryVsNow > 0) {
    console.log(`\n   ✅ ENTRY TIMING: Good - Price is up ${entryVsNow.toFixed(2)}% since entry`);
    console.log(`      → Entry prices were reasonable`);
  } else {
    console.log(`\n   ❌ ENTRY TIMING: Poor - Price is down ${Math.abs(entryVsNow).toFixed(2)}% since entry`);
    console.log(`      → Entered during local top`);
  }

  // 3. Was exit strategy good?
  if (allLosses && avgHoldTime < 60) {
    console.log(`\n   ❌ EXIT STRATEGY: Too aggressive`);
    console.log(`      → All trades closed at loss after avg ${avgHoldTime.toFixed(1)}min`);
    console.log(`      → Price recovered to $${currentPrice.toFixed(4)} (+${entryVsNow.toFixed(2)}%)`);
    console.log(`      → Missed gains: $${(currentPrice - avgEntryPrice).toFixed(4)}/unit`);
  } else if (trades.some(t => t.pnl > 0)) {
    console.log(`\n   ✅ EXIT STRATEGY: Acceptable - Some profitable exits`);
  } else {
    console.log(`\n   ⚠️  EXIT STRATEGY: Needs review`);
  }

  // 4. Overall recommendation
  console.log(`\n\n💡 RECOMMENDATIONS:\n`);
  
  if (allLosses && entryVsNow > 0) {
    console.log(`   1. 🔴 CRITICAL: Exit strategy too aggressive for AERO's volatility`);
    console.log(`      - Increase min hold duration to at least 60 minutes`);
    console.log(`      - Widen stop loss from current (appears to be ~1-2%)`);
    console.log(`      - Consider trailing stop instead of fixed targets`);
    
    console.log(`\n   2. ⚠️  Review entry confidence thresholds`);
    console.log(`      - May be entering too eagerly`);
    console.log(`      - Wait for stronger confirmation signals`);
  }
  
  if (priceChange7d < -5) {
    console.log(`\n   3. 🔴 CRITICAL: Selection filter missed downtrend`);
    console.log(`      - Add 7-day momentum filter`);
    console.log(`      - Require positive 7d change > 5%`);
  }

  console.log(`\n   4. Consider AERO's typical volatility pattern`);
  console.log(`      - Analyze historical intraday swings`);
  console.log(`      - Adjust stop/targets based on ATR`);

  console.log('\n' + '='.repeat(80));
  console.log('✅ Analysis complete!\n');
}

analyzeAeroDecisions()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
