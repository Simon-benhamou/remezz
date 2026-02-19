/**
 * Realistic live comparison: 15m-exit baseline vs exhaustion STOP_MARKET
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS SCRIPT EXISTS:
 * ═══════════════════════════════════════════════════════════════════════════
 * The 15m backtest gives trailing exits a "perfect" price (trailing stop
 * price, instant fill). But in live WITHOUT the exhaustion detector:
 * - Trailing breach happens intrabar (unknown time)
 * - We don't know until the 15m candle CLOSES
 * - Then we market order → fill at close price (potentially far from trailing)
 *
 * With the exhaustion detector, a STOP_MARKET sits on the exchange and
 * triggers INSTANTLY when the wick touches the trailing price.
 *
 * This script replays every trailing trade at 1m resolution with:
 * - BASELINE: only check exits at 15m boundaries → exit at 15m close price
 * - EXHAUSTION: STOP_MARKET fills at trailing price on first wick touch
 *   (fallback to 15m exit if exhaustion never triggers)
 *
 * The delta = the TRUE value of the exhaustion detector in live.
 *
 * Run: npx tsx scripts/analyze-exhaustion-1m.ts
 *   --threshold 55    (default 65)
 *   --sweep           (test thresholds 35-80)
 * ═══════════════════════════════════════════════════════════════════════════
 */
import * as ccxt from 'ccxt';
import { runBacktestComputation } from '../src/services/backtestService.js';
import { MomentumConfig } from '../src/strategies/momentumSimple.js';
import { determineVolatilityRegime } from '../src/strategies/indicators/technicalIndicators.js';
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

const CANDLE_15M_MS = 15 * 60 * 1000;

// Progressive tier thresholds (fixed — don't change with vol)
const TIERS = {
  WIDEN_AT_PCT: MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT,
  WIDE_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT,
  PROGRESSIVE_ENABLED: (MomentumConfig.EXIT as any).TRAILING_PROGRESSIVE_ENABLED ?? true,
  TIER2_AT_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER2_AT_PCT ?? 4.0,
  TIER2_DISTANCE_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER2_DISTANCE_PCT ?? 1.5,
  TIER3_AT_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER3_AT_PCT ?? 6.0,
  TIER3_DISTANCE_PCT: (MomentumConfig.EXIT as any).TRAILING_TIER3_DISTANCE_PCT ?? 2.5,
};

// V5.117: Dynamic vol adaptation matching live's shouldExitPosition()
interface VolState {
  regime: 'LOW' | 'MEDIUM' | 'HIGH';
  baseDistance: number;
  activation: number;
  volMultiplier: number;
}

function computeVolState(candles15m: { high: number; low: number; close: number }[]): VolState {
  const volAdaptEnabled = (MomentumConfig.EXIT as any).TRAILING_VOL_ADAPT_ENABLED ?? false;
  const volRegime = candles15m.length >= 14
    ? determineVolatilityRegime(candles15m)
    : { regime: 'MEDIUM' as const, trailingDistance: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
        trailingActivation: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT, atrPct: null, reason: 'insufficient_data' };

  let volMultiplier = 1.0;
  if (volAdaptEnabled) {
    const lowMult = (MomentumConfig.EXIT as any).TRAILING_VOL_LOW_MULT ?? 0.8;
    const medMult = (MomentumConfig.EXIT as any).TRAILING_VOL_MED_MULT ?? 1.0;
    const highMult = (MomentumConfig.EXIT as any).TRAILING_VOL_HIGH_MULT ?? 1.6;
    if (volRegime.regime === 'HIGH') volMultiplier = highMult;
    else if (volRegime.regime === 'LOW') volMultiplier = lowMult;
    else volMultiplier = medMult;
  }

  return { regime: volRegime.regime, baseDistance: volRegime.trailingDistance, activation: volRegime.trailingActivation, volMultiplier };
}

