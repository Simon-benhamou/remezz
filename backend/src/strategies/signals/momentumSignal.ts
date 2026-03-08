import {
  MomentumConfig,
  type Candle,
  type SignalResult,
  type MarketConditions,
} from '../config/momentumConfig.js';

import {
  calcMA,
  calcSMA,
  calcROC,
  calcVolRatio,
  calcBollingerBands,
  countConsecUp,
  countConsecDown,
  detectMarketRegime,
  checkMTFAlignment,
  checkBTCVolatility,
  calcGreenRatio,
  calcAlternation5,
  calcBBTouchCount,
  calcRocAcceleration,
  calcADX,
} from '../indicators/technicalIndicators.js';

export function getMarketConditions(btcCandles: Candle[], btcCandlesRegime?: Candle[]): MarketConditions {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const isTradingDay = true;

  if (btcCandles.length < 200) {
    return {
      isTradingDay,
      dayOfWeek,
      btcTrend: 'neutral',
      btcMomentum6h: 0,
      btcAboveMa50: false,
      overallStatus: 'unfavorable',
      reason: 'Insufficient BTC data (need 200 candles for SMA200)',
      checkedAt: Date.now(),
    };
  }

  const btcCloses = btcCandles.map(c => c.close);
  const btcNow15m = btcCloses[btcCloses.length - 1];

  // V5.102: Use regime-timeframe candles for SMA200 (default 15m since V5.102, configurable via BTC_REGIME_TIMEFRAME)
  let btcSma200: number;
  let btcNow: number;
  if (btcCandlesRegime && btcCandlesRegime.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
    const btcClosesRegime = btcCandlesRegime.map(c => c.close);
    btcSma200 = calcSMA(btcClosesRegime, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcClosesRegime[btcClosesRegime.length - 1];
  } else {
    btcSma200 = calcMA(btcCloses, 200);
    btcNow = btcNow15m;
  }
  // V5.113: Tolerance band around SMA200 to prevent whipsaw
  const mcTolerancePct = (MomentumConfig.ENTRY as any).BTC_REGIME_TOLERANCE_PCT ?? 0;
  const mcTolerance = btcSma200 > 0 ? btcSma200 * (mcTolerancePct / 100) : 0;
  let btcAboveSma200: boolean;
  if (mcTolerance > 0 && Math.abs(btcNow - btcSma200) <= mcTolerance) {
    // In dead zone: use SMA200 slope
    const slopeCloses = btcCandlesRegime && btcCandlesRegime.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1
      ? btcCandlesRegime.map(c => c.close)
      : btcCloses;
    if (slopeCloses.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1) {
      const sma200Prev = calcSMA(slopeCloses.slice(-(MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1), -1), MomentumConfig.ENTRY.BTC_SMA_PERIOD);
      btcAboveSma200 = btcSma200 >= sma200Prev;
    } else {
      btcAboveSma200 = btcNow > btcSma200;
    }
  } else {
    btcAboveSma200 = btcNow > btcSma200;
  }

  // BTC momentum 6h — timestamp-based lookback to handle candle gaps correctly
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const targetTs = btcCandles[btcCandles.length - 1].timestamp - SIX_HOURS_MS;
  let btc6hAgoIndex = 0;
  for (let i = btcCandles.length - 1; i >= 0; i--) {
    if (btcCandles[i].timestamp <= targetTs) {
      btc6hAgoIndex = i;
      break;
    }
  }
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow15m - btc6hAgo) / btc6hAgo) * 100 : 0;

  // V5.3 Regime: BTC > SMA200 = BULL (LONG), else BEAR (SHORT)
  let btcTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (btcAboveSma200) {
    btcTrend = 'bullish';
  } else {
    btcTrend = 'bearish';
  }

  // V5.3: LONG en bull, SHORT en bear
  let overallStatus: MarketConditions['overallStatus'] = 'neutral';
  let reason = '';

  if (btcAboveSma200) {
    overallStatus = 'favorable_long';
    reason = `V5.3 BULL: BTC ${btcNow.toFixed(0)} > SMA200 ${btcSma200.toFixed(0)} → LONG only`;
  } else {
    // V5.3: SHORT en bear market
    overallStatus = 'favorable_short';
    reason = `V5.3 BEAR: BTC ${btcNow.toFixed(0)} < SMA200 ${btcSma200.toFixed(0)} → SHORT only`;
  }

  return {
    isTradingDay,
    dayOfWeek,
    btcTrend,
    btcMomentum6h,
    btcAboveMa50: btcAboveSma200,  // V5: Use SMA200 for regime (dashboard displays this)
    btcAboveSma200,                 // V5: Explicit field for clarity
    overallStatus,
    reason,
    checkedAt: Date.now(),
  };
}

// ============================================================================
// V5.64: WICK BREAKOUT EARLY ENTRY FUNCTIONS
// ============================================================================
// Shared functions used by both backtest and production for consistent logic

export interface WickBreakoutResult {
  /** Whether early entry conditions are met */
  triggered: boolean;
  /** Calculated early entry price (null if not triggered) */
  entryPrice: number | null;
  /** Price improvement vs candle close (positive = better entry) */
  improvement: number | null;
}

