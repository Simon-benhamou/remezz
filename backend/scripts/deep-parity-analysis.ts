import { prisma } from '../src/db/client.js';

async function main() {
  console.log('='.repeat(80));
  console.log('DEEP PARITY ANALYSIS - SUI & DOGE 19/01');
  console.log('='.repeat(80));

  // Get all SUI and DOGE trades from Jan 18-19
  const trades = await prisma.trade.findMany({
    where: {
      symbol: { in: ['SUI/USDT:USDT', 'DOGE/USDT:USDT'] },
      entryTs: {
        gte: new Date('2026-01-18T20:00:00Z'),
        lte: new Date('2026-01-19T12:00:00Z')
      }
    },
    include: {
      session: {
        select: { id: true, mode: true }
      }
    },
    orderBy: [{ symbol: 'asc' }, { entryTs: 'asc' }]
  });

  console.log(`\nFound ${trades.length} trades\n`);

  // Group by symbol
  const bySymbol = new Map<string, typeof trades>();
  for (const t of trades) {
    const key = t.symbol;
    if (!bySymbol.has(key)) bySymbol.set(key, []);
    bySymbol.get(key)!.push(t);
  }

  for (const [symbol, symbolTrades] of bySymbol) {
    console.log('\n' + '='.repeat(80));
    console.log(`${symbol} - ${symbolTrades.length} trades`);
    console.log('='.repeat(80));

    // Separate live vs paper
    const liveTrades = symbolTrades.filter(t => t.session?.mode === 'live');
    const paperTrades = symbolTrades.filter(t => t.session?.mode === 'paper');

    console.log(`\nLIVE trades: ${liveTrades.length} | PAPER trades: ${paperTrades.length}`);

    // Analyze each trade
    for (const trade of symbolTrades) {
      const mode = trade.session?.mode || 'unknown';
      const modeIcon = mode === 'live' ? '🔴 LIVE' : '📝 PAPER';

      // Get parity result
      const parity = await prisma.tradeParityResult.findUnique({
        where: { tradeId: trade.id }
      });

      console.log('\n' + '-'.repeat(60));
      console.log(`${modeIcon} | ${trade.positionSide.toUpperCase()}`);
      console.log('-'.repeat(60));

      console.log(`Trade ID:     ${trade.id}`);
      console.log(`Session ID:   ${trade.session?.id}`);

      console.log('\n📥 ENTRY:');
      console.log(`  Timestamp:  ${trade.entryTs.toISOString()}`);
      console.log(`  Price:      $${trade.entryPrice.toFixed(6)}`);

      console.log('\n📤 EXIT:');
      console.log(`  Timestamp:  ${trade.exitTs.toISOString()}`);
      console.log(`  Price:      $${trade.exitPrice.toFixed(6)}`);
      console.log(`  Reason:     ${trade.exitReason}`);
      console.log(`  Duration:   ${trade.durationMinutes} min`);

      console.log('\n💰 PNL:');
      console.log(`  ROI:        ${trade.roiPct?.toFixed(4)}%`);
      console.log(`  Realized:   $${trade.realizedPnlUsd.toFixed(2)}`);
      console.log(`  Max PnL:    ${trade.maxPnlPct?.toFixed(2)}%`);

      if (parity) {
        const exitDiffMin = parity.btExitTs
          ? (trade.exitTs.getTime() - parity.btExitTs.getTime()) / 60000
          : null;

        console.log('\n🔬 PARITY (vs Backtest):');
        console.log(`  BT Exit Ts: ${parity.btExitTs?.toISOString() || 'N/A'}`);
        console.log(`  BT Reason:  ${parity.btExitReason}`);
        console.log(`  Live PnL:   ${parity.livePnlPct?.toFixed(2)}% (leveraged)`);
        console.log(`  BT PnL:     ${parity.btPnlPct?.toFixed(2)}% (leveraged)`);
        console.log(`  PnL Diff:   ${(Math.abs((parity.livePnlPct || 0) - (parity.btPnlPct || 0))).toFixed(2)}%`);
        console.log(`  Exit Δt:    ${exitDiffMin !== null ? exitDiffMin.toFixed(1) + ' min' : 'N/A'}`);
        console.log(`  Match:      ${parity.overallMatch ? '✅' : '❌'}`);

        if (parity.mismatchDetails) {
          try {
            const details = JSON.parse(parity.mismatchDetails);
            console.log(`  Category:   ${details.category}`);
          } catch {}
        }
      } else {
        console.log('\n🔬 PARITY: Not verified');
      }
    }

    // Compare live vs paper if both exist
    if (liveTrades.length > 0 && paperTrades.length > 0) {
      console.log('\n' + '='.repeat(60));
      console.log('📊 LIVE vs PAPER COMPARISON');
      console.log('='.repeat(60));

      for (let i = 0; i < Math.max(liveTrades.length, paperTrades.length); i++) {
        const live = liveTrades[i];
        const paper = paperTrades[i];

        if (live && paper) {
          const entryDiffMs = live.entryTs.getTime() - paper.entryTs.getTime();
          const exitDiffMs = live.exitTs.getTime() - paper.exitTs.getTime();
          const entryPriceDiff = ((live.entryPrice - paper.entryPrice) / paper.entryPrice) * 100;
          const exitPriceDiff = ((live.exitPrice - paper.exitPrice) / paper.exitPrice) * 100;
          const roiDiff = (live.roiPct || 0) - (paper.roiPct || 0);

          console.log(`\nPair ${i + 1}:`);
          console.log(`  Entry Time Diff:  ${(entryDiffMs / 1000).toFixed(1)}s (live ${entryDiffMs > 0 ? 'later' : 'earlier'})`);
          console.log(`  Entry Price Diff: ${entryPriceDiff.toFixed(4)}% (live ${entryPriceDiff > 0 ? 'higher' : 'lower'})`);
          console.log(`  Exit Time Diff:   ${(exitDiffMs / 1000).toFixed(1)}s (live ${exitDiffMs > 0 ? 'later' : 'earlier'})`);
          console.log(`  Exit Price Diff:  ${exitPriceDiff.toFixed(4)}% (live ${exitPriceDiff > 0 ? 'higher' : 'lower'})`);
          console.log(`  ROI Diff:         ${roiDiff.toFixed(4)}% (live ${roiDiff > 0 ? 'better' : 'worse'})`);
          console.log(`  Live ROI:         ${live.roiPct?.toFixed(4)}%`);
          console.log(`  Paper ROI:        ${paper.roiPct?.toFixed(4)}%`);
        }
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));

  const allLive = trades.filter(t => t.session?.mode === 'live');
  const allPaper = trades.filter(t => t.session?.mode === 'paper');

  const liveAvgRoi = allLive.reduce((sum, t) => sum + (t.roiPct || 0), 0) / (allLive.length || 1);
  const paperAvgRoi = allPaper.reduce((sum, t) => sum + (t.roiPct || 0), 0) / (allPaper.length || 1);

  console.log(`\nLive trades:  ${allLive.length} | Avg ROI: ${liveAvgRoi.toFixed(4)}%`);
  console.log(`Paper trades: ${allPaper.length} | Avg ROI: ${paperAvgRoi.toFixed(4)}%`);
  console.log(`Difference:   ${(paperAvgRoi - liveAvgRoi).toFixed(4)}% (paper ${paperAvgRoi > liveAvgRoi ? 'better' : 'worse'})`);

  await prisma.$disconnect();
}

main().catch(console.error);
