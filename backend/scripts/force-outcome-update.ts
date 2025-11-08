/**
 * Force update of market outcomes for all pending evaluations
 * This script manually runs the outcome updater
 */

import { prisma, Prisma } from '../src/db/client.js';
import { updateTradeOutcome } from '../src/learning/tradeEvaluationLogger.js';
import { getOHLCV } from '../src/data/market.js';

type MarketOutcome = {
  pnl_15m?: number;
  pnl_1h?: number;
  max_favorable_excursion_1h?: number;
  max_adverse_excursion_1h?: number;
};

const OUTCOME_WINDOW_MINUTES = 70;

function calculateOutcome(
  entryPrice: number,
  prices: number[],
  timestamps: number[],
  evaluationTime: number,
): MarketOutcome {
  const outcome: MarketOutcome = {};
  const fifteenMinMark = evaluationTime + 15 * 60 * 1000;
  const oneHourMark = evaluationTime + 60 * 60 * 1000;

  let price15m: number | null = null;
  let price1h: number | null = null;
  let maxPrice = entryPrice;
  let minPrice = entryPrice;

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const price = prices[i];

    if (!price15m && ts >= fifteenMinMark) {
      price15m = price;
    }

    if (!price1h && ts >= oneHourMark) {
      price1h = price;
    }

    if (ts <= oneHourMark) {
      maxPrice = Math.max(maxPrice, price);
      minPrice = Math.min(minPrice, price);
    }
  }

  if (price15m) {
    outcome.pnl_15m = (price15m - entryPrice) / entryPrice;
  }

  if (price1h) {
    outcome.pnl_1h = (price1h - entryPrice) / entryPrice;
  }

  outcome.max_favorable_excursion_1h = (maxPrice - entryPrice) / entryPrice;
  outcome.max_adverse_excursion_1h = (minPrice - entryPrice) / entryPrice;

  return outcome;
}

async function main() {
  console.log('🔄 Force updating market outcomes for all evaluations...\n');

  try {
    // Get all evaluations with null outcomes that are at least 1 hour old
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    // Use Prisma API to find null JSON outcomes
    console.log('📊 Checking pending evaluations...');
    
    const pendingRaw = await prisma.tradeEvaluation.findMany({
      where: {
        marketOutcome: { equals: Prisma.JsonNull },
        timestamp: { lte: oneHourAgo }
      },
      select: {
        id: true,
        symbol: true,
        timestamp: true,
        decision: true
      },
      orderBy: { timestamp: 'asc' },
      take: 100
    });

    console.log(`Found ${pendingRaw.length} evaluations with NULL outcomes\n`);

    if (pendingRaw.length === 0) {
      console.log('✅ No pending evaluations found. All outcomes are up to date!');
      return;
    }

    let updated = 0;
    let failed = 0;
    let skipped = 0;

    for (const evaluation of pendingRaw) {
      try {
        const evalTime = evaluation.timestamp.getTime();
        const now = Date.now();

        // Skip if too recent (< 1 hour)
        if (now - evalTime < 60 * 60 * 1000) {
          skipped++;
          continue;
        }

        console.log(`Processing ${evaluation.symbol} from ${evaluation.timestamp}...`);

        // Fetch OHLCV data
        const candles = await getOHLCV(evaluation.symbol, '1m', OUTCOME_WINDOW_MINUTES);

        if (!candles || candles.length < 15) {
          console.warn(`  ⚠️  Insufficient data (${candles?.length || 0} candles)`);
          failed++;
          continue;
        }

        // Extract prices and timestamps
        const prices = candles.map((c) => c[4]); // close price
        const timestamps = candles.map((c) => c[0]); // timestamp
        const entryPrice = candles[0][4];

        // Calculate outcome
        const outcome = calculateOutcome(entryPrice, prices, timestamps, evalTime);

        // Update the evaluation
        const success = await updateTradeOutcome(evaluation.id, outcome);
        
        if (success) {
          console.log(`  ✅ Updated: pnl_15m=${(outcome.pnl_15m! * 100).toFixed(2)}%, pnl_1h=${(outcome.pnl_1h! * 100).toFixed(2)}%`);
          updated++;
        } else {
          console.log(`  ❌ Failed to update`);
          failed++;
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        console.error(`  ❌ Error processing ${evaluation.symbol}:`, error instanceof Error ? error.message : error);
        failed++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log(`  Total pending: ${pendingRaw.length}`);
    console.log(`  ✅ Updated: ${updated}`);
    console.log(`  ⏭️  Skipped (too recent): ${skipped}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log('');

    if (updated > 0) {
      console.log('✨ Market outcomes have been updated!');
      console.log('   You can now run the optimizer: npx tsx scripts/run-optimizer-manual.ts');
    }

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
