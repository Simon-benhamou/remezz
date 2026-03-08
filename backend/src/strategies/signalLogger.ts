/**
 * signalLogger.ts — Fire-and-forget signal logging service.
 *
 * Logs every signal event (traded or filtered) to the Signal table for
 * post-hoc analysis of rejection reasons, feature distributions, etc.
 *
 * CRITICAL: This service must NEVER block or crash trading.
 * All DB writes are async, wrapped in try/catch, errors logged as warnings.
 */

import { prisma, Prisma } from '../db/client.js';
import { createLogger } from '../utils/logger.js';
import {
  calcADX,
  calcATR,
  calcGreenRatio,
  calcAlternation5,
  calcBBTouchCount,
  calcBBPosition,
  calcTrendStrength,
  calcSMA,
  calcBollingerBands,
  calcROC,
} from './indicators/technicalIndicators.js';
import { MomentumConfig, type Candle, type SignalResult } from './config/momentumConfig.js';

const logger = createLogger('signal-logger');

// ============================================================================
// TYPES
// ============================================================================

export type SignalStatus =
  | 'traded'
  | 'filtered_blacklist'
  | 'filtered_toxic_hour'
  | 'filtered_regime_recheck'
  | 'filtered_max_positions'
  | 'filtered_ranking'
  | 'filtered_capital'
  | 'filtered_skip_rule'
  | 'filtered_exchange_position'
  | 'filtered_exchange_sync';

