/**
 * analyze-skipzone-quality.ts — Deep analysis of trades in the SMA200 skip zone
 *
 * Goals:
 *   1. Per-symbol performance breakdown (which symbols are best?)
 *   2. Analyze trades IN the skip zone: what signal features predict winners vs losers?
 *   3. Test quality-bypass: skip zone + allow high-quality signals through
 *
 * Usage:
 *   npx tsx scripts/analyze-skipzone-quality.ts
 */
import { runBacktestComputation, type BacktestComputationInput } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { calcSMA, calcATR, calcADX } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from '../src/services/backtest/localOhlcvJsonStore.js';

// ============================================================================
// CONFIG
// ============================================================================
const ALL_SYMBOLS = [
  // Current strategy top performers
  'AVAX/USDT:USDT', 'FET/USDT:USDT', 'WIF/USDT:USDT', 'DOT/USDT:USDT',
  'TIA/USDT:USDT', 'IMX/USDT:USDT', 'STX/USDT:USDT',
  'DOGE/USDT:USDT', 'ADA/USDT:USDT',
  // Candidates to test
  'SOL/USDT:USDT', 'XRP/USDT:USDT', 'NEAR/USDT:USDT', 'LINK/USDT:USDT',
  'SUI/USDT:USDT', 'SEI/USDT:USDT',
];

const PERIOD = { start: '2025-01-01', end: '2025-12-31' };
const INITIAL_CAPITAL = 2000;
const LEVERAGE = 5;

// ============================================================================
// HELPERS
// ============================================================================
function padR(s: string, n: number) { return s.length >= n ? s.substring(0, n) : s + ' '.repeat(n - s.length); }
function padL(s: string, n: number) { return s.length >= n ? s.substring(0, n) : ' '.repeat(n - s.length) + s; }

