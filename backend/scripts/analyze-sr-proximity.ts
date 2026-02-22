/**
 * S/R PROXIMITY ANALYSIS - Find optimal support/resistance filters for signals
 *
 * This script:
 * 1. Loads local candle data (same as backtest)
 * 2. Detects support/resistance levels using multiple methods:
 *    - Local highs/lows (pivot points with configurable lookback)
 *    - Recent swing highs/lows (last N candles)
 * 3. For each valid signal, measures proximity to nearest S/R levels
 * 4. Runs full backtest simulation to correlate S/R proximity with trade outcome
 * 5. Tests different proximity filter thresholds
 * 6. Reports the optimal filter configuration
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SRLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number; // Number of touches
  lastTouchIdx: number;
}

interface SignalWithSR {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  entryIdx: number;

  // S/R metrics
  nearestSupport: number;
  nearestResistance: number;
  distToSupportPct: number;  // % distance to nearest support
  distToResistancePct: number;  // % distance to nearest resistance
  supportStrength: number;
  resistanceStrength: number;

  // Ratio metrics
  srRatio: number; // distance_to_resistance / (distance_to_support + distance_to_resistance)
  inSRZone: 'near_support' | 'near_resistance' | 'middle' | 'above_resistance' | 'below_support';

  // Trade outcome
  exitPrice: number;
  exitReason: string;
  pnlPct: number;
  netPnlPct: number;
  isWin: boolean;
  holdMinutes: number;
}

// ============================================================================
// INDICATOR FUNCTIONS (standalone - no imports needed)
// ============================================================================

function calcSMA(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function calcBB(closes: number[], period: number = 20, mult: number = 2) {
  if (closes.length < period) {
    const mid = closes[closes.length - 1] || 0;
    return { upper: mid, middle: mid, lower: mid };
  }
  const slice = closes.slice(-period);
  const middle = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + std * mult, middle, lower: middle - std * mult };
}

function calcROC(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return past > 0 ? (current - past) / past : 0;
}

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 1;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
  return avg > 0 ? current / avg : 1;
}

function countConsecUp(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
}

function calcRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14, smooth = 3): number | null {
  const minLen = rsiPeriod + stochPeriod + smooth;
  if (closes.length < minLen) return null;
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const r = calcRSI(closes.slice(0, i), rsiPeriod);
    if (r !== null) rsiValues.push(r);
  }
  if (rsiValues.length < stochPeriod) return null;
  const stochRaw: number[] = [];
  for (let i = stochPeriod; i <= rsiValues.length; i++) {
    const slice = rsiValues.slice(i - stochPeriod, i);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    const cur = slice[slice.length - 1];
    stochRaw.push(hi === lo ? 50 : ((cur - lo) / (hi - lo)) * 100);
  }
  if (stochRaw.length < smooth) return null;
  return stochRaw.slice(-smooth).reduce((a, b) => a + b, 0) / smooth;
}

function calcATR(candles: Candle[], period: number = 14): number {
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

function calcADX(candles: Candle[], period: number = 14): number {
  if (candles.length < period * 2 + 1) return 25; // Default neutral
  let plusDMSum = 0, minusDMSum = 0, trSum = 0;
  const startIdx = candles.length - period * 2;

  for (let i = startIdx + 1; i < startIdx + period + 1; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDMSum += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDMSum += (downMove > upMove && downMove > 0) ? downMove : 0;
    trSum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
  }

  for (let i = startIdx + period + 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
    const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    plusDMSum = plusDMSum - plusDMSum / period + plusDM;
    minusDMSum = minusDMSum - minusDMSum / period + minusDM;
    trSum = trSum - trSum / period + tr;
  }

  if (trSum === 0) return 25;
  const plusDI = (plusDMSum / trSum) * 100;
  const minusDI = (minusDMSum / trSum) * 100;
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0;
  return Math.abs(plusDI - minusDI) / diSum * 100;
}

// ============================================================================
// SUPPORT/RESISTANCE DETECTION
// ============================================================================

/**
 * Find pivot highs and lows using lookback/lookahead windows
 * A pivot high has the highest high in a window of leftBars + rightBars + 1
 * A pivot low has the lowest low in same window
 */
function findPivotPoints(
  candles: Candle[],
  leftBars: number = 10,
  rightBars: number = 10
): { pivotHighs: { idx: number; price: number }[]; pivotLows: { idx: number; price: number }[] } {
  const pivotHighs: { idx: number; price: number }[] = [];
  const pivotLows: { idx: number; price: number }[] = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) pivotHighs.push({ idx: i, price: candles[i].high });
    if (isLow) pivotLows.push({ idx: i, price: candles[i].low });
  }

  return { pivotHighs, pivotLows };
}

/**
 * Cluster nearby price levels into support/resistance zones
 * Returns consolidated S/R levels with strength (number of touches)
 */
function clusterSRLevels(
  pivotHighs: { idx: number; price: number }[],
  pivotLows: { idx: number; price: number }[],
  clusterPct: number = 0.5  // % range to merge levels
): SRLevel[] {
  const allLevels: { price: number; type: 'support' | 'resistance'; idx: number }[] = [];

  for (const p of pivotHighs) {
    allLevels.push({ price: p.price, type: 'resistance', idx: p.idx });
  }
  for (const p of pivotLows) {
    allLevels.push({ price: p.price, type: 'support', idx: p.idx });
  }

  // Sort by price
  allLevels.sort((a, b) => a.price - b.price);

  // Cluster
  const clusters: SRLevel[] = [];
  let i = 0;
  while (i < allLevels.length) {
    const clusterStart = allLevels[i];
    const clusterRange = clusterStart.price * (clusterPct / 100);
    const members: typeof allLevels = [clusterStart];

    let j = i + 1;
    while (j < allLevels.length && allLevels[j].price - clusterStart.price <= clusterRange) {
      members.push(allLevels[j]);
      j++;
    }

    // Average price, determine type by majority
    const avgPrice = members.reduce((s, m) => s + m.price, 0) / members.length;
    const supports = members.filter(m => m.type === 'support').length;
    const resistances = members.filter(m => m.type === 'resistance').length;
    const maxIdx = Math.max(...members.map(m => m.idx));

    clusters.push({
      price: avgPrice,
      type: supports >= resistances ? 'support' : 'resistance',
      strength: members.length,
      lastTouchIdx: maxIdx,
    });

    i = j;
  }

  return clusters;
}