export interface SignalContext {
  userId?: string;
  sessionId?: string;
  symbol: string;
  signal: SignalResult;
  candles: Candle[];
  btcCandles: Candle[];
  score?: number;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Save a signal event to the database (fire-and-forget).
 * Computes additional features from candles, never blocks trading.
 *
 * @param ctx - Signal context with candles and signal result
 * @param status - What happened to this signal (traded, filtered_xxx)
 * @param tradeId - Optional trade ID if status === 'traded'
 */
export function saveSignal(
  ctx: SignalContext,
  status: SignalStatus,
  tradeId?: string,
): void {
  // Fire and forget — do NOT await
  _saveSignalAsync(ctx, status, tradeId).catch((err) => {
    logger.warn(`Signal log failed (${status}/${ctx.symbol}): ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function _saveSignalAsync(
  ctx: SignalContext,
  status: SignalStatus,
  tradeId?: string,
): Promise<void> {
  const { userId, sessionId, symbol, signal, candles, btcCandles, score } = ctx;
  const side = signal.side || 'long';
  const f = signal.features;

  // Temporal context
  const lastCandle = candles.length > 0 ? candles[candles.length - 1] : null;
  const candleTs = lastCandle ? new Date(lastCandle.timestamp) : null;
  const now = new Date();
  const hour = now.getUTCHours();
  const dayOfWeek = now.getUTCDay();
  const confidence = signal.confidence ?? null;

  // Candle OHLCV
  const candleOpen = lastCandle?.open ?? null;
  const candleHigh = lastCandle?.high ?? null;
  const candleLow = lastCandle?.low ?? null;
  const candleClose = lastCandle?.close ?? null;
  const candleVolume = lastCandle?.volume ?? null;

  // Compute features from candles
  let adx: number | null = null;
  let greenRatio: number | null = null;
  let alternation5: number | null = null;
  let bbTouches: number | null = null;
  let rangePosition: number | null = null;
  let atrPct: number | null = null;
  let trendStrength: number | null = null;
  let bbMa20: number | null = null;
  let atr14Raw: number | null = null;
  let rocAcceleration: number | null = null;
  let bbPosition: number | null = null;

  try {
    if (candles.length > 0) {
      const lastClose = candles[candles.length - 1].close;
      const closes = candles.map(c => c.close);

      adx = candles.length >= 29 ? calcADX(candles, 14) : null;

      greenRatio = calcGreenRatio(candles, 10);

      alternation5 = calcAlternation5(candles);

      bbTouches = calcBBTouchCount(
        candles,
        MomentumConfig.CANDLE_PATTERN_FILTER.BB_TOUCH_LOOKBACK,
        MomentumConfig.ENTRY.BB_PERIOD,
        MomentumConfig.CANDLE_PATTERN_FILTER.BB_TOUCH_THRESHOLD,
      );

      // True 20-candle high-low range position
      const rpCandles = candles.slice(-20);
      const rpHigh = Math.max(...rpCandles.map(c => c.high));
      const rpLow = Math.min(...rpCandles.map(c => c.low));
      rangePosition = rpHigh > rpLow ? (lastClose - rpLow) / (rpHigh - rpLow) : 0.5;

      // BB position for extras JSON
      bbPosition = calcBBPosition(candles, 20, 2);

      atr14Raw = calcATR(candles, 14);
      atrPct = atr14Raw && lastClose > 0 ? (atr14Raw / lastClose) * 100 : null;

      trendStrength = calcTrendStrength(closes, 50);

      // BB middle band (MA20)
      if (closes.length >= 20) {
        const bb = calcBollingerBands(closes, 20, 2);
        bbMa20 = bb.middle;
      }

      // ROC acceleration: roc10 - roc10_prev (momentum change)
      if (closes.length >= 12) {
        const roc10Now = calcROC(closes, 10);
        const roc10Prev = calcROC(closes.slice(0, -1), 10);
        rocAcceleration = (roc10Now - roc10Prev) * 100;
      }
    }
  } catch (err) {
    // Feature computation failure is not critical — log and continue with nulls
    logger.debug(`Feature computation failed for ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // BTC context
  let btcPrice: number | null = null;
  let btcRegime: string | null = null;
  let btcSma200: number | null = null;
  let btcDistSma200: number | null = null;
  let btcAtr: number | null = null;
  let btcRoc1h: number | null = null;
  try {
    if (btcCandles.length > 0) {
      btcPrice = btcCandles[btcCandles.length - 1].close;
      const btcCloses = btcCandles.map(c => c.close);

      // BTC SMA200 + distance
      if (btcCloses.length >= 200) {
        btcSma200 = calcSMA(btcCloses, 200);
        if (btcSma200 > 0) {
          btcDistSma200 = ((btcPrice - btcSma200) / btcSma200) * 100;
        }
      }

      // BTC ATR as % of price
      const btcAtrRaw = calcATR(btcCandles, 14);
      if (btcAtrRaw && btcPrice > 0) {
        btcAtr = (btcAtrRaw / btcPrice) * 100;
      }

      // BTC ROC 1h: 4 x 15m = 1h
      if (btcCloses.length >= 5) {
        btcRoc1h = calcROC(btcCloses, 4) * 100;
      }
    }
    if (f) {
      btcRegime = f.btcInBullRegime ? 'BULL' : (f.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
    }
  } catch {
    // Non-critical
  }

  // Extensible extras — use Prisma-compatible JSON (no undefined values)
  let extras: Record<string, number | string | boolean | null> | null = null;
  try {
    extras = {
      trendStrength: trendStrength ?? null,
      bbPosition: bbPosition ?? null,
      rocAcceleration: rocAcceleration ?? null,
      btcMomentum6h: f?.btcMomentum6h ?? null,
      btcChange24h: (f as any)?.btcChange24h ?? null, // V5.147: BTC 24h % change for parity diagnostics
      signalReason: signal.reason ?? null,
    };
  } catch {
    // Non-critical
  }

  await prisma.signal.create({
    data: {
      userId: userId || null,
      sessionId: sessionId || null,
      symbol,
      side,
      status,
      score: score ?? null,
      reason: signal.reason || null,

      // Temporal context
      candleTs,
      confidence,
      hour,
      dayOfWeek,

      // Signal features
      roc10: f?.roc ?? null,
      roc5: f?.roc5 ?? null,
      roc1: f?.roc1 ?? null,
      volRatio: f?.volRatio ?? null,
      stochRsi: f?.stochRsi ?? null,
      bbUpper: f?.bbUpper ?? null,
      bbLower: f?.bbLower ?? null,
      bbMa20,

      // Computed features
      adx,
      greenRatio,
      alternation5,
      bbTouches,
      rangePosition,
      atrPct,
      trendStrength,
      consecUp: f?.consecUp ?? null,
      consecDown: f?.consecDown ?? null,
      atr14: atr14Raw,

      // BTC context
      btcPrice,
      btcRegime,
      btcSma200,
      btcDistSma200,
      btcAtr,
      btcRoc1h,

      // Candle OHLCV
      candleOpen,
      candleHigh,
      candleLow,
      candleClose,
      candleVolume,

      // Extensible extras
      extras: extras ?? Prisma.JsonNull,

      // Trade link
      tradeId: tradeId || null,
    },
  });
}
