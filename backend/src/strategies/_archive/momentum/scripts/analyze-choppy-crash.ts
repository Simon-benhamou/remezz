/**
 * V5.146 — Choppy Crash Pattern Analysis
 *
 * Why did we lose money in a -17% BTC crash (Nov 2025)?
 * Find features that distinguish winning vs losing SHORT trades
 * in high-volatility bearish months.
 *
 * Usage: npx tsx scripts/analyze-choppy-crash.ts
 */
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  CANDLE_15M_MS,
} from '../src/services/backtest/localOhlcvJsonStore.js';

const SYMBOLS = MomentumConfig.SYMBOLS;

async function loadData() {
  const startDate = new Date('2025-01-01');
  const endDate = new Date('2025-12-31');
  const since = startDate.getTime() - 250 * CANDLE_15M_MS;
  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No BTC data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endDate.getTime());

  const allData: Record<string, any[]> = {};
  for (const sym of SYMBOLS) {
    const local = await loadLocalJsonCandles(sym, '15m');
    if (!local) continue;
    allData[sym] = sliceCandlesByTime(local.candles, since, endDate.getTime());
  }

  return {
    params: { startDate, endDate, initialCapital: 2000, leverage: 5, symbols: SYMBOLS, postProcess1m: false },
    btcCandles,
    btcCandlesRegime: btcCandles,
    allData,
    CANDLE_REGIME_INTERVAL_MS: CANDLE_15M_MS,
  };
}

function calcATR(candles: any[], period: number): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

