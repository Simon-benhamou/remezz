/**
 * Analyze "Early Weakness SL Tighten" Hypothesis
 *
 * Hypothesis: SL trades that show NO favorable movement in the first 15-30 minutes
 * are "dead on arrival" — they should have their SL tightened to cut losses faster.
 *
 * Approach:
 * 1. Run standard V5.141 backtest (Jan-Dec 2025, $2K, 5x, 9 symbols)
 * 2. For each trade, replay the candle data to compute maxPnlPct trajectory
 *    at each 15m candle (candle 1 = first 15min, candle 2 = 30min, etc.)
 * 3. Analyze per-category distributions (SL, STAGNANT, TRAIL winners)
 * 4. Estimate savings from tightening SL on "dead on arrival" trades
 *
 * Usage: npx tsx scripts/analyze-early-weakness.ts
 */
import { runBacktestComputation, type BacktestComputationInput, type BacktestTrade } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════
const SYMBOLS = MomentumConfig.SYMBOLS;

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
  postProcess1m: false,
};

// MaxPnlPct thresholds to track (favorable movement)
const THRESHOLDS = [0.1, 0.2, 0.3, 0.5, 1.0];

// ═══════════════════════════════════════════════════════════════════════
// DATA LOADING
// ═══════════════════════════════════════════════════════════════════════
async function loadData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 250 * CANDLE_15M_MS;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);
  console.log(`BTC 15m: ${btcCandles.length} candles`);

  const btcCandlesRegime = btcCandles;

  const allData: Record<string, BacktestCandle[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) { console.warn(`No data for ${symbol}`); continue; }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
    console.log(`${symbol}: ${allData[symbol].length} candles`);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const CANDLE_REGIME_INTERVAL_MS = configTfMin * 60 * 1000;

  return { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS };
}

// ═══════════════════════════════════════════════════════════════════════
// TRADE ENRICHMENT: Compute maxPnlPct at each candle for each trade
// ═══════════════════════════════════════════════════════════════════════

interface EnrichedTrade extends BacktestTrade {
  // maxPnlPct at candle N (raw price %, not leveraged)
  maxPnlPctAtCandle: number[];
  // Which candle first reached each threshold (-1 = never)
  candleToReachThreshold: Map<number, number>;
  // Final maxPnlPct (raw price %)
  tradeMaxPnlPct: number;
  // Total candles in this trade
  totalCandles: number;
}

