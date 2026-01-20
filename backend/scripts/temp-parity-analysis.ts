import { prisma } from '../src/db/client.js';

async function analyzeSpecificTrade() {
  // Get the SUI trade from 2026-01-18
  const trade = await prisma.trade.findFirst({
    where: {
      symbol: 'SUI/USDT:USDT',
      entryTs: { gte: new Date('2026-01-18T23:00:00Z'), lte: new Date('2026-01-19T00:00:00Z') }
    },
    orderBy: { entryTs: 'desc' }
  });

  if (trade) {
    console.log('=== SUI SHORT TRADE ANALYSIS ===');
    console.log('Trade ID:', trade.id);
    console.log('Entry:', trade.entryTs.toISOString(), '@ $' + trade.entryPrice);
    console.log('Exit:', trade.exitTs.toISOString(), '@ $' + trade.exitPrice);
    console.log('Exit Reason:', trade.exitReason);
    console.log('ROI:', trade.roiPct?.toFixed(2) + '%');
    console.log('Duration:', trade.durationMinutes, 'minutes');

    // Get parity result
    const parity = await prisma.tradeParityResult.findUnique({
      where: { tradeId: trade.id }
    });

    if (parity) {
      console.log('');
      console.log('=== PARITY COMPARISON ===');
      console.log('BT Exit:', parity.btExitTs?.toISOString(), '| Reason:', parity.btExitReason);
      console.log('Live PnL:', parity.livePnlPct?.toFixed(2) + '%');
      console.log('BT PnL:', parity.btPnlPct?.toFixed(2) + '%');
      console.log('Exit timing diff:', ((parity.liveExitTs.getTime() - (parity.btExitTs?.getTime() || 0)) / 60000).toFixed(1), 'minutes');
    }
  }
  console.log('\n');
}

async function analyze() {
  await analyzeSpecificTrade();
  // Get last 7 days of parity results
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const results = await prisma.tradeParityResult.findMany({
    where: {
      verifiedAt: { gte: sevenDaysAgo }
    },
    orderBy: { verifiedAt: 'desc' }
  });

  console.log('=== PARITY RESULTS (Last 7 days) ===\n');
  console.log('Total trades:', results.length);
  console.log('Matched:', results.filter(r => r.overallMatch).length);
  console.log('Mismatched:', results.filter(r => r.overallMatch === false).length);

  console.log('\n=== DETAILED MISMATCHES ===\n');

  for (const r of results.filter(r => r.overallMatch === false)) {
    const trade = await prisma.trade.findUnique({ where: { id: r.tradeId } });
    if (!trade) continue;

    const pnlDiff = Math.abs((r.livePnlPct || 0) - (r.btPnlPct || 0));

    console.log('----------------------------------------');
    console.log(`${r.symbol} | ${r.side.toUpperCase()}`);
    console.log(`  Entry:      ${r.liveEntryTs.toISOString()}`);
    console.log(`  Live Exit:  ${r.liveExitTs.toISOString()} | Reason: ${r.liveExitReason}`);
    console.log(`  BT Exit:    ${r.btExitTs?.toISOString() || 'N/A'} | Reason: ${r.btExitReason}`);
    console.log(`  Live PnL:   ${r.livePnlPct?.toFixed(2)}%`);
    console.log(`  BT PnL:     ${r.btPnlPct?.toFixed(2)}%`);
    console.log(`  PnL Diff:   ${pnlDiff.toFixed(2)}%`);
    console.log(`  Entry Match: ${r.entryMatch ? '✅' : '❌'}`);
    console.log(`  Exit Match:  ${r.exitMatch ? '✅' : '❌'}`);
    console.log(`  PnL Match:   ${r.pnlMatch ? '✅' : '❌'}`);

    // Also show trade details
    console.log(`  Trade Entry: ${trade.entryPrice} | Exit: ${trade.exitPrice}`);
    console.log(`  Trade ROI:   ${trade.roiPct?.toFixed(2)}% | Realized: $${trade.realizedPnlUsd.toFixed(2)}`);

    if (r.mismatchDetails) {
      try {
        const details = JSON.parse(r.mismatchDetails);
        console.log(`  Category:   ${details.category}`);
        if (details.signalCheck) {
          console.log(`  Would BT Enter: ${details.signalCheck.wouldBacktestEnter ? '✅' : '❌'}`);
        }
      } catch {}
    }
  }

  // Check for exit timestamp differences
  console.log('\n=== EXIT TIMING ANALYSIS ===\n');

  for (const r of results.filter(r => r.overallMatch === false && r.btExitTs)) {
    const exitDiffMs = Math.abs(r.liveExitTs.getTime() - (r.btExitTs?.getTime() || 0));
    const exitDiffMin = exitDiffMs / 60000;

    if (exitDiffMin > 1) {
      console.log(`${r.symbol}: Exit diff = ${exitDiffMin.toFixed(1)} minutes | Live=${r.liveExitReason} BT=${r.btExitReason}`);
    }
  }

  // Check PnL calculation differences
  console.log('\n=== PNL CALCULATION CHECK ===\n');

  for (const r of results.filter(r => r.overallMatch === false).slice(0, 5)) {
    const trade = await prisma.trade.findUnique({ where: { id: r.tradeId } });
    if (!trade) continue;

    // Calculate expected PnL from prices
    const priceChange = trade.positionSide === 'LONG'
      ? (trade.exitPrice - trade.entryPrice) / trade.entryPrice
      : (trade.entryPrice - trade.exitPrice) / trade.entryPrice;

    const expectedPnlPct = priceChange * 100 * 5; // Assuming 5x leverage

    console.log(`${r.symbol}:`);
    console.log(`  Entry: $${trade.entryPrice} | Exit: $${trade.exitPrice}`);
    console.log(`  Price change: ${(priceChange * 100).toFixed(3)}%`);
    console.log(`  Expected PnL (5x): ${expectedPnlPct.toFixed(2)}%`);
    console.log(`  Actual Live PnL:   ${r.livePnlPct?.toFixed(2)}%`);
    console.log(`  Actual BT PnL:     ${r.btPnlPct?.toFixed(2)}%`);
    console.log('');
  }

  await prisma.$disconnect();
}

analyze().catch(console.error);