/**
 * Find nearest support and resistance relative to current price
 * Uses only levels detected BEFORE current candle (no look-ahead)
 */
function findNearestSR(
  currentPrice: number,
  currentIdx: number,
  srLevels: SRLevel[],
  maxAge: number = 200  // Only consider levels within last N candles
): {
  nearestSupport: SRLevel | null;
  nearestResistance: SRLevel | null;
  allNearbySupports: SRLevel[];
  allNearbyResistances: SRLevel[];
} {
  const recent = srLevels.filter(l =>
    l.lastTouchIdx < currentIdx &&
    currentIdx - l.lastTouchIdx <= maxAge
  );

  const supports = recent.filter(l => l.price < currentPrice);
  const resistances = recent.filter(l => l.price > currentPrice);

  // Sort supports descending (nearest first)
  supports.sort((a, b) => b.price - a.price);
  // Sort resistances ascending (nearest first)
  resistances.sort((a, b) => a.price - b.price);

  return {
    nearestSupport: supports[0] || null,
    nearestResistance: resistances[0] || null,
    allNearbySupports: supports.slice(0, 3),
    allNearbyResistances: resistances.slice(0, 3),
  };
}

// ============================================================================
// SIGNAL DETECTION (simplified from momentumSimple.ts)
// ============================================================================

interface SignalResult {
  valid: boolean;
  side?: 'long' | 'short';
  reason?: string;
}

function checkSignal(
  candles: Candle[],
  btcCandles: Candle[],
  btcCandlesRegime: Candle[],
): SignalResult {
  if (candles.length < 50 || btcCandles.length < 200) {
    return { valid: false, reason: 'insufficient' };
  }

  const current = candles[candles.length - 1];
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const btcCloses = btcCandles.map(c => c.close);

  // Regime detection (1h preferred)
  let isBullRegime: boolean;
  if (btcCandlesRegime.length >= 200) {
    const btcCloses1h = btcCandlesRegime.map(c => c.close);
    const sma200 = calcSMA(btcCloses1h, 200);
    isBullRegime = btcCloses1h[btcCloses1h.length - 1] > sma200;
  } else {
    const sma200 = calcSMA(btcCloses, 200);
    isBullRegime = btcCloses[btcCloses.length - 1] > sma200;
  }

  const bb = calcBB(closes, 20, 2);
  const volRatio = calcVolRatio(volumes);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const isBullish = current.close > current.open;
  const isBearish = current.close < current.open;

  // MTF filter
  if (btcCandlesRegime.length >= 10) {
    const btcCloses1h = btcCandlesRegime.map(c => c.close);
    const btcRoc1h = calcROC(btcCloses1h, 10);
    if (isBullRegime && btcRoc1h <= 0) return { valid: false, reason: 'mtf_misaligned' };
    if (!isBullRegime && btcRoc1h >= 0) return { valid: false, reason: 'mtf_misaligned' };
  }

  // BTC volatility filter
  const btcAtr = calcATR(btcCandles.slice(-15), 14);
  const btcAtrPct = btcCandles[btcCandles.length - 1].close > 0 ? (btcAtr / btcCandles[btcCandles.length - 1].close) * 100 : 0;
  if (btcAtrPct < 0.15) return { valid: false, reason: 'btc_low_vol' };

  // Cash mode
  const adx = calcADX(btcCandles.slice(-30), 14);
  if (adx < 20) {
    const recentATRs = [];
    for (let i = 0; i < 5; i++) {
      if (btcCandles.length > 15 + i) {
        recentATRs.push(calcATR(btcCandles.slice(0, -(i || 1) || undefined), 14));
      }
    }
    if (recentATRs.length >= 2 && recentATRs[0] < recentATRs[recentATRs.length - 1] * 0.85) {
      return { valid: false, reason: 'cash_mode' };
    }
  }

  if (isBullRegime) {
    // LONG conditions
    if (!isBullish) return { valid: false, reason: 'bearish_candle' };
    if (countConsecUp(candles) > 5) return { valid: false, reason: 'overbought' };
    if (current.close <= bb.upper) return { valid: false, reason: 'no_breakout' };
    if (roc10 < 0.0175) return { valid: false, reason: 'low_momentum' };
    if (volRatio < 1.15) return { valid: false, reason: 'low_volume' };

    // Candle pattern filters
    const last10 = candles.slice(-10);
    const greenRatio = last10.filter(c => c.close > c.open).length / 10;
    if (greenRatio >= 0.70) return { valid: false, reason: 'high_green_ratio' };

    let alt = 0;
    for (let i = 1; i < Math.min(5, candles.length); i++) {
      const prev = candles[candles.length - 1 - i];
      const cur = candles[candles.length - i];
      if ((prev.close > prev.open) !== (cur.close > cur.open)) alt++;
    }
    if (alt >= 3) return { valid: false, reason: 'choppy' };

    // BB touch check
    let touches = 0;
    for (let i = Math.max(0, candles.length - 10); i < candles.length; i++) {
      const bbAtI = calcBB(closes.slice(0, i + 1), 20, 2);
      if (Math.abs(candles[i].high - bbAtI.upper) / bbAtI.upper < 0.002 ||
          Math.abs(candles[i].low - bbAtI.lower) / bbAtI.lower < 0.002) {
        touches++;
      }
    }
    if (touches < 1) return { valid: false, reason: 'no_bb_touches' };

    return { valid: true, side: 'long', reason: 'bull_breakout' };
  } else {
    // SHORT conditions
    const stochRsi = calcStochRSI(closes, 14, 14, 3);
    if (stochRsi !== null && stochRsi < 15 && volRatio < 4.0) {
      return { valid: false, reason: 'stochrsi_filter' };
    }

    if (!isBearish) return { valid: false, reason: 'not_bearish' };
    if (roc5 > -0.015) return { valid: false, reason: 'weak_drop' };
    if (volRatio < 2.0) return { valid: false, reason: 'low_volume' };

    const ma20 = calcSMA(closes, 20);
    if (current.close >= ma20) return { valid: false, reason: 'above_ma20' };
    if (current.close >= bb.lower) return { valid: false, reason: 'above_bb_lower' };
    if (countConsecDown(candles) > 6) return { valid: false, reason: 'oversold' };

    // SHORT candle pattern filter
    const recentCloses5 = closes.slice(-5);
    const recentCloses10 = closes.slice(-10);
    const rocAccelFast = calcROC(recentCloses5, Math.min(4, recentCloses5.length - 1));
    const rocAccelSlow = recentCloses10.length > 5 ? calcROC(recentCloses10.slice(0, 5), Math.min(4, 4)) : 0;
    if (rocAccelFast - rocAccelSlow > 0) return { valid: false, reason: 'roc_accel_bullish' };

    return { valid: true, side: 'short', reason: 'bear_breakdown' };
  }
}

