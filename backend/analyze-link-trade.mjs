import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeLinkTrade() {
  console.log('='.repeat(100));
  console.log('DEEP ANALYSIS: LINK TRADE - Paper vs Live');
  console.log('='.repeat(100));

  // Get LINK trades from Jan 5-6
  const trades = await prisma.trade.findMany({
    where: {
      symbol: 'LINK/USDT:USDT',
      entryTs: {
        gte: new Date('2026-01-05T20:00:00Z'),
        lte: new Date('2026-01-06T10:00:00Z')
      }
    },
    include: {
      session: true,
      fills: {
        orderBy: { ts: 'asc' }
      }
    },
    orderBy: { entryTs: 'asc' }
  });

  const paperTrade = trades.find(t => t.session?.mode === 'paper');
  const liveTrade = trades.find(t => t.session?.mode === 'live');

  console.log('\n' + '─'.repeat(80));
  console.log('PAPER TRADE:');
  console.log('─'.repeat(80));
  if (paperTrade) {
    console.log(`  ID: ${paperTrade.id}`);
    console.log(`  Entry Time: ${paperTrade.entryTs.toISOString()}`);
    console.log(`  Exit Time:  ${paperTrade.exitTs.toISOString()}`);
    console.log(`  Entry Price: $${paperTrade.entryPrice}`);
    console.log(`  Exit Price:  $${paperTrade.exitPrice}`);
    console.log(`  Exit Reason: ${paperTrade.exitReason}`);
    console.log(`  PnL %: ${paperTrade.pctChange?.toFixed(2)}%`);
    console.log(`  Duration: ${paperTrade.durationMinutes} min`);
    console.log(`  Max PnL %: ${paperTrade.maxPnlPct?.toFixed(2)}%`);
    console.log(`  Fills: ${paperTrade.fills.length}`);
    for (const fill of paperTrade.fills) {
      console.log(`    - ${fill.ts.toISOString()} | ${fill.side} | $${fill.price} | qty=${fill.qty} | reason=${fill.exitReason || 'entry'}`);
    }
  } else {
    console.log('  NOT FOUND');
  }

  console.log('\n' + '─'.repeat(80));
  console.log('LIVE TRADE:');
  console.log('─'.repeat(80));
  if (liveTrade) {
    console.log(`  ID: ${liveTrade.id}`);
    console.log(`  Entry Time: ${liveTrade.entryTs.toISOString()}`);
    console.log(`  Exit Time:  ${liveTrade.exitTs.toISOString()}`);
    console.log(`  Entry Price: $${liveTrade.entryPrice}`);
    console.log(`  Exit Price:  $${liveTrade.exitPrice}`);
    console.log(`  Exit Reason: ${liveTrade.exitReason}`);
    console.log(`  PnL %: ${liveTrade.pctChange?.toFixed(2)}%`);
    console.log(`  Duration: ${liveTrade.durationMinutes} min`);
    console.log(`  Max PnL %: ${liveTrade.maxPnlPct?.toFixed(2)}%`);
    console.log(`  Fills: ${liveTrade.fills.length}`);
    for (const fill of liveTrade.fills) {
      console.log(`    - ${fill.ts.toISOString()} | ${fill.side} | $${fill.price} | qty=${fill.qty} | reason=${fill.exitReason || 'entry'}`);
    }
  } else {
    console.log('  NOT FOUND');
  }

  // Compare
  if (paperTrade && liveTrade) {
    console.log('\n' + '─'.repeat(80));
    console.log('COMPARISON:');
    console.log('─'.repeat(80));

    const entryDiff = (liveTrade.entryTs.getTime() - paperTrade.entryTs.getTime()) / 1000;
    const exitDiff = (liveTrade.exitTs.getTime() - paperTrade.exitTs.getTime()) / 1000;

    console.log(`  Entry Time Diff: ${entryDiff}s (${(entryDiff/60).toFixed(1)} min) - Live ${entryDiff > 0 ? 'AFTER' : 'BEFORE'} Paper`);
    console.log(`  Exit Time Diff:  ${exitDiff}s (${(exitDiff/60).toFixed(1)} min) - Live ${exitDiff > 0 ? 'AFTER' : 'BEFORE'} Paper`);
    console.log(`  Entry Price Diff: ${((liveTrade.entryPrice - paperTrade.entryPrice) / paperTrade.entryPrice * 100).toFixed(4)}%`);
    console.log(`  Exit Price Diff:  ${((liveTrade.exitPrice - paperTrade.exitPrice) / paperTrade.exitPrice * 100).toFixed(4)}%`);
    console.log(`  PnL Diff: ${(liveTrade.pctChange - paperTrade.pctChange).toFixed(2)}% (Live ${liveTrade.pctChange > paperTrade.pctChange ? 'better' : 'WORSE'})`);
  }

  // Get trigger logs around these trades
  console.log('\n' + '─'.repeat(80));
  console.log('TRIGGER LOGS:');
  console.log('─'.repeat(80));

  if (paperTrade && liveTrade) {
    const startTime = new Date(Math.min(paperTrade.entryTs.getTime(), liveTrade.entryTs.getTime()) - 30 * 60 * 1000);
    const endTime = new Date(Math.max(paperTrade.exitTs.getTime(), liveTrade.exitTs.getTime()) + 30 * 60 * 1000);

    const triggers = await prisma.triggerLog.findMany({
      where: {
        symbol: 'LINK/USDT:USDT',
        createdAt: {
          gte: startTime,
          lte: endTime
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`  Found ${triggers.length} triggers between ${startTime.toISOString()} and ${endTime.toISOString()}`);
    for (const t of triggers) {
      const payload = t.payload;
      console.log(`\n  [${t.createdAt.toISOString()}] ${t.kind}`);
      if (payload.mode) console.log(`    Mode: ${payload.mode}`);
      if (payload.price) console.log(`    Price: $${payload.price}`);
      if (payload.pnlPct !== undefined) console.log(`    PnL: ${payload.pnlPct?.toFixed(2)}%`);
      if (payload.reason) console.log(`    Reason: ${payload.reason}`);
      if (payload.signalScore) console.log(`    Signal Score: ${payload.signalScore}`);
    }
  }

  // Get orders for these sessions
  console.log('\n' + '─'.repeat(80));
  console.log('ORDERS (Live session):');
  console.log('─'.repeat(80));

  if (liveTrade) {
    const orders = await prisma.order.findMany({
      where: {
        sessionId: liveTrade.sessionId,
        symbol: 'LINK/USDT:USDT',
        createdAt: {
          gte: new Date(liveTrade.entryTs.getTime() - 5 * 60 * 1000),
          lte: new Date(liveTrade.exitTs.getTime() + 5 * 60 * 1000)
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log(`  Found ${orders.length} orders`);
    for (const o of orders) {
      console.log(`\n  [${o.createdAt.toISOString()}] ${o.side} ${o.type}`);
      console.log(`    Status: ${o.status}`);
      console.log(`    Price: $${o.price || 'MARKET'}`);
      console.log(`    Qty: ${o.qty}`);
      console.log(`    SL: ${o.sl || 'N/A'}`);
      console.log(`    Source: ${o.source}`);
      if (o.error) console.log(`    Error: ${o.error}`);
    }
  }

  // Check position state history if available
  console.log('\n' + '─'.repeat(80));
  console.log('POSITION STATE (at exit time):');
  console.log('─'.repeat(80));

  // Let's also look at what the candles looked like
  console.log('\n' + '─'.repeat(80));
  console.log('TIMELINE ANALYSIS:');
  console.log('─'.repeat(80));

  if (paperTrade && liveTrade) {
    console.log('\nPaper Timeline:');
    console.log(`  Entry: ${paperTrade.entryTs.toISOString()} @ $${paperTrade.entryPrice}`);
    console.log(`  Hold Duration: ${paperTrade.durationMinutes} min`);
    console.log(`  Max PnL reached: ${paperTrade.maxPnlPct?.toFixed(2)}%`);
    console.log(`  Exit: ${paperTrade.exitTs.toISOString()} @ $${paperTrade.exitPrice}`);
    console.log(`  Final PnL: ${paperTrade.pctChange?.toFixed(2)}%`);
    console.log(`  Exit Reason: ${paperTrade.exitReason}`);

    console.log('\nLive Timeline:');
    console.log(`  Entry: ${liveTrade.entryTs.toISOString()} @ $${liveTrade.entryPrice}`);
    console.log(`  Hold Duration: ${liveTrade.durationMinutes} min`);
    console.log(`  Max PnL reached: ${liveTrade.maxPnlPct?.toFixed(2)}%`);
    console.log(`  Exit: ${liveTrade.exitTs.toISOString()} @ $${liveTrade.exitPrice}`);
    console.log(`  Final PnL: ${liveTrade.pctChange?.toFixed(2)}%`);
    console.log(`  Exit Reason: ${liveTrade.exitReason}`);

    // Calculate what SL prices would have been
    const paperSL2pct = paperTrade.entryPrice * 0.98; // 2% SL
    const liveSL2pct = liveTrade.entryPrice * 0.98;
    const paperSL08pct = paperTrade.entryPrice * 0.992; // 0.8% tightened SL
    const liveSL08pct = liveTrade.entryPrice * 0.992;

    console.log('\n  Calculated Stop Losses:');
    console.log(`    Paper 2% SL: $${paperSL2pct.toFixed(4)}`);
    console.log(`    Paper 0.8% (stagnant) SL: $${paperSL08pct.toFixed(4)}`);
    console.log(`    Live 2% SL: $${liveSL2pct.toFixed(4)}`);
    console.log(`    Live 0.8% (stagnant) SL: $${liveSL08pct.toFixed(4)}`);

    console.log('\n  Exit Price vs SL:');
    console.log(`    Paper exit $${paperTrade.exitPrice} vs 2% SL $${paperSL2pct.toFixed(4)} → ${paperTrade.exitPrice < paperSL2pct ? 'BELOW SL' : 'above SL'}`);
    console.log(`    Live exit $${liveTrade.exitPrice} vs 2% SL $${liveSL2pct.toFixed(4)} → ${liveTrade.exitPrice < liveSL2pct ? 'BELOW SL' : 'above SL'}`);
    console.log(`    Live exit $${liveTrade.exitPrice} vs 0.8% SL $${liveSL08pct.toFixed(4)} → ${liveTrade.exitPrice < liveSL08pct ? 'BELOW SL' : 'above SL'}`);
  }

  await prisma.$disconnect();
}

analyzeLinkTrade().catch(console.error);