async function main() {
  console.log('V5.146 — Choppy Crash Pattern Analysis');
  console.log('═'.repeat(90));

  const data = await loadData();
  const result = await runBacktestComputation(data);
  const trades = result.trades;
  const btcCandles = data.btcCandles;

  // ═══════════════════════════════════════════════════════════════
  // Pre-compute BTC features at each 15m candle
  // ═══════════════════════════════════════════════════════════════
  const btcByTs: Record<number, any> = {};
  for (let i = 0; i < btcCandles.length; i++) {
    btcByTs[btcCandles[i].timestamp] = btcCandles[i];
  }

  // Build BTC ATR%, bounce size, and regime at each candle
  function getBtcFeatures(ts: number) {
    // Find nearest BTC candle
    let idx = -1;
    for (let i = btcCandles.length - 1; i >= 0; i--) {
      if (btcCandles[i].timestamp <= ts) { idx = i; break; }
    }
    if (idx < 20) return null;

    const window = btcCandles.slice(Math.max(0, idx - 200), idx + 1);
    const atr14 = calcATR(window, 14);
    const atrPct = atr14 / window[window.length - 1].close * 100;

    // Recent bounce: max upward move in last 8 candles (2h)
    let maxBounce = 0;
    for (let i = Math.max(0, window.length - 8); i < window.length; i++) {
      const bounce = (window[i].high - window[i].low) / window[i].low * 100;
      if (bounce > maxBounce) maxBounce = bounce;
    }

    // Consecutive red candles before entry
    let consecRed = 0;
    for (let i = window.length - 1; i >= 1; i--) {
      if (window[i].close < window[i].open) consecRed++;
      else break;
    }

    // SMA200 distance
    const closes = window.map(c => c.close);
    const sma200 = calcSMA(closes, Math.min(200, closes.length));
    const sma200dist = (closes[closes.length - 1] - sma200) / sma200 * 100;

    // Price change last 24h (96 candles of 15m)
    const lookback24h = Math.min(96, window.length - 1);
    const priceChange24h = (window[window.length - 1].close - window[window.length - 1 - lookback24h].close)
      / window[window.length - 1 - lookback24h].close * 100;

    // Price change last 4h (16 candles)
    const lookback4h = Math.min(16, window.length - 1);
    const priceChange4h = (window[window.length - 1].close - window[window.length - 1 - lookback4h].close)
      / window[window.length - 1 - lookback4h].close * 100;

    // Wick ratio of last candle (upper wick / range)
    const lastCandle = window[window.length - 1];
    const range = lastCandle.high - lastCandle.low;
    const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
    const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;
    const upperWickRatio = range > 0 ? upperWick / range : 0;
    const lowerWickRatio = range > 0 ? lowerWick / range : 0;

    // Avg body size last 8 candles vs last candle body
    let avgBody8 = 0;
    for (let i = window.length - 8; i < window.length; i++) {
      avgBody8 += Math.abs(window[i].close - window[i].open);
    }
    avgBody8 /= 8;
    const bodyRatio = avgBody8 > 0 ? Math.abs(lastCandle.close - lastCandle.open) / avgBody8 : 1;

    // Direction consistency last 8 candles: how many are in the same direction?
    let bearCount8 = 0;
    for (let i = window.length - 8; i < window.length; i++) {
      if (window[i].close < window[i].open) bearCount8++;
    }

    // Choppiness: count direction changes in last 12 candles (3h)
    let dirChanges = 0;
    for (let i = window.length - 11; i < window.length; i++) {
      const prev = window[i - 1].close > window[i - 1].open ? 'bull' : 'bear';
      const curr = window[i].close > window[i].open ? 'bull' : 'bear';
      if (prev !== curr) dirChanges++;
    }

    return {
      atrPct,
      maxBounce,
      consecRed,
      sma200dist,
      priceChange24h,
      priceChange4h,
      upperWickRatio,
      lowerWickRatio,
      bodyRatio,
      bearCount8,
      dirChanges,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 1: All SHORT trades — Nov vs other months
  // ═══════════════════════════════════════════════════════════════
  const allShorts = trades.filter(t => (t as any).side === 'short');
  const novShorts = allShorts.filter(t => t.month === '2025-11');
  const otherShorts = allShorts.filter(t => t.month !== '2025-11');

  console.log('\n' + '═'.repeat(90));
  console.log('PART 1: SHORT TRADES — November vs Rest of Year');
  console.log('═'.repeat(90));

  const novWins = novShorts.filter(t => t.netPnlUsd > 0);
  const otherWins = otherShorts.filter(t => t.netPnlUsd > 0);
  console.log(`  November: ${novShorts.length} trades, ${(novWins.length / novShorts.length * 100).toFixed(0)}% WR, $${novShorts.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(0)} PnL`);
  console.log(`  Other:    ${otherShorts.length} trades, ${(otherWins.length / otherShorts.length * 100).toFixed(0)}% WR, $${otherShorts.reduce((a, t) => a + t.netPnlUsd, 0).toFixed(0)} PnL`);

  // ═══════════════════════════════════════════════════════════════
  // PART 2: Feature comparison — winning vs losing SHORTs in Nov
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('PART 2: Features at ENTRY — Winning vs Losing SHORTs');
  console.log('Comparing BTC conditions when SHORT was entered');
  console.log('═'.repeat(90));

  // Get entry timestamps from entryTime
  function getEntryTs(t: any): number {
    return new Date(t.entryTime).getTime();
  }

  type FeatureSet = ReturnType<typeof getBtcFeatures>;
  const winFeatures: FeatureSet[] = [];
  const loseFeatures: FeatureSet[] = [];
  const allShortFeatures: Array<{ trade: any; features: FeatureSet; isWin: boolean }> = [];

  for (const t of allShorts) {
    const f = getBtcFeatures(getEntryTs(t));
    if (!f) continue;
    allShortFeatures.push({ trade: t, features: f, isWin: t.netPnlUsd > 0 });
    if (t.netPnlUsd > 0) winFeatures.push(f);
    else loseFeatures.push(f);
  }

  function avg(arr: number[]): number { return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

  const featureNames = ['atrPct', 'maxBounce', 'consecRed', 'sma200dist', 'priceChange24h', 'priceChange4h', 'upperWickRatio', 'lowerWickRatio', 'bodyRatio', 'bearCount8', 'dirChanges'] as const;

  console.log(`\n  ${'Feature'.padEnd(18)} ${'Win avg'.padStart(10)} ${'Lose avg'.padStart(10)} ${'Delta'.padStart(10)} ${'Cohen d'.padStart(8)} ${'Direction'.padStart(12)}`);
  console.log(`  ${'-'.repeat(72)}`);

  for (const fname of featureNames) {
    const wVals = winFeatures.map(f => f![fname]);
    const lVals = loseFeatures.map(f => f![fname]);
    const wAvg = avg(wVals);
    const lAvg = avg(lVals);
    const delta = wAvg - lAvg;

    // Cohen's d
    const pooledStd = Math.sqrt(
      ((wVals.reduce((a, v) => a + (v - wAvg) ** 2, 0) + lVals.reduce((a, v) => a + (v - lAvg) ** 2, 0))
        / (wVals.length + lVals.length - 2))
    );
    const cohenD = pooledStd > 0 ? delta / pooledStd : 0;
    const direction = Math.abs(cohenD) < 0.1 ? 'no effect' :
      cohenD > 0 ? 'winners ↑' : 'losers ↑';

    console.log(
      `  ${fname.padEnd(18)} ${wAvg.toFixed(3).padStart(10)} ${lAvg.toFixed(3).padStart(10)} ${(delta > 0 ? '+' : '') + delta.toFixed(3).padStart(9)} ${cohenD.toFixed(2).padStart(8)} ${direction.padStart(12)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 3: Bucket analysis — can we filter by feature?
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('PART 3: Bucket Analysis — HIGH vs LOW values for top features');
  console.log('═'.repeat(90));

  // ATR% buckets
  for (const [fname, thresholds, label] of [
    ['atrPct', [0.2, 0.3, 0.4, 0.5], 'BTC ATR%'],
    ['priceChange4h', [-2, -1, -0.5, 0, 0.5], 'BTC Δ4h%'],
    ['priceChange24h', [-5, -3, -1, 0, 1], 'BTC Δ24h%'],
    ['dirChanges', [4, 5, 6, 7, 8], 'Dir changes/3h'],
    ['consecRed', [0, 1, 2, 3, 4], 'Consec red'],
    ['maxBounce', [0.3, 0.5, 0.7, 1.0, 1.5], 'Max bounce 2h%'],
  ] as const) {
    console.log(`\n  ${label}:`);
    console.log(`  ${'Range'.padEnd(20)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'Avg PnL'.padStart(9)} ${'Tot PnL'.padStart(9)}`);
    console.log(`  ${'-'.repeat(55)}`);

    const sorted = [...allShortFeatures].sort((a, b) => a.features![fname as keyof NonNullable<FeatureSet>] - b.features![fname as keyof NonNullable<FeatureSet>]);

    for (let i = 0; i < thresholds.length; i++) {
      const lo = i === 0 ? -Infinity : thresholds[i - 1];
      const hi = thresholds[i];
      const bucket = allShortFeatures.filter(f => {
        const v = f.features![fname as keyof NonNullable<FeatureSet>];
        return v >= lo && v < hi;
      });
      if (bucket.length < 3) continue;
      const bWins = bucket.filter(b => b.isWin).length;
      const bPnl = bucket.reduce((a, b) => a + b.trade.netPnlUsd, 0);
      console.log(
        `  ${`${lo === -Infinity ? '<' : lo + '≤'}..${hi}`.padEnd(20)} ${String(bucket.length).padStart(6)} ${(bWins / bucket.length * 100).toFixed(0).padStart(5)}% $${(bPnl / bucket.length).toFixed(0).padStart(8)} $${bPnl.toFixed(0).padStart(8)}`
      );
    }
    // Last bucket (>= last threshold)
    const lastT = thresholds[thresholds.length - 1];
    const lastBucket = allShortFeatures.filter(f => f.features![fname as keyof NonNullable<FeatureSet>] >= lastT);
    if (lastBucket.length >= 3) {
      const bWins = lastBucket.filter(b => b.isWin).length;
      const bPnl = lastBucket.reduce((a, b) => a + b.trade.netPnlUsd, 0);
      console.log(
        `  ${`≥${lastT}`.padEnd(20)} ${String(lastBucket.length).padStart(6)} ${(bWins / lastBucket.length * 100).toFixed(0).padStart(5)}% $${(bPnl / lastBucket.length).toFixed(0).padStart(8)} $${bPnl.toFixed(0).padStart(8)}`
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 4: November losers deep dive — what would have filtered them?
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('PART 4: November Losing SHORTs — individual feature fingerprints');
  console.log('═'.repeat(90));

  const novLosers = novShorts.filter(t => t.netPnlUsd < 0).sort((a, b) => a.netPnlUsd - b.netPnlUsd);
  console.log(`\n  ${'Date'.padEnd(18)} ${'Sym'.padEnd(7)} ${'PnL$'.padStart(7)} ${'Exit'.padStart(12)} ${'ATR%'.padStart(6)} ${'Δ4h'.padStart(6)} ${'Δ24h'.padStart(6)} ${'DirChg'.padStart(6)} ${'Bounce'.padStart(7)} ${'ConsRed'.padStart(7)}`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const t of novLosers.slice(0, 20)) {
    const f = getBtcFeatures(getEntryTs(t));
    if (!f) continue;
    const sym = t.symbol.replace('/USDT:USDT', '');
    const exitR = t.exitReason.replace('EXIT_', '').substring(0, 10);
    console.log(
      `  ${t.entryTime.slice(0, 16).padEnd(18)} ${sym.padEnd(7)} $${t.netPnlUsd.toFixed(0).padStart(6)} ${exitR.padStart(12)} ${f.atrPct.toFixed(2).padStart(6)} ${f.priceChange4h.toFixed(1).padStart(5)}% ${f.priceChange24h.toFixed(1).padStart(5)}% ${String(f.dirChanges).padStart(6)} ${f.maxBounce.toFixed(2).padStart(6)}% ${String(f.consecRed).padStart(7)}`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 5: Proposed filter impact simulation
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('PART 5: Filter Simulation — if we skip SHORTs when BTC conditions are X');
  console.log('═'.repeat(90));

  const allTradesWithFeatures = trades.map(t => {
    const f = getBtcFeatures(getEntryTs(t));
    return { trade: t, features: f };
  }).filter(x => x.features !== null);

  const baselinePnl = trades.reduce((a, t) => a + t.netPnlUsd, 0);
  const baselineTrades = trades.length;

  // Test filters on ALL shorts (not just November)
  const filters = [
    { label: 'ATR% > 0.40', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.40 },
    { label: 'ATR% > 0.45', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.45 },
    { label: 'ATR% > 0.50', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.50 },
    { label: 'DirChg >= 7', test: (f: any, t: any) => (t as any).side === 'short' && f.dirChanges >= 7 },
    { label: 'DirChg >= 8', test: (f: any, t: any) => (t as any).side === 'short' && f.dirChanges >= 8 },
    { label: 'MaxBounce > 1.0%', test: (f: any, t: any) => (t as any).side === 'short' && f.maxBounce > 1.0 },
    { label: 'MaxBounce > 0.7%', test: (f: any, t: any) => (t as any).side === 'short' && f.maxBounce > 0.7 },
    { label: 'Δ4h < -2%', test: (f: any, t: any) => (t as any).side === 'short' && f.priceChange4h < -2 },
    { label: 'Δ24h < -5%', test: (f: any, t: any) => (t as any).side === 'short' && f.priceChange24h < -5 },
    { label: 'ATR>0.40 + DirChg>=7', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.40 && f.dirChanges >= 7 },
    { label: 'ATR>0.40 + Bounce>0.7', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.40 && f.maxBounce > 0.7 },
    { label: 'ATR>0.45 + DirChg>=7', test: (f: any, t: any) => (t as any).side === 'short' && f.atrPct > 0.45 && f.dirChanges >= 7 },
  ];

  console.log(`\n  Baseline: ${baselineTrades} trades, $${baselinePnl.toFixed(0)} PnL\n`);
  console.log(`  ${'Filter'.padEnd(25)} ${'Skipped'.padStart(7)} ${'SkW'.padStart(4)} ${'SkL'.padStart(4)} ${'SkPnL'.padStart(8)} ${'Kept PnL'.padStart(9)} ${'ΔPNL'.padStart(8)} ${'SkWR'.padStart(6)}`);
  console.log(`  ${'-'.repeat(75)}`);

  for (const filter of filters) {
    const skipped = allTradesWithFeatures.filter(x => filter.test(x.features, x.trade));
    const skippedWins = skipped.filter(x => x.trade.netPnlUsd > 0).length;
    const skippedLosses = skipped.length - skippedWins;
    const skippedPnl = skipped.reduce((a, x) => a + x.trade.netPnlUsd, 0);
    const keptPnl = baselinePnl - skippedPnl;
    const wr = skipped.length > 0 ? skippedWins / skipped.length * 100 : 0;
    console.log(
      `  ${filter.label.padEnd(25)} ${String(skipped.length).padStart(7)} ${String(skippedWins).padStart(4)} ${String(skippedLosses).padStart(4)} $${skippedPnl.toFixed(0).padStart(7)} $${keptPnl.toFixed(0).padStart(8)} ${(keptPnl - baselinePnl > 0 ? '+' : '') + '$' + (keptPnl - baselinePnl).toFixed(0).padStart(6)} ${wr.toFixed(0).padStart(5)}%`
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // PART 6: Same analysis for LONG trades
  // ═══════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(90));
  console.log('PART 6: LONG trades — are high-ATR periods bad for LONGs too?');
  console.log('═'.repeat(90));

  const allLongs = trades.filter(t => (t as any).side === 'long');
  const longFeatures = allLongs.map(t => {
    const f = getBtcFeatures(getEntryTs(t));
    return { trade: t, features: f, isWin: t.netPnlUsd > 0 };
  }).filter(x => x.features !== null);

  for (const [threshold, label] of [[0.3, '0.3'], [0.4, '0.4'], [0.5, '0.5']] as const) {
    const high = longFeatures.filter(x => x.features!.atrPct >= threshold);
    const low = longFeatures.filter(x => x.features!.atrPct < threshold);
    const highWR = high.length > 0 ? high.filter(x => x.isWin).length / high.length * 100 : 0;
    const lowWR = low.length > 0 ? low.filter(x => x.isWin).length / low.length * 100 : 0;
    const highPnl = high.reduce((a, x) => a + x.trade.netPnlUsd, 0);
    const lowPnl = low.reduce((a, x) => a + x.trade.netPnlUsd, 0);
    console.log(`  LONG ATR≥${label}: ${high.length} trades, ${highWR.toFixed(0)}% WR, $${highPnl.toFixed(0)} | ATR<${label}: ${low.length} trades, ${lowWR.toFixed(0)}% WR, $${lowPnl.toFixed(0)}`);
  }

  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
