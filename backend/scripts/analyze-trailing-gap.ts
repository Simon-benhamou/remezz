/**
 * Analyze the gap between trailing stop price and candle close at exit
 * This helps understand why candle.close vs trailing stop makes such a huge difference
 */

import { runBacktest } from '../src/services/backtestService.js';

async function main() {
  console.log('='.repeat(80));
  console.log('TRAILING EXIT GAP ANALYSIS');
  console.log('='.repeat(80));

  const startDate = new Date('2025-10-01T00:00:00.000Z');
  const endDate = new Date('2026-01-01T00:00:00.000Z');

  const result = await runBacktest({
    startDate,
    endDate,
    initialCapital: 2000,
    symbols: ['DOGE/USDT:USDT', 'SUI/USDT:USDT', 'SEI/USDT:USDT'],
    leverage: 4.5,
    // Enable debug mode to capture trailing details
    debug: true,
  });

  // Filter TRAIL exits
  const trailTrades = result.trades.filter(t => t.exitReason === 'TRAIL');

  console.log(`\nTotal TRAIL trades: ${trailTrades.length}`);

  // Analyze each TRAIL trade
  let totalGapPct = 0;
  let maxGapPct = 0;
  let minGapPct = Infinity;
  const gaps: { symbol: string; side: string; gapPct: number; entryPrice: number; exitPrice: number; hwm?: number }[] = [];

  for (const trade of trailTrades) {
    // The exit price in the trade is the trailing stop price (theoretical)
    // We need to understand what the candle close would have been

    // For a LONG: trailing stop = HWM × (1 - distance)
    // When breached: close < trailing stop
    // Gap = (trailing stop - close) / trailing stop

    // For a SHORT: trailing stop = LWM × (1 + distance)
    // When breached: close > trailing stop
    // Gap = (close - trailing stop) / trailing stop

    // Since we don't have the candle close stored, let's estimate based on the PnL
    // The exitPrice in the trade IS the theoretical trailing stop price

    const side = trade.side;
    const entryPrice = trade.entryPrice;
    const exitPrice = trade.exitPrice; // This is the trailing stop price

    // Calculate theoretical PnL at trailing stop
    const theoreticalPnlPct = side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

    // The actual PnL in the trade
    const actualPnlPct = trade.pnlPct;

    // The gap in PnL terms
    const pnlGap = theoreticalPnlPct - actualPnlPct;

    gaps.push({
      symbol: trade.symbol,
      side,
      gapPct: pnlGap,
      entryPrice,
      exitPrice,
    });
  }

  // Sort by gap
  gaps.sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));

  console.log('\n=== TOP 20 LARGEST GAPS ===\n');
  for (const g of gaps.slice(0, 20)) {
    console.log(`${g.symbol} ${g.side.toUpperCase()}: Gap = ${g.gapPct.toFixed(2)}% | Entry=$${g.entryPrice.toFixed(4)} | TrailStop=$${g.exitPrice.toFixed(4)}`);
  }

  // Calculate statistics
  const avgGap = gaps.reduce((sum, g) => sum + g.gapPct, 0) / gaps.length;
  const absGaps = gaps.map(g => Math.abs(g.gapPct));
  const avgAbsGap = absGaps.reduce((sum, g) => sum + g, 0) / absGaps.length;
  const maxAbsGap = Math.max(...absGaps);

  console.log('\n=== GAP STATISTICS ===\n');
  console.log(`Average gap:     ${avgGap.toFixed(2)}%`);
  console.log(`Avg absolute:    ${avgAbsGap.toFixed(2)}%`);
  console.log(`Max absolute:    ${maxAbsGap.toFixed(2)}%`);

  // Group by gap ranges
  const ranges = [
    { min: 0, max: 1, count: 0 },
    { min: 1, max: 2, count: 0 },
    { min: 2, max: 5, count: 0 },
    { min: 5, max: 10, count: 0 },
    { min: 10, max: 20, count: 0 },
    { min: 20, max: Infinity, count: 0 },
  ];

  for (const g of gaps) {
    const absGap = Math.abs(g.gapPct);
    for (const r of ranges) {
      if (absGap >= r.min && absGap < r.max) {
        r.count++;
        break;
      }
    }
  }

  console.log('\n=== GAP DISTRIBUTION ===\n');
  for (const r of ranges) {
    const pct = ((r.count / gaps.length) * 100).toFixed(1);
    const label = r.max === Infinity ? `${r.min}%+` : `${r.min}-${r.max}%`;
    console.log(`${label.padEnd(10)} ${r.count.toString().padStart(4)} trades (${pct}%)`);
  }

  // Now let's understand WHERE the gap comes from
  // The trailing stop is HWM × (1 - distance)
  // If TRAILING_DISTANCE is 0.8%, then trailing stop is 0.8% below HWM
  // When price breaches, it closes BELOW the trailing stop
  // So the close could be 1%, 2%, or even 5% below the HWM

  console.log('\n=== UNDERSTANDING THE GAP ===\n');
  console.log('The gap occurs because:');
  console.log('1. Trailing stop = HWM × (1 - 0.8%) = 0.8% below the peak');
  console.log('2. When price breaches, the CLOSE is BELOW the trailing stop');
  console.log('3. In volatile moves, the close can be much lower than the stop');
  console.log('');
  console.log('Example for LONG:');
  console.log('  - Peak (HWM): $100');
  console.log('  - Trailing stop: $99.20 (0.8% below)');
  console.log('  - Candle opens at $99.50, wicks down, closes at $98.00');
  console.log('  - Theoretical exit: $99.20 (trailing stop)');
  console.log('  - Realistic exit: $98.00 (candle close)');
  console.log('  - Gap: 1.2% on price = 5.4% on PnL with 4.5x leverage');
}

main().catch(console.error);
