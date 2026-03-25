import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig, Candle } from '../types.js';
import { calcBB, calcADX, calcSMA } from '../indicators/technicalIndicators.js';
import { PULLBACK_CONFIG } from './config.js';

// ============================================================================
// RSI calculation (inline, same as meanReversion)
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
// PullbackTrendStrategy
// ============================================================================

export class PullbackTrendStrategy implements IStrategy {
  readonly name = 'pullbackTrend';

  getConfig(): StrategyConfig {
    return {
      name: 'pullbackTrend',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 3,
      maxPositions: 2,
      positionSizePct: 0.05,
      minCandlesRequired: Math.max(PULLBACK_CONFIG.TREND_SMA_PERIOD, PULLBACK_CONFIG.BB_PERIOD) + 20,
      timeframeMs: 15 * 60 * 1000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles, btcCandles, currentPrice } = ctx;
    const cfg = PULLBACK_CONFIG;
    const minCandles = Math.max(cfg.TREND_SMA_PERIOD, cfg.BB_PERIOD) + 20;

    // 1. Warmup guard
    if (candles.length < minCandles) return null;

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // 2. Trend detection on symbol: close vs SMA
    const sma = calcSMA(closes, cfg.TREND_SMA_PERIOD);
    const symbolTrendUp = currentPrice > sma;
    const symbolTrendDown = currentPrice < sma;

    // 3. BTC trend alignment (if required)
    if (cfg.TREND_REQUIRE_BTC_ALIGN && btcCandles.length >= cfg.TREND_SMA_PERIOD) {
      const btcCloses = btcCandles.map(c => c.close);
      const btcSma = calcSMA(btcCloses, cfg.TREND_SMA_PERIOD);
      const btcPrice = btcCloses[btcCloses.length - 1];
      const btcTrendUp = btcPrice > btcSma;
      const btcTrendDown = btcPrice < btcSma;

      // BTC must agree with the symbol's trend direction
      if (symbolTrendUp && !btcTrendUp) return null;
      if (symbolTrendDown && !btcTrendDown) return null;
    }

    // 4. Bollinger Bands
    const bb = calcBB(closes, cfg.BB_PERIOD, cfg.BB_STD);

    // 5. RSI
    const rsi = calcRSI(closes, cfg.RSI_PERIOD);

    // 6. ADX — need trend to exist
    const adx = calcADX(candles, 14);
    if (adx < cfg.ADX_MIN) return null;

    // 7. Volume ratio
    const volumeRatio = calcVolumeRatio(volumes);
    if (volumeRatio < cfg.VOLUME_MIN) return null;

    // Pullback proximity threshold: within 0.5% of band counts as "touching"
    const bbProximityPct = 0.5;

    // ========================================================================
    // LONG entry: pullback in uptrend — price touches/crosses lower BB
    // ========================================================================
    if (symbolTrendUp) {
      const nearLowerBB = bb.lower > 0 && currentPrice <= bb.lower * (1 + bbProximityPct / 100);
      if (nearLowerBB && rsi < cfg.RSI_OVERSOLD) {
        // Confidence based on pullback depth (distance from SMA)
        const distFromSma = sma > 0 ? ((sma - currentPrice) / sma) * 100 : 0;
        const confidence = Math.min(1, 0.4 + distFromSma / 10);

        return {
          valid: true,
          side: 'long',
          confidence,
          reason: `PULLBACK_LONG trend=UP rsi=${rsi.toFixed(1)} adx=${adx.toFixed(1)} vol=${volumeRatio.toFixed(2)}x`,
          stopLossPct: cfg.STOP_LOSS_PCT,
          metadata: { bb, rsi, adx, volumeRatio, sma, trend: 'UP', distFromSma },
        };
      }
    }

    // ========================================================================
    // SHORT entry: pullback in downtrend — price touches/crosses upper BB
    // ========================================================================
    if (symbolTrendDown) {
      const nearUpperBB = bb.upper > 0 && currentPrice >= bb.upper * (1 - bbProximityPct / 100);
      if (nearUpperBB && rsi > cfg.RSI_OVERBOUGHT) {
        const distFromSma = sma > 0 ? ((currentPrice - sma) / sma) * 100 : 0;
        const confidence = Math.min(1, 0.4 + distFromSma / 10);

        return {
          valid: true,
          side: 'short',
          confidence,
          reason: `PULLBACK_SHORT trend=DOWN rsi=${rsi.toFixed(1)} adx=${adx.toFixed(1)} vol=${volumeRatio.toFixed(2)}x`,
          stopLossPct: cfg.STOP_LOSS_PCT,
          metadata: { bb, rsi, adx, volumeRatio, sma, trend: 'DOWN', distFromSma },
        };
      }
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { position, candles, currentPrice, unrealizedPnlPct, holdingMinutes } = ctx;
    const cfg = PULLBACK_CONFIG;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -cfg.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }

    // 2. Max hold time
    if (holdingMinutes >= cfg.MAX_HOLD_MINUTES) {
      return { shouldExit: true, reason: 'MAX_HOLD_TIME' };
    }

    // 3. Trend reversal exit: if symbol trend flips, bail
    if (candles.length >= cfg.TREND_SMA_PERIOD) {
      const closes = candles.map(c => c.close);
      const sma = calcSMA(closes, cfg.TREND_SMA_PERIOD);

      if (position.side === 'long' && currentPrice < sma) {
        return { shouldExit: true, reason: 'TREND_REVERSAL' };
      }
      if (position.side === 'short' && currentPrice > sma) {
        return { shouldExit: true, reason: 'TREND_REVERSAL' };
      }
    }

    // 4. Progressive trailing stop
    const maxPnl = position.maxPnlPct ?? unrealizedPnlPct;

    if (maxPnl >= cfg.TRAILING_ACTIVATION_PCT) {
      let trailDistance = cfg.TRAILING_DISTANCE_PCT;

      if (cfg.PROGRESSIVE_TRAIL_ENABLED) {
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

export const pullbackTrendStrategy = new PullbackTrendStrategy();