function enrichTrade(
  trade: BacktestTrade,
  symbolCandles: BacktestCandle[],
): EnrichedTrade | null {
  const entryTime = new Date(trade.entryTime).getTime();
  const exitTime = new Date(trade.exitTime).getTime();

  // Find candles in this trade's window
  // Entry is at candle close (V5.102b), so the first "after entry" candle
  // is the one whose timestamp >= entryTime
  const tradeCandles: BacktestCandle[] = [];
  for (const c of symbolCandles) {
    const candleCloseTime = c.timestamp + CANDLE_15M_MS;
    if (candleCloseTime <= entryTime) continue;
    if (c.timestamp > exitTime) break;
    tradeCandles.push(c);
  }

  if (tradeCandles.length === 0) return null;

  // Compute cumulative maxPnlPct at each candle
  const maxPnlPctAtCandle: number[] = [];
  let runningMax = 0;

  for (const candle of tradeCandles) {
    // For LONG: max favorable = (high - entry) / entry * 100
    // For SHORT: max favorable = (entry - low) / entry * 100
    const favorablePrice = trade.side === 'long' ? candle.high : candle.low;
    const candlePnlPct = trade.side === 'long'
      ? ((favorablePrice - trade.entryPrice) / trade.entryPrice) * 100
      : ((trade.entryPrice - favorablePrice) / trade.entryPrice) * 100;

    runningMax = Math.max(runningMax, candlePnlPct);
    maxPnlPctAtCandle.push(runningMax);
  }

  // Determine which candle first reached each threshold
  const candleToReachThreshold = new Map<number, number>();
  for (const threshold of THRESHOLDS) {
    let reachedAt = -1;
    for (let i = 0; i < maxPnlPctAtCandle.length; i++) {
      if (maxPnlPctAtCandle[i] >= threshold) {
        reachedAt = i;
        break;
      }
    }
    candleToReachThreshold.set(threshold, reachedAt);
  }

  return {
    ...trade,
    maxPnlPctAtCandle,
    candleToReachThreshold,
    tradeMaxPnlPct: runningMax,
    totalCandles: tradeCandles.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CATEGORY CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════

type TradeCategory = 'SL' | 'STAGNANT' | 'TRAIL_WIN' | 'OTHER';

function categorize(trade: BacktestTrade): TradeCategory {
  const r = trade.exitReason;
  if (r === 'SL') return 'SL';
  if (r.includes('STAGNANT')) return 'STAGNANT';
  if (r.includes('TRAIL')) return 'TRAIL_WIN';
  return 'OTHER';
}

// ═══════════════════════════════════════════════════════════════════════
// ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function printSummary(label: string, result: any) {
  const s = result.summary;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Trades:        ${s.totalTrades} (${s.longTrades}L / ${s.shortTrades}S)`);
  console.log(`Win Rate:      ${s.winRate.toFixed(1)}%`);
  console.log(`Net PnL:       $${s.totalPnlUsd.toFixed(2)} (${s.totalPnlPct.toFixed(1)}%)`);
  console.log(`Final Capital: $${s.finalCapital.toFixed(2)}`);
  console.log(`Max Drawdown:  ${s.maxDrawdownPct.toFixed(1)}%`);
  console.log(`Sharpe:        ${s.sharpeRatio.toFixed(2)}`);
  console.log(`Profit Factor: ${s.profitFactor.toFixed(2)}`);
}

function analyzeMaxPnlDistribution(trades: EnrichedTrade[], label: string) {
  if (trades.length === 0) return;

  console.log(`\n--- ${label} (${trades.length} trades) ---`);

  // MaxPnlPct distribution (raw price %)
  const buckets = [
    { label: '  < 0.1%', min: -Infinity, max: 0.1 },
    { label: '0.1-0.2%', min: 0.1, max: 0.2 },
    { label: '0.2-0.3%', min: 0.2, max: 0.3 },
    { label: '0.3-0.5%', min: 0.3, max: 0.5 },
    { label: '0.5-1.0%', min: 0.5, max: 1.0 },
    { label: '  1.0%+', min: 1.0, max: Infinity },
  ];

  console.log(`\n  MaxPnlPct Distribution (raw price %, best favorable move):`);
  for (const bucket of buckets) {
    const count = trades.filter(t => t.tradeMaxPnlPct >= bucket.min && t.tradeMaxPnlPct < bucket.max).length;
    const pct = (count / trades.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(count / trades.length * 40));
    console.log(`    ${bucket.label}: ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }

  // Hold minutes distribution
  const holdBuckets = [
    { label: '   < 15m', min: 0, max: 15 },
    { label: ' 15-30m', min: 15, max: 30 },
    { label: ' 30-60m', min: 30, max: 60 },
    { label: '60-120m', min: 60, max: 120 },
    { label: '  120m+', min: 120, max: Infinity },
  ];

  console.log(`\n  Hold Minutes Distribution:`);
  for (const bucket of holdBuckets) {
    const count = trades.filter(t => t.holdMinutes >= bucket.min && t.holdMinutes < bucket.max).length;
    const pct = (count / trades.length * 100).toFixed(1);
    const bar = '#'.repeat(Math.round(count / trades.length * 40));
    console.log(`    ${bucket.label}: ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`);
  }

  // Threshold reach analysis
  console.log(`\n  Threshold Reach (% of trades reaching threshold at any point):`);
  for (const threshold of THRESHOLDS) {
    const reached = trades.filter(t => t.candleToReachThreshold.get(threshold) !== -1).length;
    const pct = (reached / trades.length * 100).toFixed(1);
    console.log(`    >= ${threshold.toFixed(1)}%: ${String(reached).padStart(4)} / ${trades.length} (${pct}%)`);
  }

  // Speed to threshold (for trades that DO reach it)
  console.log(`\n  Speed to Threshold (avg candles to reach, for trades that reach it):`);
  for (const threshold of THRESHOLDS) {
    const reachedTrades = trades.filter(t => t.candleToReachThreshold.get(threshold) !== -1);
    if (reachedTrades.length === 0) {
      console.log(`    >= ${threshold.toFixed(1)}%: no trades reached this`);
      continue;
    }
    const avgCandles = reachedTrades.reduce((s, t) => s + (t.candleToReachThreshold.get(threshold)! + 1), 0) / reachedTrades.length;
    const avgMinutes = avgCandles * 15;
    console.log(`    >= ${threshold.toFixed(1)}%: avg ${avgCandles.toFixed(1)} candles (${avgMinutes.toFixed(0)}min) — ${reachedTrades.length} trades`);
  }

  // Average PnL
  const avgPnl = trades.reduce((s, t) => s + t.netPnlUsd, 0) / trades.length;
  const totalPnl = trades.reduce((s, t) => s + t.netPnlUsd, 0);
  const avgMaxPnl = trades.reduce((s, t) => s + t.tradeMaxPnlPct, 0) / trades.length;
  console.log(`\n  PnL Stats:`);
  console.log(`    Avg net PnL/trade: $${avgPnl.toFixed(2)}`);
  console.log(`    Total PnL:         $${totalPnl.toFixed(2)}`);
  console.log(`    Avg maxPnlPct:     ${avgMaxPnl.toFixed(3)}%`);
}

