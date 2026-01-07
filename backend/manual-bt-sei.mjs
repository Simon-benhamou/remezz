/**
 * Manual backtest verification for SEI trade
 */

import { runBacktest } from './dist/src/services/backtestService.js';

async function main() {
  console.log('='.repeat(80));
  console.log('🔬 MANUAL BACKTEST: SEI');
  console.log('='.repeat(80));
  
  // SEI trade: Entry 14:30, Exit 16:45 live
  const startDate = new Date('2026-01-07T12:00:00.000Z');
  const endDate = new Date('2026-01-07T18:00:00.000Z');
  
  const result = await runBacktest({
    startDate,
    endDate,
    symbols: ['SEI/USDT:USDT'],
    initialCapital: 1000,
    leverage: 5,
  });
  
  console.log(`\nBacktest trades: ${result.trades.length}`);
  
  for (const trade of result.trades) {
    console.log(`\n${trade.symbol} | ${trade.side.toUpperCase()}`);
    console.log(`  Entry:  ${trade.entryTime}`);
    console.log(`  Exit:   ${trade.exitTime}`);
    console.log(`  Reason: ${trade.exitReason}`);
    console.log(`  PnL:    ${trade.netPnlPct.toFixed(3)}%`);
    
    const entryTs = new Date(trade.entryTime).getTime();
    const exitTs = new Date(trade.exitTime).getTime();
    const holdMin = Math.round((exitTs - entryTs) / 60000);
    console.log(`  Hold:   ${holdMin}m (${(holdMin/15).toFixed(1)} bars)`);
  }
  
  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
