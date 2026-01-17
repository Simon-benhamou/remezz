/**
 * Test Parity V2
 * ==============
 * Test the redesigned parity verification system.
 */

import { verifyTradeV2, verifyAllTradesV2, type ParityCategory } from '../src/services/parityVerificationServiceV2.js';
import { prisma } from '../src/db/client.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('PARITY V2 TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Get ALL trades
  const trades = await prisma.trade.findMany({
    orderBy: { exitTs: 'desc' },
  });

  console.log(`Found ${trades.length} recent trades to verify\n`);

  const results: { trade: string; category: ParityCategory; details: string }[] = [];

  for (const trade of trades) {
    console.log(`\n─────────────────────────────────────────────────────────────────`);
    console.log(`Verifying: ${trade.symbol} ${trade.positionSide}`);
    console.log(`  Entry: ${trade.entryTs.toISOString()}`);
    console.log(`  Exit:  ${trade.exitTs.toISOString()} (${trade.exitReason})`);
    console.log(`  PnL:   ${((trade.roiPct || 0) * (trade.leverage || 5)).toFixed(2)}%`);

    try {
      const result = await verifyTradeV2(trade.id);

      console.log(`\n  Signal Check:`);
      console.log(`    Would BT enter: ${result.signalCheck.wouldBacktestEnter}`);
      console.log(`    Reason: ${result.signalCheck.signalReason}`);

      if (result.exitSimulation) {
        console.log(`\n  Exit Simulation:`);
        console.log(`    Exit reason: ${result.exitSimulation.exitReason}`);
        console.log(`    Exit price:  $${result.exitSimulation.exitPrice.toFixed(4)}`);
        console.log(`    PnL:         ${result.exitSimulation.pnlPct.toFixed(2)}%`);
      }

      console.log(`\n  Result: ${result.comparison.category}`);
      console.log(`    ${result.comparison.details}`);
      console.log(`    Time: ${result.verificationTimeMs}ms`);

      results.push({
        trade: `${trade.symbol} ${trade.positionSide}`,
        category: result.comparison.category,
        details: result.comparison.details,
      });
    } catch (e: any) {
      console.log(`  ❌ Error: ${e.message}`);
      results.push({
        trade: `${trade.symbol} ${trade.positionSide}`,
        category: 'DATA_ERROR',
        details: e.message,
      });
    }
  }

  // Summary
  console.log('\n\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const categoryCounts = results.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  for (const [cat, count] of Object.entries(categoryCounts)) {
    const pct = ((count / results.length) * 100).toFixed(1);
    const icon = cat === 'MATCH' ? '✅' : cat === 'NO_SIGNAL' ? '⚠️' : cat === 'PNL_VARIANCE' ? '📊' : '❌';
    console.log(`${icon} ${cat.padEnd(15)} ${count.toString().padStart(3)} (${pct}%)`);
  }

  // Show mismatches
  const mismatches = results.filter(r => r.category === 'EXIT_MISMATCH');
  if (mismatches.length > 0) {
    console.log('\n❌ EXIT MISMATCHES (Bugs to investigate):');
    for (const m of mismatches) {
      console.log(`  - ${m.trade}: ${m.details}`);
    }
  }

  const noSignals = results.filter(r => r.category === 'NO_SIGNAL');
  if (noSignals.length > 0) {
    console.log('\n⚠️ NO SIGNAL (Live entered when BT wouldn\'t):');
    for (const m of noSignals) {
      console.log(`  - ${m.trade}: ${m.details}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);
