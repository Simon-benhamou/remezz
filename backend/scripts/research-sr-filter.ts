/**
 * Research: Support/Resistance filter for signal quality
 *
 * Hypothesis: Signals near strong S/R levels perform differently.
 * - LONG near resistance → likely to reject → skip
 * - SHORT near support → likely to bounce → skip
 * - LONG above support with volume → confirmation → keep
 *
 * Method:
 * 1. Run baseline backtest
 * 2. For each trade, detect swing highs/lows at entry time
 * 3. Measure distance to nearest S/R
 * 4. Correlate S/R proximity with win/loss
 * 5. Simulate filtering bad signals
 */

import { runBacktest } from '../src/services/backtestService.js';
import { initializeMinimalMarkets } from '../src/exchange/ccxtClient.js';
import { loadLocalJsonCandles } from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// S/R DETECTION
// ============================================================================

interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;  // How many times tested (touches)
  barIndex: number;   // When it was first detected
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Detect swing highs and lows in a candle array
 * A swing high requires `order` candles on each side with lower highs
 * A swing low requires `order` candles on each side with higher lows
 */
function detectSwingPoints(
  candles: Candle[],
  order: number = 5
): SRLevel[] {
  const levels: SRLevel[] = [];

  for (let i = order; i < candles.length - order; i++) {
    // Check swing high
    let isSwingHigh = true;
    for (let j = 1; j <= order; j++) {
      if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      levels.push({
        price: candles[i].high,
        type: 'resistance',
        strength: 1,
        barIndex: i,
      });
    }

    // Check swing low
    let isSwingLow = true;
    for (let j = 1; j <= order; j++) {
      if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      levels.push({
        price: candles[i].low,
        type: 'support',
        strength: 1,
        barIndex: i,
      });
    }
  }

  return levels;
}

/**
 * Cluster nearby S/R levels (within tolerance %) and count touches
 */
function clusterLevels(levels: SRLevel[], tolerancePct: number = 0.3): SRLevel[] {
  if (levels.length === 0) return [];

  // Sort by price
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clusters: SRLevel[] = [];

  let currentCluster: SRLevel[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const pctDiff = Math.abs(sorted[i].price - currentCluster[0].price) / currentCluster[0].price * 100;

    if (pctDiff <= tolerancePct) {
      currentCluster.push(sorted[i]);
    } else {
      // Finalize cluster
      const avgPrice = currentCluster.reduce((s, l) => s + l.price, 0) / currentCluster.length;
      const hasSupport = currentCluster.some(l => l.type === 'support');
      const hasResistance = currentCluster.some(l => l.type === 'resistance');
      clusters.push({
        price: avgPrice,
        type: hasSupport && hasResistance ? 'support' : (hasSupport ? 'support' : 'resistance'),
        strength: currentCluster.length,
        barIndex: Math.max(...currentCluster.map(l => l.barIndex)),
      });
      currentCluster = [sorted[i]];
    }
  }

  // Last cluster
  if (currentCluster.length > 0) {
    const avgPrice = currentCluster.reduce((s, l) => s + l.price, 0) / currentCluster.length;
    const hasSupport = currentCluster.some(l => l.type === 'support');
    clusters.push({
      price: avgPrice,
      type: hasSupport ? 'support' : 'resistance',
      strength: currentCluster.length,
      barIndex: Math.max(...currentCluster.map(l => l.barIndex)),
    });
  }

  return clusters;
}

/**
 * Find nearest S/R levels above and below current price
 */
function findNearestSR(
  price: number,
  levels: SRLevel[]
): { nearestSupport: SRLevel | null; nearestResistance: SRLevel | null; distSupportPct: number; distResistancePct: number } {
  let nearestSupport: SRLevel | null = null;
  let nearestResistance: SRLevel | null = null;
  let minSupportDist = Infinity;
  let minResistanceDist = Infinity;

  for (const level of levels) {
    const dist = Math.abs(price - level.price) / price * 100;

    if (level.price <= price && dist < minSupportDist) {
      minSupportDist = dist;
      nearestSupport = level;
    }
    if (level.price >= price && dist < minResistanceDist) {
      minResistanceDist = dist;
      nearestResistance = level;
    }
  }

  return {
    nearestSupport,
    nearestResistance,
    distSupportPct: nearestSupport ? minSupportDist : 999,
    distResistancePct: nearestResistance ? minResistanceDist : 999,
  };
}

// ============================================================================
// MAIN RESEARCH
// ============================================================================

