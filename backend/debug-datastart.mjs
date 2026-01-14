/**
 * Debug: Voir les signaux AVAX détectés avec différentes configurations
 */

import { PrismaClient } from '@prisma/client';
import { runBacktest } from './dist/src/services/backtestService.js';

const prisma = new PrismaClient();

(async () => {
  try {
    const liveEntryTs = new Date('2025-12-23T15:00:00Z');
    const liveExitTs = new Date('2025-12-23T22:30:00Z');
    
    console.log('=== Test 1: Sans dataStartDate (old way) ===\n');
    
    // V5.47 avant: data loading ET simulation commencent 3 jours avant
    const oldStartDate = new Date(liveEntryTs.getTime() - 3 * 24 * 60 * 60 * 1000);
    const oldEndDate = new Date(liveExitTs.getTime() + 2 * 60 * 60 * 1000);
    
    console.log(`startDate: ${oldStartDate.toISOString()}`);
    console.log(`endDate: ${oldEndDate.toISOString()}\n`);
    
    const oldResult = await runBacktest({
      startDate: oldStartDate,
      endDate: oldEndDate,
      symbols: ['AVAXUSDT'],
      initialCapital: 1000,
      leverage: 5,
      parityMode: true,
    });
    
    console.log(`Total trades: ${oldResult.trades.length}`);
    oldResult.trades.forEach((trade, i) => {
      console.log(`Trade ${i + 1}: Entry ${trade.entryTime}, PnL: ${trade.pnlPct ? trade.pnlPct.toFixed(2) : 'N/A'}%`);
    });
    
    console.log('\n\n=== Test 2: Avec dataStartDate (new way) ===\n');
    
    const dataStartDate = new Date(liveEntryTs.getTime() - 3 * 24 * 60 * 60 * 1000);
    const btStartDate = new Date(liveEntryTs.getTime());
    const btEndDate = new Date(liveExitTs.getTime() + 2 * 60 * 60 * 1000);
    
    console.log(`dataStartDate: ${dataStartDate.toISOString()}`);
    console.log(`btStartDate: ${btStartDate.toISOString()}`);
    console.log(`btEndDate: ${btEndDate.toISOString()}\n`);
    
    const newResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      dataStartDate,
      symbols: ['AVAXUSDT'],
      initialCapital: 1000,
      leverage: 5,
      parityMode: true,
    });
    
    console.log(`Total trades: ${newResult.trades.length}`);
    newResult.trades.forEach((trade, i) => {
      console.log(`Trade ${i + 1}: Entry ${trade.entryTime}, PnL: ${trade.pnlPct ? trade.pnlPct.toFixed(2) : 'N/A'}%`);
    });
    
    console.log('\n\n=== Test 3: Start quelques heures AVANT 15:00 ===\n');
    
    const earlyStart = new Date(liveEntryTs.getTime() - 6 * 60 * 60 * 1000);  // 6h avant
    console.log(`dataStartDate: ${dataStartDate.toISOString()}`);
    console.log(`btStartDate: ${earlyStart.toISOString()}`);
    console.log(`btEndDate: ${btEndDate.toISOString()}\n`);
    
    const earlyResult = await runBacktest({
      startDate: earlyStart,
      endDate: btEndDate,
      dataStartDate,
      symbols: ['AVAXUSDT'],
      initialCapital: 1000,
      leverage: 5,
      parityMode: true,
    });
    
    console.log(`Total trades: ${earlyResult.trades.length}`);
    earlyResult.trades.forEach((trade, i) => {
      console.log(`Trade ${i + 1}: Entry ${trade.entryTime}, PnL: ${trade.pnlPct ? trade.pnlPct.toFixed(2) : 'N/A'}%`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
