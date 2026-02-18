/**
 * Analyze exhaustion detector accuracy using dynamic 1m candle fetch.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * APPROACH:
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. Run baseline 15m backtest (exhaustion OFF) → get all trades
 * 2. For each trailing exit trade, fetch 1m candles from Binance
 *    (only the entry→exit window, ~300 candles avg per trade)
 * 3. Replay trailing stop + exhaustion at 1m resolution
 * 4. Compare: did exhaustion catch exit earlier? Better price?
 *
 * Data needed: ~400 trailing trades × 300 candles = ~120K candles
 *   → ~80 API requests (vs 3,500 for full year). Takes seconds.
 *   → No files to store, no 500MB to commit.
 *
 * Run: npx tsx scripts/analyze-exhaustion-1m.ts
 *   Optional: --threshold 55 (default 65)
 *             --sweep (test thresholds 35-80)
 * ═══════════════════════════════════════════════════════════════════════════
 */
import * as ccxt from 'ccxt';
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import {
  loadLocalJsonCandles,
  sliceCandlesByTime,
} from '../src/services/backtest/localOhlcvJsonStore.js';
import {
  MomentumExhaustionCalculator,
  type ExhaustionCandle,
} from '../src/services/momentumExhaustion.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const SYMBOLS = [
  'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'WIF/USDT:USDT', 'IMX/USDT:USDT',
  'FET/USDT:USDT', 'AVAX/USDT:USDT', 'ADA/USDT:USDT', 'TIA/USDT:USDT',
  'STX/USDT:USDT', 'BTC/USDT:USDT',
];

const PARAMS = {
  startDate: new Date('2025-01-01T00:00:00.000Z'),
  endDate: new Date('2025-12-31T00:00:00.000Z'),
  initialCapital: 2000,
  symbols: SYMBOLS,
  leverage: 5,
};