function aggregate1mTo15m(candles1m: Candle1m[]): { high: number; low: number; close: number }[] {
  const buckets = new Map<number, Candle1m[]>();
  for (const c of candles1m) {
    const bucket = Math.floor(c.timestamp / CANDLE_15M_MS) * CANDLE_15M_MS;
    const arr = buckets.get(bucket);
    if (arr) arr.push(c); else buckets.set(bucket, [c]);
  }
  const result: { high: number; low: number; close: number }[] = [];
  for (const [, cs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (cs.length < 10) continue;
    result.push({
      high: Math.max(...cs.map(c => c.high)),
      low: Math.min(...cs.map(c => c.low)),
      close: cs[cs.length - 1].close,
    });
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1m CANDLE FETCHER WITH CACHING
// ═══════════════════════════════════════════════════════════════════════════

type Candle1m = { timestamp: number; open: number; high: number; low: number; close: number; volume: number };

class CandleFetcher {
  private exchange: ccxt.binanceusdm;
  private cache: Map<string, Candle1m[]> = new Map();
  private requestCount = 0;

  constructor() {
    this.exchange = new ccxt.binanceusdm({ enableRateLimit: true });
  }

  async init() {
    await this.exchange.loadMarkets();
  }

  async getCandles(symbol: string, startTs: number, endTs: number): Promise<Candle1m[]> {
    const cached = this.cache.get(symbol) || [];
    const cachedStart = cached.length > 0 ? cached[0].timestamp : Infinity;
    const cachedEnd = cached.length > 0 ? cached[cached.length - 1].timestamp : -Infinity;
    const newCandles: Candle1m[] = [];

    if (needBefore(startTs, cachedStart) && cached.length > 0) {
      newCandles.push(...await this.fetchRange(symbol, startTs, Math.min(cachedStart - 60000, endTs)));
    }
    if (needAfter(endTs, cachedEnd) && cached.length > 0) {
      newCandles.push(...await this.fetchRange(symbol, Math.max(cachedEnd + 60000, startTs), endTs));
    }
    if (cached.length === 0) {
      newCandles.push(...await this.fetchRange(symbol, startTs, endTs));
    }

    if (newCandles.length > 0) {
      const seen = new Map<number, Candle1m>();
      for (const c of [...cached, ...newCandles]) seen.set(c.timestamp, c);
      this.cache.set(symbol, Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp));
    }

    return (this.cache.get(symbol) || []).filter(c => c.timestamp >= startTs && c.timestamp <= endTs);
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
          candles.push({ timestamp: ts, open: c[1] as number, high: c[2] as number, low: c[3] as number, close: c[4] as number, volume: c[5] as number });
        }
        since = (ohlcv[ohlcv.length - 1][0] as number) + 60000;
        if (since > endTs) break;
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

function needBefore(startTs: number, cachedStart: number) { return startTs < cachedStart; }
function needAfter(endTs: number, cachedEnd: number) { return endTs > cachedEnd; }

// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP CALCULATOR (matches live logic)
// ═══════════════════════════════════════════════════════════════════════════

function getTrailingDistance(hwmPct: number, vol: VolState): number {
  if (TIERS.PROGRESSIVE_ENABLED) {
    if (hwmPct >= TIERS.TIER3_AT_PCT) return TIERS.TIER3_DISTANCE_PCT * vol.volMultiplier;
    if (hwmPct >= TIERS.TIER2_AT_PCT) return TIERS.TIER2_DISTANCE_PCT * vol.volMultiplier;
    if (hwmPct >= TIERS.WIDEN_AT_PCT) return TIERS.WIDE_DISTANCE_PCT * vol.volMultiplier;
  } else {
    if (hwmPct >= TIERS.WIDEN_AT_PCT) return TIERS.WIDE_DISTANCE_PCT * vol.volMultiplier;
  }
  return vol.baseDistance;
}

function calcTrailingStop(
  side: 'long' | 'short', entryPrice: number, hwm: number, vol: VolState,
): { stopPrice: number; distancePct: number; hwmPct: number } {
  const hwmPct = side === 'long'
    ? ((hwm - entryPrice) / entryPrice) * 100
    : ((entryPrice - hwm) / entryPrice) * 100;
  const distancePct = getTrailingDistance(hwmPct, vol);
  const stopPrice = side === 'long'
    ? hwm * (1 - distancePct / 100)
    : hwm * (1 + distancePct / 100);
  return { stopPrice, distancePct, hwmPct };
}

// ═══════════════════════════════════════════════════════════════════════════
// PnL CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

function calcPnlUsd(
  side: string, entryPrice: number, exitPrice: number,
  marginUsd: number, leverage: number,
): number {
  const posValue = marginUsd * leverage;
  const grossPnl = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * posValue
    : ((entryPrice - exitPrice) / entryPrice) * posValue;
  const fees = posValue * 0.0007 * 2; // 7bps per side × 2
  return grossPnl - fees;
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED TRADE REPLAY
// ═══════════════════════════════════════════════════════════════════════════
//
// Three modes:
// - "15m_exit": Only checks trailing at 15m boundaries → exits at 15m close price.
//   This models the CURRENT live behavior without exhaustion.
//
// - "stop_market": Exhaustion scoring on every 1m candle. If STOP_MARKET placed,
//   it fills at trailing price on first wick touch. Fallback to 15m exit.
//   Approach A: pre-place stop, wait for trailing to be hit.
//
// - "market_exit": Exhaustion scoring on every 1m candle. When score >= threshold,
//   EXIT IMMEDIATELY at current close price (market order). No waiting for trailing.
//   Approach B: momentum is dead → get out NOW at current (better) price.

interface ReplayExit {
  exitPrice: number;
  exitTs: number;
  holdMin: number;
  pnlUsd: number;
  reason: 'STOP_MARKET' | 'MARKET_EXIT' | '15M_CLOSE' | 'FALLBACK';
  exhaustionScore?: number;
}

function is15mBoundary(candleTs: number): boolean {
  // 1m candle at timestamp T closes at T + 60s
  // A 15m bar close happens at multiples of 15min
  return (candleTs + 60000) % CANDLE_15M_MS === 0;
}

function replayTrade(
  trade: any,
  candles1m: Candle1m[],
  mode: '15m_exit' | 'stop_market' | 'market_exit',
  exhaustionCalc?: MomentumExhaustionCalculator,
): ReplayExit {
  const side: 'long' | 'short' = trade.side;
  const entryPrice = trade.entryPrice;
  const entryTs = new Date(trade.entryTime).getTime();
  const leverage = trade.leverage || 5;
  const marginUsd = trade.marginUsd;
  const useExhaustion = mode !== '15m_exit';

  // V5.117: Dynamic vol adaptation — aggregate 1m→15m, recompute at boundaries
  const warmupCandles = candles1m.filter(c => c.timestamp < entryTs);
  const candles15m = aggregate1mTo15m(warmupCandles);
  let vol = computeVolState(candles15m);
  let currentBucketTs = 0;
  let currentBucket: Candle1m[] = [];

  let hwm = entryPrice;
  let trailingActive = false;

  // Exhaustion state (for stop_market and market_exit modes)
  let exhaustionStopActive = false;
  let exhaustionStopPrice = 0;
  let lastExhaustionScore = 0;
  const recentCandles: ExhaustionCandle[] = [];

  const tradeCandles = candles1m.filter(c => c.timestamp >= entryTs);

  for (const c of tradeCandles) {
    // ── 15m boundary: aggregate bucket and recompute vol regime ──
    const bucketTs = Math.floor(c.timestamp / CANDLE_15M_MS) * CANDLE_15M_MS;
    if (bucketTs !== currentBucketTs) {
      if (currentBucket.length >= 10) {
        candles15m.push({
          high: Math.max(...currentBucket.map(x => x.high)),
          low: Math.min(...currentBucket.map(x => x.low)),
          close: currentBucket[currentBucket.length - 1].close,
        });
        vol = computeVolState(candles15m);
      }
      currentBucket = [];
      currentBucketTs = bucketTs;
    }
    currentBucket.push(c);

    // ── STEP 1: Check STOP_MARKET fill (stop_market mode only) ──
    // Exchange-level check: triggers on wick, BEFORE candle closes
    if (mode === 'stop_market' && exhaustionStopActive && exhaustionStopPrice > 0) {
      const stopHit = side === 'long'
        ? c.low <= exhaustionStopPrice
        : c.high >= exhaustionStopPrice;

      if (stopHit) {
        const holdMin = (c.timestamp - entryTs) / 60000;
        return {
          exitPrice: exhaustionStopPrice,
          exitTs: c.timestamp,
          holdMin,
          pnlUsd: calcPnlUsd(side, entryPrice, exhaustionStopPrice, marginUsd, leverage),
          reason: 'STOP_MARKET',
          exhaustionScore: lastExhaustionScore,
        };
      }
    }

    // ── STEP 2: Update HWM ──
    hwm = side === 'long' ? Math.max(hwm, c.high) : Math.min(hwm, c.low);

    // ── STEP 3: Check trailing activation (vol-adapted threshold) ──
    const pnlPct = side === 'long'
      ? ((c.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - c.close) / entryPrice) * 100;

    if (!trailingActive && pnlPct >= vol.activation) {
      trailingActive = true;
    }
    if (!trailingActive) continue;

    // ── STEP 4: Compute trailing stop (vol-adapted distances) ──
    const { stopPrice } = calcTrailingStop(side, entryPrice, hwm, vol);

    // ── STEP 5: Exhaustion scoring (stop_market & market_exit modes) ──
    if (useExhaustion && exhaustionCalc) {
      if (exhaustionStopActive) {
        exhaustionStopPrice = stopPrice; // Follow trailing as HWM advances
      }

      recentCandles.push({
        timestamp: c.timestamp, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume,
      });
      if (recentCandles.length > 25) recentCandles.shift();

      const result = exhaustionCalc.calculate(recentCandles, side, stopPrice, c.close);
      lastExhaustionScore = result.score;

      if (mode === 'market_exit') {
        // ── Approach B: Exit IMMEDIATELY at current price when exhaustion triggers ──
        // Momentum is dead → get out NOW. Price is still above trailing (better price).
        if (result.shouldPlaceStop) {
          const holdMin = (c.timestamp - entryTs) / 60000;
          return {
            exitPrice: c.close,
            exitTs: c.timestamp,
            holdMin,
            pnlUsd: calcPnlUsd(side, entryPrice, c.close, marginUsd, leverage),
            reason: 'MARKET_EXIT',
            exhaustionScore: result.score,
          };
        }
      } else {
        // ── Approach A: Place/cancel STOP_MARKET with hysteresis ──
        if (result.shouldPlaceStop && !exhaustionStopActive) {
          exhaustionStopActive = true;
          exhaustionStopPrice = stopPrice;
        } else if (exhaustionStopActive && result.score < exhaustionCalc.getConfig().CANCEL_THRESHOLD) {
          exhaustionStopActive = false;
          exhaustionStopPrice = 0;
        }
      }
    }

    // ── STEP 6: 15m boundary exit check (fallback for all modes) ──
    // This models live behavior: we only DETECT the trailing breach
    // when the 15m candle closes, and exit at the close price (market order)
    if (is15mBoundary(c.timestamp)) {
      const closeBreached = side === 'long'
        ? c.close <= stopPrice
        : c.close >= stopPrice;

      if (closeBreached) {
        const holdMin = (c.timestamp - entryTs) / 60000;
        return {
          exitPrice: c.close,
          exitTs: c.timestamp,
          holdMin,
          pnlUsd: calcPnlUsd(side, entryPrice, c.close, marginUsd, leverage),
          reason: '15M_CLOSE',
        };
      }
    }
  }

  // No exit found in 1m data → use the 15m backtest exit as fallback
  const exitTs = new Date(trade.exitTime).getTime();
  return {
    exitPrice: trade.exitPrice,
    exitTs,
    holdMin: (exitTs - entryTs) / 60000,
    pnlUsd: trade.netPnlUsd,
    reason: 'FALLBACK',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKTEST DATA LOADER
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

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const sweepMode = args.includes('--sweep');
  let threshold = 65;
  const threshIdx = args.indexOf('--threshold');
  if (threshIdx !== -1 && args[threshIdx + 1]) {
    threshold = parseInt(args[threshIdx + 1]);
  }

  // ── Step 1: Run 15m baseline backtest ──
  console.log('Loading backtest data...');
  const data = await loadBacktestData();

  console.log('Running 15m baseline backtest (exhaustion OFF)...');
  (MomentumConfig.EXIT as any).EXHAUSTION_STOP_ENABLED = false;
  const baseline = await runBacktestComputation({ params: PARAMS, ...data });
  const b = baseline.summary;
  console.log(`BASELINE: ${b.totalTrades} trades | PnL=$${b.totalPnlUsd.toFixed(0)} | WR=${b.winRate.toFixed(1)}%\n`);

  // ── Step 2: Identify trailing exit trades ──
  const trailingExits = baseline.trades.filter((t: any) =>
    t.exitReason.startsWith('TRAIL') &&
    !t.exitReason.includes('PROACTIVE') &&
    t.exitReason !== 'TRAIL_NFS_HIGH'  // Already exits at trailing stop price — replay can only worsen
  );
  console.log(`${trailingExits.length} trailing exits to replay at 1m resolution`);

  // ── Step 3: Fetch 1m candles for all trailing trades ──
  const fetcher = new CandleFetcher();
  await fetcher.init();

  console.log('Fetching 1m candles from Binance...');
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
      // Fetch with 4h warmup before entry (for ATR-14 on 15m vol regime)
      // + 30min extension after exit (15m exit might happen slightly later)
      const candles = await fetcher.getCandles(
        symbol,
        entryTs - 240 * 60000,
        exitTs + 30 * 60000,
      );
      tradeCandles.set(trade.id, candles);
      if (fetchCount % 20 === 0) process.stdout.write(`  Fetched ${fetchCount}/${trailingExits.length}\r`);
    }
  }
  console.log(`\nFetched all 1m data (${fetcher.getRequestCount()} API requests)\n`);

  // ── Step 4: Replay baseline (15m exit) for all trades ──
  // This is constant across all thresholds
  console.log('Replaying baseline (15m-close exit)...');
  const baselineResults: Map<string, ReplayExit> = new Map();
  let baselineTotalPnl = 0;
  let baseline15mExits = 0;
  let baselineFallbacks = 0;

  for (const trade of trailingExits) {
    const candles = tradeCandles.get(trade.id) || [];
    const result = replayTrade(trade, candles, '15m_exit');
    baselineResults.set(trade.id, result);
    baselineTotalPnl += result.pnlUsd;
    if (result.reason === '15M_CLOSE') baseline15mExits++;
    else baselineFallbacks++;
  }

  console.log(`  15m-close exits: ${baseline15mExits} | fallbacks: ${baselineFallbacks} | total PnL: $${baselineTotalPnl.toFixed(0)}`);

  // Compare to 15m backtest PnL (for these same trades)
  const bt15mTrailPnl = trailingExits.reduce((s: number, t: any) => s + t.netPnlUsd, 0);
  console.log(`  15m backtest PnL (same trades): $${bt15mTrailPnl.toFixed(0)} (${baselineTotalPnl < bt15mTrailPnl ? '' : '+'}$${(baselineTotalPnl - bt15mTrailPnl).toFixed(0)} realistic penalty)\n`);

  // ── Step 5: Sweep exhaustion thresholds — compare all 3 approaches ──
  const thresholds = sweepMode ? [35, 40, 45, 50, 55, 60, 65, 70, 75, 80] : [threshold];

  console.log('═'.repeat(120));
  console.log('  REALISTIC LIVE COMPARISON: 3 approaches × threshold sweep');
  console.log('  Baseline = 15m-close exit (no exhaustion). A = STOP_MARKET at trailing. B = Market exit NOW at current price.');
  console.log('═'.repeat(120));
  console.log(`  Baseline PnL: $${baselineTotalPnl.toFixed(0)} across ${trailingExits.length} trailing trades`);
  console.log(`  15m backtest PnL: $${bt15mTrailPnl.toFixed(0)} (unrealistic — instant fill at trailing)\n`);

  const hdr =
    'Thresh'.padStart(6) + ' │ ' +
    '── Approach A: STOP_MARKET ──────────────'.padEnd(42) + '│ ' +
    '── Approach B: Market Exit NOW ──────────'.padEnd(42) + '│ ' +
    'B-A'.padStart(8);
  const hdr2 =
    ''.padStart(6) + ' │ ' +
    'Fills'.padStart(7) + '  ' + 'PnL'.padStart(9) + '  ' + 'Delta'.padStart(9) + '  ' + 'Δ%'.padStart(6) + '  ' + 'Time↓'.padStart(6) +
    ' │ ' +
    'Exits'.padStart(7) + '  ' + 'PnL'.padStart(9) + '  ' + 'Delta'.padStart(9) + '  ' + 'Δ%'.padStart(6) + '  ' + 'Time↓'.padStart(6) +
    ' │ ' +
    'ΔPnL'.padStart(8);
  console.log(hdr);
  console.log(hdr2);
  console.log('─'.repeat(120));

  for (const thresh of thresholds) {
    const calc = new MomentumExhaustionCalculator({
      PLACEMENT_THRESHOLD: thresh,
      CANCEL_THRESHOLD: Math.max(20, thresh - 20),
      MIN_CANDLES: 10,
    });

    // Run Approach A (STOP_MARKET) and Approach B (Market Exit) for each trade
    let aPnl = 0, bPnl = 0;
    let aFills = 0, bExits = 0;
    let aTimeSum = 0, aTimeN = 0, bTimeSum = 0, bTimeN = 0;

    for (const trade of trailingExits) {
      const candles = tradeCandles.get(trade.id) || [];
      const baseResult = baselineResults.get(trade.id)!;

      // Approach A
      const aResult = replayTrade(trade, candles, 'stop_market', calc);
      aPnl += aResult.pnlUsd;
      if (aResult.reason === 'STOP_MARKET') {
        aFills++;
        aTimeSum += baseResult.holdMin - aResult.holdMin;
        aTimeN++;
      }

      // Approach B
      const bResult = replayTrade(trade, candles, 'market_exit', calc);
      bPnl += bResult.pnlUsd;
      if (bResult.reason === 'MARKET_EXIT') {
        bExits++;
        bTimeSum += baseResult.holdMin - bResult.holdMin;
        bTimeN++;
      }
    }

    const aDelta = aPnl - baselineTotalPnl;
    const bDelta = bPnl - baselineTotalPnl;
    const aDeltaPct = (aDelta / Math.abs(baselineTotalPnl)) * 100;
    const bDeltaPct = (bDelta / Math.abs(baselineTotalPnl)) * 100;
    const aAvgTime = aTimeN > 0 ? aTimeSum / aTimeN : 0;
    const bAvgTime = bTimeN > 0 ? bTimeSum / bTimeN : 0;
    const bMinusA = bPnl - aPnl;

    console.log(
      String(thresh).padStart(6) + ' │ ' +
      `${aFills}`.padStart(4) + '/582' + '  ' +
      `$${aPnl.toFixed(0)}`.padStart(9) + '  ' +
      `${aDelta >= 0 ? '+' : ''}$${aDelta.toFixed(0)}`.padStart(9) + '  ' +
      `${aDelta >= 0 ? '+' : ''}${aDeltaPct.toFixed(1)}%`.padStart(6) + '  ' +
      `${aAvgTime.toFixed(0)}m`.padStart(6) +
      ' │ ' +
      `${bExits}`.padStart(4) + '/582' + '  ' +
      `$${bPnl.toFixed(0)}`.padStart(9) + '  ' +
      `${bDelta >= 0 ? '+' : ''}$${bDelta.toFixed(0)}`.padStart(9) + '  ' +
      `${bDelta >= 0 ? '+' : ''}${bDeltaPct.toFixed(1)}%`.padStart(6) + '  ' +
      `${bAvgTime.toFixed(0)}m`.padStart(6) +
      ' │ ' +
      `${bMinusA >= 0 ? '+' : ''}$${bMinusA.toFixed(0)}`.padStart(8)
    );
  }

  console.log('─'.repeat(120));
  console.log(`\n  Legend:`);
  console.log(`    Baseline: Exit at 15m candle close when trailing is breached (current live behavior)`);
  console.log(`    A (STOP_MARKET): Exhaustion triggers → place stop at trailing → fills on wick touch`);
  console.log(`    B (Market Exit): Exhaustion triggers → exit NOW at 1m close price (above trailing)`);
  console.log(`    B-A: How much better approach B is vs approach A`);
  console.log(`    Time↓: Average minutes saved vs baseline (earlier exit)`);
  console.log(`\n  Realistic penalty (15m-close vs backtest): $${(baselineTotalPnl - bt15mTrailPnl).toFixed(0)}`);
  console.log(`  The exhaustion detector recovers part of this by exiting faster/better.\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
