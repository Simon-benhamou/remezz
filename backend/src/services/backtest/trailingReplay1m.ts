/**
 * V5.113: 1m Post-Processing for Backtest Trailing Exits
 *
 * The backtest runs on 15m candles, so all trailing exits snap to 15m boundaries.
 * In live, the RT handler monitors 1m closes and the exhaustion detector places
 * STOP_MARKET orders that fill on any wick touch at the trailing price.
 *
 * This module replays trailing exits at 1m resolution AFTER the 15m backtest completes:
 *   Pass 1: runBacktestComputation() on worker thread (15m, fast, 0 API)
 *   Pass 2: postProcess1mTrailingExits() on main thread
 *           → fetch 1m candles per trailing trade window
 *           → replay exhaustion STOP_MARKET + 2-candle close confirmation
 *           → adjust exitPrice, exitTime, holdMinutes, PnL
 *           → recalculate summary/equity/drawdown
 *
 * V5.117: Full live-parity 1m replay with dynamic volatility adaptation:
 * - Exhaust STOP_MARKET fills at trailing stop price (better than close)
 * - 2-candle 1m close confirmation as fallback (matching live RT handler)
 * - Dynamic per-15m-boundary vol adaptation (aggregates 1m→15m on-the-fly,
 *   recomputes determineVolatilityRegime() at each boundary — matches live's
 *   shouldExitPosition() which gets fresh 15m candles every call)
 * - Exclude TRAIL_NFS_HIGH (already exits at trailing stop price — can only worsen)
 * - Exclude TRAIL_PROACTIVE (already handled by 15m MODE B)
 */

import { MomentumConfig } from '../../strategies/momentumSimple.js';
import { determineVolatilityRegime } from '../../strategies/indicators/technicalIndicators.js';
import {
  MomentumExhaustionCalculator,
  type ExhaustionCandle,
} from '../momentumExhaustion.js';
import { globalRestCircuitBreaker } from '../globalRestCircuitBreaker.js';
import { ipWeightTracker } from '../ipWeightTracker.js';
import type { BacktestResult, BacktestTrade, MonthlyStats } from '../backtestService.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface Candle1m {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ReplayResult {
  wasReplayed: boolean;
  exitPrice: number;
  exitTs: number;
  holdMinutes: number;
  netPnlUsd: number;
  grossPnlPct: number;
  netPnlPct: number;
  feesUsd: number;
  exitReason: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// A) Candle1mFetcher — adapted from scripts/analyze-exhaustion-1m.ts:79-147
// ═══════════════════════════════════════════════════════════════════════════

class Candle1mFetcher {
  private exchange: any;
  private cache: Map<string, Candle1m[]> = new Map();
  private _requestCount = 0;

  constructor(exchange: any) {
    this.exchange = exchange;
  }

  get requestCount(): number {
    return this._requestCount;
  }

  async getCandles(symbol: string, startTs: number, endTs: number): Promise<Candle1m[]> {
    const cached = this.cache.get(symbol) || [];
    const cachedStart = cached.length > 0 ? cached[0].timestamp : Infinity;
    const cachedEnd = cached.length > 0 ? cached[cached.length - 1].timestamp : -Infinity;
    const newCandles: Candle1m[] = [];

    if (cached.length === 0) {
      newCandles.push(...await this.fetchRange(symbol, startTs, endTs));
    } else {
      if (startTs < cachedStart) {
        newCandles.push(...await this.fetchRange(symbol, startTs, Math.min(cachedStart - 60000, endTs)));
      }
      if (endTs > cachedEnd) {
        newCandles.push(...await this.fetchRange(symbol, Math.max(cachedEnd + 60000, startTs), endTs));
      }
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
      // Rate limiting: circuit breaker + IP weight
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        console.warn(`[1m-replay] Circuit breaker OPEN, stopping fetch for ${symbol}`);
        break;
      }
      if (!ipWeightTracker.canMakeCall(10)) {
        const ok = await ipWeightTracker.waitForBudget(10, `1m-replay:${symbol}`, 60_000);
        if (!ok) {
          console.warn(`[1m-replay] IP weight budget exhausted for ${symbol}`);
          break;
        }
      }

      try {
        const ohlcv = await this.exchange.fetchOHLCV(symbol, '1m', since, 1500);
        ipWeightTracker.record(10, `1m-replay:${symbol}`);
        this._requestCount++;

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
        if (since > endTs) break;

        // Delay between requests
        await new Promise(r => setTimeout(r, 500));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('429') || msg.includes('418') || msg.includes('banned')) {
          console.warn(`[1m-replay] Rate limited on ${symbol}, waiting 30s...`);
          await new Promise(r => setTimeout(r, 30000));
        } else {
          console.warn(`[1m-replay] Fetch error for ${symbol}: ${msg}`);
          break;
        }
      }
    }

    return candles;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TRAILING STOP HELPERS — V5.117: Dynamic vol adaptation matching live
