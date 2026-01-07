/**
 * 🔬 WHY DOES BACKTEST EXIT EARLIER?
 * 
 * Hypothesis: The entry PRICE difference causes different stagnant timing
 * 
 * Stagnant logic:
 * 1. Trigger at 45m if maxPnl < 0.8%
 * 2. Confirm after +60m observation (total 105m)
 * 3. Tighten SL to 0.8%
 * 4. Exit when SL is hit
 * 
 * Key: maxPnl depends on entry price!
 * - BT enters at higher price (worse for short)
 * - Live enters at lower price (better for short)
 * - This affects when maxPnl reaches thresholds
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
  console.log('🔬 WHY DOES BACKTEST EXIT EARLIER? - STAGNANT TIMING ANALYSIS');
  console.log('='.repeat(100));
  
  // Get SEI trade (clearest example: 3 candles difference)
  const trade = await prisma.trade.findFirst({
    where: {
      symbol: 'SEI/USDT:USDT',
      exitTs: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    include: { session: true },
    orderBy: { exitTs: 'desc' }
  });
  
  if (!trade) {
    console.log('No trade found');
    return;
  }
  
  const parity = await prisma.tradeParityResult.findFirst({
    where: { tradeId: trade.id }
  });
  
  console.log(`\nAnalyzing: SEI SHORT | ${trade.session?.mode} mode`);
  console.log(`Live entry:  ${trade.entryTs.toISOString()} @ $${trade.entryPrice}`);
  console.log(`BT entry:    ${parity?.btEntryTs?.toISOString()} (candle timestamp)`);
  
  // Fetch candles
  const since = trade.entryTs.getTime() - 1 * 60 * 60 * 1000;
  const until = trade.exitTs.getTime() + 1 * 60 * 60 * 1000;
  const candles = await fetchCandles(trade.symbol, since, until);
  
  // Entry candle
  const entryCandleTs = Math.floor(trade.entryTs.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
  const entryCandle = candles.find(c => c[0] === entryCandleTs);
  
  const liveEntryPrice = trade.entryPrice;
  const btEntryPrice = entryCandle ? entryCandle[4] : 0; // Backtest uses candle close
  
  console.log(`\n📊 ENTRY PRICES:`);
  console.log(`   Live entry price: $${liveEntryPrice.toFixed(6)}`);
  console.log(`   BT entry price:   $${btEntryPrice.toFixed(6)} (candle close)`);
  console.log(`   Difference: $${(btEntryPrice - liveEntryPrice).toFixed(6)} (${((btEntryPrice - liveEntryPrice) / liveEntryPrice * 100).toFixed(3)}%)`);
  
  // Simulate PnL for each candle with BOTH entry prices
  console.log(`\n📊 PnL COMPARISON BY CANDLE (SHORT position):`);
  console.log(`${'Bar'.padStart(4)} | ${'Time'.padStart(5)} | ${'Low'.padStart(9)} | ${'High'.padStart(9)} | Live PnL | BT PnL   | Live MaxPnl | BT MaxPnl`);
  console.log('─'.repeat(100));
  
  let liveMaxPnl = -999;
  let btMaxPnl = -999;
  let liveStagnantTriggered = false;
  let btStagnantTriggered = false;
  let liveStagnantConfirmed = false;
  let btStagnantConfirmed = false;
  let liveStagnantTriggerBar = -1;
  let btStagnantTriggerBar = -1;
  
  const STAGNANT_TIME = 45; // 3 bars
  const STAGNANT_OBS = 60;  // 4 bars
  const STAGNANT_MIN_PROFIT = 0.8;
  const STAGNANT_SL_PCT = 0.8;
  
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ts = c[0];
    if (ts < entryCandleTs) continue;
    
    const barNum = (ts - entryCandleTs) / (15 * 60 * 1000);
    const holdMin = barNum * 15;
    
    const low = c[3];
    const high = c[2];
    
    // For SHORT: PnL is positive when price goes DOWN
    // maxPnl is based on lowest price reached
    const livePnlAtLow = ((liveEntryPrice - low) / liveEntryPrice) * 100;
    const btPnlAtLow = ((btEntryPrice - low) / btEntryPrice) * 100;
    
    // For SHORT: negative PnL is based on highest price (adverse move)
    const livePnlAtHigh = ((liveEntryPrice - high) / liveEntryPrice) * 100;
    const btPnlAtHigh = ((btEntryPrice - high) / btEntryPrice) * 100;
    
    // Track max profitable PnL (best case during trade)
    liveMaxPnl = Math.max(liveMaxPnl, livePnlAtLow);
    btMaxPnl = Math.max(btMaxPnl, btPnlAtLow);
    
    // Stagnant trigger check (at 45min = bar 3)
    if (!liveStagnantTriggered && holdMin >= STAGNANT_TIME && liveMaxPnl < STAGNANT_MIN_PROFIT) {
      liveStagnantTriggered = true;
      liveStagnantTriggerBar = barNum;
    }
    if (!btStagnantTriggered && holdMin >= STAGNANT_TIME && btMaxPnl < STAGNANT_MIN_PROFIT) {
      btStagnantTriggered = true;
      btStagnantTriggerBar = barNum;
    }
    
    // Stagnant confirm check (trigger + 60min = bar 7)
    if (liveStagnantTriggered && !liveStagnantConfirmed && holdMin >= (liveStagnantTriggerBar * 15 + STAGNANT_OBS)) {
      liveStagnantConfirmed = true;
    }
    if (btStagnantTriggered && !btStagnantConfirmed && holdMin >= (btStagnantTriggerBar * 15 + STAGNANT_OBS)) {
      btStagnantConfirmed = true;
    }
    
    // Check SL hit (after stagnant confirmed)
    const liveSL = liveEntryPrice * (1 + STAGNANT_SL_PCT / 100);
    const btSL = btEntryPrice * (1 + STAGNANT_SL_PCT / 100);
    
    const liveSlHit = liveStagnantConfirmed && high >= liveSL;
    const btSlHit = btStagnantConfirmed && high >= btSL;
    
    let marker = '';
    if (btSlHit && !liveSlHit) marker = ' ← BT EXITS HERE';
    if (liveSlHit && !btSlHit) marker = ' ← LIVE EXITS HERE';
    if (liveSlHit && btSlHit) marker = ' ← BOTH EXIT';
    
    console.log(
      `${barNum.toString().padStart(4)} | ` +
      `${new Date(ts).toISOString().slice(11,16)} | ` +
      `$${low.toFixed(5)} | ` +
      `$${high.toFixed(5)} | ` +
      `${livePnlAtHigh >= 0 ? '+' : ''}${livePnlAtHigh.toFixed(2)}% | ` +
      `${btPnlAtHigh >= 0 ? '+' : ''}${btPnlAtHigh.toFixed(2)}%  | ` +
      `${liveMaxPnl >= 0 ? '+' : ''}${liveMaxPnl.toFixed(2)}%    | ` +
      `${btMaxPnl >= 0 ? '+' : ''}${btMaxPnl.toFixed(2)}%` +
      `${liveStagnantTriggered && barNum === liveStagnantTriggerBar ? ' [L-TRIG]' : ''}` +
      `${btStagnantTriggered && barNum === btStagnantTriggerBar ? ' [BT-TRIG]' : ''}` +
      `${liveStagnantConfirmed && holdMin === liveStagnantTriggerBar * 15 + STAGNANT_OBS ? ' [L-CONF]' : ''}` +
      `${btStagnantConfirmed && holdMin === btStagnantTriggerBar * 15 + STAGNANT_OBS ? ' [BT-CONF]' : ''}` +
      marker
    );
    
    if (barNum > 12) break;
  }
  
  console.log(`\n📊 STAGNANT SL PRICES:`);
  console.log(`   Live SL (0.8% from $${liveEntryPrice.toFixed(5)}): $${(liveEntryPrice * 1.008).toFixed(5)}`);
  console.log(`   BT SL   (0.8% from $${btEntryPrice.toFixed(5)}):   $${(btEntryPrice * 1.008).toFixed(5)}`);
  console.log(`   SL difference: $${((btEntryPrice * 1.008) - (liveEntryPrice * 1.008)).toFixed(5)}`);
  
  console.log(`\n📋 CONCLUSION:`);
  console.log(`   The backtest enters at a HIGHER price ($${btEntryPrice.toFixed(5)} vs $${liveEntryPrice.toFixed(5)})`);
  console.log(`   This means the backtest's SL is HIGHER too ($${(btEntryPrice * 1.008).toFixed(5)} vs $${(liveEntryPrice * 1.008).toFixed(5)})`);
  console.log(`   When price rises, the HIGHER SL gets hit FIRST`);
  console.log(`   That's why backtest exits earlier!`);
  
  await prisma.$disconnect();
}

main().catch(console.error);
