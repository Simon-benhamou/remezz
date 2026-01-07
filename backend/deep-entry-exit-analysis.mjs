/**
 * 🔬 DEEP ANALYSIS: Entry/Exit Timing Live vs Backtest
 * 
 * Question: Is the 15min offset a real mismatch or just timestamp representation?
 * 
 * Key insight:
 * - Candle timestamp = candle OPEN time
 * - Entry in backtest = at candle CLOSE (which is 15min after timestamp)
 * - Entry in live = actual execution time
 * 
 * So candle 14:15 means: open at 14:15, close at 14:30
 * If backtest enters on candle 14:15, it actually enters at 14:30 (the close price)
 */

import { PrismaClient } from '@prisma/client';
import ccxt from 'ccxt';

const prisma = new PrismaClient();
const exchange = new ccxt.binance({ enableRateLimit: true });

async function fetchCandles(symbol, since, until) {
  const candles = [];
  let fromTs = since;
  
  while (fromTs < until) {
    const data = await exchange.fetchOHLCV(symbol.replace(':USDT', ''), '15m', fromTs, 500);
    if (data.length === 0) break;
    candles.push(...data);
    fromTs = data[data.length - 1][0] + 15 * 60 * 1000;
    if (data.length < 500) break;
  }
  
  return candles.filter(c => c[0] >= since && c[0] <= until);
}