//
// Live's shouldExitPosition() (exitLogic.ts:209-446):
//   1. Calls determineVolatilityRegime(candles) → regime + baseDistance + activation
//   2. Computes volMultiplier from regime: LOW=0.8, MED=1.0, HIGH=1.6
//   3. Progressive tiers multiplied by volMultiplier
//   4. Below tier1: uses regime's baseDistance (no extra multiplier)
//
// The replay aggregates 1m→15m on-the-fly and recomputes the vol regime at
// each 15m boundary — matching live's dynamic per-call behavior exactly.
// ═══════════════════════════════════════════════════════════════════════════

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

interface VolState {
  regime: 'LOW' | 'MEDIUM' | 'HIGH';
  baseDistance: number;  // regime-specific base (0.3 LOW / 0.4 MED / 0.8 HIGH)
  activation: number;   // regime-specific activation (0.6 LOW / 1.0 MED / 1.2 HIGH)
  volMultiplier: number; // applied to progressive tier distances
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

  return {
    regime: volRegime.regime,
    baseDistance: volRegime.trailingDistance,
    activation: volRegime.trailingActivation,
    volMultiplier,
  };
}

// Aggregate 1m candles into completed 15m buckets
function aggregate1mTo15m(candles1m: Candle1m[]): { high: number; low: number; close: number }[] {
  const buckets = new Map<number, Candle1m[]>();
  for (const c of candles1m) {
    const bucket = Math.floor(c.timestamp / CANDLE_15M_MS) * CANDLE_15M_MS;
    const arr = buckets.get(bucket);
    if (arr) arr.push(c); else buckets.set(bucket, [c]);
  }
  const result: { high: number; low: number; close: number }[] = [];
  for (const [, cs] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (cs.length < 10) continue; // skip incomplete buckets
    result.push({
      high: Math.max(...cs.map(c => c.high)),
      low: Math.min(...cs.map(c => c.low)),
      close: cs[cs.length - 1].close,
    });
  }
  return result;
}

// Matches exitLogic.ts:388-446 exactly
function getTrailingDistance(hwmPct: number, vol: VolState): number {
  if (TIERS.PROGRESSIVE_ENABLED) {
    if (hwmPct >= TIERS.TIER3_AT_PCT) return TIERS.TIER3_DISTANCE_PCT * vol.volMultiplier;
    if (hwmPct >= TIERS.TIER2_AT_PCT) return TIERS.TIER2_DISTANCE_PCT * vol.volMultiplier;
    if (hwmPct >= TIERS.WIDEN_AT_PCT) return TIERS.WIDE_DISTANCE_PCT * vol.volMultiplier;
  } else {
    if (hwmPct >= TIERS.WIDEN_AT_PCT) return TIERS.WIDE_DISTANCE_PCT * vol.volMultiplier;
  }
  // Below tier1: use regime's base distance (no extra multiplier — matches live)
  return vol.baseDistance;
}

function calcTrailingStop(
  side: 'long' | 'short',
  entryPrice: number,
  hwm: number,
  vol: VolState,
): { stopPrice: number } {
  const hwmPct = side === 'long'
    ? ((hwm - entryPrice) / entryPrice) * 100
    : ((entryPrice - hwm) / entryPrice) * 100;
  const distancePct = getTrailingDistance(hwmPct, vol);
  const stopPrice = side === 'long'
    ? hwm * (1 - distancePct / 100)
    : hwm * (1 + distancePct / 100);
  return { stopPrice };
}

// ═══════════════════════════════════════════════════════════════════════════
// PNL CALCULATION (matches backtestService.ts CONFIG.COSTS)
// ═══════════════════════════════════════════════════════════════════════════

const COSTS = {
  TRADING_FEE_PCT: 0.04,
  SLIPPAGE_PCT: 0.05,
  FUNDING_RATE_PCT: 0.01,
  FUNDING_INTERVAL_BARS: 32, // 32 × 15min = 8h
};

