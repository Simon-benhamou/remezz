/**
 * Test AVAX parity après les changements V5.47 avec dataStartDate
 */

import { PrismaClient } from '@prisma/client';
import { runBacktest } from './dist/src/services/backtestService.js';

const prisma = new PrismaClient();

(async () => {
  try {
    // Simuler un trade AVAX comme dans mes tests précédents
    // Entry: 2025-12-23 15:00 UTC
    const liveEntryTs = new Date('2025-12-23T15:00:00Z');
    const liveExitTs = new Date('2025-12-23T22:30:00Z');
    
    console.log('=== Testing AVAX Backtest with dataStartDate ===\n');
    console.log(`Live Entry: ${liveEntryTs.toISOString()}`);
    console.log(`Live Exit: ${liveExitTs.toISOString()}\n`);
    
    // V5.47: Use dataStartDate for warmup
    const dataStartDate = new Date(liveEntryTs.getTime() - 3 * 24 * 60 * 60 * 1000);
    const btStartDate = new Date(liveEntryTs.getTime());
    const btEndDate = new Date(liveExitTs.getTime() + 2 * 60 * 60 * 1000);
    
    console.log(`dataStartDate (warmup): ${dataStartDate.toISOString()}`);
    console.log(`btStartDate (sim start): ${btStartDate.toISOString()}`);
    console.log(`btEndDate: ${btEndDate.toISOString()}\n`);
    
    const btResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      dataStartDate,  // Load data from 3 days before for warmup
      symbols: ['AVAXUSDT'],
      initialCapital: 1000,
      leverage: 5,
      parityMode: true,  // Ignore position limits
    });
    
    console.log(`\n=== Backtest Results ===`);
    console.log(`Total trades: ${btResult.trades.length}`);
    
    if (btResult.trades.length === 0) {
      console.log('\n❌ NO TRADES FOUND - Fix did not work!');
      console.log('Expected: Trade entering at 15:00');
    } else {
      btResult.trades.forEach((trade, i) => {
        console.log(`\nTrade ${i + 1}:`);
        console.log(`  Symbol: ${trade.symbol}`);
        console.log(`  Entry: ${trade.entryTime}`);
        console.log(`  Exit: ${trade.exitTime}`);
        console.log(`  PnL: ${trade.pnlPct.toFixed(2)}%`);
        console.log(`  Exit Reason: ${trade.exitReason}`);
      });
      
      // Check if first trade matches live entry time
      const firstTrade = btResult.trades[0];
      const btEntryDate = new Date(firstTrade.entryTime);
      
      console.log(`\n=== Entry Timing Check ===`);
      console.log(`Live Entry: ${liveEntryTs.toISOString()}`);
      console.log(`BT Entry:   ${btEntryDate.toISOString()}`);
      
      if (Math.abs(btEntryDate.getTime() - liveEntryTs.getTime()) < 60000) {
        console.log('✅ ENTRY TIMES MATCH! Fix is working correctly.');
      } else {
        console.log('❌ ENTRY TIMES DO NOT MATCH! Fix did not work.');
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
})();
