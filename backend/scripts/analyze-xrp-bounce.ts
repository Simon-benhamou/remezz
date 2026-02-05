/**
 * Deep analysis of XRP trade - what happened after exit?
 * Could we have captured more of the move?
 */
import { prisma } from '../src/db/client.js';
import ccxt from 'ccxt';

async function analyze() {
  // Get XRP trade details
  const xrpTrade = await prisma.trade.findFirst({
    where: {
      symbol: { contains: 'XRP' },
      entryTs: { gte: new Date('2026-02-05T00:00:00Z') }
    },
    orderBy: { entryTs: 'desc' },
    include: { session: true }
  });

  if (!xrpTrade) {
    console.log('No XRP trade found');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('XRP TRADE - BOUNCE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const entryTime = xrpTrade.entryTs;
  const exitTime = xrpTrade.exitTs;
  const entryPrice = xrpTrade.entryPrice;
  const exitPrice = xrpTrade.exitPrice || 0;

  console.log(`Entry:  ${entryTime.toISOString().slice(11,19)} @ $${entryPrice.toFixed(4)}`);
  console.log(`Exit:   ${exitTime.toISOString().slice(11,19)} @ $${exitPrice.toFixed(4)}`);
  console.log(`Side:   ${xrpTrade.positionSide.toUpperCase()}`);
  console.log(`Reason: ${xrpTrade.exitReason}`);

  // Fetch candles to see what happened after exit
  const exchange = new ccxt.binance({ enableRateLimit: true });

  // Get 15m candles from entry to now
  const since = entryTime.getTime();
  const candles = await exchange.fetchOHLCV('XRP/USDT', '15m', since, 50);

  console.log('\n─── PRICE ACTION TIMELINE ───\n');

  let lowestAfterEntry = entryPrice;
  let lowestAfterExit = exitPrice;
  let lowestTime = '';
  let exitCandleIndex = -1;

  for (let i = 0; i < candles.length; i++) {
    const [ts, open, high, low, close] = candles[i];
    const time = new Date(ts).toISOString().slice(11, 16);
    const isEntry = ts <= entryTime.getTime() && ts + 15*60*1000 > entryTime.getTime();
    const isExit = ts <= exitTime.getTime() && ts + 15*60*1000 > exitTime.getTime();

    if (isExit) exitCandleIndex = i;

    // Track lowest price
    if (low < lowestAfterEntry) {
      lowestAfterEntry = low;
      if (ts > exitTime.getTime()) {
        lowestAfterExit = low;
        lowestTime = time;
      }
    }

    // Show key candles
    if (isEntry || isExit || i === candles.length - 1 || low === lowestAfterEntry) {
      const pnlFromEntry = ((entryPrice - close) / entryPrice * 100).toFixed(2);
      const marker = isEntry ? '📥 ENTRY' : isExit ? '📤 EXIT' : low === lowestAfterEntry ? '📉 LOW' : '📊 NOW';
      console.log(`${time} | O:${open.toFixed(4)} H:${high.toFixed(4)} L:${low.toFixed(4)} C:${close.toFixed(4)} | ${marker} | PnL:${pnlFromEntry}%`);
    }
  }

  // Analysis
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const maxPnlPct = (xrpTrade.maxPnlPct || 0);
  const actualPnlPct = xrpTrade.roiPct || 0;
  const capturedRatio = actualPnlPct / maxPnlPct * 100;

  console.log(`Max PnL reached:     ${(maxPnlPct * 5).toFixed(2)}% (leveraged)`);
  console.log(`Actual PnL:          ${(actualPnlPct * 5).toFixed(2)}% (leveraged)`);
  console.log(`Captured:            ${capturedRatio.toFixed(1)}% of max potential`);

  // What happened after exit
  const currentPrice = candles[candles.length - 1][4]; // close of last candle
  const potentialPnlIfHeld = ((entryPrice - currentPrice) / entryPrice * 100 * 5);
  const potentialPnlAtLow = ((entryPrice - lowestAfterEntry) / entryPrice * 100 * 5);
  const missedPnl = potentialPnlAtLow - (actualPnlPct * 5);

  console.log(`\nAFTER EXIT:`);
  console.log(`Lowest price after exit: $${lowestAfterExit.toFixed(4)} at ${lowestTime}`);
  console.log(`Current price:           $${currentPrice.toFixed(4)}`);
  console.log(`If held to lowest:       ${potentialPnlAtLow.toFixed(2)}% (leveraged)`);
  console.log(`If still holding now:    ${potentialPnlIfHeld.toFixed(2)}% (leveraged)`);
  console.log(`Missed by early exit:    ${missedPnl.toFixed(2)}%`);

  // The bounce analysis
  const bounceFromLow = ((exitPrice - lowestAfterEntry) / lowestAfterEntry * 100);
  console.log(`\nBOUNCE THAT TRIGGERED EXIT:`);
  console.log(`Bounce size: ${bounceFromLow.toFixed(2)}% from low`);
  console.log(`Trailing distance was: ~1.5%`);
  console.log(`Bounce exceeded trailing → Exit triggered`);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUGGESTIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log('1. WIDER TRAILING ON STRONG MOVES');
  console.log('   Current: 1.5% trailing distance');
  console.log('   If move is >3%, could widen to 2-2.5%');
  console.log('   Trade-off: May give back more on real reversals');

  console.log('\n2. MOMENTUM CONFIRMATION');
  console.log('   Current: Exit on price breach + NFS score');
  console.log('   Could add: Check if momentum (ROC) reversed');
  console.log('   Only exit if bounce has momentum behind it');

  console.log('\n3. PARTIAL EXITS');
  console.log('   Take 50% at first target (e.g., +10% lev)');
  console.log('   Let rest run with wider trailing');
  console.log('   Locks in profit, captures more of big moves');

  console.log('\n4. RE-ENTRY LOGIC');
  console.log('   If exited and price continues in original direction');
  console.log('   Re-enter with reduced size');
  console.log('   Requires cooldown bypass for same-direction re-entry');

  console.log('\n5. TIME-BASED CONFIRMATION');
  console.log('   Current: 1-2 candle confirmation');
  console.log('   Could require bounce to sustain for 2-3 candles');
  console.log('   Filters out quick wicks that recover');
}

analyze().catch(console.error);
