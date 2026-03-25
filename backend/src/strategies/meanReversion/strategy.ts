import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig } from '../types.js';
import { calcBB, calcADX } from '../indicators/technicalIndicators.js';
import { MEAN_REV_CONFIG } from './config.js';

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
// MeanReversionStrategy
// ============================================================================

export class MeanReversionStrategy implements IStrategy {
  readonly name = 'meanReversion';

  getConfig(): StrategyConfig {
    return {
      name: 'meanReversion',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 2,
      maxPositions: 2,
      positionSizePct: 0.02,
      minCandlesRequired: MEAN_REV_CONFIG.BB_PERIOD + 10,
      timeframeMs: 15 * 60 * 1000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles, currentPrice } = ctx;
    const minCandles = MEAN_REV_CONFIG.BB_PERIOD + 10;

    // 1. Warmup guard
    if (candles.length < minCandles) return null;

    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    // 2. Bollinger Bands (50-period, 2.5 std)
    const bb = calcBB(closes, MEAN_REV_CONFIG.BB_PERIOD, MEAN_REV_CONFIG.BB_STD_ENTRY);

    // 3. RSI (14-period)
    const rsi = calcRSI(closes, 14);

    // 4. Volume ratio
    const volumeRatio = calcVolumeRatio(volumes);

    // 5. ADX filter — skip if strongly trending
    const adx = calcADX(candles, 14);
    if (adx > MEAN_REV_CONFIG.ADX_MAX) return null;

    // 6. LONG entry: price below lower BB, RSI oversold, volume spike
    if (
      currentPrice < bb.lower &&
      rsi < MEAN_REV_CONFIG.RSI_OVERSOLD &&
      volumeRatio > MEAN_REV_CONFIG.VOLUME_SPIKE_MIN
    ) {
      const deviationPct = bb.lower > 0
        ? ((bb.lower - currentPrice) / bb.lower) * 100
        : 0;

      // Only enter if deviation is meaningful
      if (deviationPct < MEAN_REV_CONFIG.MIN_DEVIATION_PCT) return null;

      const confidence = Math.min(1, 0.5 + deviationPct / 10);

      return {
        valid: true,
        side: 'long',
        confidence,
        reason: `BB_LOWER_BREACH rsi=${rsi.toFixed(1)} vol=${volumeRatio.toFixed(2)}x dev=${deviationPct.toFixed(2)}%`,
        stopLossPct: MEAN_REV_CONFIG.STOP_LOSS_PCT,
        metadata: { bb, rsi, volumeRatio, adx, deviationPct },
      };
    }

    // 7. SHORT entry: price above upper BB, RSI overbought, volume spike
    if (
      currentPrice > bb.upper &&
      rsi > MEAN_REV_CONFIG.RSI_OVERBOUGHT &&
      volumeRatio > MEAN_REV_CONFIG.VOLUME_SPIKE_MIN
    ) {
      const deviationPct = bb.upper > 0
        ? ((currentPrice - bb.upper) / bb.upper) * 100
        : 0;

      if (deviationPct < MEAN_REV_CONFIG.MIN_DEVIATION_PCT) return null;

      const confidence = Math.min(1, 0.5 + deviationPct / 10);

      return {
        valid: true,
        side: 'short',
        confidence,
        reason: `BB_UPPER_BREACH rsi=${rsi.toFixed(1)} vol=${volumeRatio.toFixed(2)}x dev=${deviationPct.toFixed(2)}%`,
        stopLossPct: MEAN_REV_CONFIG.STOP_LOSS_PCT,
        metadata: { bb, rsi, volumeRatio, adx, deviationPct },
      };
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { position, candles, currentPrice, unrealizedPnlPct, holdingMinutes } = ctx;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -MEAN_REV_CONFIG.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'STOP_LOSS' };
    }

    // 2. Max hold time
    if (holdingMinutes >= MEAN_REV_CONFIG.MAX_HOLD_MINUTES) {
      return { shouldExit: true, reason: 'MAX_HOLD_TIME' };
    }

    if (candles.length < MEAN_REV_CONFIG.BB_PERIOD + 10) {
      return { shouldExit: false, reason: 'insufficient_candles' };
    }

    const closes = candles.map(c => c.close);
    const bb = calcBB(closes, MEAN_REV_CONFIG.BB_PERIOD, MEAN_REV_CONFIG.BB_STD_EXIT);

    // 3. Mean reversion exit: price crosses back to middle band
    if (position.side === 'long' && currentPrice >= bb.middle) {
      return { shouldExit: true, reason: 'MEAN_REVERSION_EXIT' };
    }
    if (position.side === 'short' && currentPrice <= bb.middle) {
      return { shouldExit: true, reason: 'MEAN_REVERSION_EXIT' };
    }

    // 4. Simple trailing: if profit exceeds TRAILING_AFTER_PCT, track high water mark
    // and exit if it drops by TRAILING_DISTANCE_PCT
    if (unrealizedPnlPct > MEAN_REV_CONFIG.TRAILING_AFTER_PCT) {
      const hwm = position.highWaterMark;
      const lwm = position.lowWaterMark;

      if (position.side === 'long' && hwm !== undefined) {
        const hwmPnlPct = ((hwm - position.entryPrice) / position.entryPrice) * 100;
        if (hwmPnlPct - unrealizedPnlPct >= MEAN_REV_CONFIG.TRAILING_DISTANCE_PCT) {
          return { shouldExit: true, reason: 'TRAILING_STOP' };
        }
      }

      if (position.side === 'short' && lwm !== undefined) {
        const lwmPnlPct = ((position.entryPrice - lwm) / position.entryPrice) * 100;
        if (lwmPnlPct - unrealizedPnlPct >= MEAN_REV_CONFIG.TRAILING_DISTANCE_PCT) {
          return { shouldExit: true, reason: 'TRAILING_STOP' };
        }
      }
    }

    return { shouldExit: false, reason: 'holding' };
  }
}

export const meanReversionStrategy = new MeanReversionStrategy();
