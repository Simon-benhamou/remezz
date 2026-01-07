/**
 * Debug: Compare stagnant timing between live and backtest
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
  console.log('='.repeat(80));
  console.log('🔬 STAGNANT TIMING ANALYSIS');
  console.log('='.repeat(80));
  
  // Analyze SEI trade (most clear case: BT=90m, Live=135m)
  const seiTrade = await prisma.trade.findFirst({
    where: {
      symbol: 'SEI/USDT:USDT',
      exitTs: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    },
    orderBy: { exitTs: 'desc' }
  });
  
  if (!seiTrade) {
    console.log('No SEI trade found');
    return;
  }
  
  console.log(`\nAnalyzing SEI trade:`);
  console.log(`  Entry: ${seiTrade.entryTs.toISOString()}`);
  console.log(`  Exit:  ${seiTrade.exitTs.toISOString()}`);
  console.log(`  Side:  ${seiTrade.positionSide}`);
  console.log(`  Entry Price: $${seiTrade.entryPrice}`);
  
  // Fetch candles around the trade
  const since = seiTrade.entryTs.getTime() - 2 * 60 * 60 * 1000;
  const until = seiTrade.exitTs.getTime() + 1 * 60 * 60 * 1000;
  const candles = await fetchCandles('SEI/USDT:USDT', since, until);
  
  console.log(`\nCandles from ${new Date(since).toISOString()} to ${new Date(until).toISOString()}:`);
  
  // Find entry bar
  const entryTs = seiTrade.entryTs.getTime();
  const entryCandle15m = Math.floor(entryTs / (15 * 60 * 1000)) * (15 * 60 * 1000);
  
  console.log(`\nEntry candle: ${new Date(entryCandle15m).toISOString()}`);
  
  // Calculate stagnant timing
  // Trigger: 45m after entry (bar 3)
  // Confirm: +60m observation (bar 7 = 105m after entry)
  // SL tightens to 0.8%
  
  const triggerTime = entryCandle15m + 45 * 60 * 1000;
  const confirmTime = entryCandle15m + 105 * 60 * 1000;
  
  console.log(`\nExpected stagnant timeline:`);
  console.log(`  Trigger at:  ${new Date(triggerTime).toISOString()} (45m after entry)`);
  console.log(`  Confirm at:  ${new Date(confirmTime).toISOString()} (105m after entry)`);
  
  // After confirmation, SL tightens to 0.8%
  // For SHORT: SL price = entryPrice * (1 + 0.8/100)
  const slPct = 0.8;
  const entryPrice = seiTrade.entryPrice;
  const slPrice = seiTrade.positionSide === 'short' 
    ? entryPrice * (1 + slPct / 100)
    : entryPrice * (1 - slPct / 100);
  
  console.log(`\n  Entry Price: $${entryPrice.toFixed(6)}`);
  console.log(`  Tightened SL (0.8%): $${slPrice.toFixed(6)}`);
  
  // Find which candle first breaches the SL after confirmation
  console.log(`\nCandles after confirmation:`);
  
  for (const c of candles) {
    const ts = c[0];
    const open = c[1];
    const high = c[2];
    const low = c[3];
    const close = c[4];
    
    if (ts < entryCandle15m) continue;
    
    const barNum = Math.floor((ts - entryCandle15m) / (15 * 60 * 1000));
    const holdMin = barNum * 15;
    
    // For short: wick HIGH breaches SL
    const slBreached = seiTrade.positionSide === 'short' 
      ? high >= slPrice
      : low <= slPrice;
    
    const closeBreached = seiTrade.positionSide === 'short'
      ? close >= slPrice
      : close <= slPrice;
    
    const isAfterConfirm = ts >= confirmTime;
    
    const marker = slBreached && isAfterConfirm ? ' <<<< SL BREACHED' : '';
    
    console.log(`  Bar ${barNum.toString().padStart(2)} | ${new Date(ts).toISOString().slice(11,16)} | O=${open.toFixed(5)} H=${high.toFixed(5)} L=${low.toFixed(5)} C=${close.toFixed(5)}${marker}`);
    
    if (barNum > 15) break;
  }
  
  await prisma.$disconnect();
}

main().catch(console.error);