const SYMBOLS = [
  'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
  'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
  'STX/USDT:USDT', 'BTC/USDT:USDT',
];

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('RESEARCH: Support/Resistance Filter for Signal Quality');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Step 0: Initialize markets offline
  initializeMinimalMarkets();

  // Step 1: Run baseline backtest
  console.log('Step 1: Running baseline backtest (no S/R filter)...\n');

  const result = await runBacktest({
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: new Date('2026-02-09T00:00:00.000Z'),
    initialCapital: 2000,
    symbols: SYMBOLS,
    leverage: 5,
  });

  const s = result.summary;
  console.log('BASELINE RESULTS:');
  console.log(`  Trades: ${s.totalTrades} (${s.longTrades}L / ${s.shortTrades}S)`);
  console.log(`  Win Rate: ${s.winRate.toFixed(1)}%`);
  console.log(`  Net PnL: $${s.totalPnlUsd.toFixed(2)} (${s.totalPnlPct.toFixed(1)}%)`);
  console.log(`  Max DD: ${s.maxDrawdownPct.toFixed(1)}%`);
  console.log(`  Sharpe: ${s.sharpeRatio.toFixed(2)}`);
  console.log(`  Profit Factor: ${s.profitFactor.toFixed(2)}`);
  console.log('');

  // Step 2: Load candle data for S/R analysis
  console.log('Step 2: Loading candle data for S/R analysis...');

  const candleData: Record<string, Candle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (local) {
      candleData[symbol] = local.candles;
      console.log(`  ${symbol}: ${local.candles.length} candles`);
    }
  }

  // Step 3: Analyze each trade's S/R context
  console.log('\nStep 3: Analyzing S/R context for each trade...\n');

  interface TradeAnalysis {
    symbol: string;
    side: 'long' | 'short';
    entryPrice: number;
    entryTime: number;
    pnlPct: number;
    isWinner: boolean;
    distToSupportPct: number;
    distToResistancePct: number;
    supportStrength: number;
    resistanceStrength: number;
    // Adverse level = resistance for LONG, support for SHORT
    distToAdverseLevelPct: number;
    adverseStrength: number;
    volumeRatio: number; // Volume at entry vs average
  }

  const LOOKBACK_BARS = 100;  // How many candles to analyze for S/R
  const SWING_ORDERS = [3, 5, 8]; // Test different swing detection sensitivities

  for (const swingOrder of SWING_ORDERS) {
    console.log(`\n${'═'.repeat(65)}`);
    console.log(`SWING ORDER = ${swingOrder} (${swingOrder * 15} min on each side)`);
    console.log('═'.repeat(65));

    const analyses: TradeAnalysis[] = [];
    let skippedNoData = 0;

    for (const trade of result.trades) {
      const candles = candleData[trade.symbol];
      if (!candles) { skippedNoData++; continue; }

      // Find the candle index closest to entry time
      const entryTs = new Date(trade.entryTime).getTime();
      let entryIdx = -1;
      for (let i = 0; i < candles.length; i++) {
        if (candles[i].timestamp >= entryTs) {
          entryIdx = i;
          break;
        }
      }
      if (entryIdx < LOOKBACK_BARS || entryIdx < 0) { skippedNoData++; continue; }

      // Get lookback window for S/R detection
      const lookbackCandles = candles.slice(entryIdx - LOOKBACK_BARS, entryIdx);

      // Detect S/R levels
      const rawLevels = detectSwingPoints(lookbackCandles, swingOrder);
      const clusteredLevels = clusterLevels(rawLevels, 0.3);

      // Find nearest S/R
      const sr = findNearestSR(trade.entryPrice, clusteredLevels);

      // Volume at entry
      const entryCandle = candles[entryIdx];
      const recentVolumes = lookbackCandles.slice(-20).map(c => c.volume);
      const avgVol = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const volRatio = avgVol > 0 ? entryCandle.volume / avgVol : 1;

      const side = trade.side as 'long' | 'short';
      const isAdverseSupport = side === 'short';
      const isAdverseResistance = side === 'long';

      analyses.push({
        symbol: trade.symbol,
        side,
        entryPrice: trade.entryPrice,
        entryTime: entryTs,
        pnlPct: trade.netPnlPct,
        isWinner: trade.netPnlPct > 0,
        distToSupportPct: sr.distSupportPct,
        distToResistancePct: sr.distResistancePct,
        supportStrength: sr.nearestSupport?.strength || 0,
        resistanceStrength: sr.nearestResistance?.strength || 0,
        distToAdverseLevelPct: isAdverseResistance ? sr.distResistancePct : sr.distSupportPct,
        adverseStrength: isAdverseResistance ? (sr.nearestResistance?.strength || 0) : (sr.nearestSupport?.strength || 0),
        volumeRatio: volRatio,
      });
    }

    console.log(`Analyzed: ${analyses.length} trades (${skippedNoData} skipped - no data)`);

    // Step 4: Bucket analysis - distance to adverse S/R
    console.log('\n─── DISTANCE TO ADVERSE S/R vs WIN RATE ───');
    console.log('(Adverse = resistance for LONG, support for SHORT)');
    console.log('');

    const buckets = [
      { label: '< 0.3%  (very close)', min: 0, max: 0.3 },
      { label: '0.3-0.7% (close)',      min: 0.3, max: 0.7 },
      { label: '0.7-1.5% (medium)',     min: 0.7, max: 1.5 },
      { label: '1.5-3.0% (far)',        min: 1.5, max: 3.0 },
      { label: '> 3.0%  (very far)',    min: 3.0, max: 999 },
    ];

    for (const bucket of buckets) {
      const inBucket = analyses.filter(a => a.distToAdverseLevelPct >= bucket.min && a.distToAdverseLevelPct < bucket.max);
      if (inBucket.length === 0) {
        console.log(`  ${bucket.label.padEnd(25)} | N=0`);
        continue;
      }
      const wins = inBucket.filter(a => a.isWinner).length;
      const wr = (wins / inBucket.length) * 100;
      const avgPnl = inBucket.reduce((s, a) => s + a.pnlPct, 0) / inBucket.length;
      const totalPnl = inBucket.reduce((s, a) => s + a.pnlPct, 0);
      console.log(`  ${bucket.label.padEnd(25)} | N=${String(inBucket.length).padStart(4)} | WR=${wr.toFixed(1).padStart(5)}% | avg PnL=${avgPnl.toFixed(2).padStart(6)}% | sum PnL=${totalPnl.toFixed(1).padStart(7)}%`);
    }

    // Step 5: Strength analysis
    console.log('\n─── ADVERSE S/R STRENGTH vs WIN RATE ───');
    console.log('(Strength = number of touches at that level)');
    console.log('');

    const strengthBuckets = [
      { label: 'Strength 1 (weak)',   min: 0, max: 2 },
      { label: 'Strength 2-3 (med)',  min: 2, max: 4 },
      { label: 'Strength 4+ (strong)', min: 4, max: 999 },
    ];

    for (const bucket of strengthBuckets) {
      const inBucket = analyses.filter(a =>
        a.adverseStrength >= bucket.min && a.adverseStrength < bucket.max && a.distToAdverseLevelPct < 1.5
      );
      if (inBucket.length === 0) {
        console.log(`  ${bucket.label.padEnd(25)} | N=0`);
        continue;
      }
      const wins = inBucket.filter(a => a.isWinner).length;
      const wr = (wins / inBucket.length) * 100;
      const avgPnl = inBucket.reduce((s, a) => s + a.pnlPct, 0) / inBucket.length;
      console.log(`  ${bucket.label.padEnd(25)} | N=${String(inBucket.length).padStart(4)} | WR=${wr.toFixed(1).padStart(5)}% | avg PnL=${avgPnl.toFixed(2).padStart(6)}%`);
    }

    // Step 6: Volume interaction
    console.log('\n─── VOLUME × S/R PROXIMITY (close < 1%) ───');
    console.log('');

    const closeSR = analyses.filter(a => a.distToAdverseLevelPct < 1.0);
    if (closeSR.length > 0) {
      const highVol = closeSR.filter(a => a.volumeRatio >= 1.5);
      const lowVol = closeSR.filter(a => a.volumeRatio < 1.5);

      if (highVol.length > 0) {
        const wr = (highVol.filter(a => a.isWinner).length / highVol.length) * 100;
        const avgPnl = highVol.reduce((s, a) => s + a.pnlPct, 0) / highVol.length;
        console.log(`  High volume (≥1.5x) near adverse S/R | N=${String(highVol.length).padStart(4)} | WR=${wr.toFixed(1).padStart(5)}% | avg PnL=${avgPnl.toFixed(2)}%`);
      }
      if (lowVol.length > 0) {
        const wr = (lowVol.filter(a => a.isWinner).length / lowVol.length) * 100;
        const avgPnl = lowVol.reduce((s, a) => s + a.pnlPct, 0) / lowVol.length;
        console.log(`  Low volume  (<1.5x) near adverse S/R | N=${String(lowVol.length).padStart(4)} | WR=${wr.toFixed(1).padStart(5)}% | avg PnL=${avgPnl.toFixed(2)}%`);
      }
    }

    // Step 7: Simulate filtering
    console.log('\n─── SIMULATED S/R FILTER RESULTS ───');
    console.log('');

    const filterConfigs = [
      { label: 'Skip if adverse S/R < 0.3%',                fn: (a: TradeAnalysis) => a.distToAdverseLevelPct >= 0.3 },
      { label: 'Skip if adverse S/R < 0.5%',                fn: (a: TradeAnalysis) => a.distToAdverseLevelPct >= 0.5 },
      { label: 'Skip if adverse S/R < 0.7%',                fn: (a: TradeAnalysis) => a.distToAdverseLevelPct >= 0.7 },
      { label: 'Skip if adverse S/R < 1.0%',                fn: (a: TradeAnalysis) => a.distToAdverseLevelPct >= 1.0 },
      { label: 'Skip if adverse S/R < 0.5% & strength≥2',   fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 0.5 && a.adverseStrength >= 2) },
      { label: 'Skip if adverse S/R < 0.7% & strength≥2',   fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 0.7 && a.adverseStrength >= 2) },
      { label: 'Skip if adverse S/R < 1.0% & strength≥3',   fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 1.0 && a.adverseStrength >= 3) },
      { label: 'Skip if adverse S/R < 0.5% & lowVol(<1.5)', fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 0.5 && a.volumeRatio < 1.5) },
      { label: 'Skip if adverse S/R < 0.7% & lowVol(<1.5)', fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 0.7 && a.volumeRatio < 1.5) },
      { label: 'Skip if adverse S/R < 1.0% & lowVol(<1.5)', fn: (a: TradeAnalysis) => !(a.distToAdverseLevelPct < 1.0 && a.volumeRatio < 1.5) },
    ];

    const baselineWR = analyses.length > 0 ? (analyses.filter(a => a.isWinner).length / analyses.length) * 100 : 0;
    const baselinePnl = analyses.reduce((s, a) => s + a.pnlPct, 0);
    console.log(`  Baseline:  N=${String(analyses.length).padStart(4)} | WR=${baselineWR.toFixed(1).padStart(5)}% | total PnL=${baselinePnl.toFixed(1).padStart(7)}%`);
    console.log('  ───────────────────────────────────────────────────────────');

    for (const config of filterConfigs) {
      const kept = analyses.filter(config.fn);
      const removed = analyses.length - kept.length;
      if (kept.length === 0) continue;

      const wr = (kept.filter(a => a.isWinner).length / kept.length) * 100;
      const totalPnl = kept.reduce((s, a) => s + a.pnlPct, 0);
      const pnlDelta = totalPnl - baselinePnl;
      const removedWins = analyses.filter(a => !config.fn(a) && a.isWinner).length;
      const removedLosses = analyses.filter(a => !config.fn(a) && !a.isWinner).length;

      console.log(
        `  ${config.label.padEnd(45)} | N=${String(kept.length).padStart(4)} (-${String(removed).padStart(2)}) ` +
        `| WR=${wr.toFixed(1).padStart(5)}% | PnL=${totalPnl.toFixed(1).padStart(7)}% (${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(1)}%) ` +
        `| removed: ${removedLosses}L ${removedWins}W`
      );
    }

    // Step 8: Per-side breakdown
    console.log('\n─── PER-SIDE BREAKDOWN (adverse S/R < 0.7%) ───');

    const nearAdverse = analyses.filter(a => a.distToAdverseLevelPct < 0.7);
    const longNear = nearAdverse.filter(a => a.side === 'long');
    const shortNear = nearAdverse.filter(a => a.side === 'short');

    if (longNear.length > 0) {
      const wr = (longNear.filter(a => a.isWinner).length / longNear.length) * 100;
      console.log(`  LONG near resistance (< 0.7%):  N=${longNear.length} | WR=${wr.toFixed(1)}% | ${longNear.filter(a => a.isWinner).length}W / ${longNear.filter(a => !a.isWinner).length}L`);
    }
    if (shortNear.length > 0) {
      const wr = (shortNear.filter(a => a.isWinner).length / shortNear.length) * 100;
      console.log(`  SHORT near support (< 0.7%):    N=${shortNear.length} | WR=${wr.toFixed(1)}% | ${shortNear.filter(a => a.isWinner).length}W / ${shortNear.filter(a => !a.isWinner).length}L`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('RESEARCH COMPLETE');
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
