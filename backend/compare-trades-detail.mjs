import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function compareTradesDetail() {
  console.log('='.repeat(100));
  console.log('DETAILED COMPARISON: BACKTEST vs LIVE TRADES');
  console.log('='.repeat(100));

  // Get live trades
  const liveTrades = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      entryTs: {
        gte: new Date('2026-01-04T00:00:00Z'),
        lte: new Date('2026-01-06T23:59:59Z')
      }
    },
    orderBy: { entryTs: 'asc' }
  });

  // Backtest trades from the previous run (hardcoded from output)
  const backtestTrades = [
    { symbol: 'SUI', entry: '2026-01-04T00:00:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'SEI', entry: '2026-01-04T02:15:00Z', pnl: 4.49, reason: 'TRAIL' },
    { symbol: 'DOGE', entry: '2026-01-04T00:30:00Z', pnl: 16.44, reason: 'TRAIL' },
    { symbol: 'IMX', entry: '2026-01-04T05:00:00Z', pnl: 3.19, reason: 'TRAIL' },
    { symbol: 'ADA', entry: '2026-01-04T03:45:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'ADA', entry: '2026-01-04T09:45:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'APT', entry: '2026-01-04T16:30:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'IMX', entry: '2026-01-04T16:15:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'UNI', entry: '2026-01-05T00:45:00Z', pnl: 6.10, reason: 'TRAIL' },
    { symbol: 'BTC', entry: '2026-01-05T01:00:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
    { symbol: 'BCH', entry: '2026-01-05T06:00:00Z', pnl: 2.80, reason: 'TRAIL' },
    { symbol: 'DOT', entry: '2026-01-05T14:30:00Z', pnl: 7.15, reason: 'TRAIL' },
    { symbol: 'IMX', entry: '2026-01-05T14:45:00Z', pnl: 4.83, reason: 'TRAIL' },
    { symbol: 'DOGE', entry: '2026-01-05T16:15:00Z', pnl: 9.00, reason: 'TRAIL' },
    { symbol: 'IMX', entry: '2026-01-05T18:15:00Z', pnl: 6.95, reason: 'TRAIL' },
    { symbol: 'SUI', entry: '2026-01-05T16:00:00Z', pnl: 46.74, reason: 'TRAIL' },
    { symbol: 'UNI', entry: '2026-01-05T21:45:00Z', pnl: 18.37, reason: 'TRAIL' },
    { symbol: 'LINK', entry: '2026-01-05T20:30:00Z', pnl: -3.92, reason: 'STAGNANT_TRADE' },
  ];

  console.log(`\nBacktest trades: ${backtestTrades.length}`);
  console.log(`Live trades: ${liveTrades.length}`);

  // Group by symbol
  const symbols = [...new Set([
    ...backtestTrades.map(t => t.symbol),
    ...liveTrades.map(t => t.symbol.replace('/USDT:USDT', ''))
  ])].sort();

  console.log('\n' + '='.repeat(100));
  console.log('TRADE BY TRADE COMPARISON');
  console.log('='.repeat(100));

  for (const symbol of symbols) {
    const btTrades = backtestTrades.filter(t => t.symbol === symbol);
    const liveTrs = liveTrades.filter(t => t.symbol.includes(symbol));

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`${symbol} - Backtest: ${btTrades.length} trades | Live: ${liveTrs.length} trades`);
    console.log(`${'─'.repeat(80)}`);

    // Show backtest trades
    console.log('\n  BACKTEST:');
    for (const t of btTrades) {
      const entryTime = new Date(t.entry);
      console.log(`    ${entryTime.toLocaleString().padEnd(22)} | ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2).padStart(6)}% | ${t.reason}`);
    }

    // Show live trades
    console.log('\n  LIVE:');
    for (const t of liveTrs) {
      console.log(`    ${t.entryTs.toLocaleString().padEnd(22)} | ${(t.pctChange ?? 0) >= 0 ? '+' : ''}${(t.pctChange ?? 0).toFixed(2).padStart(6)}% | ${t.exitReason}`);
    }

    // Analyze differences
    if (btTrades.length !== liveTrs.length) {
      console.log(`\n  ⚠️  COUNT MISMATCH: Backtest ${btTrades.length} vs Live ${liveTrs.length}`);
    }
  }

  // Check for trades that exist only in one
  console.log('\n' + '='.repeat(100));
  console.log('TRADES ONLY IN BACKTEST (not in Live):');
  console.log('='.repeat(100));

  for (const bt of backtestTrades) {
    const btTime = new Date(bt.entry);
    // Find matching live trade (same symbol, within 30 min)
    const matchingLive = liveTrades.find(live => {
      const liveSymbol = live.symbol.replace('/USDT:USDT', '');
      const timeDiff = Math.abs(live.entryTs.getTime() - btTime.getTime());
      return liveSymbol === bt.symbol && timeDiff < 60 * 60 * 1000; // 1 hour window
    });

    if (!matchingLive) {
      console.log(`  ${bt.symbol.padEnd(5)} @ ${btTime.toLocaleString()} | ${bt.pnl >= 0 ? '+' : ''}${bt.pnl.toFixed(2)}% | ${bt.reason}`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('TRADES ONLY IN LIVE (not in Backtest):');
  console.log('='.repeat(100));

  for (const live of liveTrades) {
    const liveSymbol = live.symbol.replace('/USDT:USDT', '');
    // Find matching backtest trade
    const matchingBt = backtestTrades.find(bt => {
      const btTime = new Date(bt.entry);
      const timeDiff = Math.abs(live.entryTs.getTime() - btTime.getTime());
      return bt.symbol === liveSymbol && timeDiff < 60 * 60 * 1000;
    });

    if (!matchingBt) {
      console.log(`  ${liveSymbol.padEnd(5)} @ ${live.entryTs.toLocaleString()} | ${(live.pctChange ?? 0) >= 0 ? '+' : ''}${(live.pctChange ?? 0).toFixed(2)}% | ${live.exitReason}`);
    }
  }

  // Analyze the DOGE case specifically
  console.log('\n' + '='.repeat(100));
  console.log('DOGE ANALYSIS:');
  console.log('='.repeat(100));

  const dogeBt = backtestTrades.filter(t => t.symbol === 'DOGE');
  const dogeLive = liveTrades.filter(t => t.symbol.includes('DOGE'));

  console.log('\nBacktest DOGE trades:');
  for (const t of dogeBt) {
    console.log(`  Entry: ${new Date(t.entry).toLocaleString()} | PnL: ${t.pnl.toFixed(2)}% | ${t.reason}`);
  }

  console.log('\nLive DOGE trades:');
  for (const t of dogeLive) {
    console.log(`  Entry: ${t.entryTs.toLocaleString()} | PnL: ${(t.pctChange ?? 0).toFixed(2)}% | ${t.exitReason}`);
  }

  // Check what positions were open at backtest DOGE entry times
  console.log('\n' + '='.repeat(100));
  console.log('WHAT POSITIONS WERE OPEN IN LIVE WHEN BACKTEST ENTERED DOGE?');
  console.log('='.repeat(100));

  for (const bt of dogeBt) {
    const btTime = new Date(bt.entry);
    console.log(`\nAt ${btTime.toLocaleString()} (Backtest DOGE entry +${bt.pnl.toFixed(2)}%):`);

    // Find live trades that were open at this time
    const openAtTime = liveTrades.filter(t => {
      return t.entryTs <= btTime && t.exitTs > btTime;
    });

    if (openAtTime.length === 0) {
      console.log('  No positions were open in Live at this time');
      console.log('  ⚠️  WHY DIDNT LIVE ENTER?');
    } else {
      console.log(`  Open positions in Live: ${openAtTime.length}`);
      for (const t of openAtTime) {
        const symbol = t.symbol.replace('/USDT:USDT', '');
        console.log(`    - ${symbol}: entry ${t.entryTs.toLocaleString()} → exit ${t.exitTs.toLocaleString()}`);
      }
      if (openAtTime.length >= 2) {
        console.log('  → MAX POSITIONS (2) reached - DOGE could not enter');
      }
    }
  }

  // Also check first live trade time vs first backtest trade time
  console.log('\n' + '='.repeat(100));
  console.log('TIMING ANALYSIS:');
  console.log('='.repeat(100));

  const firstBt = backtestTrades.sort((a, b) => new Date(a.entry).getTime() - new Date(b.entry).getTime())[0];
  const firstLive = liveTrades[0];

  console.log(`\nFirst Backtest trade: ${new Date(firstBt.entry).toLocaleString()} (${firstBt.symbol})`);
  console.log(`First Live trade: ${firstLive.entryTs.toLocaleString()} (${firstLive.symbol.replace('/USDT:USDT', '')})`);

  const timeDiffHours = (firstLive.entryTs.getTime() - new Date(firstBt.entry).getTime()) / (1000 * 60 * 60);
  console.log(`\nLive started ${timeDiffHours.toFixed(1)} hours ${timeDiffHours > 0 ? 'AFTER' : 'BEFORE'} backtest`);

  if (timeDiffHours > 0) {
    console.log('\n⚠️  Live trading started LATER than backtest!');
    console.log('   This means some early backtest trades were missed in Live.');
  }

  await prisma.$disconnect();
}

compareTradesDetail().catch(console.error);