// Trailing stop config (mirrors MomentumConfig.EXIT)
const TRAILING = {
  ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
  DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
  WIDEN_AT_PCT: MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT,
  WIDE_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT,
  PROGRESSIVE_ENABLED: (MomentumConfig.EXIT as any).TRAILING_PROGRESSIVE_ENABLED ?? true,
  TIER2_AT_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER2_AT_PCT ?? 4.0,
  TIER2_DISTANCE_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER2_DISTANCE_PCT ?? 1.5,
  TIER3_AT_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER3_AT_PCT ?? 6.0,
  TIER3_DISTANCE_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER3_DISTANCE_PCT ?? 2.5,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1m CANDLE FETCHER WITH CACHING
// ═══════════════════════════════════════════════════════════════════════════

type Candle1m = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

class CandleFetcher {
  private exchange: ccxt.binanceusdm;
  private cache: Map<string, Candle1m[]> = new Map(); // symbol → sorted 1m candles
  private requestCount = 0;

  constructor() {
    this.exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  }

  async init() {
    await this.exchange.loadMarkets();
  }

  /**
   * Get 1m candles for a symbol within [startTs, endTs].
   * Merges with cache to avoid re-fetching overlapping windows.
   */
  async getCandles(symbol: string, startTs: number, endTs: number): Promise<Candle1m[]> {
    const cached = this.cache.get(symbol) || [];

    // Find what we already have vs what we need
    const cachedStart = cached.length > 0 ? cached[0].timestamp : Infinity;
    const cachedEnd = cached.length > 0 ? cached[cached.length - 1].timestamp : -Infinity;

    const needBefore = startTs < cachedStart;
    const needAfter = endTs > cachedEnd;

    const newCandles: Candle1m[] = [];

    // Fetch before cached range
    if (needBefore && cached.length > 0) {
      const fetched = await this.fetchRange(symbol, startTs, Math.min(cachedStart - 60000, endTs));
      newCandles.push(...fetched);
    }

    // Fetch after cached range
    if (needAfter && cached.length > 0) {
      const fetched = await this.fetchRange(symbol, Math.max(cachedEnd + 60000, startTs), endTs);
      newCandles.push(...fetched);
    }

    // No cache at all — fetch entire range
    if (cached.length === 0) {
      const fetched = await this.fetchRange(symbol, startTs, endTs);
      newCandles.push(...fetched);
    }

    // Merge and deduplicate
    if (newCandles.length > 0) {
      const all = [...cached, ...newCandles];
      const seen = new Map<number, Candle1m>();
      for (const c of all) seen.set(c.timestamp, c);
      const merged = Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
      this.cache.set(symbol, merged);
    }

    // Return slice for requested range
    const result = (this.cache.get(symbol) || []).filter(
      c => c.timestamp >= startTs && c.timestamp <= endTs
    );
    return result;
  }

  private async fetchRange(symbol: string, startTs: number, endTs: number): Promise<Candle1m[]> {
    const candles: Candle1m[] = [];
    let since = startTs;

    while (since <= endTs) {
      try {
        const ohlcv = await this.exchange.fetchOHLCV(symbol, '1m', since, 1500);
        this.requestCount++;

        if (!ohlcv || ohlcv.length === 0) break;

        for (const c of ohlcv) {
          const ts = c[0] as number;
          if (ts > endTs) break;
          candles.push({
            timestamp: ts,
            open: c[1] as number,
            high: c[2] as number,
            low: c[3] as number,
            close: c[4] as number,
            volume: c[5] as number,
          });
        }

        since = (ohlcv[ohlcv.length - 1][0] as number) + 60000;
        if ((ohlcv[ohlcv.length - 1][0] as number) >= endTs) break;

        await new Promise(r => setTimeout(r, 100));
      } catch (err: any) {
        if (err.message?.includes('429')) {
          console.warn('  Rate limited, waiting 30s...');
          await new Promise(r => setTimeout(r, 30000));
        } else {
          console.warn(`  Fetch error: ${err.message}, retrying...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return candles;
  }

  getRequestCount() { return this.requestCount; }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP CALCULATOR (matches live logic)
// ═══════════════════════════════════════════════════════════════════════════

function getTrailingDistance(hwmPct: number): number {
  if (TRAILING.PROGRESSIVE_ENABLED) {
    if (hwmPct >= TRAILING.TIER3_AT_PCT) return TRAILING.TIER3_DISTANCE_PCT;
    if (hwmPct >= TRAILING.TIER2_AT_PCT) return TRAILING.TIER2_DISTANCE_PCT;
    if (hwmPct >= TRAILING.WIDEN_AT_PCT) return TRAILING.WIDE_DISTANCE_PCT;
  } else {
    if (hwmPct >= TRAILING.WIDEN_AT_PCT) return TRAILING.WIDE_DISTANCE_PCT;
  }
  return TRAILING.DISTANCE_PCT;
}

function calcTrailingStop(
  side: 'long' | 'short',
  entryPrice: number,
  hwm: number,
): { stopPrice: number; distancePct: number; hwmPct: number } {
  const hwmPct = side === 'long'
    ? ((hwm - entryPrice) / entryPrice) * 100
    : ((entryPrice - hwm) / entryPrice) * 100;

  const distancePct = getTrailingDistance(hwmPct);

  const stopPrice = side === 'long'
    ? hwm * (1 - distancePct / 100)
    : hwm * (1 + distancePct / 100);

  return { stopPrice, distancePct, hwmPct };
}

// ═══════════════════════════════════════════════════════════════════════════
// TRADE REPLAY WITH 1m EXHAUSTION
// ═══════════════════════════════════════════════════════════════════════════

interface ReplayResult {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  // Baseline (15m) exit
  baselineExitPrice: number;
  baselineExitTime: string;
  baselineHoldMin: number;
  baselinePnlUsd: number;
  // Exhaustion (1m) exit — null if exhaustion didn't trigger
  exhaustionExitPrice: number | null;
  exhaustionExitTime: string | null;
  exhaustionHoldMin: number | null;
  exhaustionPnlUsd: number | null;
  exhaustionScore: number | null;
  // Delta
  pnlDeltaUsd: number;
  timeDeltaMin: number;
  exitedEarlier: boolean;
  betterPrice: boolean;
}

function replayTradeWith1mExhaustion(
  trade: any,
  candles1m: Candle1m[],
  exhaustionCalc: MomentumExhaustionCalculator,
): ReplayResult {
  const side: 'long' | 'short' = trade.side;
  const entryPrice = trade.entryPrice;
  const entryTs = new Date(trade.entryTime).getTime();
  const exitTs = new Date(trade.exitTime).getTime();
  const leverage = trade.leverage || 5;
  const marginUsd = trade.marginUsd;

  // Filter 1m candles to trade window
  const tradeCandles = candles1m.filter(c => c.timestamp >= entryTs && c.timestamp <= exitTs);

  let hwm = entryPrice;
  let trailingActive = false;
  let exhaustionStopActive = false;
  let exhaustionStopPrice = 0;
  let exhaustionExitPrice: number | null = null;
  let exhaustionExitTs: number | null = null;
  let exhaustionScore: number | null = null;

  // Sliding window of recent 1m candles for exhaustion
  const recentCandles: ExhaustionCandle[] = [];

  for (const c of tradeCandles) {
    // 1. Check if existing exhaustion stop triggers on this 1m candle
    if (exhaustionStopActive && exhaustionStopPrice > 0) {
      const breached = side === 'long'
        ? c.low <= exhaustionStopPrice
        : c.high >= exhaustionStopPrice;

      if (breached) {
        exhaustionExitPrice = exhaustionStopPrice;
        exhaustionExitTs = c.timestamp;
        break;
      }
    }

    // 2. Update HWM
    if (side === 'long') {
      hwm = Math.max(hwm, c.high);
    } else {
      hwm = Math.min(hwm, c.low);
    }

    // 3. Check trailing activation
    const pnlPct = side === 'long'
      ? ((c.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - c.close) / entryPrice) * 100;

    if (!trailingActive && pnlPct >= TRAILING.ACTIVATION_PCT) {
      trailingActive = true;
    }

    if (!trailingActive) continue;

    // 4. Compute trailing stop
    const { stopPrice } = calcTrailingStop(side, entryPrice, hwm);

    // 5. Update exhaustion stop price to follow trailing
    if (exhaustionStopActive) {
      exhaustionStopPrice = stopPrice;
    }

    // 6. Add this 1m candle to history
    recentCandles.push({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    });
    if (recentCandles.length > 25) recentCandles.shift();

    // 7. Calculate exhaustion
    const result = exhaustionCalc.calculate(
      recentCandles, side, stopPrice, c.close,
    );

    if (result.shouldPlaceStop) {
      exhaustionStopActive = true;
      exhaustionStopPrice = stopPrice;
      exhaustionScore = result.score;
    } else if (exhaustionStopActive && result.score < exhaustionCalc.getConfig().CANCEL_THRESHOLD) {
      exhaustionStopActive = false;
      exhaustionStopPrice = 0;
    }
  }

  // Calculate PnL for exhaustion exit
  let exhaustionPnlUsd: number | null = null;
  let exhaustionHoldMin: number | null = null;
  if (exhaustionExitPrice !== null && exhaustionExitTs !== null) {
    const rawPnlPct = side === 'long'
      ? ((exhaustionExitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exhaustionExitPrice) / entryPrice) * 100;
    const feesPct = 0.04 * 2; // taker + maker
    const netPnlPct = (rawPnlPct * leverage) - feesPct;
    exhaustionPnlUsd = (netPnlPct / 100) * marginUsd;
    exhaustionHoldMin = (exhaustionExitTs - entryTs) / 60000;
  }

  const baseHoldMin = (exitTs - entryTs) / 60000;
  const pnlDelta = (exhaustionPnlUsd ?? trade.netPnlUsd) - trade.netPnlUsd;
  const timeDelta = (exhaustionHoldMin ?? baseHoldMin) - baseHoldMin;

  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    side,
    entryPrice,
    baselineExitPrice: trade.exitPrice,
    baselineExitTime: trade.exitTime,
    baselineHoldMin: baseHoldMin,
    baselinePnlUsd: trade.netPnlUsd,
    exhaustionExitPrice,
    exhaustionExitTime: exhaustionExitTs ? new Date(exhaustionExitTs).toISOString() : null,
    exhaustionHoldMin,
    exhaustionPnlUsd,
    exhaustionScore,
    pnlDeltaUsd: pnlDelta,
    timeDeltaMin: timeDelta,
    exitedEarlier: timeDelta < 0,
    betterPrice: pnlDelta > 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function loadBacktestData() {
  const startMs = PARAMS.startDate.getTime();
  const endMs = PARAMS.endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000;
  const since = startMs - extraBarsMs;

  const btcLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '15m');
  if (!btcLocal) throw new Error('No local BTC 15m data');
  const btcCandles = sliceCandlesByTime(btcLocal.candles, since, endMs);

  const btc1hLocal = await loadLocalJsonCandles('BTC/USDT:USDT', '1h');
  if (!btc1hLocal) throw new Error('No local BTC 1h data');
  const btcCandles1h = sliceCandlesByTime(btc1hLocal.candles, since, endMs);

  const allData: Record<string, any[]> = {};
  for (const symbol of SYMBOLS) {
    const local = await loadLocalJsonCandles(symbol, '15m');
    if (!local) continue;
    allData[symbol] = sliceCandlesByTime(local.candles, since, endMs);
  }

  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);

  return { btcCandles, btcCandles1h, allData, CANDLE_REGIME_INTERVAL_MS: configTfMin * 60 * 1000 };
}

async function runAnalysis(threshold: number) {
  const data = await loadBacktestData();

  // Step 1: Baseline backtest (exhaustion OFF)
  console.log('[1/3] Running baseline 15m backtest (exhaustion OFF)...');
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const baseline = await runBacktestComputation({ params: PARAMS, ...data });
  const b = baseline.summary;
  console.log(`  ${b.totalTrades} trades | PnL=$${b.totalPnlUsd.toFixed(0)} | WR=${b.winRate.toFixed(1)}% | DD=${b.maxDrawdownPct.toFixed(1)}%`);

  // Step 2: Identify trailing exit trades to replay
  const trailingExits = baseline.trades.filter((t: any) =>
    t.exitReason.startsWith('TRAIL') && !t.exitReason.includes('PROACTIVE')
  );
  console.log(`\n[2/3] Found ${trailingExits.length} trailing exit trades to analyze`);

  // Step 3: Fetch 1m candles and replay with exhaustion
  console.log(`[3/3] Fetching 1m candles from Binance & replaying with exhaustion (threshold=${threshold})...\n`);

  const fetcher = new CandleFetcher();
  await fetcher.init();

  const exhaustionCalc = new MomentumExhaustionCalculator({
    PLACEMENT_THRESHOLD: threshold,
    CANCEL_THRESHOLD: Math.max(20, threshold - 20),
    MIN_CANDLES: 10,
  });

  const results: ReplayResult[] = [];
  let processedCount = 0;

  // Group trades by symbol to batch fetch and use cache efficiently
  const bySymbol: Record<string, any[]> = {};
  for (const t of trailingExits) {
    (bySymbol[t.symbol] ??= []).push(t);
  }

  for (const [symbol, trades] of Object.entries(bySymbol)) {
    // Sort by entry time for cache efficiency
    trades.sort((a: any, b: any) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());

    for (const trade of trades) {
      processedCount++;
      const entryTs = new Date(trade.entryTime).getTime();
      const exitTs = new Date(trade.exitTime).getTime();

      // Fetch with 20-candle lookback for exhaustion warmup
      const lookback = 25 * 60 * 1000; // 25 minutes
      const candles1m = await fetcher.getCandles(symbol, entryTs - lookback, exitTs + 60000);

      const result = replayTradeWith1mExhaustion(trade, candles1m, exhaustionCalc);
      results.push(result);

      // Progress
      if (processedCount % 20 === 0 || processedCount === trailingExits.length) {
        process.stdout.write(`  Processed ${processedCount}/${trailingExits.length} trades (${fetcher.getRequestCount()} API requests)\r`);
      }
    }
  }
  console.log(''); // Clear progress line

  return { baseline, results, threshold };
}

function printResults(
  baseline: any,
  results: ReplayResult[],
  threshold: number,
) {
  const triggered = results.filter(r => r.exhaustionExitPrice !== null);
  const notTriggered = results.filter(r => r.exhaustionExitPrice === null);

  console.log('\n' + '='.repeat(75));
  console.log(`  EXHAUSTION DETECTOR ANALYSIS (1m resolution, threshold=${threshold})`);
  console.log('='.repeat(75));

  console.log(`\nTotal trailing exit trades analyzed: ${results.length}`);
  console.log(`  Exhaustion triggered:     ${triggered.length} (${(triggered.length / results.length * 100).toFixed(1)}%)`);
  console.log(`  Exhaustion NOT triggered: ${notTriggered.length}`);

  if (triggered.length === 0) {
    console.log('\nNo exhaustion exits detected. Try lowering the threshold.');
    return;
  }

  // Stats for triggered trades
  const betterPrice = triggered.filter(r => r.betterPrice);
  const exitedEarlier = triggered.filter(r => r.exitedEarlier);
  const totalPnlDelta = triggered.reduce((s, r) => s + r.pnlDeltaUsd, 0);
  const avgTimeDelta = triggered.reduce((s, r) => s + r.timeDeltaMin, 0) / triggered.length;

  console.log(`\n--- Exhaustion-triggered trades (${triggered.length}) ---`);
  console.log(`  Better price (higher PnL): ${betterPrice.length}/${triggered.length} (${(betterPrice.length / triggered.length * 100).toFixed(1)}%)`);
  console.log(`  Exited earlier:            ${exitedEarlier.length}/${triggered.length} (${(exitedEarlier.length / triggered.length * 100).toFixed(1)}%)`);
  console.log(`  Total PnL delta:           ${totalPnlDelta >= 0 ? '+' : ''}$${totalPnlDelta.toFixed(2)}`);
  console.log(`  Avg time delta:            ${avgTimeDelta.toFixed(1)} min`);

  // Winners vs losers in exhaustion trades
  const exhaustWins = triggered.filter(r => (r.exhaustionPnlUsd ?? 0) >= 0);
  const baselineWins = triggered.filter(r => r.baselinePnlUsd >= 0);
  console.log(`  Exhaustion WR:             ${(exhaustWins.length / triggered.length * 100).toFixed(1)}% (vs ${(baselineWins.length / triggered.length * 100).toFixed(1)}% baseline)`);

  // Per-trade detail (show first 20 + worst 5 + best 5)
  console.log(`\n--- Per-trade detail (first 20) ---`);
  console.log(`${'Symbol'.padEnd(18)} ${'Side'.padEnd(5)} ${'Base PnL'.padStart(10)} ${'Exh PnL'.padStart(10)} ${'Delta'.padStart(8)} ${'Time'.padStart(8)} ${'Score'.padStart(5)}`);
  console.log('-'.repeat(75));

  for (const r of triggered.slice(0, 20)) {
    const delta = r.pnlDeltaUsd;
    console.log(
      `${r.symbol.padEnd(18)} ${r.side.padEnd(5)} ` +
      `${('$' + r.baselinePnlUsd.toFixed(2)).padStart(10)} ` +
      `${('$' + (r.exhaustionPnlUsd ?? 0).toFixed(2)).padStart(10)} ` +
      `${((delta >= 0 ? '+' : '') + '$' + delta.toFixed(2)).padStart(8)} ` +
      `${r.timeDeltaMin.toFixed(0).padStart(6)}m ` +
      `${(r.exhaustionScore ?? 0).toFixed(0).padStart(5)}`
    );
  }

  // Best and worst
  const sorted = [...triggered].sort((a, b) => b.pnlDeltaUsd - a.pnlDeltaUsd);
  if (sorted.length > 5) {
    console.log(`\n--- Best 5 improvements ---`);
    for (const r of sorted.slice(0, 5)) {
      console.log(
        `  ${r.symbol.padEnd(18)} base=$${r.baselinePnlUsd.toFixed(2)} → exh=$${(r.exhaustionPnlUsd ?? 0).toFixed(2)} ` +
        `(${r.pnlDeltaUsd >= 0 ? '+' : ''}$${r.pnlDeltaUsd.toFixed(2)}) ${r.timeDeltaMin.toFixed(0)}min earlier`
      );
    }

    console.log(`\n--- Worst 5 (worse than baseline) ---`);
    for (const r of sorted.slice(-5).reverse()) {
      console.log(
        `  ${r.symbol.padEnd(18)} base=$${r.baselinePnlUsd.toFixed(2)} → exh=$${(r.exhaustionPnlUsd ?? 0).toFixed(2)} ` +
        `(${r.pnlDeltaUsd >= 0 ? '+' : ''}$${r.pnlDeltaUsd.toFixed(2)}) ${r.timeDeltaMin.toFixed(0)}min`
      );
    }
  }

  // Impact on overall PnL
  const b = baseline.summary;
  const adjustedPnl = b.totalPnlUsd + totalPnlDelta;
  console.log(`\n--- Impact on overall strategy ---`);
  console.log(`  Baseline PnL:    $${b.totalPnlUsd.toFixed(0)}`);
  console.log(`  Adjusted PnL:    $${adjustedPnl.toFixed(0)} (${totalPnlDelta >= 0 ? '+' : ''}$${totalPnlDelta.toFixed(0)})`);
  console.log(`  Change:          ${(totalPnlDelta / b.totalPnlUsd * 100).toFixed(2)}%`);
}

async function main() {
  const args = process.argv.slice(2);
  const sweepMode = args.includes('--sweep');

  let threshold = 65;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseInt(args[threshIdx + 1]);
  }

  if (sweepMode) {
    // Sweep thresholds
    console.log('Loading backtest data...');
    const data = await loadBacktestData();

    console.log('Running baseline...');
    (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
    const baseline = await runBacktestComputation({ params: PARAMS, ...data });
    const b = baseline.summary;
    console.log(`BASELINE: ${b.totalTrades} trades | PnL=$${b.totalPnlUsd.toFixed(0)}\n`);

    const trailingExits = baseline.trades.filter((t: any) =>
      t.exitReason.startsWith('TRAIL') && !t.exitReason.includes('PROACTIVE')
    );
    console.log(`${trailingExits.length} trailing exits to analyze`);

    const fetcher = new CandleFetcher();
    await fetcher.init();

    // Fetch all 1m data upfront (shared across threshold sweep)
    console.log('Fetching 1m candles for all trailing trades...');
    const tradeCandles: Map<string, Candle1m[]> = new Map();

    const bySymbol: Record<string, any[]> = {};
    for (const t of trailingExits) (bySymbol[t.symbol] ??= []).push(t);

    let fetchCount = 0;
    for (const [symbol, trades] of Object.entries(bySymbol)) {
      trades.sort((a: any, b: any) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
      for (const trade of trades) {
        fetchCount++;
        const entryTs = new Date(trade.entryTime).getTime();
        const exitTs = new Date(trade.exitTime).getTime();
        const candles = await fetcher.getCandles(symbol, entryTs - 25 * 60000, exitTs + 60000);
        tradeCandles.set(trade.id, candles);
        if (fetchCount % 20 === 0) process.stdout.write(`  Fetched ${fetchCount}/${trailingExits.length}\r`);
      }
    }
    console.log(`\nFetched all 1m data (${fetcher.getRequestCount()} API requests)\n`);

    // Now sweep thresholds (no more API calls needed)
    const thresholds = [35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
    console.log('Thresh | Triggered | Better$ | Earlier | PnL Delta  | Avg Time');
    console.log('-'.repeat(70));

    for (const thresh of thresholds) {
      const calc = new MomentumExhaustionCalculator({
        PLACEMENT_THRESHOLD: thresh,
        CANCEL_THRESHOLD: Math.max(20, thresh - 20),
        MIN_CANDLES: 10,
      });

      const results: ReplayResult[] = [];
      for (const trade of trailingExits) {
        const candles = tradeCandles.get(trade.id) || [];
        results.push(replayTradeWith1mExhaustion(trade, candles, calc));
      }

      const triggered = results.filter(r => r.exhaustionExitPrice !== null);
      const better = triggered.filter(r => r.betterPrice).length;
      const earlier = triggered.filter(r => r.exitedEarlier).length;
      const pnlDelta = triggered.reduce((s, r) => s + r.pnlDeltaUsd, 0);
      const avgTime = triggered.length > 0
        ? triggered.reduce((s, r) => s + r.timeDeltaMin, 0) / triggered.length
        : 0;

      console.log(
        `  ${String(thresh).padStart(3)}  | ` +
        `${String(triggered.length).padStart(5)}/${results.length} | ` +
        `${String(better).padStart(5)}   | ` +
        `${String(earlier).padStart(5)}   | ` +
        `${(pnlDelta >= 0 ? '+' : '') + '$' + pnlDelta.toFixed(0).padStart(7)} | ` +
        `${avgTime.toFixed(1)}min`
      );
    }
  } else {
    // Single threshold analysis
    console.log('Loading backtest data...');
    const { baseline, results, threshold: th } = await runAnalysis(threshold);
    printResults(baseline, results, th);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