function analyzeSLCrossTab(slTrades: EnrichedTrade[]) {
  if (slTrades.length === 0) return;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  SL CROSS-TABULATION: maxPnlPct vs holdMinutes`);
  console.log(`${'='.repeat(70)}`);

  // For SL trades with maxPnl < 0.2% (dead on arrival): what's the avg holdMinutes?
  const deadOnArrival = slTrades.filter(t => t.tradeMaxPnlPct < 0.2);
  const hadFavorable = slTrades.filter(t => t.tradeMaxPnlPct >= 0.2);

  console.log(`\n  SL trades with maxPnl < 0.2% ("dead on arrival"): ${deadOnArrival.length} / ${slTrades.length} (${(deadOnArrival.length / slTrades.length * 100).toFixed(1)}%)`);
  if (deadOnArrival.length > 0) {
    const avgHold = deadOnArrival.reduce((s, t) => s + t.holdMinutes, 0) / deadOnArrival.length;
    const avgLoss = deadOnArrival.reduce((s, t) => s + t.netPnlUsd, 0) / deadOnArrival.length;
    const totalLoss = deadOnArrival.reduce((s, t) => s + t.netPnlUsd, 0);
    const avgMaxPnl = deadOnArrival.reduce((s, t) => s + t.tradeMaxPnlPct, 0) / deadOnArrival.length;
    console.log(`    Avg hold:       ${avgHold.toFixed(0)}min`);
    console.log(`    Avg loss:       $${avgLoss.toFixed(2)}`);
    console.log(`    Total loss:     $${totalLoss.toFixed(2)}`);
    console.log(`    Avg maxPnlPct:  ${avgMaxPnl.toFixed(3)}%`);
  }

  console.log(`\n  SL trades with maxPnl >= 0.2% (had favorable move): ${hadFavorable.length} / ${slTrades.length} (${(hadFavorable.length / slTrades.length * 100).toFixed(1)}%)`);
  if (hadFavorable.length > 0) {
    const avgHold = hadFavorable.reduce((s, t) => s + t.holdMinutes, 0) / hadFavorable.length;
    const avgLoss = hadFavorable.reduce((s, t) => s + t.netPnlUsd, 0) / hadFavorable.length;
    const totalLoss = hadFavorable.reduce((s, t) => s + t.netPnlUsd, 0);
    const avgMaxPnl = hadFavorable.reduce((s, t) => s + t.tradeMaxPnlPct, 0) / hadFavorable.length;
    console.log(`    Avg hold:       ${avgHold.toFixed(0)}min`);
    console.log(`    Avg loss:       $${avgLoss.toFixed(2)}`);
    console.log(`    Total loss:     $${totalLoss.toFixed(2)}`);
    console.log(`    Avg maxPnlPct:  ${avgMaxPnl.toFixed(3)}%`);
  }

  // Cross-tab: maxPnlPct buckets x holdMinutes buckets
  const pnlBuckets = [
    { label: '<0.1%', test: (t: EnrichedTrade) => t.tradeMaxPnlPct < 0.1 },
    { label: '0.1-0.2%', test: (t: EnrichedTrade) => t.tradeMaxPnlPct >= 0.1 && t.tradeMaxPnlPct < 0.2 },
    { label: '0.2-0.5%', test: (t: EnrichedTrade) => t.tradeMaxPnlPct >= 0.2 && t.tradeMaxPnlPct < 0.5 },
    { label: '0.5%+', test: (t: EnrichedTrade) => t.tradeMaxPnlPct >= 0.5 },
  ];
  const holdBuckets = [
    { label: '<30m', test: (t: EnrichedTrade) => t.holdMinutes < 30 },
    { label: '30-60m', test: (t: EnrichedTrade) => t.holdMinutes >= 30 && t.holdMinutes < 60 },
    { label: '60m+', test: (t: EnrichedTrade) => t.holdMinutes >= 60 },
  ];

  console.log(`\n  Cross-Tab (count | avg loss $):`);
  const header = '                  ' + holdBuckets.map(h => h.label.padStart(14)).join('') + '     TOTAL'.padStart(14);
  console.log(header);
  console.log('  ' + '-'.repeat(header.length));

  for (const pb of pnlBuckets) {
    const cells: string[] = [];
    let rowTotal = 0;
    let rowTotalLoss = 0;
    for (const hb of holdBuckets) {
      const matches = slTrades.filter(t => pb.test(t) && hb.test(t));
      const avgLoss = matches.length > 0
        ? matches.reduce((s, t) => s + t.netPnlUsd, 0) / matches.length
        : 0;
      cells.push(`${String(matches.length).padStart(4)}|$${avgLoss.toFixed(0).padStart(5)}`);
      rowTotal += matches.length;
      rowTotalLoss += matches.reduce((s, t) => s + t.netPnlUsd, 0);
    }
    const rowAvg = rowTotal > 0 ? rowTotalLoss / rowTotal : 0;
    cells.push(`${String(rowTotal).padStart(4)}|$${rowAvg.toFixed(0).padStart(5)}`);
    console.log(`  maxPnl ${pb.label.padEnd(8)} ${cells.join('  ')}`);
  }

  // Early weakness: maxPnlPct at candle 2 (30min)
  console.log(`\n  Early Weakness Detection (maxPnlPct at candle 2 = 30min):`);
  const withCandle2 = slTrades.filter(t => t.maxPnlPctAtCandle.length >= 2);
  console.log(`    SL trades with >= 2 candles: ${withCandle2.length}`);

  if (withCandle2.length > 0) {
    const earlyWeak = withCandle2.filter(t => t.maxPnlPctAtCandle[1] < 0.2);
    const earlyStrong = withCandle2.filter(t => t.maxPnlPctAtCandle[1] >= 0.2);

    console.log(`    maxPnl < 0.2% at 30min: ${earlyWeak.length} (${(earlyWeak.length / withCandle2.length * 100).toFixed(1)}%)`);
    if (earlyWeak.length > 0) {
      const avgLoss = earlyWeak.reduce((s, t) => s + t.netPnlUsd, 0) / earlyWeak.length;
      const totalLoss = earlyWeak.reduce((s, t) => s + t.netPnlUsd, 0);
      console.log(`      Avg loss: $${avgLoss.toFixed(2)}, Total loss: $${totalLoss.toFixed(2)}`);
    }

    console.log(`    maxPnl >= 0.2% at 30min: ${earlyStrong.length} (${(earlyStrong.length / withCandle2.length * 100).toFixed(1)}%)`);
    if (earlyStrong.length > 0) {
      const avgLoss = earlyStrong.reduce((s, t) => s + t.netPnlUsd, 0) / earlyStrong.length;
      const totalLoss = earlyStrong.reduce((s, t) => s + t.netPnlUsd, 0);
      console.log(`      Avg loss: $${avgLoss.toFixed(2)}, Total loss: $${totalLoss.toFixed(2)}`);
    }
  }
}

function analyzeCandle1Trajectory(enrichedTrades: EnrichedTrade[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  CANDLE-1 TRAJECTORY: maxPnlPct at first candle (15min)`);
  console.log(`${'='.repeat(70)}`);

  // Group by category, then show maxPnlPct at candle 1
  const categories: TradeCategory[] = ['SL', 'STAGNANT', 'TRAIL_WIN', 'OTHER'];

  for (const cat of categories) {
    const catTrades = enrichedTrades.filter(t => categorize(t) === cat);
    if (catTrades.length === 0) continue;

    const withCandle1 = catTrades.filter(t => t.maxPnlPctAtCandle.length >= 1);
    if (withCandle1.length === 0) continue;

    const candle1vals = withCandle1.map(t => t.maxPnlPctAtCandle[0]);
    const avg = candle1vals.reduce((s, v) => s + v, 0) / candle1vals.length;
    const sorted = [...candle1vals].sort((a, b) => a - b);
    const p = (pct: number) => sorted[Math.floor(sorted.length * pct / 100)] ?? 0;

    console.log(`\n  ${cat} (${withCandle1.length} trades):`);
    console.log(`    Avg maxPnlPct at candle 1 (15min): ${avg.toFixed(3)}%`);
    console.log(`    P10: ${p(10).toFixed(3)}%, P25: ${p(25).toFixed(3)}%, P50: ${p(50).toFixed(3)}%, P75: ${p(75).toFixed(3)}%, P90: ${p(90).toFixed(3)}%`);

    // What fraction < 0.1%, < 0.2% at candle 1
    const below01 = candle1vals.filter(v => v < 0.1).length;
    const below02 = candle1vals.filter(v => v < 0.2).length;
    const below03 = candle1vals.filter(v => v < 0.3).length;
    console.log(`    < 0.1% at 15min: ${below01} (${(below01 / withCandle1.length * 100).toFixed(1)}%)`);
    console.log(`    < 0.2% at 15min: ${below02} (${(below02 / withCandle1.length * 100).toFixed(1)}%)`);
    console.log(`    < 0.3% at 15min: ${below03} (${(below03 / withCandle1.length * 100).toFixed(1)}%)`);
  }
}