// ============================================================================
// DATA LOADING
// ============================================================================
async function loadData(startMs: number, endMs: number) {
  const extraBarsMs = 250 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const allData: Record<string, BacktestCandle[]> = {};
  const available: string[] = [];
  for (const symbol of ALL_SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) {
      console.warn(`  No local data for ${symbol}, skipping`);
      continue;
    }
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
    available.push(symbol);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, allData, available, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

// ============================================================================
// PART 1: PER-SYMBOL ANALYSIS
// ============================================================================
async function runPerSymbol(data: Awaited<ReturnType<typeof loadData>>) {
  console.log('\n' + '='.repeat(90));
  console.log('PART 1: PER-SYMBOL PERFORMANCE (2025, individual backtests)');
  console.log('='.repeat(90));

  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');

  const results: {
    symbol: string;
    trades: number;
    longTrades: number;
    shortTrades: number;
    winRate: number;
    pnlUsd: number;
    pnlPerTrade: number;
    maxDD: number;
    sharpe: number;
    profitFactor: number;
  }[] = [];

  for (const symbol of data.available) {
    const symData: Record<string, BacktestCandle[]> = { [symbol]: data.allData[symbol] };

    const input: BacktestComputationInput = {
      params: {
        startDate,
        endDate,
        initialCapital: INITIAL_CAPITAL,
        symbols: [symbol],
        leverage: LEVERAGE,
      },
      btcCandles: data.btcCandles,
      btcCandlesRegime: data.btcCandles,
      allData: symData,
      CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
    };

    const result = await runBacktestComputation(input);
    const s = result.summary;

    results.push({
      symbol: symbol.replace('/USDT:USDT', ''),
      trades: s.totalTrades,
      longTrades: s.longTrades,
      shortTrades: s.shortTrades,
      winRate: s.winRate,
      pnlUsd: s.totalPnlUsd,
      pnlPerTrade: s.totalTrades > 0 ? s.totalPnlUsd / s.totalTrades : 0,
      maxDD: s.maxDrawdownPct,
      sharpe: s.sharpeRatio,
      profitFactor: s.profitFactor,
    });

    console.log(`  ${padR(symbol.replace('/USDT:USDT', ''), 8)} ${s.totalTrades} trades, $${s.totalPnlUsd.toFixed(0)} PnL, ${s.winRate.toFixed(1)}% WR, DD ${s.maxDrawdownPct.toFixed(1)}%`);
  }

  // Sort by PnL
  results.sort((a, b) => b.pnlUsd - a.pnlUsd);

  console.log('\n' + '-'.repeat(100));
  const hdr = [
    padR('Symbol', 8), padL('Trades', 7), padL('L/S', 9), padL('WR%', 7),
    padL('PnL $', 10), padL('$/trade', 9), padL('DD%', 7), padL('Sharpe', 7), padL('PF', 6),
  ].join(' | ');
  console.log(hdr);
  console.log('-'.repeat(100));

  for (const r of results) {
    const row = [
      padR(r.symbol, 8),
      padL(String(r.trades), 7),
      padL(`${r.longTrades}/${r.shortTrades}`, 9),
      padL(r.winRate.toFixed(1), 7),
      padL('$' + r.pnlUsd.toFixed(0), 10),
      padL('$' + r.pnlPerTrade.toFixed(1), 9),
      padL(r.maxDD.toFixed(1), 7),
      padL(r.sharpe.toFixed(2), 7),
      padL(r.profitFactor.toFixed(2), 6),
    ].join(' | ');
    const flag = r.pnlUsd > 0 ? '+' : r.pnlUsd < -500 ? 'X' : ' ';
    console.log(flag + row);
  }
  console.log('-'.repeat(100));

  // Tier classification
  const tier1 = results.filter(r => r.sharpe > 2 && r.profitFactor > 1.3 && r.trades > 50);
  const tier2 = results.filter(r => r.sharpe > 1 && r.profitFactor > 1.1 && !tier1.includes(r));
  const tierX = results.filter(r => !tier1.includes(r) && !tier2.includes(r));

  console.log('\n--- Symbol Tiers ---');
  console.log(`  TIER 1 (Sharpe>2, PF>1.3, N>50): ${tier1.map(r => r.symbol).join(', ') || 'none'}`);
  console.log(`  TIER 2 (Sharpe>1, PF>1.1):       ${tier2.map(r => r.symbol).join(', ') || 'none'}`);
  console.log(`  AVOID:                            ${tierX.map(r => r.symbol).join(', ') || 'none'}`);

  return results;
}

// ============================================================================
// PART 2: SKIP ZONE TRADE QUALITY ANALYSIS
// ============================================================================
async function analyzeSkipZoneQuality(data: Awaited<ReturnType<typeof loadData>>) {
  console.log('\n\n' + '='.repeat(90));
  console.log('PART 2: SKIP ZONE TRADE QUALITY ANALYSIS');
  console.log('='.repeat(90));

  // Run baseline backtest with NO skip zone filter, capture all trades
  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');

  // Ensure skip zone is disabled
  const origSkipZone = (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT;
  (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT = 0;

  const symbols = data.available.filter(s => [
    'DOGE/USDT:USDT', 'IMX/USDT:USDT', 'AVAX/USDT:USDT',
    'FET/USDT:USDT', 'WIF/USDT:USDT', 'ADA/USDT:USDT',
    'DOT/USDT:USDT', 'STX/USDT:USDT', 'TIA/USDT:USDT',
  ].includes(s));

  const input: BacktestComputationInput = {
    params: {
      startDate,
      endDate,
      initialCapital: INITIAL_CAPITAL,
      symbols,
      leverage: LEVERAGE,
    },
    btcCandles: data.btcCandles,
    btcCandlesRegime: data.btcCandles,
    allData: Object.fromEntries(
      symbols.map(s => [s, data.allData[s]]).filter(([_, v]) => v)
    ),
    CANDLE_REGIME_INTERVAL_MS: data.CANDLE_REGIME_INTERVAL_MS,
  };

  console.log('\nRunning baseline backtest (skip zone OFF)...');
  const result = await runBacktestComputation(input);
  console.log(`  ${result.trades.length} trades, $${result.summary.totalPnlUsd.toFixed(0)} PnL`);

  (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT = origSkipZone;

  // Now analyze each trade's BTC distance from SMA200 at entry
  const btcCloses = data.btcCandles.map(c => c.close);
  const btcTimestamps = data.btcCandles.map(c => c.timestamp);

  // Build symbol candle index for feature computation
  const symCandleMap: Record<string, { timestamps: number[]; candles: BacktestCandle[] }> = {};
  for (const sym of symbols) {
    const candles = data.allData[sym];
    if (!candles) continue;
    symCandleMap[sym] = { timestamps: candles.map(c => c.timestamp), candles };
  }

  interface TradeWithZone {
    symbol: string;
    side: string;
    entryTimeMs: number;
    pnlUsd: number;
    pnlPct: number;
    isWin: boolean;
    btcDistFromSma200: number; // %
    btcSma200Slope: number;
    volRatio: number;
    roc10: number;
    roc5: number;
    btcAdx: number;
    inSkipZone: boolean; // within 1% of SMA200
    exitReason: string;
  }

  const trades: TradeWithZone[] = [];

  for (const t of result.trades) {
    // entryTime is ISO string, convert to ms
    const entryMs = new Date(t.entryTime).getTime();

    // Find BTC state at entry time
    let btcIdx = -1;
    for (let i = btcTimestamps.length - 1; i >= 0; i--) {
      if (btcTimestamps[i] <= entryMs) { btcIdx = i; break; }
    }
    if (btcIdx < 200) continue; // Need enough candles for SMA200

    const sma200 = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
    if (!sma200 || sma200 === 0) continue;

    const btcPrice = btcCloses[btcIdx];
    const distFromSma200 = Math.abs((btcPrice - sma200) / sma200) * 100;

    // SMA200 slope (10-bar lookback)
    const sma200prev = calcSMA(btcCloses.slice(0, btcIdx - 9), 200);
    const sma200Slope = sma200prev ? ((sma200 - sma200prev) / sma200prev) * 100 : 0;

    // BTC ADX (trend strength)
    const btcWindow = data.btcCandles.slice(Math.max(0, btcIdx - 30), btcIdx + 1);
    const btcAdx = btcWindow.length >= 15 ? (calcADX(btcWindow, 14) ?? 0) : 0;

    // Symbol-level features at entry
    const symEntry = symCandleMap[t.symbol];
    let volRatio = 0;
    let roc10 = 0;
    let roc5 = 0;
    if (symEntry) {
      let symIdx = -1;
      for (let i = symEntry.timestamps.length - 1; i >= 0; i--) {
        if (symEntry.timestamps[i] <= entryMs) { symIdx = i; break; }
      }
      if (symIdx >= 20) {
        // Volume ratio (current vs 20-bar avg)
        const volumes = symEntry.candles.slice(symIdx - 20, symIdx + 1).map(c => c.volume);
        const avgVol = volumes.slice(0, 20).reduce((s, v) => s + v, 0) / 20;
        volRatio = avgVol > 0 ? volumes[20] / avgVol : 0;

        // ROC10 = (close - close[10]) / close[10] * 100
        if (symIdx >= 10) {
          const closeNow = symEntry.candles[symIdx].close;
          const close10 = symEntry.candles[symIdx - 10].close;
          roc10 = close10 > 0 ? Math.abs((closeNow - close10) / close10 * 100) : 0;
        }
        // ROC5
        if (symIdx >= 5) {
          const closeNow = symEntry.candles[symIdx].close;
          const close5 = symEntry.candles[symIdx - 5].close;
          roc5 = close5 > 0 ? Math.abs((closeNow - close5) / close5 * 100) : 0;
        }
      }
    }

    trades.push({
      symbol: t.symbol.replace('/USDT:USDT', ''),
      side: t.side,
      entryTimeMs: entryMs,
      pnlUsd: t.netPnlUsd,
      pnlPct: t.netPnlPct,
      isWin: t.netPnlUsd > 0,
      btcDistFromSma200: distFromSma200,
      btcSma200Slope: sma200Slope,
      volRatio,
      roc10,
      roc5,
      btcAdx,
      inSkipZone: distFromSma200 < 1.0,
      exitReason: t.exitReason || '',
    });
  }

  console.log(`\nAnalyzed ${trades.length} trades with BTC SMA200 context\n`);

  // === ZONE BREAKDOWN ===
  const zones = [
    { label: '< 0.5%', min: 0, max: 0.5 },
    { label: '0.5-1%', min: 0.5, max: 1.0 },
    { label: '1-1.5%', min: 1.0, max: 1.5 },
    { label: '1.5-2%', min: 1.5, max: 2.0 },
    { label: '2-3%', min: 2.0, max: 3.0 },
    { label: '3-5%', min: 3.0, max: 5.0 },
    { label: '> 5%', min: 5.0, max: 100 },
  ];

  console.log('--- BTC Distance from SMA200 Zones ---\n');
  console.log(`  ${padR('Zone', 10)} | ${padL('N', 5)} | ${padL('WR%', 7)} | ${padL('PnL $', 10)} | ${padL('$/trade', 9)} | ${padL('PF', 6)} | ${padL('Avg Vol', 9)}`);
  console.log('  ' + '-'.repeat(75));

  for (const z of zones) {
    const zt = trades.filter(t => t.btcDistFromSma200 >= z.min && t.btcDistFromSma200 < z.max);
    if (zt.length === 0) continue;
    const wins = zt.filter(t => t.isWin).length;
    const totalPnl = zt.reduce((s, t) => s + t.pnlUsd, 0);
    const grossWins = zt.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
    const grossLosses = Math.abs(zt.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : Infinity;
    const avgVol = zt.reduce((s, t) => s + t.volRatio, 0) / zt.length;

    console.log(`  ${padR(z.label, 10)} | ${padL(String(zt.length), 5)} | ${padL((wins / zt.length * 100).toFixed(1), 7)} | ${padL('$' + totalPnl.toFixed(0), 10)} | ${padL('$' + (totalPnl / zt.length).toFixed(1), 9)} | ${padL(pf.toFixed(2), 6)} | ${padL(avgVol.toFixed(2), 9)}`);
  }

  // === SKIP ZONE DEEP DIVE (< 1%) ===
  const skipZoneTrades = trades.filter(t => t.inSkipZone);
  const outZoneTrades = trades.filter(t => !t.inSkipZone);

  console.log('\n\n--- Skip Zone (< 1%) Deep Dive ---\n');
  console.log(`  In zone:  ${skipZoneTrades.length} trades, WR ${(skipZoneTrades.filter(t => t.isWin).length / skipZoneTrades.length * 100).toFixed(1)}%, PnL $${skipZoneTrades.reduce((s, t) => s + t.pnlUsd, 0).toFixed(0)}`);
  console.log(`  Out zone: ${outZoneTrades.length} trades, WR ${(outZoneTrades.filter(t => t.isWin).length / outZoneTrades.length * 100).toFixed(1)}%, PnL $${outZoneTrades.reduce((s, t) => s + t.pnlUsd, 0).toFixed(0)}`);

  // === FEATURE ANALYSIS IN SKIP ZONE ===
  console.log('\n--- Feature Analysis: Winners vs Losers in Skip Zone ---\n');

  const szWins = skipZoneTrades.filter(t => t.isWin);
  const szLosses = skipZoneTrades.filter(t => !t.isWin);

  if (szWins.length > 0 && szLosses.length > 0) {
    const avgFeature = (arr: TradeWithZone[], key: keyof TradeWithZone) =>
      arr.reduce((s, t) => s + (t[key] as number), 0) / arr.length;

    const features: { name: string; key: keyof TradeWithZone }[] = [
      { name: 'Vol Ratio', key: 'volRatio' },
      { name: '|ROC10|', key: 'roc10' },
      { name: '|ROC5|', key: 'roc5' },
      { name: 'BTC Dist%', key: 'btcDistFromSma200' },
      { name: 'SMA Slope%', key: 'btcSma200Slope' },
      { name: 'BTC ADX', key: 'btcAdx' },
    ];

    console.log(`  ${padR('Feature', 14)} | ${padL('Winners', 10)} | ${padL('Losers', 10)} | ${padL('Delta', 10)} | ${padL('Direction', 10)}`);
    console.log('  ' + '-'.repeat(65));

    for (const f of features) {
      const winAvg = avgFeature(szWins, f.key);
      const lossAvg = avgFeature(szLosses, f.key);
      const delta = winAvg - lossAvg;
      const dir = delta > 0 ? 'Win > Loss' : delta < 0 ? 'Loss > Win' : 'Equal';
      console.log(`  ${padR(f.name, 14)} | ${padL(winAvg.toFixed(4), 10)} | ${padL(lossAvg.toFixed(4), 10)} | ${padL((delta >= 0 ? '+' : '') + delta.toFixed(4), 10)} | ${padL(dir, 10)}`);
    }

    // === LONG vs SHORT in skip zone ===
    console.log('\n--- LONG vs SHORT in Skip Zone ---\n');
    for (const side of ['long', 'short'] as const) {
      const sideTrades = skipZoneTrades.filter(t => t.side === side);
      if (sideTrades.length === 0) continue;
      const wins = sideTrades.filter(t => t.isWin).length;
      const pnl = sideTrades.reduce((s, t) => s + t.pnlUsd, 0);
      console.log(`  ${side.toUpperCase()}: ${sideTrades.length} trades, WR ${(wins / sideTrades.length * 100).toFixed(1)}%, PnL $${pnl.toFixed(0)}`);
    }
  }

  // === QUALITY BYPASS SIMULATION ===
  console.log('\n\n' + '='.repeat(90));
  console.log('PART 3: QUALITY BYPASS SIMULATION');
  console.log('Skip zone 1% + allow trades through if quality score > threshold');
  console.log('='.repeat(90));

  // Quality score: composite of features that differentiate winners in skip zone
  function qualityScore(t: TradeWithZone): number {
    let score = 0;
    // Volume conviction (volRatio > 2 = strong signal)
    score += Math.min((t.volRatio / 2.5) * 30, 30);
    // ROC10 strength (stronger momentum = more conviction)
    score += Math.min((t.roc10 / 3.0) * 25, 25);
    // ROC5 strength (short-term momentum)
    score += Math.min((t.roc5 / 2.0) * 15, 15);
    // BTC ADX (trend strength — higher = clearer direction even near SMA200)
    score += Math.min((t.btcAdx / 30) * 20, 20);
    // SMA slope (directional certainty)
    score += Math.min(Math.abs(t.btcSma200Slope) / 0.1, 1) * 10;
    return Math.min(score, 100);
  }

  // Compute quality scores for all trades
  const tradesWithScore = trades.map(t => ({ ...t, quality: qualityScore(t) }));

  // Test different quality thresholds for bypass
  const thresholds = [0, 20, 30, 40, 50, 60, 70, 80];
  const skipZonePct = 1.0;

  console.log(`\n  ${padR('Bypass', 10)} | ${padL('Trades', 7)} | ${padL('Skipped', 8)} | ${padL('Bypassed', 9)} | ${padL('WR%', 7)} | ${padL('PnL $', 10)} | ${padL('$/trade', 9)} | ${padL('PF', 6)}`);
  console.log('  ' + '-'.repeat(85));

  // Baseline: no filter
  const baselineN = tradesWithScore.length;
  const baselineWR = tradesWithScore.filter(t => t.isWin).length / baselineN * 100;
  const baselinePnl = tradesWithScore.reduce((s, t) => s + t.pnlUsd, 0);
  const baselineGW = tradesWithScore.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
  const baselineGL = Math.abs(tradesWithScore.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
  console.log(`  ${padR('No filter', 10)} | ${padL(String(baselineN), 7)} | ${padL('0', 8)} | ${padL('-', 9)} | ${padL(baselineWR.toFixed(1), 7)} | ${padL('$' + baselinePnl.toFixed(0), 10)} | ${padL('$' + (baselinePnl / baselineN).toFixed(1), 9)} | ${padL((baselineGL > 0 ? baselineGW / baselineGL : 0).toFixed(2), 6)}`);

  // Skip zone only (no bypass)
  const skipOnlyTrades = tradesWithScore.filter(t => t.btcDistFromSma200 >= skipZonePct);
  const skipOnlyN = skipOnlyTrades.length;
  const skipOnlyWR = skipOnlyTrades.filter(t => t.isWin).length / skipOnlyN * 100;
  const skipOnlyPnl = skipOnlyTrades.reduce((s, t) => s + t.pnlUsd, 0);
  const skipGW = skipOnlyTrades.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
  const skipGL = Math.abs(skipOnlyTrades.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
  const skippedCount = baselineN - skipOnlyN;
  console.log(`  ${padR('SZ 1% only', 10)} | ${padL(String(skipOnlyN), 7)} | ${padL(String(skippedCount), 8)} | ${padL('0', 9)} | ${padL(skipOnlyWR.toFixed(1), 7)} | ${padL('$' + skipOnlyPnl.toFixed(0), 10)} | ${padL('$' + (skipOnlyPnl / skipOnlyN).toFixed(1), 9)} | ${padL((skipGL > 0 ? skipGW / skipGL : 0).toFixed(2), 6)}`);

  // Quality bypass at different thresholds
  for (const threshold of thresholds) {
    if (threshold === 0) continue; // Same as baseline
    // Keep trades: either outside skip zone OR inside but quality >= threshold
    const kept = tradesWithScore.filter(t =>
      t.btcDistFromSma200 >= skipZonePct || t.quality >= threshold
    );
    const bypassed = kept.filter(t => t.btcDistFromSma200 < skipZonePct);
    const skipped = baselineN - kept.length;
    const keptN = kept.length;
    const wr = kept.filter(t => t.isWin).length / keptN * 100;
    const pnl = kept.reduce((s, t) => s + t.pnlUsd, 0);
    const gw = kept.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
    const gl = Math.abs(kept.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
    const pf = gl > 0 ? gw / gl : 0;
    console.log(`  ${padR(`Q>=${threshold}`, 10)} | ${padL(String(keptN), 7)} | ${padL(String(skipped), 8)} | ${padL(String(bypassed.length), 9)} | ${padL(wr.toFixed(1), 7)} | ${padL('$' + pnl.toFixed(0), 10)} | ${padL('$' + (pnl / keptN).toFixed(1), 9)} | ${padL(pf.toFixed(2), 6)}`);
  }

  // === BYPASS TRADE DETAILS ===
  console.log('\n--- Quality distribution of skip zone trades ---\n');
  const szTrades = tradesWithScore.filter(t => t.btcDistFromSma200 < skipZonePct);
  const qBuckets = [
    { label: 'Q < 20', min: 0, max: 20 },
    { label: 'Q 20-40', min: 20, max: 40 },
    { label: 'Q 40-60', min: 40, max: 60 },
    { label: 'Q 60-80', min: 60, max: 80 },
    { label: 'Q >= 80', min: 80, max: 101 },
  ];

  console.log(`  ${padR('Quality', 10)} | ${padL('N', 5)} | ${padL('WR%', 7)} | ${padL('PnL $', 10)} | ${padL('$/trade', 9)} | ${padL('Avg Vol', 8)} | ${padL('Avg ROC', 8)}`);
  console.log('  ' + '-'.repeat(72));

  for (const q of qBuckets) {
    const qt = szTrades.filter(t => t.quality >= q.min && t.quality < q.max);
    if (qt.length === 0) continue;
    const wins = qt.filter(t => t.isWin).length;
    const pnl = qt.reduce((s, t) => s + t.pnlUsd, 0);
    const avgVol = qt.reduce((s, t) => s + t.volRatio, 0) / qt.length;
    const avgRoc = qt.reduce((s, t) => s + t.roc, 0) / qt.length;
    console.log(`  ${padR(q.label, 10)} | ${padL(String(qt.length), 5)} | ${padL((wins / qt.length * 100).toFixed(1), 7)} | ${padL('$' + pnl.toFixed(0), 10)} | ${padL('$' + (pnl / qt.length).toFixed(1), 9)} | ${padL(avgVol.toFixed(2), 8)} | ${padL(avgRoc.toFixed(2), 8)}`);
  }

  // === BEST BYPASS RECOMMENDATION ===
  console.log('\n--- Optimal Quality Bypass ---\n');
  let bestConfig = { threshold: -1, pnl: -Infinity, wr: 0, n: 0, pf: 0 };
  for (const threshold of [0, 20, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80]) {
    const kept = tradesWithScore.filter(t =>
      t.btcDistFromSma200 >= skipZonePct || (threshold > 0 && t.quality >= threshold)
    );
    if (threshold === 0) {
      // Skip zone only, no bypass
      const k = tradesWithScore.filter(t => t.btcDistFromSma200 >= skipZonePct);
      const pnl = k.reduce((s, t) => s + t.pnlUsd, 0);
      const wr = k.filter(t => t.isWin).length / k.length * 100;
      const gw = k.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
      const gl = Math.abs(k.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
      if (pnl > bestConfig.pnl) bestConfig = { threshold: 0, pnl, wr, n: k.length, pf: gl > 0 ? gw / gl : 0 };
      continue;
    }
    const pnl = kept.reduce((s, t) => s + t.pnlUsd, 0);
    const wr = kept.filter(t => t.isWin).length / kept.length * 100;
    const gw = kept.filter(t => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
    const gl = Math.abs(kept.filter(t => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
    const pf = gl > 0 ? gw / gl : 0;
    if (pnl > bestConfig.pnl) bestConfig = { threshold, pnl, wr, n: kept.length, pf };
  }

  console.log(`  Best PnL config: Skip zone 1% + Quality bypass >= ${bestConfig.threshold}`);
  console.log(`    Trades: ${bestConfig.n}, WR: ${bestConfig.wr.toFixed(1)}%, PnL: $${bestConfig.pnl.toFixed(0)}, PF: ${bestConfig.pf.toFixed(2)}`);
  console.log(`    vs Baseline ($${baselinePnl.toFixed(0)}): ${bestConfig.pnl > baselinePnl ? '+' : ''}$${(bestConfig.pnl - baselinePnl).toFixed(0)}`);
  console.log(`    vs Skip only ($${skipOnlyPnl.toFixed(0)}): ${bestConfig.pnl > skipOnlyPnl ? '+' : ''}$${(bestConfig.pnl - skipOnlyPnl).toFixed(0)}`);

  return tradesWithScore;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  console.log('=== Skip Zone Quality + Per-Symbol Analysis ===\n');

  const startDate = new Date(PERIOD.start + 'T00:00:00.000Z');
  const endDate = new Date(PERIOD.end + 'T23:59:59.999Z');

  console.log('Loading data...');
  const data = await loadData(startDate.getTime(), endDate.getTime());
  console.log(`  BTC 15m: ${data.btcCandles.length} candles`);
  console.log(`  Symbols available: ${data.available.length} (${data.available.map(s => s.replace('/USDT:USDT', '')).join(', ')})\n`);

  // Part 1: Per-symbol analysis
  const symbolResults = await runPerSymbol(data);

  // Part 2+3: Skip zone quality analysis
  const tradesWithScore = await analyzeSkipZoneQuality(data);

  console.log('\n\nDone.');
}

main().catch(console.error);
