/**
 * test-refactor-parity.ts
 * 
 * Run this script BEFORE and AFTER refactoring backtestService.ts
 * to verify that the exit logic produces identical results.
 * 
 * Usage:
 *   npx ts-node scripts/test-refactor-parity.ts > before.txt
 *   # ... do refactoring ...
 *   npx ts-node scripts/test-refactor-parity.ts > after.txt
 *   diff before.txt after.txt
 */

import { runBacktest } from '../src/services/backtestService.js';

async function main() {
  console.log('=== BACKTEST PARITY TEST ===');
  console.log('Date: ' + new Date().toISOString());
  console.log('');

  // Use a fixed 30-day period for consistent comparison
  const symbols = [
    'BTC/USDT:USDT',
    'SOL/USDT:USDT',
    'XRP/USDT:USDT',
    'DOGE/USDT:USDT',
    'ADA/USDT:USDT',
    'AVAX/USDT:USDT',
    'LINK/USDT:USDT',
    'APT/USDT:USDT',
    'SUI/USDT:USDT',
  ];

  const result = await runBacktest({
    startDate: new Date('2025-12-01T00:00:00Z'),
    endDate: new Date('2025-12-31T23:59:59Z'),
    initialCapital: 1000,
    symbols,
    leverage: 4,
  });

  const s = result.summary;

  // Print summary for comparison
  console.log('--- SUMMARY ---');
  console.log(`Total Trades: ${s.totalTrades}`);
  console.log(`Wins: ${s.wins}`);
  console.log(`Losses: ${s.losses}`);
  console.log(`Win Rate: ${s.winRate.toFixed(2)}%`);
  console.log(`Final Capital: ${s.finalCapital.toFixed(2)}`);
  console.log(`Total PnL %: ${s.totalPnlPct.toFixed(4)}%`);
  console.log(`Max Drawdown: ${s.maxDrawdownPct.toFixed(4)}%`);
  console.log(`Profit Factor: ${s.profitFactor.toFixed(4)}`);
  console.log('');

  // Count exits by reason
  const exitReasons: Record<string, number> = {};
  for (const t of result.trades) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }
  
  console.log('--- EXIT REASONS ---');
  const sortedReasons = Object.entries(exitReasons).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`${reason}: ${count}`);
  }
  console.log('');

  // Print first 20 trades with key details (for detailed comparison)
  console.log('--- FIRST 20 TRADES ---');
  for (const t of result.trades.slice(0, 20)) {
    const symbol = t.symbol.replace('/USDT:USDT', '');
    const entryDate = new Date(t.entryTime).toISOString();
    const exitDate = new Date(t.exitTime).toISOString();
    console.log(`${symbol}|${t.side}|${entryDate}|${exitDate}|${t.exitReason}|${t.netPnlPct.toFixed(4)}`);
  }
  console.log('');

  // Print last 10 trades too
  console.log('--- LAST 10 TRADES ---');
  for (const t of result.trades.slice(-10)) {
    const symbol = t.symbol.replace('/USDT:USDT', '');
    const entryDate = new Date(t.entryTime).toISOString();
    const exitDate = new Date(t.exitTime).toISOString();
    console.log(`${symbol}|${t.side}|${entryDate}|${exitDate}|${t.exitReason}|${t.netPnlPct.toFixed(4)}`);
  }

  console.log('');
  console.log('=== END PARITY TEST ===');
}

main().catch(console.error);
