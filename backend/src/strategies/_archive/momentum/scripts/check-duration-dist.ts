/**
 * Check duration distribution to verify V5.68 realistic timing
 */
import { runBacktest } from '../src/services/backtestService.js';
import { preloadMarkets } from '../src/exchange/ccxtClient.js';

async function main() {
  console.log('Preloading markets...');
  await preloadMarkets();

  console.log('Running backtest...');
  const result = await runBacktest({
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-03-31'),
    initialCapital: 2000,
    symbols: ['ETH/USDT:USDT', 'DOGE/USDT:USDT'],
    leverage: 4.5,
  });

  // Check duration distribution
  const durations = result.trades.map(t => t.holdMinutes);
  const mod15 = durations.filter(d => d % 15 === 0).length;
  const nonMod15 = durations.filter(d => d % 15 !== 0).length;

  console.log('\n=== DURATION ANALYSIS (V5.68 Realistic Timing) ===');
  console.log('Total trades:', durations.length);
  console.log('Divisible by 15:', mod15, '(' + (100*mod15/durations.length).toFixed(1) + '%)');
  console.log('NOT divisible by 15:', nonMod15, '(' + (100*nonMod15/durations.length).toFixed(1) + '%)');

  // Sample durations
  console.log('\nSample durations (first 20):');
  durations.slice(0, 20).forEach((d, i) => {
    const marker = d % 15 === 0 ? '  (15m mult)' : '';
    console.log(`  Trade ${i+1}: ${d} min${marker}`);
  });

  // Histogram
  const buckets: Record<string, number> = {
    '<30m': 0, '30-60m': 0, '1-2h': 0, '2-4h': 0, '4-8h': 0, '8h+': 0
  };
  for (const d of durations) {
    if (d < 30) buckets['<30m']++;
    else if (d < 60) buckets['30-60m']++;
    else if (d < 120) buckets['1-2h']++;
    else if (d < 240) buckets['2-4h']++;
    else if (d < 480) buckets['4-8h']++;
    else buckets['8h+']++;
  }
  console.log('\nDuration histogram:');
  for (const [k, v] of Object.entries(buckets)) {
    console.log(`  ${k}: ${v} trades (${(100*v/durations.length).toFixed(1)}%)`);
  }
}

main().catch(console.error);