// ============================================================================
// SIMPLIFIED TRADE SIMULATION
// ============================================================================

interface TradeResult {
  exitPrice: number;
  exitReason: string;
  pnlPct: number;     // gross
  netPnlPct: number;  // after fees
  holdMinutes: number;
  isWin: boolean;
}

function simulateTrade(
  candles: Candle[],
  entryIdx: number,
  side: 'long' | 'short',
  entryPrice: number,
  symbol: string,
): TradeResult {
  const FEES_PCT = 0.04 * 2; // 0.04% taker each way = 0.08% round trip
  const SLIPPAGE_PCT = 0.05 * 2;
  const MAX_HOLD_BARS = 192; // 48h

  // Dynamic SL
  let slPct = 2.5; // default
  const tier1 = ['BTC', 'ETH'];
  const tier3 = ['IMX', 'OP', 'FTM', 'FET', 'WIF'];
  if (tier1.some(t => symbol.includes(t))) slPct = 2.0;
  else if (tier3.some(t => symbol.includes(t))) slPct = 3.0;

  // Trailing params
  const TRAIL_ACTIVATION = 1.0;
  const TRAIL_DISTANCE = 0.4;
  const TRAIL_WIDEN_AT = 3.0;
  const TRAIL_WIDE_DISTANCE = 0.8;

  let highWaterMark = entryPrice;
  let lowWaterMark = entryPrice;
  let trailingActive = false;
  let appTrailingStop = 0;
  let maxPnlPct = 0;

  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + MAX_HOLD_BARS + 1); i++) {
    const c = candles[i];
    const holdBars = i - entryIdx;
    const holdMinutes = holdBars * 15;

    // Update water marks
    if (side === 'long') {
      highWaterMark = Math.max(highWaterMark, c.high);
    } else {
      lowWaterMark = Math.min(lowWaterMark, c.low);
    }

    const pnlPct = side === 'long'
      ? ((c.close - entryPrice) / entryPrice) * 100
      : ((entryPrice - c.close) / entryPrice) * 100;
    maxPnlPct = Math.max(maxPnlPct, pnlPct);

    // Check stop loss
    if (side === 'long' && c.low <= entryPrice * (1 - slPct / 100)) {
      const exitPrice = entryPrice * (1 - slPct / 100);
      const gross = ((exitPrice - entryPrice) / entryPrice) * 100;
      return { exitPrice, exitReason: 'SL', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: false };
    }
    if (side === 'short' && c.high >= entryPrice * (1 + slPct / 100)) {
      const exitPrice = entryPrice * (1 + slPct / 100);
      const gross = ((entryPrice - exitPrice) / entryPrice) * 100;
      return { exitPrice, exitReason: 'SL', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: false };
    }

    // Trailing stop
    const rawPnl = side === 'long'
      ? ((highWaterMark - entryPrice) / entryPrice) * 100
      : ((entryPrice - lowWaterMark) / entryPrice) * 100;

    if (rawPnl >= TRAIL_ACTIVATION) {
      trailingActive = true;
      const trailDist = rawPnl >= TRAIL_WIDEN_AT ? TRAIL_WIDE_DISTANCE : TRAIL_DISTANCE;

      if (side === 'long') {
        const newStop = highWaterMark * (1 - trailDist / 100);
        appTrailingStop = Math.max(appTrailingStop, newStop);
        if (c.close <= appTrailingStop) {
          const exitPrice = appTrailingStop;
          const gross = ((exitPrice - entryPrice) / entryPrice) * 100;
          return { exitPrice, exitReason: 'TRAIL', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: gross > FEES_PCT + SLIPPAGE_PCT };
        }
      } else {
        const newStop = lowWaterMark * (1 + trailDist / 100);
        appTrailingStop = appTrailingStop === 0 ? newStop : Math.min(appTrailingStop, newStop);
        if (c.close >= appTrailingStop) {
          const exitPrice = appTrailingStop;
          const gross = ((entryPrice - exitPrice) / entryPrice) * 100;
          return { exitPrice, exitReason: 'TRAIL', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: gross > FEES_PCT + SLIPPAGE_PCT };
        }
      }
    }

    // Time exit
    if (holdBars >= MAX_HOLD_BARS) {
      const exitPrice = c.close;
      const gross = side === 'long'
        ? ((exitPrice - entryPrice) / entryPrice) * 100
        : ((entryPrice - exitPrice) / entryPrice) * 100;
      return { exitPrice, exitReason: 'TIME', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: gross > FEES_PCT + SLIPPAGE_PCT };
    }

    // Stagnant exit (simplified)
    if (holdMinutes >= 60 && maxPnlPct < 0.8 && !trailingActive) {
      // Check if it recovers in observation window (60 more min)
      if (holdMinutes >= 120 && maxPnlPct < 0.6) {
        // Tighten SL
        const tighterSl = slPct * 0.5;
        if (side === 'long' && c.close <= entryPrice * (1 - tighterSl / 100)) {
          const exitPrice = entryPrice * (1 - tighterSl / 100);
          const gross = ((exitPrice - entryPrice) / entryPrice) * 100;
          return { exitPrice, exitReason: 'STAGNANT', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: false };
        }
        if (side === 'short' && c.close >= entryPrice * (1 + tighterSl / 100)) {
          const exitPrice = entryPrice * (1 + tighterSl / 100);
          const gross = ((entryPrice - exitPrice) / entryPrice) * 100;
          return { exitPrice, exitReason: 'STAGNANT', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes, isWin: false };
        }
      }
    }
  }

  // End of data
  const lastCandle = candles[Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS)];
  const exitPrice = lastCandle.close;
  const gross = side === 'long'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  return { exitPrice, exitReason: 'END', pnlPct: gross, netPnlPct: gross - FEES_PCT - SLIPPAGE_PCT, holdMinutes: Math.min(MAX_HOLD_BARS * 15, (candles.length - 1 - entryIdx) * 15), isWin: gross > FEES_PCT + SLIPPAGE_PCT };
}