function estimateSavings(slTrades: EnrichedTrade[], allTrades: EnrichedTrade[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  SAVINGS ESTIMATE: Tighten SL by 50% on early-weak trades`);
  console.log(`${'='.repeat(70)}`);
  console.log(`\n  Rule: If maxPnlPct < 0.2% by candle 2 (30min), tighten SL by 50%`);
  console.log(`  Assumption: A halved SL on a dead-on-arrival trade cuts its loss roughly in half.`);
  console.log(`  (In reality it depends on entry-to-SL distance, but this gives a useful estimate.)\n`);

  const eligible = slTrades.filter(t => t.maxPnlPctAtCandle.length >= 2 && t.maxPnlPctAtCandle[1] < 0.2);

  if (eligible.length === 0) {
    console.log(`  No eligible trades found.`);
    return;
  }

  const currentTotalLoss = eligible.reduce((s, t) => s + t.netPnlUsd, 0);
  const estimatedSavedPerTrade = eligible.map(t => Math.abs(t.netPnlUsd) * 0.5);
  const totalSaved = estimatedSavedPerTrade.reduce((s, v) => s + v, 0);

  console.log(`  Eligible SL trades (early-weak): ${eligible.length}`);
  console.log(`  Current total loss on these:     $${currentTotalLoss.toFixed(2)}`);
  console.log(`  Estimated savings (50% tighter):  $${totalSaved.toFixed(2)}`);
  console.log(`  Estimated new loss on these:      $${(currentTotalLoss + totalSaved).toFixed(2)}`);

  // What percentage of total strategy PnL is this?
  const totalStratPnl = allTrades.reduce((s, t) => s + t.netPnlUsd, 0);
  console.log(`\n  Strategy total PnL:              $${totalStratPnl.toFixed(2)}`);
  console.log(`  Savings as % of total PnL:       ${(totalSaved / Math.abs(totalStratPnl) * 100).toFixed(1)}%`);
  console.log(`  Estimated new total PnL:          $${(totalStratPnl + totalSaved).toFixed(2)}`);

  // Risk: would tighter SL also kill winning trades that started slow?
  console.log(`\n  --- RISK ANALYSIS: Would tighter SL hurt winning trades? ---`);
  const winningTrades = allTrades.filter(t => t.netPnlUsd > 0);
  const slowStartWinners = winningTrades.filter(
    t => t.maxPnlPctAtCandle.length >= 2 && t.maxPnlPctAtCandle[1] < 0.2
  );
  console.log(`  Winning trades with maxPnl < 0.2% at 30min: ${slowStartWinners.length} / ${winningTrades.length}`);
  if (slowStartWinners.length > 0) {
    const totalPnlAtRisk = slowStartWinners.reduce((s, t) => s + t.netPnlUsd, 0);
    console.log(`  PnL at risk (these winners might get stopped out early): $${totalPnlAtRisk.toFixed(2)}`);
    console.log(`  Avg PnL of slow-start winners: $${(totalPnlAtRisk / slowStartWinners.length).toFixed(2)}`);

    // Show exit reasons of slow-start winners
    const reasons: Record<string, number> = {};
    for (const t of slowStartWinners) {
      reasons[t.exitReason] = (reasons[t.exitReason] || 0) + 1;
    }
    console.log(`  Exit reasons of slow-start winners:`);
    for (const [r, c] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${r}: ${c}`);
    }
  }

  // Additional thresholds
  console.log(`\n  --- SENSITIVITY: Different thresholds ---`);
  for (const thresh of [0.1, 0.15, 0.2, 0.3]) {
    for (const candle of [1, 2, 3]) {
      const elig = slTrades.filter(
        t => t.maxPnlPctAtCandle.length >= candle && t.maxPnlPctAtCandle[candle - 1] < thresh
      );
      const saved = elig.reduce((s, t) => s + Math.abs(t.netPnlUsd) * 0.5, 0);
      const slowWin = winningTrades.filter(
        t => t.maxPnlPctAtCandle.length >= candle && t.maxPnlPctAtCandle[candle - 1] < thresh
      );
      const atRisk = slowWin.reduce((s, t) => s + t.netPnlUsd, 0);

      console.log(
        `    thresh=${thresh.toFixed(2)}% candle=${candle} (${candle * 15}min): ` +
        `${elig.length} SL saved=$${saved.toFixed(0)}, ` +
        `${slowWin.length} winners at risk=$${atRisk.toFixed(0)}, ` +
        `net=${saved - atRisk > 0 ? '+' : ''}$${(saved - atRisk).toFixed(0)}`
      );
    }
  }
}

