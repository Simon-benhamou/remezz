import type { IStrategy, EntryContext, ExitContext, StrategySignal, StrategyExitSignal, StrategyConfig } from '../types.js';
import { GRID_CONFIG } from './config.js';

// ── ADX calculation (simple 14-period) ────────────────────────────────────

function calcSimpleADX(closes: number[], highs: number[], lows: number[], period = 14): number {
  if (closes.length < period + 1) return 0;

  const n = closes.length;
  const dmPlus: number[] = [];
  const dmMinus: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const trueRange = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    tr.push(trueRange);
  }

  // Wilder smoothing
  let smoothedTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedDMPlus = dmPlus.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothedDMMinus = dmMinus.slice(0, period).reduce((a, b) => a + b, 0);

  const dxValues: number[] = [];

  for (let i = period; i < tr.length; i++) {
    smoothedTR = smoothedTR - smoothedTR / period + tr[i];
    smoothedDMPlus = smoothedDMPlus - smoothedDMPlus / period + dmPlus[i];
    smoothedDMMinus = smoothedDMMinus - smoothedDMMinus / period + dmMinus[i];

    const diPlus = smoothedTR > 0 ? (smoothedDMPlus / smoothedTR) * 100 : 0;
    const diMinus = smoothedTR > 0 ? (smoothedDMMinus / smoothedTR) * 100 : 0;
    const diSum = diPlus + diMinus;
    const dx = diSum > 0 ? (Math.abs(diPlus - diMinus) / diSum) * 100 : 0;
    dxValues.push(dx);
  }

  if (dxValues.length === 0) return 0;

  // ADX = smoothed average of DX values
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }

  return adx;
}

// ── Range detection helpers ────────────────────────────────────────────────

