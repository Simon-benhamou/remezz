import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function analyzeTrades() {
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  twoDaysAgo.setHours(0, 0, 0, 0);

  console.log('='.repeat(100));
  console.log('DEEP ANALYSIS: PAPER vs LIVE TRADES');
  console.log('Period:', twoDaysAgo.toISOString(), 'to now');
  console.log('='.repeat(100));

  // Get all trades with session info
  const allTrades = await prisma.trade.findMany({
    where: {
      entryTs: { gte: twoDaysAgo }
    },
    include: {
      session: true
    },
    orderBy: { entryTs: 'asc' }
  });

  const paperTrades = allTrades.filter(t => t.session?.mode === 'paper');
  const liveTrades = allTrades.filter(t => t.session?.mode === 'live');

  console.log(`\nTotal trades found: ${allTrades.length}`);
  console.log(`Paper trades: ${paperTrades.length}`);
  console.log(`Live trades: ${liveTrades.length}`);

  // Group by symbol to compare
  const symbols = [...new Set(allTrades.map(t => t.symbol))];

  console.log('\n' + '='.repeat(100));
  console.log('SYMBOL BY SYMBOL COMPARISON (30 min matching window)');
  console.log('='.repeat(100));

  const allDifferences = [];

  for (const symbol of symbols) {
    const symbolPaper = paperTrades.filter(t => t.symbol === symbol);
    const symbolLive = liveTrades.filter(t => t.symbol === symbol);

    console.log(`\n${'─'.repeat(80)}`);
    console.log(`${symbol} - Paper: ${symbolPaper.length} trades | Live: ${symbolLive.length} trades`);
    console.log(`${'─'.repeat(80)}`);

    // Try to match trades with 30 min window
    const usedLiveIds = new Set();

    for (const paper of symbolPaper) {
      const matchingLive = symbolLive.find(live => {
        if (usedLiveIds.has(live.id)) return false;
        const timeDiff = Math.abs(new Date(live.entryTs).getTime() - new Date(paper.entryTs).getTime());
        return timeDiff < 30 * 60 * 1000; // 30 minutes
      });

      if (matchingLive) {
        usedLiveIds.add(matchingLive.id);

        const entryTimeDiffSec = (new Date(matchingLive.entryTs).getTime() - new Date(paper.entryTs).getTime()) / 1000;
        const exitTimeDiffSec = (new Date(matchingLive.exitTs).getTime() - new Date(paper.exitTs).getTime()) / 1000;
        const entryPriceDiff = ((matchingLive.entryPrice - paper.entryPrice) / paper.entryPrice * 100);
        const exitPriceDiff = ((matchingLive.exitPrice - paper.exitPrice) / paper.exitPrice * 100);
        const exitReasonMatch = paper.exitReason === matchingLive.exitReason;

        const diff = {
          symbol,
          paperEntry: paper.entryTs,
          liveEntry: matchingLive.entryTs,
          entryTimeDiffSec,
          paperExit: paper.exitTs,
          liveExit: matchingLive.exitTs,
          exitTimeDiffSec,
          paperEntryPrice: paper.entryPrice,
          liveEntryPrice: matchingLive.entryPrice,
          entryPriceDiff,
          paperExitPrice: paper.exitPrice,
          liveExitPrice: matchingLive.exitPrice,
          exitPriceDiff,
          paperExitReason: paper.exitReason,
          liveExitReason: matchingLive.exitReason,
          exitReasonMatch,
          paperPnl: paper.pctChange,
          livePnl: matchingLive.pctChange,
          paperId: paper.id,
          liveId: matchingLive.id
        };

        allDifferences.push(diff);

        console.log(`\n  📊 MATCHED TRADE:`);
        console.log(`     Entry: Paper ${new Date(paper.entryTs).toLocaleTimeString()} | Live ${new Date(matchingLive.entryTs).toLocaleTimeString()} (${entryTimeDiffSec > 0 ? '+' : ''}${entryTimeDiffSec.toFixed(0)}s)`);
        console.log(`     Exit:  Paper ${new Date(paper.exitTs).toLocaleTimeString()} | Live ${new Date(matchingLive.exitTs).toLocaleTimeString()} (${exitTimeDiffSec > 0 ? '+' : ''}${exitTimeDiffSec.toFixed(0)}s = ${(exitTimeDiffSec/60).toFixed(1)}min)`);
        console.log(`     Entry Price: Paper $${paper.entryPrice.toFixed(4)} | Live $${matchingLive.entryPrice.toFixed(4)} (${entryPriceDiff > 0 ? '+' : ''}${entryPriceDiff.toFixed(4)}%)`);
        console.log(`     Exit Price:  Paper $${paper.exitPrice.toFixed(4)} | Live $${matchingLive.exitPrice.toFixed(4)} (${exitPriceDiff > 0 ? '+' : ''}${exitPriceDiff.toFixed(4)}%)`);
        console.log(`     Exit Reason: Paper "${paper.exitReason}" | Live "${matchingLive.exitReason}" ${exitReasonMatch ? '✅' : '❌ DIFFERENT'}`);
        console.log(`     PnL: Paper ${paper.pctChange?.toFixed(2)}% | Live ${matchingLive.pctChange?.toFixed(2)}%`);
      } else {
        console.log(`\n  ⚠️  PAPER ONLY: Entry ${new Date(paper.entryTs).toLocaleTimeString()} | Exit "${paper.exitReason}" | PnL ${paper.pctChange?.toFixed(2)}%`);
      }
    }

    // Check for unmatched live trades
    for (const live of symbolLive) {
      if (!usedLiveIds.has(live.id)) {
        console.log(`\n  ⚠️  LIVE ONLY: Entry ${new Date(live.entryTs).toLocaleTimeString()} | Exit "${live.exitReason}" | PnL ${live.pctChange?.toFixed(2)}%`);
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(100));
  console.log('SUMMARY OF MATCHED TRADES');
  console.log('='.repeat(100));

  const matched = allDifferences.length;
  const exitReasonMismatches = allDifferences.filter(d => !d.exitReasonMatch);
  const significantTimeDiffs = allDifferences.filter(d => Math.abs(d.exitTimeDiffSec) > 60);

  console.log(`\nMatched trades: ${matched}`);
  console.log(`Exit reason mismatches: ${exitReasonMismatches.length}`);
  console.log(`Significant exit time differences (>1min): ${significantTimeDiffs.length}`);

  if (exitReasonMismatches.length > 0) {
    console.log('\n' + '─'.repeat(80));
    console.log('🔴 EXIT REASON MISMATCHES:');
    console.log('─'.repeat(80));
    for (const d of exitReasonMismatches) {
      console.log(`\n  ${d.symbol}`);
      console.log(`    Paper: ${new Date(d.paperEntry).toLocaleString()} → "${d.paperExitReason}" (PnL: ${d.paperPnl?.toFixed(2)}%)`);
      console.log(`    Live:  ${new Date(d.liveEntry).toLocaleString()} → "${d.liveExitReason}" (PnL: ${d.livePnl?.toFixed(2)}%)`);
      console.log(`    Entry time diff: ${d.entryTimeDiffSec}s | Exit time diff: ${(d.exitTimeDiffSec/60).toFixed(1)}min`);
    }
  }

  // Analyze patterns in exit time differences
  console.log('\n' + '='.repeat(100));
  console.log('ENTRY TIME PATTERN ANALYSIS');
  console.log('='.repeat(100));

  const entryDiffs = allDifferences.map(d => d.entryTimeDiffSec);
  const avgEntryDiff = entryDiffs.reduce((a,b) => a+b, 0) / entryDiffs.length;

  console.log(`\nEntry time differences (Live - Paper):`);
  console.log(`  Average: ${avgEntryDiff.toFixed(0)}s`);
  console.log(`  Min: ${Math.min(...entryDiffs).toFixed(0)}s`);
  console.log(`  Max: ${Math.max(...entryDiffs).toFixed(0)}s`);

  const exitDiffs = allDifferences.map(d => d.exitTimeDiffSec);
  const avgExitDiff = exitDiffs.reduce((a,b) => a+b, 0) / exitDiffs.length;

  console.log(`\nExit time differences (Live - Paper):`);
  console.log(`  Average: ${(avgExitDiff/60).toFixed(1)}min`);
  console.log(`  Min: ${(Math.min(...exitDiffs)/60).toFixed(1)}min`);
  console.log(`  Max: ${(Math.max(...exitDiffs)/60).toFixed(1)}min`);

  // Look at paper entry times - are they always on 15-min boundaries?
  console.log('\n' + '='.repeat(100));
  console.log('PAPER ENTRY TIME PATTERN (are they on candle boundaries?)');
  console.log('='.repeat(100));

  for (const d of allDifferences.slice(0, 10)) {
    const paperTime = new Date(d.paperEntry);
    const paperMin = paperTime.getMinutes();
    const paperSec = paperTime.getSeconds();
    const liveTime = new Date(d.liveEntry);
    const liveMin = liveTime.getMinutes();
    const liveSec = liveTime.getSeconds();
    console.log(`  Paper: ${paperTime.toLocaleTimeString()} (min:${paperMin}, sec:${paperSec}) | Live: ${liveTime.toLocaleTimeString()} (min:${liveMin}, sec:${liveSec})`);
  }

  // Check for real-time exit differences
  console.log('\n' + '='.repeat(100));
  console.log('REAL-TIME EXIT ANALYSIS (TRAILING_RT, STOPLOSS_RT)');
  console.log('='.repeat(100));

  const rtExits = liveTrades.filter(t => t.exitReason?.includes('_RT'));
  console.log(`\nLive trades with real-time exit: ${rtExits.length}`);
  for (const t of rtExits) {
    console.log(`  ${t.symbol} @ ${new Date(t.entryTs).toLocaleTimeString()} → "${t.exitReason}" (PnL: ${t.pctChange?.toFixed(2)}%)`);

    // Find corresponding paper trade
    const matchingPaper = paperTrades.find(p => {
      const timeDiff = Math.abs(new Date(p.entryTs).getTime() - new Date(t.entryTs).getTime());
      return p.symbol === t.symbol && timeDiff < 30 * 60 * 1000;
    });
    if (matchingPaper) {
      console.log(`    Paper equivalent: "${matchingPaper.exitReason}" (PnL: ${matchingPaper.pctChange?.toFixed(2)}%)`);
    }
  }

  // Look for systematic patterns
  console.log('\n' + '='.repeat(100));
  console.log('POTENTIAL CAUSES ANALYSIS');
  console.log('='.repeat(100));

  // Check if paper always uses :00, :15, :30, :45 (candle boundaries)
  const paperOnBoundary = paperTrades.filter(t => {
    const min = new Date(t.entryTs).getMinutes();
    return min % 15 === 0;
  });

  const liveOnBoundary = liveTrades.filter(t => {
    const min = new Date(t.entryTs).getMinutes();
    return min % 15 === 0;
  });

  console.log(`\nPaper trades on 15-min boundary: ${paperOnBoundary.length}/${paperTrades.length} (${(paperOnBoundary.length/paperTrades.length*100).toFixed(0)}%)`);
  console.log(`Live trades on 15-min boundary: ${liveOnBoundary.length}/${liveTrades.length} (${(liveOnBoundary.length/liveTrades.length*100).toFixed(0)}%)`);

  // Check seconds - paper should be :00
  const paperZeroSec = paperTrades.filter(t => new Date(t.entryTs).getSeconds() === 0);
  const liveZeroSec = liveTrades.filter(t => new Date(t.entryTs).getSeconds() === 0);

  console.log(`\nPaper trades with :00 seconds: ${paperZeroSec.length}/${paperTrades.length}`);
  console.log(`Live trades with :00 seconds: ${liveZeroSec.length}/${liveTrades.length}`);

  await prisma.$disconnect();
}

analyzeTrades().catch(console.error);