function calculatePnl(
  entryPrice: number,
  exitPrice: number,
  side: 'long' | 'short',
  marginUsd: number,
  leverage: number,
  holdMinutes: number,
): { grossPnlPct: number; netPnlPct: number; netPnlUsd: number; feesUsd: number } {
  const pricePct = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;

  const notionalUsd = marginUsd * leverage;
  const grossPnlUsd = (pricePct / 100) * notionalUsd;

  const holdBars = holdMinutes / 15;
  const tradingFees = COSTS.TRADING_FEE_PCT * 2;
  const slippage = COSTS.SLIPPAGE_PCT * 2;
  const fundingPeriods = Math.floor(holdBars / COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * COSTS.FUNDING_RATE_PCT;

  const totalCostsNotionalPct = tradingFees + slippage + funding;
  const feesUsd = (totalCostsNotionalPct / 100) * notionalUsd;
  const netPnlUsd = grossPnlUsd - feesUsd;

  const grossPnlPct = (grossPnlUsd / marginUsd) * 100;
  const netPnlPct = (netPnlUsd / marginUsd) * 100;

  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd };
}

// ═══════════════════════════════════════════════════════════════════════════
// B) replayTradeAt1m — V5.117: full live-parity with dynamic vol adaptation
//
// Two exit mechanisms (whichever fires first):
//
// 1. EXHAUST STOP_MARKET:
//    - Exhaustion scoring on every 1m candle after trailing activates
//    - Score >= threshold → place STOP at trailing price
//    - STOP fills on first wick touch → exit at trailing stop price
//    - Score < cancel threshold → cancel STOP (hysteresis)
//
// 2. 2-CANDLE CLOSE CONFIRMATION (fallback, matches live RT handler):
//    - Check trailing breach on every 1m close
//    - 2 consecutive closes below stop → exit at close price
//
// Dynamic vol adaptation: aggregates 1m→15m incrementally, recomputes
// determineVolatilityRegime() at each 15m boundary (matching live exactly).
// ═══════════════════════════════════════════════════════════════════════════

const CONFIRM_CANDLES = 2; // Matches live: REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES

