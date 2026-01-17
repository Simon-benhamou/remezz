/**
 * Re-verify Parity for Mismatched Trades
 * =======================================
 * Re-runs parity verification for trades that had END mismatches.
 */

import { prisma } from '../src/db/client.js';
import { verifyTrade } from '../src/services/parityVerificationService.js';

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('RE-VERIFY PARITY FOR END MISMATCHES');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Find END mismatches
  const endMismatches = await prisma.tradeParityResult.findMany({
    where: {
      btExitReason: 'END',
    },
    orderBy: {
      verifiedAt: 'desc',
    },
  });

  console.log(`Found ${endMismatches.length} trades with END mismatch\n`);

  if (endMismatches.length === 0) {
    console.log('No END mismatches to re-verify');
    await prisma.$disconnect();
    return;
  }

  let improved = 0;
  let unchanged = 0;
  let failed = 0;

  for (const oldResult of endMismatches) {
    console.log(`\nRe-verifying ${oldResult.symbol} ${oldResult.side}...`);
    console.log(`  Entry: ${oldResult.liveEntryTs.toISOString()}`);
    console.log(`  Old result: BT=${oldResult.btExitReason}, match=${oldResult.overallMatch}`);

    try {
      // Delete old result
      await prisma.tradeParityResult.delete({
        where: { id: oldResult.id },
      });

      // Re-verify
      const newResult = await verifyTrade(oldResult.tradeId);

      const newMatch = newResult.overallMatch;
      const newBtReason = newResult.btExitReason ?? 'N/A';

      console.log(`  New result: BT=${newBtReason}, match=${newMatch}`);

      if (newMatch && !oldResult.overallMatch) {
        console.log(`  ✓ IMPROVED: Now matches!`);
        improved++;
      } else if (newBtReason !== 'END' && oldResult.btExitReason === 'END') {
        console.log(`  ✓ BETTER: Exit reason now ${newBtReason} (was END)`);
        improved++;
      } else {
        console.log(`  - Unchanged`);
        unchanged++;
      }
    } catch (e: any) {
      console.log(`  ✗ Error: ${e.message}`);
      failed++;
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════\n');

  console.log(`Improved: ${improved}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Failed: ${failed}`);

  // Show new overall stats
  const allResults = await prisma.tradeParityResult.findMany();
  const matched = allResults.filter(r => r.overallMatch).length;
  console.log(`\nNew match rate: ${matched}/${allResults.length} (${(matched/allResults.length*100).toFixed(1)}%)`);

  await prisma.$disconnect();
}

main().catch(console.error);
