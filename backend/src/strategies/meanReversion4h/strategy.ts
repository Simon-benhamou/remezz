import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig, Candle } from '../types.js';
import { calcBB, calcADX } from '../indicators/technicalIndicators.js';
import { MEAN_REV_4H_CONFIG } from './config.js';

// ============================================================================
// RSI calculation (14-period, inline)
// ============================================================================

function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================================
// Volume ratio: current / avg of last 20 candles
// ============================================================================

function calcVolumeRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

// ============================================================================
// MeanReversion4hStrategy
// ============================================================================

export class MeanReversion4hStrategy implements IStrategy {
  readonly name = 'meanReversion4h';

  getConfig(): StrategyConfig {
    return {
      name: 'meanReversion4h',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 2,
      maxPositions: 2,
      positionSizePct: 0.05,
      minCandlesRequired: (MEAN_REV_4H_CONFIG.BB_PERIOD + 20) * MEAN_REV_4H_CONFIG.CANDLE_AGGREGATE, // 640
      timeframeMs: 4 * 60 * 60 * 1000, // 4h
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  /**
   * Aggregate 15m candles into 4h candles by timestamp boundary.
   * Only completed 4h buckets are returned (no look-ahead bias).
   */
  private aggregateTo4h(candles15m: Candle[]): Candle[] {
    const agg: Candle[] = [];
    const step = MEAN_REV_4H_CONFIG.CANDLE_AGGREGATE; // 16
    const fourHourMs = 4 * 60 * 60 * 1000;

    let bucket: Candle[] = [];
    let bucketStart = 0;

    for (const c of candles15m) {
      const boundary = Math.floor(c.timestamp / fourHourMs) * fourHourMs;
      if (boundary !== bucketStart && bucket.length > 0) {
        // Close previous bucket — only add if complete (16 candles)
        if (bucket.length === step) {
          agg.push({
            timestamp: bucketStart,
            open: bucket[0].open,
            high: Math.max(...bucket.map(b => b.high)),
            low: Math.min(...bucket.map(b => b.low)),
            close: bucket[bucket.length - 1].close,
            volume: bucket.reduce((s, b) => s + b.volume, 0),
          });
        }
        bucket = [];
      }
      bucketStart = boundary;
      bucket.push(c);
    }
    // Don't add incomplete last bucket (avoid look-ahead bias)
    // Only add if bucket has all 16 candles
    if (bucket.length === step) {
      agg.push({
        timestamp: bucketStart,
        open: bucket[0].open,
        high: Math.max(...bucket.map(b => b.high)),
        low: Math.min(...bucket.map(b => b.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((s, b) => s + b.volume, 0),
      });
    }
    return agg;
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles, currentPrice } = ctx;
    const cfg = MEAN_REV_4H_CONFIG;

    // 1. Aggregate 15m candles to 4h
    const candles4h = this.aggregateTo4h(candles);
    const minCandles4h = cfg.BB_PERIOD + 20;

    if (candles4h.length < minCandles4h) return null;

    const closes = candles4h.map(c => c.close);
    const volumes = candles4h.map(c => c.volume);

    // 2. Bollinger Bands on 4h closes
    const bb = calcBB(closes, cfg.BB_PERIOD, cfg.BB_STD_ENTRY);

    // 3. RSI on 4h closes
    const rsi = calcRSI(closes, cfg.RSI_PERIOD);

    // 4. Volume ratio on 4h volumes
    const volumeRatio = calcVolumeRatio(volumes);
    if (volumeRatio < cfg.VOLUME_MIN) return null;

    // 5. ADX on 4h candles — skip if trending too hard
    const adx = calcADX(candles4h, 14);
    if (adx > cfg.ADX_MAX) return null;

    // 6. Bandwidth for confidence calculation
    const bandwidth = bb.upper - bb.lower;

    // 7. LONG: close < lower BB AND RSI < oversold
    const lastClose = closes[closes.length - 1];
    if (lastClose < bb.lower && rsi < cfg.RSI_OVERSOLD) {
      const distBeyondBand = bb.lower - lastClose;
      const confidence = bandwidth > 0
        ? Math.min(1, 0.4 + (distBeyondBand / bandwidth) * 0.6)
        : 0.5;

      return {
        valid: true,
        side: 'long',
        confidence,
        reason: `BB4H_LOWER rsi=${rsi.toFixed(1)} adx=${adx.toFixed(1)} vol=${volumeRatio.toFixed(2)}x`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: { bb, rsi, adx, volumeRatio, bandwidth },
      };
    }

    // 8. SHORT: close > upper BB AND RSI > overbought
    if (lastClose > bb.upper && rsi > cfg.RSI_OVERBOUGHT) {
      const distBeyondBand = lastClose - bb.upper;
      const confidence = bandwidth > 0
        ? Math.min(1, 0.4 + (distBeyondBand / bandwidth) * 0.6)
        : 0.5;

      return {
        valid: true,
        side: 'short',
        confidence,
        reason: `BB4H_UPPER rsi=${rsi.toFixed(1)} adx=${adx.toFixed(1)} vol=${volumeRatio.toFixed(2)}x`,
        stopLossPct: cfg.STOP_LOSS_PCT,
        metadata: { bb, rsi, adx, volumeRatio, bandwidth },
      };
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { position, candles, currentPrice, unrealizedPnlPct, holdingMinutes } = ctx;
    const cfg = MEAN_REV_4H_CONFIG;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -cfg.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }

    // 2. Max hold time
    if (holdingMinutes >= cfg.MAX_HOLD_MINUTES) {
      return { shouldExit: true, reason: 'MAX_HOLD_TIME' };
    }

    // 3. Aggregate to 4h and check mean reversion
    const candles4h = this.aggregateTo4h(candles);
    if (candles4h.length < cfg.BB_PERIOD + 5) {
      return { shouldExit: false, reason: 'insufficient_4h_candles' };
    }

    const closes = candles4h.map(c => c.close);
    const bb = calcBB(closes, cfg.BB_PERIOD, cfg.BB_STD_EXIT);

    // 4. Mean reversion: price crosses back past middle BB
    if (position.side === 'long' && currentPrice >= bb.middle) {
      return { shouldExit: true, reason: 'MEAN_REVERSION_EXIT' };
    }
    if (position.side === 'short' && currentPrice <= bb.middle) {
      return { shouldExit: true, reason: 'MEAN_REVERSION_EXIT' };
    }

    // 5. Progressive trailing using position.maxPnlPct
    const maxPnl = position.maxPnlPct ?? unrealizedPnlPct;

    if (maxPnl >= cfg.TRAILING_ACTIVATION_PCT) {
      let trailDistance = cfg.TRAILING_DISTANCE_PCT;

      if (cfg.PROGRESSIVE_ENABLED) {
        if (maxPnl >= cfg.TIER3_PROFIT_PCT) {
          trailDistance = cfg.TIER3_TRAIL_PCT;
        } else if (maxPnl >= cfg.TIER2_PROFIT_PCT) {
          trailDistance = cfg.TIER2_TRAIL_PCT;
        }
      }

      if ((maxPnl - unrealizedPnlPct) > trailDistance) {
        return { shouldExit: true, reason: 'TRAILING_STOP' };
      }
    }

    return { shouldExit: false, reason: 'holding' };
  }
}

export const meanReversion4hStrategy = new MeanReversion4hStrategy();
