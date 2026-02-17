/**
 * V5.101: Quick parity test — runs verifyTradeV2 on recent trades
 * Usage: DATABASE_URL=... npx tsx scripts/run-parity-v2-test.ts
 */

import { PrismaClient } from '@prisma/client';
import { verifyTradeV2 } from '../src/services/parityVerificationServiceV2.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';

async function main() {
  const prisma = new PrismaClient();

  // Get recent trades
  const trades = await prisma.trade.findMany({
    orderBy: { exitTs: 'desc' },
    take: 20,
    select: {
      id: true, symbol: true, positionSide: true,
      entryTs: true, exitTs: true, exitReason: true,
      roiPct: true, leverage: true, durationMinutes: true,
    },
  });

  // Deduplicate: one trade per symbol+side+entryCandle (15m bucket)
  const seen = new Set<string>();
  const unique = trades.filter(t => {
    const bucket = Math.floor(t.entryTs.getTime() / (15 * 60 * 1000));
    const key = `${t.symbol}|${t.positionSide}|${bucket}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`=== Running V5.101 parity on ${unique.length} trades ===\n`);

  await preloadMarkets();

  for (const trade of unique) {
    console.log('─'.repeat(70));
    console.log(`Trade: ${trade.symbol} ${trade.positionSide}`);
    console.log(`  Entry: ${trade.entryTs.toISOString()} | Exit: ${trade.exitTs.toISOString()}`);
    console.log(`  Live: reason=${trade.exitReason} roi=${(trade.roiPct ?? 0).toFixed(2)}% duration=${trade.durationMinutes}min`);

    try {
      const result = await verifyTradeV2(trade.id);
      console.log(`  Category: ${result.comparison.category}`);
      console.log(`  Signal: enter=${result.signalCheck.wouldBacktestEnter} | ${result.signalCheck.signalReason}`);
      if (result.exitSimulation) {
        console.log(`  BT exit: reason=${result.exitSimulation.exitReason} pnl=${result.exitSimulation.pnlPct.toFixed(2)}% duration=${result.exitSimulation.durationMin}min`);
      }
      console.log(`  Details: ${result.comparison.details}`);
      console.log(`  Time: ${result.verificationTimeMs}ms`);
    } catch (err: any) {
      console.error(`  ERROR: ${err.message}`);
    }
    console.log('');
  }

  await (prisma as any).$disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