async function main() {
  console.log('='.repeat(100));
  console.log('🔬 DEEP ENTRY/EXIT TIMING ANALYSIS: SEI & ADA');
  console.log('='.repeat(100));
  
  // Get SEI and ADA trades
  const trades = await prisma.trade.findMany({
    where: {
      symbol: { in: ['SEI/USDT:USDT', 'ADA/USDT:USDT'] },
      exitTs: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    include: { session: true },
    orderBy: { entryTs: 'desc' }
  });
  
  // Get parity results
  const parityResults = await prisma.tradeParityResult.findMany({
    where: { tradeId: { in: trades.map(t => t.id) } }
  });
  const parityByTradeId = new Map(parityResults.map(p => [p.tradeId, p]));
  
  console.log(`\nFound ${trades.length} trades with ${parityResults.length} parity results\n`);
  
  for (const trade of trades.slice(0, 4)) { // Analyze first 4 trades
    const parity = parityByTradeId.get(trade.id);
    if (!parity) continue;
    
    const sym = trade.symbol.replace('/USDT:USDT', '');
    console.log('━'.repeat(100));
    console.log(`📊 ${sym} | ${trade.positionSide.toUpperCase()} | ${trade.session?.mode || 'unknown'} mode`);
    console.log('━'.repeat(100));
    
    // Fetch candles around the trade
    const since = trade.entryTs.getTime() - 2 * 60 * 60 * 1000;
    const until = trade.exitTs.getTime() + 1 * 60 * 60 * 1000;
    const candles = await fetchCandles(trade.symbol, since, until);
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LIVE ENTRY ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n📍 LIVE TRADE:');
    console.log(`   Entry Time:  ${trade.entryTs.toISOString()}`);
    console.log(`   Entry Price: $${trade.entryPrice.toFixed(6)}`);
    console.log(`   Exit Time:   ${trade.exitTs.toISOString()}`);
    
    // Which candle does the live entry fall into?
    const liveEntryTs = trade.entryTs.getTime();
    const liveEntryCandleTs = Math.floor(liveEntryTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    
    console.log(`\n   Entry is in candle: ${new Date(liveEntryCandleTs).toISOString()}`);
    console.log(`   (This candle opens at ${new Date(liveEntryCandleTs).toISOString().slice(11,16)} and closes at ${new Date(liveEntryCandleTs + 15*60*1000).toISOString().slice(11,16)})`);
    
    // Find the actual candle
    const liveEntryCandle = candles.find(c => c[0] === liveEntryCandleTs);
    if (liveEntryCandle) {
      console.log(`   Candle data: O=${liveEntryCandle[1].toFixed(5)} H=${liveEntryCandle[2].toFixed(5)} L=${liveEntryCandle[3].toFixed(5)} C=${liveEntryCandle[4].toFixed(5)}`);
      console.log(`   Live entry price vs candle close: $${trade.entryPrice.toFixed(6)} vs $${liveEntryCandle[4].toFixed(6)}`);
      
      const priceDiff = Math.abs(trade.entryPrice - liveEntryCandle[4]);
      const priceDiffPct = (priceDiff / liveEntryCandle[4]) * 100;
      console.log(`   Price difference: $${priceDiff.toFixed(6)} (${priceDiffPct.toFixed(4)}%)`);
      
      if (priceDiffPct < 0.1) {
        console.log(`   ✅ Entry price matches candle CLOSE (expected for momentum entry)`);
      } else {
        console.log(`   ⚠️  Entry price differs from candle close - might be mid-candle entry`);
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // BACKTEST ENTRY ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n🔄 BACKTEST TRADE:');
    if (parity.btEntryTs) {
      console.log(`   Entry Time:  ${parity.btEntryTs.toISOString()}`);
      console.log(`   Entry Price: (not stored in parity - need to check)`);
      
      const btEntryTs = parity.btEntryTs.getTime();
      const btEntryCandleTs = Math.floor(btEntryTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
      
      console.log(`\n   Entry is in candle: ${new Date(btEntryCandleTs).toISOString()}`);
      console.log(`   (This candle opens at ${new Date(btEntryCandleTs).toISOString().slice(11,16)} and closes at ${new Date(btEntryCandleTs + 15*60*1000).toISOString().slice(11,16)})`);
      
      // Find the actual candle
      const btEntryCandle = candles.find(c => c[0] === btEntryCandleTs);
      if (btEntryCandle) {
        console.log(`   Candle data: O=${btEntryCandle[1].toFixed(5)} H=${btEntryCandle[2].toFixed(5)} L=${btEntryCandle[3].toFixed(5)} C=${btEntryCandle[4].toFixed(5)}`);
        console.log(`   Backtest enters at candle CLOSE price: $${btEntryCandle[4].toFixed(6)}`);
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // COMPARISON
      // ═══════════════════════════════════════════════════════════════════════════
      console.log('\n⚖️  COMPARISON:');
      
      const liveEntryCandleEnd = liveEntryCandleTs + 15 * 60 * 1000; // When candle closes
      const btEntryCandleEnd = btEntryCandleTs + 15 * 60 * 1000;
      
      console.log(`   Live entry candle closes at:     ${new Date(liveEntryCandleEnd).toISOString()}`);
      console.log(`   Backtest entry candle closes at: ${new Date(btEntryCandleEnd).toISOString()}`);
      
      const candleDiff = (liveEntryCandleTs - btEntryCandleTs) / (15 * 60 * 1000);
      console.log(`   Candle difference: ${candleDiff} candles (${candleDiff * 15} minutes)`);
      
      if (candleDiff === 0) {
        console.log(`   ✅ SAME CANDLE - Entry is aligned!`);
        console.log(`      The 15-second difference is just execution time within the same candle.`);
      } else if (candleDiff === 1 || candleDiff === -1) {
        console.log(`   ⚠️  OFF BY 1 CANDLE`);
        
        // Check if backtest timestamp is the candle open but means candle close
        // Backtest uses candle timestamp as entry time, but entry happens at CLOSE
        const btActualEntryTime = btEntryCandleTs + 15 * 60 * 1000; // Entry at close
        const timeToLiveEntry = Math.abs(btActualEntryTime - liveEntryTs) / 1000;
        console.log(`   If BT enters at candle CLOSE: ${new Date(btActualEntryTime).toISOString()}`);
        console.log(`   Live entry time:              ${trade.entryTs.toISOString()}`);
        console.log(`   Actual time difference: ${timeToLiveEntry.toFixed(0)} seconds`);
        
        if (timeToLiveEntry < 30) {
          console.log(`   ✅ ACTUALLY SAME TIME! BT stores candle open timestamp, but enters at close.`);
          console.log(`      This is a REPRESENTATION ISSUE, not a real mismatch!`);
        } else {
          console.log(`   ❌ REAL MISMATCH - different entry times`);
        }
      } else {
        console.log(`   ❌ SIGNIFICANT MISMATCH - ${Math.abs(candleDiff)} candles apart`);
      }
      
      // Check entry prices
      if (liveEntryCandle && btEntryCandle) {
        const liveClosePrice = liveEntryCandle[4];
        const btClosePrice = btEntryCandle[4];
        const priceMatch = Math.abs(trade.entryPrice - btClosePrice) < 0.0001;
        
        console.log(`\n   Entry Price Check:`);
        console.log(`   Live entry:  $${trade.entryPrice.toFixed(6)}`);
        console.log(`   BT candle close: $${btClosePrice.toFixed(6)}`);
        
        if (priceMatch) {
          console.log(`   ✅ PRICES MATCH - Same entry point!`);
        }
      }
    } else {
      console.log(`   ❌ No backtest trade found!`);
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // EXIT ANALYSIS (similar logic)
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('\n📍 EXIT TIMING:');
    const liveExitTs = trade.exitTs.getTime();
    const liveExitCandleTs = Math.floor(liveExitTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
    
    if (parity.btExitTs) {
      const btExitTs = parity.btExitTs.getTime();
      const btExitCandleTs = Math.floor(btExitTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
      
      console.log(`   Live exit candle:     ${new Date(liveExitCandleTs).toISOString().slice(11,16)} (closes at ${new Date(liveExitCandleTs + 15*60*1000).toISOString().slice(11,16)})`);
      console.log(`   Backtest exit candle: ${new Date(btExitCandleTs).toISOString().slice(11,16)} (closes at ${new Date(btExitCandleTs + 15*60*1000).toISOString().slice(11,16)})`);
      
      const exitCandleDiff = (liveExitCandleTs - btExitCandleTs) / (15 * 60 * 1000);
      console.log(`   Exit candle difference: ${exitCandleDiff} candles`);
      
      // Check if accounting for timestamp representation fixes it
      const btActualExitTime = btExitCandleTs + 15 * 60 * 1000;
      const exitTimeDiff = Math.abs(btActualExitTime - liveExitTs) / 1000;
      console.log(`   If BT exits at candle CLOSE: ${new Date(btActualExitTime).toISOString()}`);
      console.log(`   Actual time difference: ${exitTimeDiff.toFixed(0)} seconds`);
      
      if (exitTimeDiff < 60) {
        console.log(`   ✅ EXIT TIMES ALIGN when accounting for timestamp representation!`);
      } else {
        console.log(`   ⚠️  Exit times still differ by ${(exitTimeDiff/60).toFixed(1)} minutes`);
      }
    }
    
    console.log('\n');
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('='.repeat(100));
  console.log('📋 KEY INSIGHT:');
  console.log('='.repeat(100));
  console.log(`
  TIMESTAMP REPRESENTATION:
  ─────────────────────────
  • Backtest stores entry time as CANDLE OPEN timestamp (e.g., 14:15:00)
  • But the actual entry happens at CANDLE CLOSE (14:30:00)
  • Live stores the ACTUAL EXECUTION time (e.g., 14:30:07)
  
  So when you see:
  • BT Entry: 14:15:00
  • Live Entry: 14:30:07
  
  They are actually THE SAME entry point (within 7 seconds)!
  The 15-minute difference is just how the timestamp is represented.
  
  RECOMMENDATION:
  ───────────────
  The parity service should store entry times consistently:
  • Either always use candle open timestamp
  • Or always use candle close timestamp (more accurate)
  
  For comparison, we should compare CANDLES, not exact timestamps.
  If both entered on the "same candle" (same 15-minute period), that's a match.
  `);
  
  await prisma.$disconnect();
}

main().catch(console.error);
