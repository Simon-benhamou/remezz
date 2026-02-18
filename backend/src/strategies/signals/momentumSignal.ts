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
  calcBB,
  countConsecUp,
  countConsecDown,
  calcADX,
  detectMarketRegime,
  shouldSkipEntryForRegime,
  checkMTFAlignment,
  checkBTCVolatility,
  calcATR,
  findSRLevels,
  calcSRProximityScore,
  calcGreenRatio,
  calcAlternation5,
  calcBBTouchCount,
  calcRocAcceleration,
  detectBBSqueeze,
  detectVolumeAccumulation,
} from '../indicators/technicalIndicators.js';

export function getMarketConditions(btcCandles: Candle[], btcCandles1h?: Candle[]): MarketConditions {
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
  const btcMa50 = calcMA(btcCloses, 50);

  // V5.82: Use 1h candles for SMA200 regime (more stable)
  let btcSma200: number;
  let btcNow: number;
  if (btcCandles1h && btcCandles1h.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
    const btcCloses1h = btcCandles1h.map(c => c.close);
    btcSma200 = calcSMA(btcCloses1h, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcCloses1h[btcCloses1h.length - 1];
  } else {
    btcSma200 = calcMA(btcCloses, 200);
    btcNow = btcNow15m;
  }
  const btcAboveMa50 = btcNow15m > btcMa50;
  const btcAboveSma200 = btcNow > btcSma200;

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
    btcCandles1h?: Candle[];  // V5.36: For MTF filter + V5.82: For regime SMA200
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
  // than 15m (200 × 15m = 50h) which whipsaws around SMA200 intraday.
  // Falls back to 15m if 1h candles not available.
  let btcSma200: number;
  let btcNow: number;
  const btcCandles1h = opts?.btcCandles1h;
  if (btcCandles1h && btcCandles1h.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
    const btcCloses1h = btcCandles1h.map(c => c.close);
    btcSma200 = calcSMA(btcCloses1h, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcCloses1h[btcCloses1h.length - 1];
  } else {
    // Fallback to 15m if 1h not available (startup, insufficient data)
    btcSma200 = calcSMA(btcCloses, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
    btcNow = btcCloses[btcCloses.length - 1];
  }
  const btcInBullRegime = btcNow > btcSma200;
  const btcInBearRegime = btcNow < btcSma200;

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

  // V5.10: RSI + BTC ROC 4h filter for LONG
  const rsi = calcRSI(closes, 14);
  const btcRoc4h = btcCloses.length >= 17
    ? ((btcCloses[btcCloses.length - 1] - btcCloses[btcCloses.length - 17]) / btcCloses[btcCloses.length - 17]) * 100
    : 0;

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
    rsi: rsi ?? undefined,  // V5.10
    btcRoc4h,  // V5.10
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
    const regime = detectMarketRegime(btcCandles, btcCandles1h || []);
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
    // V5.32: ANTICIPATORY ENTRY - Catch momentum BEFORE it happens
    const anticipatoryConfig = MomentumConfig.ANTICIPATORY_ENTRY;

    if (anticipatoryConfig.ENABLED) {
      // Detect BB Squeeze (volatility compression)
      const squeeze = detectBBSqueeze(
        closes,
        MomentumConfig.ENTRY.BB_PERIOD,
        anticipatoryConfig.BB_SQUEEZE_LOOKBACK,
        anticipatoryConfig.BB_SQUEEZE_THRESHOLD
      );

      // Detect Volume Accumulation
      const volAccum = detectVolumeAccumulation(
        volumes,
        anticipatoryConfig.VOL_ACCUMULATION_CANDLES,
        anticipatoryConfig.VOL_ACCUMULATION_MIN_TREND,
        anticipatoryConfig.VOL_ACCUMULATION_MIN_RATIO
      );

      // Pre-breakout zone: close approaching upper band
      const distanceToUpper = (bb.upper - close) / close;  // % distance to upper band
      const inPreBreakoutZone = distanceToUpper <= anticipatoryConfig.PRE_BREAKOUT_ZONE_PCT / 100;

      // Momentum building but not exhausted
      const roc5Building = roc5 >= anticipatoryConfig.PRE_BREAKOUT_MIN_ROC5;
      const roc10NotExhausted = roc10 < anticipatoryConfig.PRE_BREAKOUT_MAX_ROC10;

      // Price above MA20 (uptrend) but not too far
      const distanceFromMa20 = (close - ma20) / ma20;
      const maDistanceOk = distanceFromMa20 <= anticipatoryConfig.MAX_DISTANCE_FROM_ENTRY / 100;

      // Bullish candle check
      const bullishOk = !anticipatoryConfig.REQUIRE_BULLISH_CANDLE || isBullish;
      const priceAboveOk = !anticipatoryConfig.REQUIRE_PRICE_ABOVE_MA20 || priceAboveMa20;

      // ✅ ANTICIPATORY ENTRY CONDITIONS
      const anticipatoryValid =
        squeeze.isSqueeze &&              // BB bands contracting
        inPreBreakoutZone &&              // Price approaching upper band
        roc5Building &&                   // Momentum building
        roc10NotExhausted &&              // But not already exhausted
        bullishOk &&                      // Bullish candle
        priceAboveOk &&                   // Above MA20
        maDistanceOk &&                   // Not too far from MA20
        (volAccum.isAccumulating || volRatio >= 0.9);  // Volume building OR decent volume

      if (anticipatoryValid) {
        const confidence = Math.min(1,
          (1 - squeeze.squeezeRatio) * 0.3 +  // Tighter squeeze = higher confidence
          volAccum.trendScore * 0.3 +          // Better vol trend = higher confidence
          (roc5 / 0.01) * 0.2 +                // Momentum building
          0.2                                   // Base confidence
        );

        return {
          valid: true,
          side: 'long',
          reason: `v5.32_anticipatory_entry|squeeze=${squeeze.squeezeRatio.toFixed(2)}|vol_trend=${volAccum.trendScore.toFixed(2)}|dist_to_upper=${(distanceToUpper*100).toFixed(2)}%`,
          confidence,
          features: {
            ...features,
            bbSqueeze: squeeze.squeezeRatio,
            volAccumulating: volAccum.isAccumulating,
            distanceToUpper: distanceToUpper * 100,
          } as any
        };
      }
    }

    // FALLBACK: Classic LONG conditions V5.12 (breakout-based)
    // V5.33: Added BREAKOUT CONFIRMATION filter for higher win rate
    const breakoutOk = close > bb.upper;
    const rocOk = roc10 >= MomentumConfig.ENTRY_LONG.ROC_MIN;
    const volOk = volRatio >= MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER;
    const consecOk = consecUp <= MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP;

    // V5.33: BREAKOUT CONFIRMATION - Wait for clear breakout confirmation
    // Analysis of 30,000+ LONG breakouts shows:
    // - Distance > 0.5%: 53% WR (vs 36% baseline)
    // - Distance > 0.75%: 60% WR
    // - Distance > 1.0%: 66% WR
    const confirmConfig = MomentumConfig.BREAKOUT_CONFIRMATION;
    const distanceFromUpper = bb.upper > 0 ? (close - bb.upper) / bb.upper : 0;
    const distanceOk = !confirmConfig.ENABLED ||
      distanceFromUpper >= confirmConfig.LONG_MIN_DISTANCE_PCT / 100;
    const roc1Ok = !confirmConfig.ENABLED ||
      roc1 >= confirmConfig.LONG_MIN_ROC1_PCT;
    const confirmVolOk = !confirmConfig.ENABLED ||
      volRatio >= confirmConfig.LONG_MIN_VOL_RATIO;

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
    // V5.33: Check breakout confirmation AFTER basic breakout
    if (!distanceOk) {
      return {
        valid: false,
        reason: `v5.33_breakout_not_confirmed(dist=${(distanceFromUpper*100).toFixed(2)}% < ${confirmConfig.LONG_MIN_DISTANCE_PCT}%)`,
        features
      };
    }
    if (!roc1Ok) {
      return {
        valid: false,
        reason: `v5.33_roc1_weak(${(roc1*100).toFixed(2)}% < ${(confirmConfig.LONG_MIN_ROC1_PCT*100).toFixed(1)}%)`,
        features
      };
    }
    if (!confirmVolOk) {
      return {
        valid: false,
        reason: `v5.33_vol_low(${volRatio.toFixed(2)}x < ${confirmConfig.LONG_MIN_VOL_RATIO}x)`,
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
    const mtfAligned = checkMTFAlignment(opts?.btcCandles1h || [], 'LONG');
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

    // V5.101: S/R proximity filter
    if (MomentumConfig.SR_FILTER.ENABLED) {
      const srCfg = MomentumConfig.SR_FILTER;
      const levels = findSRLevels(candles, {
        lookbackCandles: srCfg.LOOKBACK_CANDLES,
        pivotLookback: srCfg.PIVOT_LOOKBACK,
        minTouches: srCfg.MIN_TOUCHES,
        clusterPct: srCfg.CLUSTER_PCT,
      });
      const srScore = calcSRProximityScore(close, 'long', levels, {
        nearThresholdPct: srCfg.NEAR_THRESHOLD_PCT,
        farThresholdPct: srCfg.FAR_THRESHOLD_PCT,
      });
      if (srScore < srCfg.FILTER_THRESHOLD) {
        return { valid: false, reason: `v5.101_sr_filter(score=${srScore.toFixed(2)})`, features };
      }
    }

    // ✅ ALL LONG CONDITIONS MET
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

    // V5.4: BB Breakdown filter
    const priceBelowBBLower = MomentumConfig.ENTRY_SHORT.PRICE_BELOW_BB_LOWER
      ? close < bb.lower
      : true;

    // V5.33: BREAKOUT CONFIRMATION for SHORT
    // Analysis of 29,000+ SHORT breakdowns shows:
    // - Distance > 0.5%: 61% WR (vs 44% baseline)
    // - Distance > 0.75%: 66% WR
    // - Distance > 1.0%: 71% WR
    const confirmConfig = MomentumConfig.BREAKOUT_CONFIRMATION;
    const distanceFromLower = bb.lower > 0 ? (bb.lower - close) / bb.lower : 0;
    const shortDistanceOk = !confirmConfig.ENABLED ||
      distanceFromLower >= confirmConfig.SHORT_MIN_DISTANCE_PCT / 100;
    const shortRoc1Ok = !confirmConfig.ENABLED ||
      roc1 <= confirmConfig.SHORT_MAX_ROC1_PCT;
    const shortConfirmVolOk = !confirmConfig.ENABLED ||
      volRatio >= confirmConfig.SHORT_MIN_VOL_RATIO;

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
    if (!priceBelowBBLower) {
      return {
        valid: false,
        reason: `bear_regime:price_above_bb_lower(${close.toFixed(4)} >= ${bb.lower.toFixed(4)})`,
        features
      };
    }

    // V5.33: Check breakout confirmation for SHORT
    if (!shortDistanceOk) {
      return {
        valid: false,
        reason: `v5.33_short_not_confirmed(dist=${(distanceFromLower*100).toFixed(2)}% < ${confirmConfig.SHORT_MIN_DISTANCE_PCT}%)`,
        features
      };
    }
    if (!shortRoc1Ok) {
      return {
        valid: false,
        reason: `v5.33_short_roc1_weak(${(roc1*100).toFixed(2)}% > ${(confirmConfig.SHORT_MAX_ROC1_PCT*100).toFixed(1)}%)`,
        features
      };
    }
    if (!shortConfirmVolOk) {
      return {
        valid: false,
        reason: `v5.33_short_vol_low(${volRatio.toFixed(2)}x < ${confirmConfig.SHORT_MIN_VOL_RATIO}x)`,
        features
      };
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
    const mtfAlignedShort = checkMTFAlignment(opts?.btcCandles1h || [], 'SHORT');
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
    }

    // V5.101: S/R proximity filter
    if (MomentumConfig.SR_FILTER.ENABLED) {
      const srCfg = MomentumConfig.SR_FILTER;
      const levels = findSRLevels(candles, {
        lookbackCandles: srCfg.LOOKBACK_CANDLES,
        pivotLookback: srCfg.PIVOT_LOOKBACK,
        minTouches: srCfg.MIN_TOUCHES,
        clusterPct: srCfg.CLUSTER_PCT,
      });
      const srScore = calcSRProximityScore(close, 'short', levels, {
        nearThresholdPct: srCfg.NEAR_THRESHOLD_PCT,
        farThresholdPct: srCfg.FAR_THRESHOLD_PCT,
      });
      if (srScore < srCfg.FILTER_THRESHOLD) {
        return { valid: false, reason: `v5.101_sr_filter(score=${srScore.toFixed(2)})`, features };
      }
    }

    // ✅ ALL SHORT CONDITIONS MET
    const confidence = Math.min(1, (volRatio / 4) * 0.3 + (Math.abs(roc5) / 0.04) * 0.3 + (distanceFromLower * 50) * 0.2 + 0.2);
    return {
      valid: true,
      side: 'short',
      reason: `v5.98_bear_short_confirmed|mtf_aligned|btc_vol_ok|pattern_ok|dist=${(distanceFromLower*100).toFixed(2)}%`,
      confidence,
      features
    };
  }

  // Neither bull nor bear (shouldn't happen but safety)
  return { valid: false, reason: 'regime_neutral', features };
}