function analyzeExitReasonBreakdown(enrichedTrades: EnrichedTrade[]) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  EXIT REASON BREAKDOWN`);
  console.log(`${'='.repeat(70)}`);

  const reasons: Record<string, { count: number; totalPnl: number; avgMaxPnl: number; trades: EnrichedTrade[] }> = {};
  for (const t of enrichedTrades) {
    const r = t.exitReason || 'UNKNOWN';
    if (!reasons[r]) reasons[r] = { count: 0, totalPnl: 0, avgMaxPnl: 0, trades: [] };
    reasons[r].count++;
    reasons[r].totalPnl += t.netPnlUsd;
    reasons[r].trades.push(t);
  }

  // Compute avg maxPnlPct per reason
  for (const data of Object.values(reasons)) {
    data.avgMaxPnl = data.trades.reduce((s, t) => s + t.tradeMaxPnlPct, 0) / data.trades.length;
  }

  console.log(`\n  ${'Exit Reason'.padEnd(28)} ${'Count'.padStart(6)} ${'Total PnL'.padStart(11)} ${'Avg PnL'.padStart(9)} ${'Avg MaxPnl%'.padStart(12)}`);
  console.log('  ' + '-'.repeat(70));
  for (const [reason, data] of Object.entries(reasons).sort((a, b) => b[1].count - a[1].count)) {
    const avgPnl = data.totalPnl / data.count;
    console.log(
      `  ${reason.padEnd(28)} ${String(data.count).padStart(6)} ` +
      `$${data.totalPnl.toFixed(0).padStart(9)} ` +
      `$${avgPnl.toFixed(2).padStart(8)} ` +
      `${data.avgMaxPnl.toFixed(3).padStart(10)}%`
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('=== Early Weakness SL Tighten Analysis ===');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Period: Jan-Dec 2025, $2K capital, 5x leverage\n`);

  // 1. Load data
  console.log('Loading candle data...');
  const { btcCandles, btcCandlesRegime, allData, CANDLE_REGIME_INTERVAL_MS } = await loadData();

  // 2. Run backtest
  console.log('\nRunning backtest...');
  const input: BacktestComputationInput = {
    params: PARAMS,
    btcCandles,
    btcCandlesRegime,
    allData,
    CANDLE_REGIME_INTERVAL_MS,
  };
  const result = await runBacktestComputation(input);
  printSummary('V5.141 Baseline Backtest', result);

  // 3. Enrich trades with candle-level maxPnlPct trajectory
  console.log(`\nEnriching ${result.trades.length} trades with candle-level trajectory...`);
  const enrichedTrades: EnrichedTrade[] = [];
  let skipped = 0;
  for (const trade of result.trades) {
    const symbolCandles = allData[trade.symbol];
    if (!symbolCandles) { skipped++; continue; }
    const enriched = enrichTrade(trade, symbolCandles);
    if (enriched) {
      enrichedTrades.push(enriched);
    } else {
      skipped++;
    }
  }
  console.log(`Enriched: ${enrichedTrades.length}, Skipped: ${skipped}`);

  // 4. Exit reason breakdown with maxPnlPct
  analyzeExitReasonBreakdown(enrichedTrades);

  // 5. Per-category maxPnlPct distributions
  const slTrades = enrichedTrades.filter(t => categorize(t) === 'SL');
  const stagnantTrades = enrichedTrades.filter(t => categorize(t) === 'STAGNANT');
  const trailWinTrades = enrichedTrades.filter(t => categorize(t) === 'TRAIL_WIN');
  const otherTrades = enrichedTrades.filter(t => categorize(t) === 'OTHER');

  analyzeMaxPnlDistribution(slTrades, 'SL TRADES (Stop Loss)');
  analyzeMaxPnlDistribution(stagnantTrades, 'STAGNANT TRADES');
  analyzeMaxPnlDistribution(trailWinTrades, 'TRAIL WINNER TRADES');
  if (otherTrades.length > 0) {
    analyzeMaxPnlDistribution(otherTrades, 'OTHER TRADES');
  }

  // 6. SL cross-tabulation
  analyzeSLCrossTab(slTrades);

  // 7. Candle-1 trajectory comparison
  analyzeCandle1Trajectory(enrichedTrades);

  // 8. Savings estimation
  estimateSavings(slTrades, enrichedTrades);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ANALYSIS COMPLETE`);
  console.log(`${'='.repeat(70)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