function percentile(sortedArr: number[], pct: number): number {
  const idx = (sortedArr.length - 1) * pct;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

// ── GridStrategy ──────────────────────────────────────────────────────────

export class GridStrategy implements IStrategy {
  readonly name = 'grid';

  getConfig(): StrategyConfig {
    return {
      name: 'grid',
      version: '1.0',
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT'],
      leverage: 2,
      maxPositions: 3,
      positionSizePct: 0.02,
      minCandlesRequired: GRID_CONFIG.RANGE_LOOKBACK_CANDLES,
      timeframeMs: 15 * 60 * 1000,
      fees: { tradingPct: 0.04, slippagePct: 0.05, fundingPct: 0.01 },
    };
  }

  checkEntry(ctx: EntryContext): StrategySignal | null {
    const { candles, currentPrice, openPositions } = ctx;

    // 1. Need at least RANGE_LOOKBACK_CANDLES candles
    if (candles.length < GRID_CONFIG.RANGE_LOOKBACK_CANDLES) return null;

    // 2. Max positions guard
    if (openPositions >= this.getConfig().maxPositions) return null;

    // Slice to lookback window
    const recentCandles = candles.slice(-GRID_CONFIG.RANGE_LOOKBACK_CANDLES);
    const closes = recentCandles.map(c => c.close);
    const highs = recentCandles.map(c => c.high);
    const lows = recentCandles.map(c => c.low);

    // 3. Detect range: sort closes, compute 25th/75th percentile
    const sortedCloses = [...closes].sort((a, b) => a - b);
    const rangeLow = percentile(sortedCloses, GRID_CONFIG.RANGE_PERCENTILE_LOW);
    const rangeHigh = percentile(sortedCloses, GRID_CONFIG.RANGE_PERCENTILE_HIGH);
    const midPoint = (rangeLow + rangeHigh) / 2;
    const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;

    // 4. Validate range width
    if (rangePct < GRID_CONFIG.MIN_RANGE_PCT || rangePct > GRID_CONFIG.MAX_RANGE_PCT) return null;

    // 5. Calculate ADX — skip if trending
    const adx = calcSimpleADX(closes, highs, lows, 14);
    if (adx > GRID_CONFIG.TREND_FILTER_ADX_MAX) return null;

    // 6. Grid spacing
    const gridSpacingPct = rangePct / GRID_CONFIG.GRID_LEVELS;

    // 7. Determine signal direction based on price vs midpoint
    const distFromMidPct = ((currentPrice - midPoint) / midPoint) * 100;

    if (distFromMidPct < -GRID_CONFIG.ENTRY_THRESHOLD_PCT) {
      // Price is below midpoint → LONG signal
      const distBelowMidPct = Math.abs(distFromMidPct);
      const gridLevel = Math.min(
        Math.floor(distBelowMidPct / gridSpacingPct) + 1,
        GRID_CONFIG.GRID_LEVELS,
      );
      const confidence = gridLevel / GRID_CONFIG.GRID_LEVELS;

      return {
        valid: true,
        side: 'long',
        confidence,
        reason: `grid_long: price ${distBelowMidPct.toFixed(2)}% below midpoint, level=${gridLevel}/${GRID_CONFIG.GRID_LEVELS}`,
        stopLossPct: GRID_CONFIG.STOP_LOSS_PCT,
        takeProfitPct: gridSpacingPct * GRID_CONFIG.TAKE_PROFIT_GRIDS,
        metadata: { rangeLow, rangeHigh, midPoint, gridLevel, gridSpacingPct, adx },
      };
    }

    if (distFromMidPct > GRID_CONFIG.ENTRY_THRESHOLD_PCT) {
      // Price is above midpoint → SHORT signal
      const distAboveMidPct = Math.abs(distFromMidPct);
      const gridLevel = Math.min(
        Math.floor(distAboveMidPct / gridSpacingPct) + 1,
        GRID_CONFIG.GRID_LEVELS,
      );
      const confidence = gridLevel / GRID_CONFIG.GRID_LEVELS;

      return {
        valid: true,
        side: 'short',
        confidence,
        reason: `grid_short: price ${distAboveMidPct.toFixed(2)}% above midpoint, level=${gridLevel}/${GRID_CONFIG.GRID_LEVELS}`,
        stopLossPct: GRID_CONFIG.STOP_LOSS_PCT,
        takeProfitPct: gridSpacingPct * GRID_CONFIG.TAKE_PROFIT_GRIDS,
        metadata: { rangeLow, rangeHigh, midPoint, gridLevel, gridSpacingPct, adx },
      };
    }

    return null;
  }

  checkExit(ctx: ExitContext): StrategyExitSignal {
    const { position, currentPrice, unrealizedPnlPct, holdingMinutes, candles } = ctx;

    // 1. Hard stop loss
    if (unrealizedPnlPct <= -GRID_CONFIG.STOP_LOSS_PCT) {
      return { shouldExit: true, reason: 'stop_loss', exitPrice: currentPrice };
    }

    // 2. Max hold time
    if (holdingMinutes >= GRID_CONFIG.MAX_HOLD_MINUTES) {
      return { shouldExit: true, reason: 'max_hold_time', exitPrice: currentPrice };
    }

    // 3. Take profit: unrealizedPnlPct >= grid spacing * TAKE_PROFIT_GRIDS
    // Recalculate grid spacing from current candle context if we have enough data
    if (candles.length >= GRID_CONFIG.RANGE_LOOKBACK_CANDLES) {
      const recentCandles = candles.slice(-GRID_CONFIG.RANGE_LOOKBACK_CANDLES);
      const closes = recentCandles.map(c => c.close);
      const sortedCloses = [...closes].sort((a, b) => a - b);
      const rangeLow = percentile(sortedCloses, GRID_CONFIG.RANGE_PERCENTILE_LOW);
      const rangeHigh = percentile(sortedCloses, GRID_CONFIG.RANGE_PERCENTILE_HIGH);
      const rangePct = ((rangeHigh - rangeLow) / rangeLow) * 100;
      const gridSpacingPct = rangePct / GRID_CONFIG.GRID_LEVELS;
      const takeProfitPct = gridSpacingPct * GRID_CONFIG.TAKE_PROFIT_GRIDS;

      if (unrealizedPnlPct >= takeProfitPct) {
        return { shouldExit: true, reason: 'take_profit', exitPrice: currentPrice };
      }

      // 4. Range breakout exit
      const breakoutThresholdHigh = rangeHigh * 1.015;
      const breakoutThresholdLow = rangeLow * 0.985;

      if (position.side === 'long' && currentPrice < breakoutThresholdLow) {
        return { shouldExit: true, reason: 'range_breakout_down', exitPrice: currentPrice };
      }
      if (position.side === 'short' && currentPrice > breakoutThresholdHigh) {
        return { shouldExit: true, reason: 'range_breakout_up', exitPrice: currentPrice };
      }
    }

    return { shouldExit: false, reason: 'hold' };
  }
}
