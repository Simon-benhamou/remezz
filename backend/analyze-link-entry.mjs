import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeEntry() {
  console.log('='.repeat(100));
  console.log('WHY DID LIVE ENTER 15 MIN LATER?');
  console.log('='.repeat(100));

  // Get the live session ID
  const liveTrade = await prisma.trade.findFirst({
    where: {
      symbol: 'LINK/USDT:USDT',
      entryTs: {
        gte: new Date('2026-01-05T20:00:00Z'),
        lte: new Date('2026-01-06T00:00:00Z')
      }
    },
    include: { session: true },
    orderBy: { entryTs: 'desc' }
  });

  if (!liveTrade) {
    console.log('No live trade found');
    return;
  }

  const liveSessionId = liveTrade.session?.mode === 'live' ? liveTrade.sessionId : null;

  // Check what positions were open in live at 20:30 (when paper entered)
  console.log('\n' + '─'.repeat(80));
  console.log('POSITIONS OPEN IN LIVE AT 20:30 (when paper entered LINK):');
  console.log('─'.repeat(80));

  // Get all live trades that were open at 20:30
  const paperEntryTime = new Date('2026-01-05T20:30:00Z');

  const openAtPaperEntry = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      entryTs: { lt: paperEntryTime },
      exitTs: { gt: paperEntryTime }
    },
    include: { session: true },
    orderBy: { entryTs: 'asc' }
  });

  console.log(`\nTrades open in LIVE at ${paperEntryTime.toISOString()}:`);
  if (openAtPaperEntry.length === 0) {
    console.log('  NONE - Live should have been able to enter!');
  } else {
    for (const t of openAtPaperEntry) {
      console.log(`  - ${t.symbol}: entry ${t.entryTs.toISOString()} → exit ${t.exitTs.toISOString()}`);
    }
    console.log(`\n  Total open positions: ${openAtPaperEntry.length}`);
    console.log('  If MAX_POSITIONS = 2, this might explain why LINK could not enter');
  }

  // Also check paper positions at 20:30
  console.log('\n' + '─'.repeat(80));
  console.log('POSITIONS OPEN IN PAPER AT 20:30:');
  console.log('─'.repeat(80));

  const openAtPaperEntryPaper = await prisma.trade.findMany({
    where: {
      session: { mode: 'paper' },
      entryTs: { lt: paperEntryTime },
      exitTs: { gt: paperEntryTime }
    },
    include: { session: true },
    orderBy: { entryTs: 'asc' }
  });

  console.log(`\nTrades open in PAPER at ${paperEntryTime.toISOString()}:`);
  if (openAtPaperEntryPaper.length === 0) {
    console.log('  NONE');
  } else {
    for (const t of openAtPaperEntryPaper) {
      console.log(`  - ${t.symbol}: entry ${t.entryTs.toISOString()} → exit ${t.exitTs.toISOString()}`);
    }
    console.log(`\n  Total open positions: ${openAtPaperEntryPaper.length}`);
  }

  // Check at 20:45 (when live entered)
  const liveEntryTime = new Date('2026-01-05T20:45:00Z');

  console.log('\n' + '─'.repeat(80));
  console.log('POSITIONS OPEN IN LIVE AT 20:45 (when live entered LINK):');
  console.log('─'.repeat(80));

  const openAtLiveEntry = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      entryTs: { lt: liveEntryTime },
      exitTs: { gt: liveEntryTime }
    },
    include: { session: true },
    orderBy: { entryTs: 'asc' }
  });

  console.log(`\nTrades open in LIVE at ${liveEntryTime.toISOString()}:`);
  if (openAtLiveEntry.length === 0) {
    console.log('  NONE');
  } else {
    for (const t of openAtLiveEntry) {
      console.log(`  - ${t.symbol}: entry ${t.entryTs.toISOString()} → exit ${t.exitTs.toISOString()}`);
    }
    console.log(`\n  Total open positions: ${openAtLiveEntry.length}`);
  }

  // Check what closed between 20:30 and 20:45 in live
  console.log('\n' + '─'.repeat(80));
  console.log('TRADES THAT CLOSED BETWEEN 20:30 AND 20:45 IN LIVE:');
  console.log('─'.repeat(80));

  const closedBetween = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      exitTs: {
        gte: paperEntryTime,
        lt: liveEntryTime
      }
    },
    include: { session: true },
    orderBy: { exitTs: 'asc' }
  });

  console.log(`\nTrades that exited in LIVE between 20:30 and 20:45:`);
  if (closedBetween.length === 0) {
    console.log('  NONE');
  } else {
    for (const t of closedBetween) {
      console.log(`  - ${t.symbol}: exited ${t.exitTs.toISOString()} (${t.exitReason}) PnL: ${t.pctChange?.toFixed(2)}%`);
    }
  }

  // Get all trades around this time to see the full picture
  console.log('\n' + '─'.repeat(80));
  console.log('ALL LIVE TRADES FROM 20:00 TO 21:00:');
  console.log('─'.repeat(80));

  const allLiveAround = await prisma.trade.findMany({
    where: {
      session: { mode: 'live' },
      OR: [
        {
          entryTs: {
            gte: new Date('2026-01-05T20:00:00Z'),
            lte: new Date('2026-01-05T21:00:00Z')
          }
        },
        {
          exitTs: {
            gte: new Date('2026-01-05T20:00:00Z'),
            lte: new Date('2026-01-05T21:00:00Z')
          }
        }
      ]
    },
    include: { session: true },
    orderBy: { entryTs: 'asc' }
  });

  for (const t of allLiveAround) {
    console.log(`\n  ${t.symbol}:`);
    console.log(`    Entry: ${t.entryTs.toISOString()} @ $${t.entryPrice}`);
    console.log(`    Exit:  ${t.exitTs.toISOString()} @ $${t.exitPrice}`);
    console.log(`    Reason: ${t.exitReason} | PnL: ${t.pctChange?.toFixed(2)}%`);
  }

  await prisma.$disconnect();
}

analyzeEntry().catch(console.error);