// ============================================================================
// DATA LOADING
// ============================================================================

async function loadCandles(symbol: string, timeframe: '15m' | '1h'): Promise<Candle[]> {
  const base = symbol.toUpperCase().replace(':USDT', '').replace('/', '_');
  const dataDir = path.resolve(process.cwd(), 'data');
  const file = path.join(dataDir, `${base}_${timeframe}.json`);

  try {
    const raw = await fs.readFile(file, 'utf8');
    const json = JSON.parse(raw) as any[];
    return json
      .map((item: any) => ({
        timestamp: Number(item.openTime),
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume ?? 0),
      }))
      .filter((c: Candle) => Number.isFinite(c.timestamp) && c.timestamp > 0)
      .sort((a: Candle, b: Candle) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

// ============================================================================
// MAIN ANALYSIS
// ============================================================================

async function main() {
  console.log('='.repeat(80));
  console.log('S/R PROXIMITY ANALYSIS - Finding Optimal Support/Resistance Filters');
  console.log('='.repeat(80));

  const SYMBOLS = [
    'AVAX/USDT', 'FET/USDT', 'WIF/USDT', 'DOT/USDT', 'TIA/USDT',
    'IMX/USDT', 'STX/USDT', 'DOGE/USDT', 'ADA/USDT', 'BTC/USDT',
  ];

  // Load BTC data
  console.log('\nLoading data...');
  const btcCandles15m = await loadCandles('BTC/USDT', '15m');
  const btcCandlesRegime = await loadCandles('BTC/USDT', '1h');
  console.log(`BTC 15m: ${btcCandles15m.length} candles`);
  console.log(`BTC 1h: ${btcCandlesRegime.length} candles`);

  if (!btcCandles15m.length) {
    console.error('No BTC data found! Make sure you run from backend/ directory.');
    process.exit(1);
  }

  // Date range: use all available data
  const startTs = btcCandles15m[200]?.timestamp || 0;
  const endTs = btcCandles15m[btcCandles15m.length - 1]?.timestamp || 0;
  console.log(`Date range: ${new Date(startTs).toISOString().slice(0, 10)} to ${new Date(endTs).toISOString().slice(0, 10)}`);

  // Collect all signals with S/R metrics
  const allSignals: SignalWithSR[] = [];

  for (const symbol of SYMBOLS) {
    console.log(`\nProcessing ${symbol}...`);
    const candles15m = await loadCandles(symbol, '15m');
    if (candles15m.length < 200) {
      console.log(`  Skipping: only ${candles15m.length} candles`);
      continue;
    }

    // Pre-compute S/R levels for entire history using different lookback windows
    // Use lookback of 5, 10, 20 bars for pivot detection
    const allPivots5 = findPivotPoints(candles15m, 5, 5);
    const allPivots10 = findPivotPoints(candles15m, 10, 10);
    const allPivots20 = findPivotPoints(candles15m, 20, 20);

    // Merge all pivot points for richest S/R map
    const allPivotHighs = [...allPivots5.pivotHighs, ...allPivots10.pivotHighs, ...allPivots20.pivotHighs];
    const allPivotLows = [...allPivots5.pivotLows, ...allPivots10.pivotLows, ...allPivots20.pivotLows];

    // Cluster into S/R levels (0.3% range - tighter clustering)
    const srLevels = clusterSRLevels(allPivotHighs, allPivotLows, 0.3);
    console.log(`  S/R levels detected: ${srLevels.length}`);

    let signalCount = 0;

    // Iterate through candles, check signals
    for (let i = 200; i < candles15m.length - 200; i++) {
      const current = candles15m[i];
      if (current.timestamp < startTs || current.timestamp > endTs) continue;

      const windowCandles = candles15m.slice(Math.max(0, i - 200), i + 1);

      // BTC candles up to current time
      const btcWindow15m = btcCandles15m.filter(c => c.timestamp < current.timestamp);
      if (btcWindow15m.length < 200) continue;

      const CANDLE_1H_MS = 60 * 60 * 1000;
      const btcWindow1h = btcCandlesRegime.filter(c => c.timestamp + CANDLE_1H_MS <= current.timestamp);

      // Toxic hours filter
      const signalHourUtc = new Date(current.timestamp + 15 * 60 * 1000).getUTCHours();
      if ([4, 5, 9, 18, 21].includes(signalHourUtc)) continue;

      // Check signal
      const signal = checkSignal(windowCandles, btcWindow15m.slice(-201), btcWindow1h);
      if (!signal.valid || !signal.side) continue;

      signalCount++;

      // Find nearest S/R
      const sr = findNearestSR(current.close, i, srLevels, 300);

      const nearestSupportPrice = sr.nearestSupport?.price ?? current.close * 0.95;
      const nearestResistancePrice = sr.nearestResistance?.price ?? current.close * 1.05;

      const distToSupport = ((current.close - nearestSupportPrice) / current.close) * 100;
      const distToResistance = ((nearestResistancePrice - current.close) / current.close) * 100;

      // Determine zone
      let zone: SignalWithSR['inSRZone'];
      if (distToSupport < 0) zone = 'below_support';
      else if (distToResistance < 0) zone = 'above_resistance';
      else if (distToSupport < distToResistance * 0.33) zone = 'near_support';
      else if (distToResistance < distToSupport * 0.33) zone = 'near_resistance';
      else zone = 'middle';

      const srRatio = (distToSupport + distToResistance) > 0
        ? distToResistance / (distToSupport + distToResistance)
        : 0.5;

      // Simulate trade
      const trade = simulateTrade(candles15m, i, signal.side, current.close, symbol);

      allSignals.push({
        symbol,
        side: signal.side,
        entryPrice: current.close,
        entryTime: current.timestamp,
        entryIdx: i,
        nearestSupport: nearestSupportPrice,
        nearestResistance: nearestResistancePrice,
        distToSupportPct: distToSupport,
        distToResistancePct: distToResistance,
        supportStrength: sr.nearestSupport?.strength ?? 0,
        resistanceStrength: sr.nearestResistance?.strength ?? 0,
        srRatio,
        inSRZone: zone,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        pnlPct: trade.pnlPct,
        netPnlPct: trade.netPnlPct,
        isWin: trade.isWin,
        holdMinutes: trade.holdMinutes,
      });
    }

    console.log(`  Valid signals: ${signalCount}`);
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`TOTAL SIGNALS COLLECTED: ${allSignals.length}`);
  console.log(`${'='.repeat(80)}\n`);

  if (allSignals.length === 0) {
    console.log('No signals found. Check data path.');
    return;
  }

  // ========================================================================
  // ANALYSIS 1: BASELINE (no filter)
  // ========================================================================

  function analyzeGroup(signals: SignalWithSR[], label: string) {
    if (signals.length === 0) return null;
    const wins = signals.filter(s => s.isWin).length;
    const losses = signals.length - wins;
    const wr = (wins / signals.length) * 100;
    const avgPnl = signals.reduce((s, t) => s + t.netPnlPct, 0) / signals.length;
    const totalPnl = signals.reduce((s, t) => s + t.netPnlPct, 0);
    const avgWin = signals.filter(s => s.isWin).reduce((s, t) => s + t.netPnlPct, 0) / Math.max(1, wins);
    const avgLoss = signals.filter(s => !s.isWin).reduce((s, t) => s + t.netPnlPct, 0) / Math.max(1, losses);
    const pf = Math.abs(avgLoss) > 0 ? (avgWin * wins) / Math.abs(avgLoss * losses) : Infinity;

    return { label, trades: signals.length, wins, losses, wr, avgPnl, totalPnl, avgWin, avgLoss, pf };
  }

  function printStats(stats: ReturnType<typeof analyzeGroup>) {
    if (!stats) return;
    console.log(`  ${stats.label}`);
    console.log(`    Trades: ${stats.trades} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
    console.log(`    Win Rate: ${stats.wr.toFixed(1)}% | Avg PnL: ${stats.avgPnl.toFixed(3)}% | Total PnL: ${stats.totalPnl.toFixed(1)}%`);
    console.log(`    Avg Win: +${stats.avgWin.toFixed(3)}% | Avg Loss: ${stats.avgLoss.toFixed(3)}% | PF: ${stats.pf.toFixed(2)}`);
  }

  // Baseline
  console.log('BASELINE (No S/R Filter):');
  const baseline = analyzeGroup(allSignals, 'ALL SIGNALS');
  printStats(baseline);

  // ========================================================================
  // ANALYSIS 2: BY ZONE
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY S/R ZONE:');
  console.log('='.repeat(80));

  const zones = ['near_support', 'near_resistance', 'middle', 'above_resistance', 'below_support'] as const;
  for (const zone of zones) {
    const signals = allSignals.filter(s => s.inSRZone === zone);
    printStats(analyzeGroup(signals, `Zone: ${zone.toUpperCase()}`));
  }

  // ========================================================================
  // ANALYSIS 3: BY SIDE + ZONE
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY SIDE + ZONE:');
  console.log('='.repeat(80));

  for (const side of ['long', 'short'] as const) {
    console.log(`\n  --- ${side.toUpperCase()} SIGNALS ---`);
    for (const zone of zones) {
      const signals = allSignals.filter(s => s.side === side && s.inSRZone === zone);
      printStats(analyzeGroup(signals, `${side.toUpperCase()} in ${zone}`));
    }
  }

  // ========================================================================
  // ANALYSIS 4: DISTANCE BUCKETS
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY DISTANCE TO SUPPORT (for LONG signals):');
  console.log('='.repeat(80));

  const longSignals = allSignals.filter(s => s.side === 'long');
  const distBucketsSupport = [
    { label: '< 0.5% from support (very close)', min: 0, max: 0.5 },
    { label: '0.5-1.0% from support', min: 0.5, max: 1.0 },
    { label: '1.0-1.5% from support', min: 1.0, max: 1.5 },
    { label: '1.5-2.0% from support', min: 1.5, max: 2.0 },
    { label: '2.0-3.0% from support', min: 2.0, max: 3.0 },
    { label: '3.0-5.0% from support', min: 3.0, max: 5.0 },
    { label: '> 5.0% from support (far)', min: 5.0, max: 100 },
  ];

  for (const bucket of distBucketsSupport) {
    const signals = longSignals.filter(s => s.distToSupportPct >= bucket.min && s.distToSupportPct < bucket.max);
    printStats(analyzeGroup(signals, bucket.label));
  }

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY DISTANCE TO RESISTANCE (for LONG signals):');
  console.log('='.repeat(80));

  const distBucketsResistance = [
    { label: '< 0.5% to resistance (very close)', min: 0, max: 0.5 },
    { label: '0.5-1.0% to resistance', min: 0.5, max: 1.0 },
    { label: '1.0-1.5% to resistance', min: 1.0, max: 1.5 },
    { label: '1.5-2.0% to resistance', min: 1.5, max: 2.0 },
    { label: '2.0-3.0% to resistance', min: 2.0, max: 3.0 },
    { label: '3.0-5.0% to resistance', min: 3.0, max: 5.0 },
    { label: '> 5.0% to resistance (far, open space)', min: 5.0, max: 100 },
  ];

  for (const bucket of distBucketsResistance) {
    const signals = longSignals.filter(s => s.distToResistancePct >= bucket.min && s.distToResistancePct < bucket.max);
    printStats(analyzeGroup(signals, bucket.label));
  }

  // ========================================================================
  // ANALYSIS 5: SHORT SIGNALS + DISTANCE
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY DISTANCE TO RESISTANCE (for SHORT signals):');
  console.log('='.repeat(80));

  const shortSignals = allSignals.filter(s => s.side === 'short');
  for (const bucket of distBucketsResistance) {
    const signals = shortSignals.filter(s => s.distToResistancePct >= bucket.min && s.distToResistancePct < bucket.max);
    printStats(analyzeGroup(signals, `SHORT ${bucket.label}`));
  }

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY DISTANCE TO SUPPORT (for SHORT signals):');
  console.log('='.repeat(80));

  for (const bucket of distBucketsSupport) {
    const signals = shortSignals.filter(s => s.distToSupportPct >= bucket.min && s.distToSupportPct < bucket.max);
    printStats(analyzeGroup(signals, `SHORT ${bucket.label}`));
  }

  // ========================================================================
  // ANALYSIS 6: S/R STRENGTH
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY S/R LEVEL STRENGTH (touches):');
  console.log('='.repeat(80));

  const strengthBuckets = [
    { label: 'Weak S/R (1-2 touches)', min: 1, max: 2 },
    { label: 'Medium S/R (3-4 touches)', min: 3, max: 4 },
    { label: 'Strong S/R (5+ touches)', min: 5, max: 100 },
  ];

  console.log('\n  --- LONG near support ---');
  for (const bucket of strengthBuckets) {
    const signals = longSignals.filter(s =>
      s.distToSupportPct < 2.0 &&
      s.supportStrength >= bucket.min && s.supportStrength <= bucket.max
    );
    printStats(analyzeGroup(signals, `Support strength: ${bucket.label}`));
  }

  console.log('\n  --- LONG near resistance ---');
  for (const bucket of strengthBuckets) {
    const signals = longSignals.filter(s =>
      s.distToResistancePct < 2.0 &&
      s.resistanceStrength >= bucket.min && s.resistanceStrength <= bucket.max
    );
    printStats(analyzeGroup(signals, `Resistance strength: ${bucket.label}`));
  }

  // ========================================================================
  // ANALYSIS 7: SR RATIO (combined metric)
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('ANALYSIS BY S/R RATIO (0 = at resistance, 1 = at support):');
  console.log('='.repeat(80));

  const ratioBuckets = [
    { label: 'Ratio 0.0-0.2 (near resistance)', min: 0.0, max: 0.2 },
    { label: 'Ratio 0.2-0.4', min: 0.2, max: 0.4 },
    { label: 'Ratio 0.4-0.6 (middle)', min: 0.4, max: 0.6 },
    { label: 'Ratio 0.6-0.8', min: 0.6, max: 0.8 },
    { label: 'Ratio 0.8-1.0 (near support)', min: 0.8, max: 1.0 },
  ];

  console.log('\n  --- LONG ---');
  for (const bucket of ratioBuckets) {
    const signals = longSignals.filter(s => s.srRatio >= bucket.min && s.srRatio < bucket.max);
    printStats(analyzeGroup(signals, bucket.label));
  }

  console.log('\n  --- SHORT ---');
  for (const bucket of ratioBuckets) {
    const signals = shortSignals.filter(s => s.srRatio >= bucket.min && s.srRatio < bucket.max);
    printStats(analyzeGroup(signals, bucket.label));
  }

  // ========================================================================
  // ANALYSIS 8: FILTER CANDIDATES (test specific filter rules)
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('FILTER CANDIDATES - Testing specific S/R proximity filters:');
  console.log('='.repeat(80));

  type FilterRule = {
    name: string;
    filter: (s: SignalWithSR) => boolean;
  };

  const filterCandidates: FilterRule[] = [
    // === LONG filters based on resistance distance ===
    { name: 'LONG: Skip if resistance < 0.5%', filter: s => !(s.side === 'long' && s.distToResistancePct < 0.5) },
    { name: 'LONG: Skip if resistance < 1.0%', filter: s => !(s.side === 'long' && s.distToResistancePct < 1.0) },
    { name: 'LONG: Skip if resistance < 1.5%', filter: s => !(s.side === 'long' && s.distToResistancePct < 1.5) },
    { name: 'LONG: Skip if resistance < 2.0%', filter: s => !(s.side === 'long' && s.distToResistancePct < 2.0) },

    // === LONG filters based on support distance ===
    { name: 'LONG: Skip if support > 3.0% (too far)', filter: s => !(s.side === 'long' && s.distToSupportPct > 3.0) },
    { name: 'LONG: Skip if support > 4.0% (too far)', filter: s => !(s.side === 'long' && s.distToSupportPct > 4.0) },
    { name: 'LONG: Skip if support > 5.0% (too far)', filter: s => !(s.side === 'long' && s.distToSupportPct > 5.0) },

    // === LONG keep only near support ===
    { name: 'LONG: Only if support < 1.0%', filter: s => s.side !== 'long' || s.distToSupportPct < 1.0 },
    { name: 'LONG: Only if support < 1.5%', filter: s => s.side !== 'long' || s.distToSupportPct < 1.5 },
    { name: 'LONG: Only if support < 2.0%', filter: s => s.side !== 'long' || s.distToSupportPct < 2.0 },

    // === LONG combined: near support + far from resistance ===
    { name: 'LONG: support < 2% AND resistance > 1%', filter: s => s.side !== 'long' || (s.distToSupportPct < 2.0 && s.distToResistancePct > 1.0) },
    { name: 'LONG: support < 2% AND resistance > 1.5%', filter: s => s.side !== 'long' || (s.distToSupportPct < 2.0 && s.distToResistancePct > 1.5) },
    { name: 'LONG: support < 3% AND resistance > 1%', filter: s => s.side !== 'long' || (s.distToSupportPct < 3.0 && s.distToResistancePct > 1.0) },

    // === SR Ratio filters ===
    { name: 'LONG: SR ratio > 0.3 (not near resistance)', filter: s => s.side !== 'long' || s.srRatio > 0.3 },
    { name: 'LONG: SR ratio > 0.4', filter: s => s.side !== 'long' || s.srRatio > 0.4 },
    { name: 'LONG: SR ratio > 0.5 (closer to support)', filter: s => s.side !== 'long' || s.srRatio > 0.5 },

    // === SHORT filters ===
    { name: 'SHORT: Skip if support < 0.5% (too close to bounce)', filter: s => !(s.side === 'short' && s.distToSupportPct < 0.5) },
    { name: 'SHORT: Skip if support < 1.0%', filter: s => !(s.side === 'short' && s.distToSupportPct < 1.0) },
    { name: 'SHORT: Skip if support < 1.5%', filter: s => !(s.side === 'short' && s.distToSupportPct < 1.5) },
    { name: 'SHORT: Only if resistance < 1.0% (near overhead resistance)', filter: s => s.side !== 'short' || s.distToResistancePct < 1.0 },
    { name: 'SHORT: Only if resistance < 2.0%', filter: s => s.side !== 'short' || s.distToResistancePct < 2.0 },

    // === SHORT SR ratio ===
    { name: 'SHORT: SR ratio < 0.5 (closer to resistance)', filter: s => s.side !== 'short' || s.srRatio < 0.5 },
    { name: 'SHORT: SR ratio < 0.3 (near resistance)', filter: s => s.side !== 'short' || s.srRatio < 0.3 },

    // === Strength-based filters ===
    { name: 'LONG: Require support strength >= 3', filter: s => s.side !== 'long' || s.supportStrength >= 3 },
    { name: 'LONG: Require nearby S/R strength >= 3', filter: s => s.side !== 'long' || s.supportStrength >= 3 || s.resistanceStrength >= 3 },
    { name: 'SHORT: Require resistance strength >= 3', filter: s => s.side !== 'short' || s.resistanceStrength >= 3 },

    // === COMBINED filters (LONG + SHORT together) ===
    { name: 'BOTH: Skip LONG near resistance (<1%) + SHORT near support (<1%)',
      filter: s => {
        if (s.side === 'long' && s.distToResistancePct < 1.0) return false;
        if (s.side === 'short' && s.distToSupportPct < 1.0) return false;
        return true;
      }
    },
    { name: 'BOTH: Skip LONG near resistance (<1.5%) + SHORT near support (<1.5%)',
      filter: s => {
        if (s.side === 'long' && s.distToResistancePct < 1.5) return false;
        if (s.side === 'short' && s.distToSupportPct < 1.5) return false;
        return true;
      }
    },
    { name: 'BOTH: LONG support<2%+resistance>1% + SHORT resistance<2%+support>1%',
      filter: s => {
        if (s.side === 'long') return s.distToSupportPct < 2.0 && s.distToResistancePct > 1.0;
        if (s.side === 'short') return s.distToResistancePct < 2.0 && s.distToSupportPct > 1.0;
        return true;
      }
    },

    // Above resistance / below support (breakout confirmed past S/R)
    { name: 'LONG: Only above_resistance zone (broke through)', filter: s => s.side !== 'long' || s.inSRZone === 'above_resistance' },
    { name: 'LONG: Exclude above_resistance zone', filter: s => s.side !== 'long' || s.inSRZone !== 'above_resistance' },
    { name: 'SHORT: Only below_support zone (broke through)', filter: s => s.side !== 'short' || s.inSRZone === 'below_support' },
    { name: 'SHORT: Exclude below_support zone', filter: s => s.side !== 'short' || s.inSRZone !== 'below_support' },
  ];

  // Compare each filter to baseline
  interface FilterResult {
    name: string;
    trades: number;
    tradesRemoved: number;
    wr: number;
    wrDelta: number;
    avgPnl: number;
    avgPnlDelta: number;
    totalPnl: number;
    totalPnlDelta: number;
    pf: number;
    score: number; // Combined score
  }

  const baselineWr = baseline!.wr;
  const baselineAvgPnl = baseline!.avgPnl;
  const baselineTotalPnl = baseline!.totalPnl;

  const filterResults: FilterResult[] = [];

  for (const fc of filterCandidates) {
    const filtered = allSignals.filter(fc.filter);
    if (filtered.length < 20) continue; // Need enough trades for significance

    const stats = analyzeGroup(filtered, fc.name);
    if (!stats) continue;

    filterResults.push({
      name: fc.name,
      trades: stats.trades,
      tradesRemoved: allSignals.length - stats.trades,
      wr: stats.wr,
      wrDelta: stats.wr - baselineWr,
      avgPnl: stats.avgPnl,
      avgPnlDelta: stats.avgPnl - baselineAvgPnl,
      totalPnl: stats.totalPnl,
      totalPnlDelta: stats.totalPnl - baselineTotalPnl,
      pf: stats.pf,
      // Score: reward WR improvement and avg PnL improvement, penalize too many removed trades
      score: (stats.wr - baselineWr) * 2 + (stats.avgPnl - baselineAvgPnl) * 100 +
             (stats.trades > allSignals.length * 0.3 ? 0 : -20), // Penalize if <30% trades remain
    });
  }

  // Sort by score
  filterResults.sort((a, b) => b.score - a.score);

  console.log('\n  RANKED FILTER RESULTS (best first):');
  console.log('  ' + '-'.repeat(76));
  console.log(`  ${'Filter'.padEnd(55)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'dWR'.padStart(6)} ${'AvgPnl'.padStart(8)} ${'dAvgPnl'.padStart(8)} ${'TotalPnl'.padStart(9)} ${'PF'.padStart(5)}`);
  console.log('  ' + '-'.repeat(76));

  for (const r of filterResults) {
    const wrSign = r.wrDelta >= 0 ? '+' : '';
    const avgSign = r.avgPnlDelta >= 0 ? '+' : '';
    const totalSign = r.totalPnlDelta >= 0 ? '+' : '';
    console.log(`  ${r.name.padEnd(55)} ${String(r.trades).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${(wrSign + r.wrDelta.toFixed(1)).padStart(6)} ${r.avgPnl.toFixed(3).padStart(8)} ${(avgSign + r.avgPnlDelta.toFixed(3)).padStart(8)} ${r.totalPnl.toFixed(0).padStart(9)} ${r.pf.toFixed(2).padStart(5)}`);
  }

  // ========================================================================
  // ANALYSIS 9: EXHAUSTIVE GRID SEARCH
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('GRID SEARCH - Optimal LONG S/R Proximity Parameters:');
  console.log('='.repeat(80));

  interface GridResult {
    maxDistSupport: number;
    minDistResistance: number;
    trades: number;
    wr: number;
    avgPnl: number;
    totalPnl: number;
    pf: number;
    score: number;
  }

  const gridResults: GridResult[] = [];

  const maxDistSupportValues = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 10.0, 100.0];
  const minDistResistanceValues = [0.0, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0];

  for (const maxDistSupport of maxDistSupportValues) {
    for (const minDistResistance of minDistResistanceValues) {
      const filtered = allSignals.filter(s => {
        if (s.side === 'long') {
          return s.distToSupportPct <= maxDistSupport && s.distToResistancePct >= minDistResistance;
        }
        return true; // Keep all shorts
      });

      if (filtered.length < 30) continue;

      const stats = analyzeGroup(filtered, 'grid');
      if (!stats) continue;

      gridResults.push({
        maxDistSupport,
        minDistResistance,
        trades: stats.trades,
        wr: stats.wr,
        avgPnl: stats.avgPnl,
        totalPnl: stats.totalPnl,
        pf: stats.pf,
        score: (stats.wr - baselineWr) * 2 + (stats.avgPnl - baselineAvgPnl) * 100 +
               (stats.trades > allSignals.length * 0.3 ? 0 : -10),
      });
    }
  }

  gridResults.sort((a, b) => b.score - a.score);

  console.log(`\n  TOP 15 CONFIGURATIONS:`);
  console.log(`  ${'MaxDistS'.padStart(8)} ${'MinDistR'.padStart(8)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'dWR'.padStart(6)} ${'AvgPnl'.padStart(8)} ${'TotalPnl'.padStart(9)} ${'PF'.padStart(5)} ${'Score'.padStart(7)}`);
  console.log('  ' + '-'.repeat(70));

  for (const r of gridResults.slice(0, 15)) {
    const wrDelta = r.wr - baselineWr;
    const wrSign = wrDelta >= 0 ? '+' : '';
    console.log(`  ${r.maxDistSupport.toFixed(1).padStart(8)} ${r.minDistResistance.toFixed(1).padStart(8)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)} ${(wrSign + wrDelta.toFixed(1)).padStart(6)} ${r.avgPnl.toFixed(3).padStart(8)} ${r.totalPnl.toFixed(0).padStart(9)} ${r.pf.toFixed(2).padStart(5)} ${r.score.toFixed(1).padStart(7)}`);
  }

  // ========================================================================
  // ANALYSIS 10: GRID SEARCH FOR SHORT SIGNALS
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('GRID SEARCH - Optimal SHORT S/R Proximity Parameters:');
  console.log('='.repeat(80));

  const shortGridResults: GridResult[] = [];

  const maxDistResistanceValues = [1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 10.0, 100.0];
  const minDistSupportValues = [0.0, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0, 3.0];

  for (const maxDistResistance of maxDistResistanceValues) {
    for (const minDistSupport of minDistSupportValues) {
      const filtered = allSignals.filter(s => {
        if (s.side === 'short') {
          return s.distToResistancePct <= maxDistResistance && s.distToSupportPct >= minDistSupport;
        }
        return true; // Keep all longs
      });

      if (filtered.length < 30) continue;

      const stats = analyzeGroup(filtered, 'grid');
      if (!stats) continue;

      shortGridResults.push({
        maxDistSupport: maxDistResistance, // reusing field name for SHORT
        minDistResistance: minDistSupport,
        trades: stats.trades,
        wr: stats.wr,
        avgPnl: stats.avgPnl,
        totalPnl: stats.totalPnl,
        pf: stats.pf,
        score: (stats.wr - baselineWr) * 2 + (stats.avgPnl - baselineAvgPnl) * 100 +
               (stats.trades > allSignals.length * 0.3 ? 0 : -10),
      });
    }
  }

  shortGridResults.sort((a, b) => b.score - a.score);

  console.log(`\n  TOP 15 CONFIGURATIONS (SHORT: MaxDistR=max dist to resistance, MinDistS=min dist to support):`);
  console.log(`  ${'MaxDistR'.padStart(8)} ${'MinDistS'.padStart(8)} ${'Trades'.padStart(7)} ${'WR%'.padStart(6)} ${'dWR'.padStart(6)} ${'AvgPnl'.padStart(8)} ${'TotalPnl'.padStart(9)} ${'PF'.padStart(5)} ${'Score'.padStart(7)}`);
  console.log('  ' + '-'.repeat(70));

  for (const r of shortGridResults.slice(0, 15)) {
    const wrDelta = r.wr - baselineWr;
    const wrSign = wrDelta >= 0 ? '+' : '';
    console.log(`  ${r.maxDistSupport.toFixed(1).padStart(8)} ${r.minDistResistance.toFixed(1).padStart(8)} ${String(r.trades).padStart(7)} ${r.wr.toFixed(1).padStart(6)} ${(wrSign + wrDelta.toFixed(1)).padStart(6)} ${r.avgPnl.toFixed(3).padStart(8)} ${r.totalPnl.toFixed(0).padStart(9)} ${r.pf.toFixed(2).padStart(5)} ${r.score.toFixed(1).padStart(7)}`);
  }

  // ========================================================================
  // FINAL SUMMARY
  // ========================================================================

  console.log('\n' + '='.repeat(80));
  console.log('FINAL RECOMMENDATION:');
  console.log('='.repeat(80));

  const bestFilter = filterResults[0];
  const bestGrid = gridResults[0];
  const bestShortGrid = shortGridResults[0];

  if (bestFilter) {
    console.log(`\n  Best Named Filter: ${bestFilter.name}`);
    console.log(`    Trades: ${bestFilter.trades} (removed ${bestFilter.tradesRemoved})`);
    console.log(`    WR: ${bestFilter.wr.toFixed(1)}% (${bestFilter.wrDelta >= 0 ? '+' : ''}${bestFilter.wrDelta.toFixed(1)}pp)`);
    console.log(`    Avg PnL: ${bestFilter.avgPnl.toFixed(3)}% (${bestFilter.avgPnlDelta >= 0 ? '+' : ''}${bestFilter.avgPnlDelta.toFixed(3)}%)`);
    console.log(`    Total PnL: ${bestFilter.totalPnl.toFixed(1)}% (${bestFilter.totalPnlDelta >= 0 ? '+' : ''}${bestFilter.totalPnlDelta.toFixed(1)}%)`);
    console.log(`    PF: ${bestFilter.pf.toFixed(2)}`);
  }

  if (bestGrid) {
    console.log(`\n  Best LONG Grid: MaxDistSupport=${bestGrid.maxDistSupport}%, MinDistResistance=${bestGrid.minDistResistance}%`);
    console.log(`    Trades: ${bestGrid.trades} | WR: ${bestGrid.wr.toFixed(1)}% | Avg PnL: ${bestGrid.avgPnl.toFixed(3)}% | Total: ${bestGrid.totalPnl.toFixed(1)}% | PF: ${bestGrid.pf.toFixed(2)}`);
  }

  if (bestShortGrid) {
    console.log(`\n  Best SHORT Grid: MaxDistResistance=${bestShortGrid.maxDistSupport}%, MinDistSupport=${bestShortGrid.minDistResistance}%`);
    console.log(`    Trades: ${bestShortGrid.trades} | WR: ${bestShortGrid.wr.toFixed(1)}% | Avg PnL: ${bestShortGrid.avgPnl.toFixed(3)}% | Total: ${bestShortGrid.totalPnl.toFixed(1)}% | PF: ${bestShortGrid.pf.toFixed(2)}`);
  }

  console.log('\n' + '='.repeat(80));
}

main().catch(console.error);