/**
 * Check if wick breakout early entry is possible for LONG
 *
 * V5.64: Enter earlier when high breaks above BB_upper + buffer
 * instead of waiting for candle close.
 *
 * @param candle Current candle with OHLC data
 * @param bbUpper Bollinger Band upper value
 * @returns WickBreakoutResult with entry details
 */
export function checkWickBreakoutLong(
  candle: { open: number; high: number; low: number; close: number },
  bbUpper: number
): WickBreakoutResult {
  const config = MomentumConfig.WICK_BREAKOUT;

  if (!config.ENABLED) {
    return { triggered: false, entryPrice: null, improvement: null };
  }

  // LONG: Did the high break above BB_upper + buffer?
  const breakoutTarget = bbUpper * (1 + config.LONG_BB_BUFFER);

  if (candle.high >= breakoutTarget) {
    // Calculate early entry price at BB_upper × 1.003
    const idealEntryPrice = bbUpper * (1 + config.LONG_ENTRY_BUFFER);

    // Sanity: entry price should be achievable within the candle
    // Must be between open and high
    const entryPrice = Math.min(candle.high, Math.max(candle.open, idealEntryPrice));

    // Calculate improvement (positive = better entry for LONG = lower price)
    const improvement = candle.close > 0
      ? ((candle.close - entryPrice) / candle.close) * 100
      : 0;

    return {
      triggered: true,
      entryPrice,
      improvement,
    };
  }

  return { triggered: false, entryPrice: null, improvement: null };
}

/**
 * Check if wick breakout early entry is possible for SHORT
 *
 * V5.64: Enter earlier when low breaks below BB_lower - buffer
 * instead of waiting for candle close.
 *
 * @param candle Current candle with OHLC data
 * @param bbLower Bollinger Band lower value
 * @returns WickBreakoutResult with entry details
 */
export function checkWickBreakoutShort(
  candle: { open: number; high: number; low: number; close: number },
  bbLower: number
): WickBreakoutResult {
  const config = MomentumConfig.WICK_BREAKOUT;

  if (!config.ENABLED) {
    return { triggered: false, entryPrice: null, improvement: null };
  }

  // SHORT: Did the low break below BB_lower - buffer?
  const breakdownTarget = bbLower * (1 - config.SHORT_BB_BUFFER);

  if (candle.low <= breakdownTarget) {
    // Calculate early entry price at BB_lower × 0.997
    const idealEntryPrice = bbLower * (1 - config.SHORT_ENTRY_BUFFER);

    // Sanity: entry price should be achievable within the candle
    // Must be between open and low
    const entryPrice = Math.max(candle.low, Math.min(candle.open, idealEntryPrice));

    // Calculate improvement (positive = better entry for SHORT = higher price)
    const improvement = candle.close > 0
      ? ((entryPrice - candle.close) / candle.close) * 100
      : 0;

    return {
      triggered: true,
      entryPrice,
      improvement,
    };
  }

  return { triggered: false, entryPrice: null, improvement: null };
}

/**
 * Unified wick breakout check for any side
 *
 * @param candle Current candle with OHLC data
 * @param bb Bollinger Bands { upper, lower }
 * @param side Trade side ('long' or 'short')
 * @returns WickBreakoutResult with entry details
 */
export function checkWickBreakout(
  candle: { open: number; high: number; low: number; close: number },
  bb: { upper: number; lower: number },
  side: 'long' | 'short'
): WickBreakoutResult {
  if (side === 'long') {
    return checkWickBreakoutLong(candle, bb.upper);
  } else {
    return checkWickBreakoutShort(candle, bb.lower);
  }
}

/**
 * Calculate RSI (Relative Strength Index)
 * @param closes - Array of closing prices
 * @param period - RSI period (default 14)
 * @returns RSI value 0-100 or null if insufficient data
 */
function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Calculate initial average gain/loss
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate Stochastic RSI
 * StochRSI = (RSI - RSI_Low) / (RSI_High - RSI_Low) * 100
 *
 * @param closes - Array of closing prices
 * @param rsiPeriod - RSI period (default 14)
 * @param stochPeriod - Stochastic lookback period (default 14)
 * @param smooth - Smoothing period (default 3)
 * @returns StochRSI value 0-100 or null if insufficient data
 */
function calcStochRSI(
  closes: number[],
  rsiPeriod = 14,
  stochPeriod = 14,
  smooth = 3
): number | null {
  const minLength = rsiPeriod + stochPeriod + smooth;
  if (closes.length < minLength) return null;

  // Calculate RSI series
  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const rsi = calcRSI(slice, rsiPeriod);
    if (rsi !== null) rsiValues.push(rsi);
  }

  if (rsiValues.length < stochPeriod) return null;

  // Calculate StochRSI for recent values
  const stochRsiRaw: number[] = [];
  for (let i = stochPeriod; i <= rsiValues.length; i++) {
    const rsiSlice = rsiValues.slice(i - stochPeriod, i);
    const rsiHigh = Math.max(...rsiSlice);
    const rsiLow = Math.min(...rsiSlice);
    const currentRsi = rsiSlice[rsiSlice.length - 1];

    if (rsiHigh === rsiLow) {
      stochRsiRaw.push(50); // Neutral when no range
    } else {
      stochRsiRaw.push(((currentRsi - rsiLow) / (rsiHigh - rsiLow)) * 100);
    }
  }

  if (stochRsiRaw.length < smooth) return null;

  // Smooth the StochRSI (%K line)
  const smoothSlice = stochRsiRaw.slice(-smooth);
  return smoothSlice.reduce((a, b) => a + b, 0) / smooth;
}

