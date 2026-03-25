/**
 * Raw XRP trade data check
 */
import { prisma } from '../src/db/client.js';

async function analyze() {
  const xrpTrades = await prisma.trade.findMany({
    where: {
      symbol: { contains: 'XRP' },
      entryTs: { gte: new Date('2026-02-04T00:00:00Z') }
    },
    orderBy: { entryTs: 'asc' },
    include: { session: true }
  });

  for (const t of xrpTrades) {
    const mode = t.session?.mode || 'unknown';

    console.log(`\n=== ${mode.toUpperCase()} XRP ===`);
    console.log(`Raw data:`);
    console.log(`  roiPct: ${t.roiPct}`);
    console.log(`  leverage: ${t.leverage}`);
    console.log(`  maxPnlPct: ${t.maxPnlPct}`);
    console.log(`  entryPrice: ${t.entryPrice}`);
    console.log(`  exitPrice: ${t.exitPrice}`);
    console.log(`  positionSide: ${t.positionSide}`);
    console.log(`  exitReason: ${t.exitReason}`);

    // Manual calculation
    const exitPx = t.exitPrice || 0;
    const entryPx = t.entryPrice;

    let rawPnlPct: number;
    if (t.positionSide === 'short') {
      rawPnlPct = (entryPx - exitPx) / entryPx * 100;
    } else {
      rawPnlPct = (exitPx - entryPx) / entryPx * 100;
    }

    console.log(`\nCalculations:`);
    console.log(`  Raw PnL (no leverage): ${rawPnlPct.toFixed(4)}%`);
    console.log(`  With leverage (${t.leverage}x): ${(rawPnlPct * (t.leverage || 1)).toFixed(4)}%`);
    console.log(`  roiPct * leverage * 100: ${((t.roiPct || 0) * (t.leverage || 1) * 100).toFixed(4)}%`);

    // What was max PnL in USD terms
    const maxPnlPct = (t.maxPnlPct || 0) * 100; // This is unleveraged
    console.log(`  Max PnL (unleveraged): ${maxPnlPct.toFixed(4)}%`);
    console.log(`  Max PnL (with leverage): ${(maxPnlPct * (t.leverage || 1)).toFixed(4)}%`);
  }
}

analyze().catch(console.error);