function replayTradeAt1m(
  trade: BacktestTrade,
  candles1m: Candle1m[],
  exhaustionCalc: MomentumExhaustionCalculator,
): ReplayResult {
  const side = trade.side;
  const entryPrice = trade.entryPrice;
  const entryTs = new Date(trade.entryTime).getTime();

  // Build initial 15m candles from warmup (before entry) for vol regime
  const warmupCandles = candles1m.filter(c => c.timestamp < entryTs);
  const candles15m = aggregate1mTo15m(warmupCandles);
  let vol = computeVolState(candles15m);

  // Track current 15m bucket for incremental updates
  let currentBucketTs = 0;
  let currentBucket: Candle1m[] = [];

  let hwm = entryPrice;
  let trailingActive = false;
  let breachCount = 0;

  // Exhaustion state
  let exhaustionStopActive = false;
  let exhaustionStopPrice = 0;
  const recentCandles: ExhaustionCandle[] = [];

  const tradeCandles = candles1m.filter(c => c.timestamp >= entryTs);

  for (const c of tradeCandles) {
    // ── 15m boundary: aggregate bucket and recompute vol regime ──
    const bucketTs = Math.floor(c.timestamp / CANDLE_15M_MS) * CANDLE_15M_MS;
    if (bucketTs !== currentBucketTs) {
      // Finalize previous 15m bucket
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

    // STEP 1: Check STOP_MARKET fill (exchange-level: triggers on wick)
    if (exhaustionStopActive && exhaustionStopPrice > 0) {
      const stopHit = side === 'long'
        ? c.low <= exhaustionStopPrice
        : c.high >= exhaustionStopPrice;

      if (stopHit) {
        const holdMinutes = (c.timestamp - entryTs) / 60000;
        const pnl = calculatePnl(entryPrice, exhaustionStopPrice, side, trade.marginUsd, trade.leverage, holdMinutes);
        return {
          wasReplayed: true,
          exitPrice: exhaustionStopPrice,
          exitTs: c.timestamp,
          holdMinutes,
          ...pnl,
          exitReason: trade.exitReason,
        };
      }
    }

    // STEP 2: Update HWM
    hwm = side === 'long' ? Math.max(hwm, c.high) : Math.min(hwm, c.low);

    // STEP 3: Check trailing activation (vol-adapted threshold)
    const pnlPct = side === 'long'
      ? ((c.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - c.close) / entryPrice) * 100;

    if (!trailingActive && pnlPct >= vol.activation) {
      trailingActive = true;
    }
    if (!trailingActive) continue;

    // STEP 4: Compute trailing stop (vol-adapted distances)
    const { stopPrice } = calcTrailingStop(side, entryPrice, hwm, vol);

    // STEP 5: Exhaustion scoring + STOP_MARKET placement/cancel
    if (exhaustionStopActive) {
      exhaustionStopPrice = stopPrice; // Follow trailing as HWM advances
    }

    recentCandles.push({
      timestamp: c.timestamp, open: c.open, high: c.high,
      low: c.low, close: c.close, volume: c.volume,
    });
    if (recentCandles.length > 25) recentCandles.shift();

    const result = exhaustionCalc.calculate(recentCandles, side, stopPrice, c.close);

    if (result.shouldPlaceStop && !exhaustionStopActive) {
      exhaustionStopActive = true;
      exhaustionStopPrice = stopPrice;
    } else if (exhaustionStopActive && result.score < exhaustionCalc.getConfig().CANCEL_THRESHOLD) {
      exhaustionStopActive = false;
      exhaustionStopPrice = 0;
    }

    // STEP 6: 2-candle close confirmation (fallback when exhaust doesn't fire)
    const closeBreached = side === 'long'
      ? c.close <= stopPrice
      : c.close >= stopPrice;

    if (closeBreached) {
      breachCount++;
      if (breachCount >= CONFIRM_CANDLES) {
        const holdMinutes = (c.timestamp - entryTs) / 60000;
        const pnl = calculatePnl(entryPrice, c.close, side, trade.marginUsd, trade.leverage, holdMinutes);
        return {
          wasReplayed: true,
          exitPrice: c.close,
          exitTs: c.timestamp,
          holdMinutes,
          ...pnl,
          exitReason: trade.exitReason,
        };
      }
    } else {
      breachCount = 0;
    }
  }

  // No 1m exit found → keep original 15m result
  return {
    wasReplayed: false,
    exitPrice: trade.exitPrice,
    exitTs: new Date(trade.exitTime).getTime(),
    holdMinutes: trade.holdMinutes,
    netPnlUsd: trade.netPnlUsd,
    grossPnlPct: trade.grossPnlPct,
    netPnlPct: trade.netPnlPct,
    feesUsd: trade.feesUsd,
    exitReason: trade.exitReason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// C) postProcess1mTrailingExits — orchestrator
// ═══════════════════════════════════════════════════════════════════════════

export async function postProcess1mTrailingExits(
  result: BacktestResult,
  exchange: any,
): Promise<BacktestResult> {
  // V5.116b: Filter trailing trades for replay
  // - Include: TRAIL, TRAIL_NFS_MED, TRAIL_NFS_LOW (exit at close → can improve with STOP at trailing price)
  // - Exclude: TRAIL_RT, TRAIL_EXCHANGE (live-only mechanisms)
  // - Exclude: TRAIL_PROACTIVE (already handled by 15m backtest MODE B)
  // - Exclude: TRAIL_NFS_HIGH (already exits at trailing stop price — replay can only worsen)
  const trailingTrades = result.trades.filter(t =>
    t.exitReason.startsWith('TRAIL') &&
    t.exitReason !== 'TRAIL_RT' &&
    t.exitReason !== 'TRAIL_EXCHANGE' &&
    t.exitReason !== 'TRAIL_PROACTIVE' &&
    t.exitReason !== 'TRAIL_NFS_HIGH'
  );

  if (trailingTrades.length === 0) {
    console.log(`[Backtest] 1m post-processing: no trailing trades to replay`);
    return result;
  }

  console.log(`[Backtest] 1m post-processing: ${trailingTrades.length} trailing trades to replay...`);

  const fetcher = new Candle1mFetcher(exchange);
  const exhaustionCalc = new MomentumExhaustionCalculator({
    PLACEMENT_THRESHOLD: (MomentumConfig.EXIT as any).EXHAUSTION_PLACEMENT_THRESHOLD ?? 35,
    CANCEL_THRESHOLD: (MomentumConfig.EXIT as any).EXHAUSTION_CANCEL_THRESHOLD ?? 20,
    MIN_CANDLES: (MomentumConfig.EXIT as any).EXHAUSTION_MIN_CANDLES ?? 10,
  });

  // Group by symbol, sort by entryTime (cache-friendly fetching)
  const bySymbol: Record<string, BacktestTrade[]> = {};
  for (const t of trailingTrades) {
    (bySymbol[t.symbol] ??= []).push(t);
  }
  for (const trades of Object.values(bySymbol)) {
    trades.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
  }

  // Build trade index for fast lookup
  const tradeIndex = new Map<string, number>();
  for (let i = 0; i < result.trades.length; i++) {
    tradeIndex.set(result.trades[i].id, i);
  }

  let replayedCount = 0;

  // V5.114: Save original PnLs BEFORE replaying — needed for incremental delta approach.
  // recalculateSummary must NOT rebuild the capital chain from scratch because trades
  // have concurrent positions (capital + capitalInUse). A linear rebuild makes later
  // trades oversized relative to recalculated capital, causing cascading losses and DD>100%.
  const originalPnls = new Map<string, { netPnlUsd: number; feesUsd: number }>();
  for (const t of result.trades) {
    originalPnls.set(t.id, { netPnlUsd: t.netPnlUsd, feesUsd: t.feesUsd });
  }

  for (const [symbol, trades] of Object.entries(bySymbol)) {
    for (const trade of trades) {
      try {
        const entryTs = new Date(trade.entryTime).getTime();
        const exitTs = new Date(trade.exitTime).getTime();

        // Fetch 1m with 4h warmup before entry (for ATR-14 on 15m = 14×15min)
        // + extension after exit. Cache makes this negligible cost for subsequent trades.
        const candles1m = await fetcher.getCandles(
          symbol,
          entryTs - 240 * 60000,
          exitTs + 30 * 60000,
        );

        if (candles1m.length === 0) continue;

        const replay = replayTradeAt1m(trade, candles1m, exhaustionCalc);

        if (replay.wasReplayed) {
          const idx = tradeIndex.get(trade.id);
          if (idx === undefined) continue;

          // Update trade in-place
          const t = result.trades[idx];
          t.exitPrice = replay.exitPrice;
          t.exitTime = new Date(replay.exitTs).toISOString();
          t.holdMinutes = replay.holdMinutes;
          t.netPnlUsd = replay.netPnlUsd;
          t.grossPnlPct = replay.grossPnlPct;
          t.netPnlPct = replay.netPnlPct;
          t.feesUsd = replay.feesUsd;
          t.exitReason = replay.exitReason;
          // V5.115: Update month/day to match new exit time
          t.month = t.exitTime.slice(0, 7);
          t.day = t.exitTime.slice(0, 10);
          replayedCount++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[1m-replay] Error replaying ${trade.id} (${symbol}): ${msg}`);
        // Graceful fallback: keep 15m result
      }
    }
  }

  console.log(`[Backtest] 1m post-processing: ${replayedCount} trades replayed, ${fetcher.requestCount} API requests`);

  if (replayedCount === 0) {
    return result;
  }

  // V5.114: Use incremental delta approach instead of full capital chain rebuild
  return recalculateSummaryIncremental(result, originalPnls);
}

// ═══════════════════════════════════════════════════════════════════════════
// D) recalculateSummaryIncremental — V5.114: delta-based approach
// ═══════════════════════════════════════════════════════════════════════════
//
// The old recalculateSummary rebuilt the capital chain linearly:
//   capitalAfter = capitalBefore + netPnlUsd  (for each trade sequentially)
//
// This is WRONG because the 15m backtest has concurrent positions:
//   capital (free) + capitalInUse (margins of open trades) = total equity
// When the 1m replay changes some trades' PnL, rebuilding linearly makes
// subsequent trades' position sizes disproportionate to the recalculated
// capital — cascading losses can drive capital below zero → DD > 100%.
//
// FIX: Keep the original capital chain (which correctly models concurrency)
// and apply PnL deltas incrementally. Each replayed trade shifts all
// subsequent capitalBefore/capitalAfter by the cumulative delta.

function recalculateSummaryIncremental(
  result: BacktestResult,
  originalPnls: Map<string, { netPnlUsd: number; feesUsd: number }>,
): BacktestResult {
  const trades = result.trades;
  const initialCapital = result.params.initialCapital;

  // Apply cumulative PnL deltas to the original capital chain (for trade-level display)
  let cumDelta = 0;
  for (const t of trades) {
    t.capitalBefore += cumDelta;
    t.capitalAfter += cumDelta;

    const orig = originalPnls.get(t.id);
    if (orig) {
      const pnlDelta = t.netPnlUsd - orig.netPnlUsd;
      if (pnlDelta !== 0) {
        t.capitalAfter += pnlDelta;
        cumDelta += pnlDelta;
      }
    }
  }

  // V5.115: Use cumulative realized PnL for equity/DD instead of capitalAfter.
  // The incremental delta approach keeps original position sizes but shifts the
  // capital chain — when total PnL delta is large relative to early capital,
  // capitalAfter can go negative (impossible in reality). Cumulative PnL gives
  // a robust equity curve: equity = initialCapital + sum(realized PnL to date).
  const finalCapital = initialCapital + trades.reduce((sum, t) => sum + t.netPnlUsd, 0);

  // Rebuild equity curve from cumulative realized PnL (sorted by exit time)
  const equityCurve: { date: string; equity: number }[] = [];
  const drawdownCurve: { date: string; drawdown: number }[] = [];
  let peakCapital = initialCapital;
  let maxDrawdown = 0;

  // Group PnL by exit day (using actual exit times, which may have changed)
  const dailyPnl = new Map<string, number>();
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.exitTime).getTime() - new Date(b.exitTime).getTime(),
  );
  for (const t of sortedTrades) {
    const day = new Date(t.exitTime).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) || 0) + t.netPnlUsd);
  }

  let equity = initialCapital;
  for (const [day, pnl] of [...dailyPnl.entries()].sort()) {
    equity += pnl;
    equityCurve.push({ date: day, equity });

    if (equity > peakCapital) peakCapital = equity;
    const drawdownPct = peakCapital > 0 ? ((peakCapital - equity) / peakCapital) * 100 : 0;
    if (drawdownPct > maxDrawdown) maxDrawdown = drawdownPct;
    drawdownCurve.push({ date: day, drawdown: drawdownPct });
  }

  // Rebuild monthly stats using cumulative PnL for capitalEnd
  const monthlyMap = new Map<string, BacktestTrade[]>();
  for (const t of trades) {
    if (!monthlyMap.has(t.month)) monthlyMap.set(t.month, []);
    monthlyMap.get(t.month)!.push(t);
  }

  const monthlyStats: MonthlyStats[] = [];
  let prevCap = initialCapital;

  for (const [month, monthTrades] of [...monthlyMap.entries()].sort()) {
    const wins = monthTrades.filter(t => t.netPnlUsd > 0).length;
    const losses = monthTrades.filter(t => t.netPnlUsd <= 0).length;
    const pnlUsd = monthTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const longTrades = monthTrades.filter(t => t.side === 'long').length;
    const shortTrades = monthTrades.filter(t => t.side === 'short').length;
    const capitalEnd = prevCap + pnlUsd;

    monthlyStats.push({
      month,
      trades: monthTrades.length,
      wins,
      losses,
      winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
      pnlUsd,
      pnlPct: prevCap > 0 ? (pnlUsd / prevCap) * 100 : 0,
      longTrades,
      shortTrades,
      avgTradeUsd: monthTrades.length > 0 ? pnlUsd / monthTrades.length : 0,
      maxWinUsd: monthTrades.length > 0 ? Math.max(...monthTrades.map(t => t.netPnlUsd)) : 0,
      maxLossUsd: monthTrades.length > 0 ? Math.min(...monthTrades.map(t => t.netPnlUsd)) : 0,
      capitalStart: prevCap,
      capitalEnd,
    });

    prevCap = capitalEnd;
  }

  // Rebuild summary
  const wins = trades.filter(t => t.netPnlUsd > 0);
  const losses = trades.filter(t => t.netPnlUsd <= 0);
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const totalFeesUsd = trades.reduce((sum, t) => sum + t.feesUsd, 0);
  const grossWins = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));

  // Sharpe ratio from equity curve
  const dailyReturns = equityCurve
    .map((e, i) => {
      if (i === 0) return 0;
      const prev = equityCurve[i - 1].equity;
      return prev > 0 ? ((e.equity - prev) / prev) * 100 : 0;
    })
    .slice(1);

  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / dailyReturns.length)
    : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(365) : 0;

  return {
    ...result,
    summary: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlUsd,
      totalPnlPct: (totalPnlUsd / initialCapital) * 100,
      maxDrawdownPct: maxDrawdown,
      avgTradeUsd: trades.length > 0 ? totalPnlUsd / trades.length : 0,
      avgWinUsd: wins.length > 0 ? grossWins / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      sharpeRatio,
      finalCapital,
      longTrades: trades.filter(t => t.side === 'long').length,
      shortTrades: trades.filter(t => t.side === 'short').length,
      avgHoldMinutes: trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length : 0,
      totalFeesUsd,
    },
    trades,
    monthlyStats,
    equityCurve,
    drawdownCurve,
  };
}