// ============================================================================
// SIGNAL CHECK V5.3 - LONG (Bull) + SHORT (Bear)
// ============================================================================

/**
 * Check momentum signal V5.3 - LONG in bull, SHORT in bear
 *
 * LONG conditions (BTC > SMA200):
 * 1. Close > Bollinger Upper Band (breakout)
 * 2. ROC 10 > 2.5% (strict)
 * 3. Volume > 2x average (strict)
 * 4. ConsecUp <= 3 (pas en top)
 *
 * SHORT conditions (BTC < SMA200):
 * 1. ROC 5 < -2% (drop significatif)
 * 2. Volume > 2.5x average (panic selling)
 * 3. Price < MA20
 * 4. ConsecDown <= 5 (pas oversold)
 *
 * @param symbol Trading symbol
 * @param candles Symbol candles (15m)
 * @param btcCandles BTC candles (15m) for volatility filter and legacy features
 */
export function checkMomentumSignal(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[],
  opts?: {
    nowMs?: number;
    btcCandlesRegime?: Candle[];  // V5.36: For MTF filter + V5.82: For regime SMA200
  }
): SignalResult {
  // Need more data for SMA200
  if (candles.length < 50 || btcCandles.length < 200) {
    return { valid: false, reason: 'insufficient_candles' };
  }

  // Données bougie actuelle
  const current = candles[candles.length - 1];
  const { open, close } = current;

  // Extraire closes et volumes
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const btcCloses = btcCandles.map(c => c.close);

  // ========== REGIME FILTER: BTC vs SMA200 ==========
  // V5.82: Use 1h candles for regime SMA200 (200h = ~8 days) — much more stable
  // V5.102: Use regime-timeframe candles (default 15m) for SMA200.
  // Falls back to symbol 15m candles if regime candles not available.
  let btcSma200: number;
  let btcNow: number;
  const btcCandlesRegime = opts?.btcCandlesRegime;
  if (btcCandlesRegime && btcCandlesRegime.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
    const btcClosesRegime = btcCandlesRegime.map(c => c.close);
    btcSma200 = calcSMA(btcClosesRegime, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcClosesRegime[btcClosesRegime.length - 1];
  } else {
    // Fallback to 15m if regime candles not available (startup, insufficient data)
    btcSma200 = calcSMA(btcCloses, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcCloses[btcCloses.length - 1];
  }
  // V5.113: Tolerance band around SMA200 to prevent whipsaw at boundary
  const regimeTolerancePct = (MomentumConfig.ENTRY as any).BTC_REGIME_TOLERANCE_PCT ?? 0;
  const regimeTolerance = btcSma200 > 0 ? btcSma200 * (regimeTolerancePct / 100) : 0;
  let btcInBullRegime: boolean;
  let btcInBearRegime: boolean;
  if (regimeTolerance > 0 && Math.abs(btcNow - btcSma200) <= regimeTolerance) {
    // In dead zone: use SMA200 slope to determine regime
    const btcClosesForSlope = btcCandlesRegime && btcCandlesRegime.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1
      ? btcCandlesRegime.map(c => c.close)
      : btcCloses;
    if (btcClosesForSlope.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1) {
      const sma200Prev = calcSMA(btcClosesForSlope.slice(-(MomentumConfig.ENTRY.BTC_SMA_PERIOD + 1), -1), MomentumConfig.ENTRY.BTC_SMA_PERIOD);
      btcInBullRegime = btcSma200 >= sma200Prev;
      btcInBearRegime = !btcInBullRegime;
    } else {
      btcInBullRegime = btcNow > btcSma200;
      btcInBearRegime = !btcInBullRegime;
    }
  } else {
    btcInBullRegime = btcNow > btcSma200;
    btcInBearRegime = btcNow < btcSma200;
  }

  // V5.129: Skip entries when BTC is too close to SMA200 (regime uncertainty zone)
  // Data shows: when |dist| < 1%, 268 trades at 56% WR and -$14,462 total PnL
  const skipZonePct = (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_PCT ?? 0;
  if (skipZonePct > 0 && btcSma200 > 0) {
    const distFromSma200Pct = Math.abs((btcNow - btcSma200) / btcSma200) * 100;
    if (distFromSma200Pct < skipZonePct) {
      // Quality bypass: allow high-quality signals through the skip zone
      const qualityBypass = (MomentumConfig.ENTRY as any).BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS ?? 0;
      if (qualityBypass > 0 && candles.length >= 20) {
        const vols = candles.map(c => c.volume);
        const volR = calcVolRatio(vols);
        const roc10 = calcROC(closes, 10);
        const roc5 = calcROC(closes, 5);
        const sma20now = calcSMA(closes, 20);
        const sma20prev = closes.length >= 21 ? calcSMA(closes.slice(0, -1), 20) : sma20now;
        const smaSlope = sma20prev > 0 ? ((sma20now - sma20prev) / sma20prev) * 100 : 0;
        // Composite score 0-100: volRatio(25) + ROC10(25) + ROC5(25) + SMA slope(25)
        const volScore = Math.min(volR / 3.0, 1) * 25;       // 3x avg volume = max
        const roc10Score = Math.min(Math.abs(roc10) / 4.0, 1) * 25;  // 4% ROC10 = max
        const roc5Score = Math.min(Math.abs(roc5) / 3.0, 1) * 25;    // 3% ROC5 = max
        const slopeScore = Math.min(Math.abs(smaSlope) / 0.3, 1) * 25; // 0.3% slope = max
        const qualityScore = volScore + roc10Score + roc5Score + slopeScore;
        if (qualityScore >= qualityBypass) {
          // Bypass: quality signal allowed through skip zone
        } else {
          return { valid: false, reason: `sma200_skip_zone(dist=${distFromSma200Pct.toFixed(2)}%<${skipZonePct}%,Q=${qualityScore.toFixed(0)}<${qualityBypass})` };
        }
      } else {
        return { valid: false, reason: `sma200_skip_zone(dist=${distFromSma200Pct.toFixed(2)}%<${skipZonePct}%)` };
      }
    }
  }

  // Calcul legacy pour compatibilité features — timestamp-based to handle candle gaps
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const targetTs = btcCandles[btcCandles.length - 1].timestamp - SIX_HOURS_MS;
  let btc6hAgoIndex = 0;
  for (let i = btcCandles.length - 1; i >= 0; i--) {
    if (btcCandles[i].timestamp <= targetTs) {
      btc6hAgoIndex = i;
      break;
    }
  }
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  const ma20 = calcMA(closes, 20);
  const btcMa50 = calcMA(btcCloses, 50);
  const btcAboveMa50 = btcNow > btcMa50;

  // ========== COMMON DATA ==========
  const volRatio = calcVolRatio(volumes);
  const nowMs = opts?.nowMs ?? Date.now();
  const dayOfWeek = new Date(nowMs).getUTCDay();
  const isBullish = close > open;
  const isBearish = close < open;
  const priceAboveMa20 = close > ma20;
  const priceBelowMa20 = close < ma20;

  // V5.3 features
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const roc1 = calcROC(closes, 1);  // V5.33: Current candle momentum
  const consecUp = countConsecUp(candles);
  const consecDown = countConsecDown(candles);
  const bb = calcBollingerBands(closes, MomentumConfig.ENTRY.BB_PERIOD, MomentumConfig.ENTRY.BB_STD);

  // V5.8: StochRSI calculation
  const stochRsiConfig = MomentumConfig.STOCHRSI_FILTER;
  const stochRsi = calcStochRSI(
    closes,
    stochRsiConfig.RSI_PERIOD,
    stochRsiConfig.STOCH_PERIOD,
    stochRsiConfig.STOCH_SMOOTH
  );

  // V5.147: Pre-compute BTC 24h change for features + filter
  let btcChange24h: number | null = null;
  if (btcCandles.length >= 97) {
    const btcNowPrice = btcCandles[btcCandles.length - 1].close;
    const btc24hAgoPrice = btcCandles[btcCandles.length - 97].close;
    btcChange24h = btc24hAgoPrice > 0 ? (btcNowPrice - btc24hAgoPrice) / btc24hAgoPrice * 100 : null;
  }

  const features = {
    volRatio,
    isBullish,
    priceAboveMa20,
    btcAboveMa50,
    btcMomentum6h,
    dayOfWeek,
    roc: roc10 * 100,
    roc5: roc5 * 100,
    roc1: roc1 * 100,  // V5.33: Current candle momentum
    consecUp,
    consecDown,
    btcInBullRegime,
    btcInBearRegime,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    stochRsi: stochRsi ?? undefined,  // V5.8
    btcChange24h,  // V5.147: BTC 24h % change for signal logging diagnostics
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.9: StochRSI FILTER - SHORT ONLY (moved from here to bear regime section)
  // The StochRSI filter is now applied only to SHORT trades, not LONG
  // LONG uses VOL_MULTIPLIER: 3.0 instead as its quality filter
  // ═══════════════════════════════════════════════════════════════════════════
  // (StochRSI filter removed from here - now in bear regime section below)

  // ═══════════════════════════════════════════════════════════════════════════
  // CASH MODE: Skip entry in choppy / low-vol markets
  // ═══════════════════════════════════════════════════════════════════════════
  if (MomentumConfig.CASH_MODE.ENABLED) {
    const regime = detectMarketRegime(btcCandles, btcCandlesRegime || []);
    if (regime === 'CHOPPY' || regime === 'LOW_VOL') {
      return { valid: false, reason: `cash_mode:${regime.toLowerCase()}`, features };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.12 BULL REGIME → LONG ONLY
  // V5.10 RSI+BTC filter REMOVED - 2-year backtest showed it blocked good trades
  // V5.32: Added ANTICIPATORY ENTRY - Enter BEFORE breakout on BB Squeeze
  // ═══════════════════════════════════════════════════════════════════════════
  if (btcInBullRegime) {
    // LONG conditions V5.12 (breakout-based)
    const requireBBBreakout = MomentumConfig.ENTRY_LONG.REQUIRE_BB_BREAKOUT !== false;
    const breakoutOk = requireBBBreakout ? close > bb.upper : true;
    const rocOk = roc10 >= MomentumConfig.ENTRY_LONG.ROC_MIN;
    const volOk = volRatio >= MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER;
    const consecOk = consecUp <= MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP;

    if (!isBullish) {
      return { valid: false, reason: 'bull_regime:bearish_candle', features };
    }
    if (!consecOk) {
      return {
        valid: false,
        reason: `bull_regime:too_many_consec_up(${consecUp}>${MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP})`,
        features
      };
    }
    if (!breakoutOk) {
      return {
        valid: false,
        reason: `bull_regime:no_breakout(close=${close.toFixed(4)} < bb_upper=${bb.upper.toFixed(4)})`,
        features
      };
    }
    if (!rocOk) {
      return {
        valid: false,
        reason: `bull_regime:roc_low(${(roc10*100).toFixed(2)}% < ${(MomentumConfig.ENTRY_LONG.ROC_MIN*100).toFixed(1)}%)`,
        features
      };
    }
    if (!volOk) {
      return {
        valid: false,
        reason: `bull_regime:vol_low(${volRatio.toFixed(1)}x < ${MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER}x)`,
        features
      };
    }

    // V5.139: Range Position Filter — reject entries in the "death zone" of recent range
    const rpf = MomentumConfig.RANGE_POSITION_FILTER;
    if (rpf.ENABLED) {
      const rpLookback = candles.slice(-rpf.LOOKBACK_CANDLES);
      const rpHigh = Math.max(...rpLookback.map(c => c.high));
      const rpLow = Math.min(...rpLookback.map(c => c.low));
      const rangePos = rpHigh > rpLow ? (close - rpLow) / (rpHigh - rpLow) : 0.5;
      if (rangePos >= rpf.DEATH_ZONE_LOW && rangePos < rpf.DEATH_ZONE_HIGH) {
        return {
          valid: false,
          reason: `bull_regime:range_death_zone(pos=${(rangePos*100).toFixed(1)}% in [${rpf.DEATH_ZONE_LOW*100}-${rpf.DEATH_ZONE_HIGH*100}%])`,
          features
        };
      }
    }

    // V5.141: Body ratio filter — reject doji/indecision candles
    const eqConfigLong = MomentumConfig.ENTRY_QUALITY;
    if (eqConfigLong.BODY_RATIO_ENABLED) {
      const bodySize = Math.abs(current.close - current.open);
      const candleRange = current.high - current.low;
      const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;
      if (bodyRatio < eqConfigLong.BODY_RATIO_MIN) {
        return {
          valid: false,
          reason: `v5.141_body_ratio_low(${(bodyRatio*100).toFixed(0)}% < ${(eqConfigLong.BODY_RATIO_MIN*100).toFixed(0)}%)`,
          features
        };
      }
    }

    // V5.141: ADX rising filter — require trend to be strengthening
    if (eqConfigLong.ADX_RISING_ENABLED) {
      const adxNow = calcADX(candles, 14);
      const adxPrev = calcADX(candles.slice(0, -eqConfigLong.ADX_RISING_LOOKBACK), 14);
      if (adxNow <= adxPrev) {
        return {
          valid: false,
          reason: `v5.141_adx_not_rising(${adxNow.toFixed(1)} <= ${adxPrev.toFixed(1)})`,
          features
        };
      }
    }

    // V5.144: ROC Acceleration filter — require momentum to be INCREASING
    const eqROCLong = MomentumConfig.ENTRY_QUALITY as any;
    if (eqROCLong.ROC_ACCEL_ENABLED) {
      const prevCandle = candles[candles.length - 2];
      const prevPrevCandle = candles[candles.length - 3];
      if (prevCandle && prevPrevCandle) {
        const roc1Current = prevCandle.close > 0 ? (current.close - prevCandle.close) / prevCandle.close : 0;
        const roc1Prev = prevPrevCandle.close > 0 ? (prevCandle.close - prevPrevCandle.close) / prevPrevCandle.close : 0;
        if (roc1Current <= roc1Prev) {  // NOT accelerating
          return { valid: false, reason: `v5.144_roc_not_accelerating`, features };
        }
      }
    }

    // V5.144: RSI Divergence filter — reject LONG if price HH but RSI LH (bearish divergence)
    if (eqROCLong.RSI_DIVERGENCE_ENABLED) {
      const divLookback = eqROCLong.RSI_DIVERGENCE_LOOKBACK ?? 10;
      const divBuffer = eqROCLong.RSI_DIVERGENCE_BUFFER ?? 2;
      if (candles.length >= 30 + divLookback) {
        const currentCloses = candles.slice(-30).map(c => c.close);
        const currentRSI = calcRSI(currentCloses, 14);
        const pastCloses = candles.slice(-30 - divLookback, -divLookback).map(c => c.close);
        const pastRSI = calcRSI(pastCloses, 14);
        const pastPrice = candles[candles.length - 1 - divLookback]?.close ?? current.close;
        // LONG divergence: price Higher High but RSI Lower High
        if (currentRSI !== null && pastRSI !== null && current.close > pastPrice && currentRSI < pastRSI - divBuffer) {
          return { valid: false, reason: `v5.144_rsi_divergence_long(rsi=${currentRSI.toFixed(1)}<${pastRSI.toFixed(1)})`, features };
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.36: PATTERN FILTERS (2-Year Validated: +22.4pp WR)
    // ═══════════════════════════════════════════════════════════════════════════

    // V5.36 Pattern 2: BTC Volatility Filter
    // Filters out low-volatility choppy markets that lead to stagnant trades
    const btcVolatilityOk = checkBTCVolatility(btcCandles);
    if (!btcVolatilityOk) {
      return {
        valid: false,
        reason: 'v5.36_btc_volatility_low(choppy_market)',
        features
      };
    }

    // V5.36 Pattern 1: Multi-Timeframe Confluence Filter
    // Requires BTC 1h trend to align with LONG direction (filters divergent moves)
    const mtfAligned = checkMTFAlignment(opts?.btcCandlesRegime || [], 'LONG');
    if (!mtfAligned) {
      return {
        valid: false,
        reason: 'v5.36_mtf_divergent(btc_1h_not_bullish)',
        features
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.78: CANDLE PATTERN QUALITY FILTERS (LONG)
    // ═══════════════════════════════════════════════════════════════════════════
    const patternConfig = MomentumConfig.CANDLE_PATTERN_FILTER;
    if (patternConfig.ENABLED) {
      // L1: Skip if green ratio too high (overbought candle pattern)
      const gr = calcGreenRatio(candles, patternConfig.GREEN_RATIO_LOOKBACK);
      if (gr >= patternConfig.LONG_MAX_GREEN_RATIO) {
        return {
          valid: false,
          reason: `v5.78_long_green_ratio_high(${(gr*100).toFixed(0)}% >= ${(patternConfig.LONG_MAX_GREEN_RATIO*100).toFixed(0)}%)`,
          features
        };
      }

      // L2: Skip if market is choppy (high alternation)
      const alt5 = calcAlternation5(candles);
      if (alt5 > patternConfig.LONG_MAX_ALT5) {
        return {
          valid: false,
          reason: `v5.78_long_choppy(alt5=${alt5} > ${patternConfig.LONG_MAX_ALT5})`,
          features
        };
      }

      // L3: Skip if no BB band touches (no pressure building)
      const bbTouches = calcBBTouchCount(
        candles,
        patternConfig.BB_TOUCH_LOOKBACK,
        MomentumConfig.ENTRY.BB_PERIOD,
        patternConfig.BB_TOUCH_THRESHOLD
      );
      if (bbTouches < patternConfig.LONG_MIN_BB_TOUCHES) {
        return {
          valid: false,
          reason: `v5.78_long_no_bb_touches(${bbTouches} < ${patternConfig.LONG_MIN_BB_TOUCHES})`,
          features
        };
      }
    }

    // ✅ ALL LONG CONDITIONS MET
    const distanceFromUpper = bb.upper > 0 ? (close - bb.upper) / bb.upper : 0;

    const confidence = Math.min(1, (volRatio / 3) * 0.3 + (roc10 / 0.04) * 0.3 + (distanceFromUpper * 50) * 0.2 + 0.2);
    return {
      valid: true,
      side: 'long',
      reason: `v5.98_bull_long_confirmed|mtf_aligned|btc_vol_ok|pattern_ok|dist=${(distanceFromUpper*100).toFixed(2)}%`,
      confidence,
      features
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.4 BEAR REGIME → SHORT ONLY (BB Breakdown)
  // V5.33: Added BREAKOUT CONFIRMATION filter for higher win rate
  // ═══════════════════════════════════════════════════════════════════════════
  if (btcInBearRegime) {
    // SHORT conditions V5.4 - BB Breakdown
    const dropOk = roc5 <= MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN;
    const volSpikeOk = volRatio >= MomentumConfig.ENTRY_SHORT.VOL_SPIKE;
    const priceBelowMa20Ok = priceBelowMa20;
    const consecDownOk = consecDown <= (MomentumConfig.ENTRY_SHORT.MAX_CONSEC_DOWN || 5);

    if (!isBearish) {
      return { valid: false, reason: 'bear_regime:bullish_candle', features };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.9: StochRSI FILTER - SHORT ONLY
    // Skip SHORT if StochRSI < 15 AND volRatio < 4.0 (low quality signal)
    // Analysis: 848 trades filtered, +368% equity improvement
    // ═══════════════════════════════════════════════════════════════════════════
    if (stochRsiConfig.ENABLED && stochRsi !== null && stochRsi < stochRsiConfig.MIN_STOCHRSI && volRatio < stochRsiConfig.VOLUME_EXCEPTION_MULTIPLIER) {
      return {
        valid: false,
        reason: `v5.9_stochrsi_filter(stochRsi=${stochRsi.toFixed(1)}<${stochRsiConfig.MIN_STOCHRSI} AND volRatio=${volRatio.toFixed(1)}<${stochRsiConfig.VOLUME_EXCEPTION_MULTIPLIER})`,
        features
      };
    }

    if (!consecDownOk) {
      return {
        valid: false,
        reason: `bear_regime:too_many_consec_down(${consecDown}>5)_oversold`,
        features
      };
    }
    if (!dropOk) {
      return {
        valid: false,
        reason: `bear_regime:roc5_not_low_enough(${(roc5*100).toFixed(2)}% > ${(MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN*100).toFixed(1)}%)`,
        features
      };
    }
    if (!volSpikeOk) {
      return {
        valid: false,
        reason: `bear_regime:vol_spike_low(${volRatio.toFixed(1)}x < ${MomentumConfig.ENTRY_SHORT.VOL_SPIKE}x)`,
        features
      };
    }
    if (!priceBelowMa20Ok) {
      return {
        valid: false,
        reason: `bear_regime:price_above_ma20`,
        features
      };
    }

    // V5.139: Range Position Filter — reject entries in the "death zone" of recent range
    const rpfShort = MomentumConfig.RANGE_POSITION_FILTER;
    if (rpfShort.ENABLED) {
      const rpLookbackShort = candles.slice(-rpfShort.LOOKBACK_CANDLES);
      const rpHighShort = Math.max(...rpLookbackShort.map(c => c.high));
      const rpLowShort = Math.min(...rpLookbackShort.map(c => c.low));
      const rangePosShort = rpHighShort > rpLowShort ? (close - rpLowShort) / (rpHighShort - rpLowShort) : 0.5;
      if (rangePosShort >= rpfShort.DEATH_ZONE_LOW && rangePosShort < rpfShort.DEATH_ZONE_HIGH) {
        return {
          valid: false,
          reason: `bear_regime:range_death_zone(pos=${(rangePosShort*100).toFixed(1)}% in [${rpfShort.DEATH_ZONE_LOW*100}-${rpfShort.DEATH_ZONE_HIGH*100}%])`,
          features
        };
      }
    }

    // V5.141: Body ratio filter — reject doji/indecision candles
    const eqConfigShort = MomentumConfig.ENTRY_QUALITY;
    if (eqConfigShort.BODY_RATIO_ENABLED) {
      const bodySize = Math.abs(current.close - current.open);
      const candleRange = current.high - current.low;
      const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;
      if (bodyRatio < eqConfigShort.BODY_RATIO_MIN) {
        return {
          valid: false,
          reason: `v5.141_body_ratio_low(${(bodyRatio*100).toFixed(0)}% < ${(eqConfigShort.BODY_RATIO_MIN*100).toFixed(0)}%)`,
          features
        };
      }
    }

    // V5.141: ADX rising filter — require trend to be strengthening
    if (eqConfigShort.ADX_RISING_ENABLED) {
      const adxNow = calcADX(candles, 14);
      const adxPrev = calcADX(candles.slice(0, -eqConfigShort.ADX_RISING_LOOKBACK), 14);
      if (adxNow <= adxPrev) {
        return {
          valid: false,
          reason: `v5.141_adx_not_rising(${adxNow.toFixed(1)} <= ${adxPrev.toFixed(1)})`,
          features
        };
      }
    }

    // V5.144: ADX minimum for SHORT — require minimum trend strength
    const adxMinShort = (eqConfigShort as any).ADX_MIN_SHORT ?? 0;
    if (adxMinShort > 0) {
      const adxVal = calcADX(candles, 14);
      if (adxVal < adxMinShort) {
        return {
          valid: false,
          reason: `v5.144_adx_min_short(${adxVal.toFixed(1)} < ${adxMinShort})`,
          features
        };
      }
    }

    // V5.144: Wick rejection filter for SHORT — skip if lower wick = buying pressure
    const wickRejShortEnabled = (eqConfigShort as any).WICK_REJECTION_SHORT_ENABLED ?? false;
    if (wickRejShortEnabled) {
      const wickRejThreshold = (eqConfigShort as any).WICK_REJECTION_SHORT_THRESHOLD ?? 0.4;
      const candleRange = current.high - current.low;
      if (candleRange > 0) {
        const lowerWick = Math.min(current.open, current.close) - current.low;
        const lowerWickRatio = lowerWick / candleRange;
        if (lowerWickRatio > wickRejThreshold) {
          return {
            valid: false,
            reason: `v5.144_wick_rejection_short(${(lowerWickRatio*100).toFixed(0)}% > ${(wickRejThreshold*100).toFixed(0)}%)`,
            features
          };
        }
      }
    }

    // V5.146: Consecutive red BTC candles — require confirmed downtrend before shorting
    const shortMinConsecRed = (eqConfigShort as any).SHORT_MIN_CONSEC_RED ?? 0;
    if (shortMinConsecRed > 0 && btcCandles.length >= 10) {
      let consecRed = 0;
      for (let i = btcCandles.length - 1; i >= 1; i--) {
        if (btcCandles[i].close < btcCandles[i].open) consecRed++;
        else break;
      }
      if (consecRed < shortMinConsecRed) {
        return { valid: false, reason: `v5.146_short_consec_red(${consecRed} < ${shortMinConsecRed})`, features };
      }
    }

    // V5.146: BTC 24h drop filter — skip SHORT if BTC already crashed too much (exhausted move)
    // V5.147: 1.0% tolerance buffer for WS/REST candle variance (effective threshold = -6%)
    const shortBtcDrop24hMax = (eqConfigShort as any).SHORT_BTC_DROP_24H_MAX ?? 0;
    const btcDropTolerance = (eqConfigShort as any).SHORT_BTC_DROP_24H_TOLERANCE ?? 1.0;
    if (shortBtcDrop24hMax < 0 && btcChange24h !== null) {
      if (btcChange24h < shortBtcDrop24hMax - btcDropTolerance) {
        return { valid: false, reason: `v5.147_btc_drop_24h(${btcChange24h.toFixed(1)}% < ${(shortBtcDrop24hMax - btcDropTolerance).toFixed(1)}%)`, features };
      }
    }

    // V5.144: ROC Acceleration filter for SHORT — require downward momentum ACCELERATING
    const eqROCShort = MomentumConfig.ENTRY_QUALITY as any;
    if (eqROCShort.ROC_ACCEL_ENABLED) {
      const prevCandleShort = candles[candles.length - 2];
      const prevPrevCandleShort = candles[candles.length - 3];
      if (prevCandleShort && prevPrevCandleShort) {
        const roc1CurrentShort = prevCandleShort.close > 0 ? (current.close - prevCandleShort.close) / prevCandleShort.close : 0;
        const roc1PrevShort = prevPrevCandleShort.close > 0 ? (prevCandleShort.close - prevPrevCandleShort.close) / prevPrevCandleShort.close : 0;
        // For SHORT: we want price drop to be ACCELERATING (roc1Current < roc1Prev = more negative)
        if (roc1CurrentShort >= roc1PrevShort) {  // NOT accelerating downward
          return { valid: false, reason: `v5.144_roc_not_accelerating_short`, features };
        }
      }
    }

    // V5.144: RSI Divergence filter — reject SHORT if price LL but RSI HL (bullish divergence)
    if (eqROCShort.RSI_DIVERGENCE_ENABLED) {
      const divLookbackShort = eqROCShort.RSI_DIVERGENCE_LOOKBACK ?? 10;
      const divBufferShort = eqROCShort.RSI_DIVERGENCE_BUFFER ?? 2;
      if (candles.length >= 30 + divLookbackShort) {
        const currentClosesShort = candles.slice(-30).map(c => c.close);
        const currentRSIShort = calcRSI(currentClosesShort, 14);
        const pastClosesShort = candles.slice(-30 - divLookbackShort, -divLookbackShort).map(c => c.close);
        const pastRSIShort = calcRSI(pastClosesShort, 14);
        const pastPriceShort = candles[candles.length - 1 - divLookbackShort]?.close ?? current.close;
        // SHORT divergence: price Lower Low but RSI Higher Low
        if (currentRSIShort !== null && pastRSIShort !== null && current.close < pastPriceShort && currentRSIShort > pastRSIShort + divBufferShort) {
          return { valid: false, reason: `v5.144_rsi_divergence_short(rsi=${currentRSIShort.toFixed(1)}>${pastRSIShort.toFixed(1)})`, features };
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.36: PATTERN FILTERS (2-Year Validated: +22.4pp WR)
    // ═══════════════════════════════════════════════════════════════════════════

    // V5.36 Pattern 2: BTC Volatility Filter
    // Filters out low-volatility choppy markets that lead to stagnant trades
    const btcVolatilityOkShort = checkBTCVolatility(btcCandles);
    if (!btcVolatilityOkShort) {
      return {
        valid: false,
        reason: 'v5.36_btc_volatility_low(choppy_market)',
        features
      };
    }

    // V5.36 Pattern 1: Multi-Timeframe Confluence Filter
    // Requires BTC 1h trend to align with SHORT direction (filters divergent moves)
    const mtfAlignedShort = checkMTFAlignment(opts?.btcCandlesRegime || [], 'SHORT');
    if (!mtfAlignedShort) {
      return {
        valid: false,
        reason: 'v5.36_mtf_divergent(btc_1h_not_bearish)',
        features
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // V5.78: CANDLE PATTERN QUALITY FILTERS (SHORT)
    // ═══════════════════════════════════════════════════════════════════════════
    const patternConfigShort = MomentumConfig.CANDLE_PATTERN_FILTER;
    if (patternConfigShort.ENABLED) {
      // S4: Skip SHORT if ROC acceleration is positive (momentum turning bullish)
      const rocAccel = calcRocAcceleration(closes, patternConfigShort.ROC_ACCEL_FAST_PERIOD);
      if (rocAccel > patternConfigShort.SHORT_MAX_ROC_ACCEL) {
        return {
          valid: false,
          reason: `v5.78_short_roc_accel_positive(${rocAccel.toFixed(2)} > ${patternConfigShort.SHORT_MAX_ROC_ACCEL})`,
          features
        };
      }

      // V5.118: SHORT choppiness filter — skip if market alternates heavily
      // Uses calcAlternation5() for parity with LONG path (candle direction, not close-vs-close)
      const shortAlt5 = calcAlternation5(candles);
      const shortMaxAlt5 = patternConfigShort.SHORT_MAX_ALT5 ?? 2;
      if (shortAlt5 > shortMaxAlt5) {
        return {
          valid: false,
          reason: `v5.118_short_choppy(alt5=${shortAlt5}>${shortMaxAlt5})`,
          features
        };
      }
    }

    // ✅ ALL SHORT CONDITIONS MET
    const distanceBelowMa20 = ma20 > 0 ? (ma20 - close) / ma20 : 0;
    const confidence = Math.min(1, (volRatio / 4) * 0.3 + (Math.abs(roc5) / 0.04) * 0.3 + (distanceBelowMa20 * 50) * 0.2 + 0.2);
    return {
      valid: true,
      side: 'short',
      reason: `v5.98_bear_short_confirmed|mtf_aligned|btc_vol_ok|pattern_ok|dist_ma20=${(distanceBelowMa20*100).toFixed(2)}%`,
      confidence,
      features
    };
  }

  // Neither bull nor bear (shouldn't happen but safety)
  return { valid: false, reason: 'regime_neutral', features };
}
