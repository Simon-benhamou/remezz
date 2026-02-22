import {
  MomentumConfig,
  type Candle,
  type Position,
  type ExitSignal,
} from '../config/momentumConfig.js';

import {
  calcROC,
  calcSMA,
  calcATR,
  determineVolatilityRegime,
} from '../indicators/technicalIndicators.js';

// ============================================================================
// EXIT CHECK V5 WITH TRAILING STOP + SMART EXITS
// ============================================================================

/**
 * Check if position should be closed - V5 with smart exits
 *
 * Exit conditions:
 * 0. REGIME CHANGE (NEW) - Exit if BTC regime flips
 * 0b. MOMENTUM REVERSAL (NEW) - Exit if momentum reverses against position
 * 1. Trailing Stop (main exit)
 * 2. Stop Loss (safety exit)
 */
export function shouldExitPosition(
  position: Position,
  currentPrice: number,
  candles?: Candle[],  // Optional candles for smart exits
  opts?: {
    nowMs?: number;
    priceHigh?: number;
    priceLow?: number;
    btcCandles?: Candle[];  // BTC 15m candles for momentum/volume
    btcCandlesRegime?: Candle[];  // V5.82: BTC 1h candles for regime SMA200
  }
): ExitSignal {
  const now = opts?.nowMs ?? Date.now();
  const holdMinutes = (now - position.entryTime) / 60000;

  // V5.86: Use realEntryTime for stagnant detection (actual hold time in live/paper)
  // Keep holdMinutes (candle-based) for other calculations to maintain backtest parity
  const stagnantEntryTime = position.realEntryTime ?? position.entryTime;
  const holdMinutesForStagnant = (now - stagnantEntryTime) / 60000;

  // ============================================================================
  // V5.42 FIX: Skip exit checks if candle is BEFORE or AT entry time
  // This happens when:
  // 1. Entry occurs mid-candle and checkExit runs on the previous closed candle
  // 2. Entry and candle have the same timestamp (holdMinutes = 0)
  //
  // We must NOT check SL/exit using high/low of candles before/at entry because
  // those price extremes occurred BEFORE the position existed!
  //
  // The check is holdMinutes <= 0 (not just < 0) because:
  // - holdMinutes < 0: candle is BEFORE entry (obvious skip)
  // - holdMinutes = 0: candle is AT entry time - we shouldn't use its high/low
  //   for SL check since entry happens at candle CLOSE, not at its high/low
  // ============================================================================
  if (holdMinutes <= 0) {
    return { shouldExit: false };
  }

  // Calculate PnL based on position side
  let pnlPct: number;
  if (position.side === 'long') {
    pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  } else {
    pnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  }

  // ============================================================================
  // V5.39 FIX: MAX HOLD TIME EXIT (aligned with backtest)
  // Backtest has MAX_HOLD_BARS = 192 (48h in 15m bars) = 2880 minutes
  // Live was MISSING this exit - positions could stay open indefinitely!
  // ============================================================================
  const MAX_HOLD_MINUTES = MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN ?? 2880; // 48h default
  if (holdMinutes >= MAX_HOLD_MINUTES) {
    return {
      shouldExit: true,
      reason: 'time',
      pnlPct,
      holdMinutes
    };
  }

  // ============================================================================
  // 0. REGIME CHANGE EXIT (V5.13 with confirmation filters)
  // Exit if BTC regime flips WITH confirmation (volume + momentum)
  // Avoids whipsaws when BTC oscillates around SMA200
  // ============================================================================
  if (MomentumConfig.REGIME_CHANGE_EXIT.ENABLED &&
      opts?.btcCandles &&
      opts.btcCandles.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {

    // V5.82: Use 1h candles for regime SMA200 (more stable, less whipsaw)
    let btcSma200: number;
    let btcNow: number;
    const btcCandlesRegimeExit = opts.btcCandlesRegime;
    if (btcCandlesRegimeExit && btcCandlesRegimeExit.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
      const btcCloses1h = btcCandlesRegimeExit.map(c => c.close);
      btcSma200 = calcSMA(btcCloses1h, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
      btcNow = btcCloses1h[btcCloses1h.length - 1];
    } else {
      const btcCloses15m = opts.btcCandles.map(c => c.close);
      btcSma200 = calcSMA(btcCloses15m, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
      btcNow = btcCloses15m[btcCloses15m.length - 1];
    }
    // Keep 15m candles for volume confirmation
    const btcCandles = opts.btcCandles;

    // Calculate distance from SMA200
    const distanceFromSma200Pct = ((btcNow - btcSma200) / btcSma200) * 100;
    const inBufferZone = Math.abs(distanceFromSma200Pct) <= MomentumConfig.REGIME_CHANGE_EXIT.BUFFER_ZONE_PCT;

    // Check if regime changed
    const currentlyBullRegime = btcNow > btcSma200;
    const positionOpenedInBullRegime = position.side === 'long';  // LONG positions open in bull regime
    const regimeChanged = (positionOpenedInBullRegime && !currentlyBullRegime) ||
                          (!positionOpenedInBullRegime && currentlyBullRegime);

    if (regimeChanged && !inBufferZone) {
      // Regime changed AND we're outside the buffer zone - check confirmations
      let confirmed = true;

      // CONFIRMATION 1: Volume spike (confirms conviction)
      if (MomentumConfig.REGIME_CHANGE_EXIT.REQUIRE_VOLUME_CONFIRMATION && btcCandles.length >= 20) {
        const volumes = btcCandles.slice(-20).map(c => c.volume);
        const avgVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
        const currentVol = volumes[volumes.length - 1];
        const volRatio = currentVol / avgVol;

        if (volRatio < MomentumConfig.REGIME_CHANGE_EXIT.MIN_VOLUME_MULTIPLIER) {
          confirmed = false; // Not enough volume to confirm regime change
        }
      }

      // CONFIRMATION 2: Momentum in the new direction (use 15m closes for momentum)
      const btcCloses15mForMomentum = btcCandles.map(c => c.close);
      if (confirmed && MomentumConfig.REGIME_CHANGE_EXIT.REQUIRE_MOMENTUM_CONFIRMATION && btcCloses15mForMomentum.length >= 6) {
        const btcRoc5 = calcROC(btcCloses15mForMomentum, 5);

        if (currentlyBullRegime) {
          // Flipped to bull - require bullish momentum
          if (btcRoc5 < 0.015) {
            confirmed = false; // Not enough bullish momentum
          }
        } else {
          // Flipped to bear - require bearish momentum
          if (btcRoc5 > -0.015) {
            confirmed = false; // Not enough bearish momentum
          }
        }
      }

      // Exit only if confirmed
      if (confirmed) {
        return {
          shouldExit: true,
          reason: 'regime_change',
          pnlPct,
          holdMinutes
        };
      }
    }
  }

  // ============================================================================
  // 0b. MOMENTUM REVERSAL EXIT (V5.13 + V5.35 2-candle confirmation)
  // Exit if short-term momentum reverses against the position
  // V5.35: Require 2 consecutive candles to reduce false exits from noise
  // ============================================================================
  if (candles && candles.length >= 7) {  // V5.35: Need 7 candles (was 6) for 2-candle check
    const closes = candles.map(c => c.close);
    const roc5Current = calcROC(closes, 5);
    const roc5Previous = calcROC(closes.slice(0, -1), 5);

    if (position.side === 'long') {
      // V5.35: Require 2 consecutive candles below -1.5%
      if (roc5Previous < -0.015 && roc5Current < -0.015) {
        return {
          shouldExit: true,
          reason: 'momentum_reversal',
          pnlPct,
          holdMinutes
        };
      }
    } else if (position.side === 'short') {
      // V5.35: Require 2 consecutive candles above +1.5%
      if (roc5Previous > 0.015 && roc5Current > 0.015) {
        return {
          shouldExit: true,
          reason: 'momentum_reversal',
          pnlPct,
          holdMinutes
        };
      }
    }
  }

  // ============================================================================
  // V5.39 FIX: Calculate trailing state and effective SL with ADAPTIVE params
  // Backtest uses calcAdaptiveTrailing() - live must use same logic for parity
  // ============================================================================

  // V5.39: Use adaptive trailing params based on ATR (like backtest)
  const volatilityRegime = candles && candles.length > 0
    ? determineVolatilityRegime(candles)
    : { trailingActivation: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT, trailingDistance: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT, regime: 'MEDIUM' as const, atrPct: null, reason: 'no_candles' };

  const trailingActivation = volatilityRegime.trailingActivation;
  const baseTrailingDistance = volatilityRegime.trailingDistance;

  const shouldActivateNow = pnlPct >= trailingActivation;
  const trailingIsActive = position.trailingActive === true || shouldActivateNow;

  const effectiveLow = opts?.priceLow ?? currentPrice;
  const effectiveHigh = opts?.priceHigh ?? currentPrice;

  // ============================================================================
  // V5.38: STAGNANT STATE MACHINE (only when trailing NOT active)
  // ============================================================================
  const stagnantConfig = MomentumConfig.EXIT;
  const stagnantEnabled = stagnantConfig.STAGNANT_TRADE_EXIT_ENABLED ?? false;
  const stagnantTimeMinutes = stagnantConfig.STAGNANT_TRADE_TIME_MINUTES ?? 45;
  const stagnantObsMinutes = stagnantConfig.STAGNANT_TRADE_OBS_MINUTES ?? 60;
  const stagnantMinProfitPct = stagnantConfig.STAGNANT_TRADE_MIN_PROFIT_PCT ?? 0.8;
  const stagnantRecoveryPct = stagnantConfig.STAGNANT_TRADE_RECOVERY_PCT ?? 0.6;
  const stagnantTightenSlRatio = (stagnantConfig as any).STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5;
  const stagnantExitIfProfit = stagnantConfig.STAGNANT_TRADE_EXIT_IF_PROFIT ?? false;

  const totalStagnantMinutes = stagnantTimeMinutes + stagnantObsMinutes;

  // Initialize stagnant state if needed
  if (!position.stagnantState) {
    position.stagnantState = { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 };
  }

  // Only process stagnant if trailing NOT active (like backtest)
  if (!trailingIsActive) {
    // V5.86: Step 1: Check if initial stagnant trigger (at 45min REAL time, no trailing, low maxPnl)
    // Use holdMinutesForStagnant to trigger based on actual hold time in live/paper mode
    if (stagnantEnabled &&
        !position.stagnantState.triggered &&
        holdMinutesForStagnant >= stagnantTimeMinutes &&
        (position.maxPnlPct ?? 0) < stagnantMinProfitPct) {
      position.stagnantState.triggered = true;
      position.stagnantState.triggeredAtMinutes = holdMinutesForStagnant;  // V5.86: Use real time minutes
    }

    // Step 2: During observation window, track peak and check for recovery
    if (position.stagnantState.triggered && !position.stagnantState.confirmed && !position.stagnantState.cancelled) {
      // Use wick to detect peaks (like backtest)
      const wickPeakPnl = position.side === 'long'
        ? ((effectiveHigh - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - effectiveLow) / position.entryPrice) * 100;

      position.stagnantState.obsPeakPct = Math.max(position.stagnantState.obsPeakPct, wickPeakPnl);

      // If peak during observation >= recovery threshold → cancel stagnant
      if (position.stagnantState.obsPeakPct >= stagnantRecoveryPct) {
        position.stagnantState.cancelled = true;
      }

      // V5.86 FIX: End of observation window = triggered time + obsMinutes
      // Use holdMinutesForStagnant (real time) for consistency with trigger
      const triggeredAtMinutes = position.stagnantState.triggeredAtMinutes ?? stagnantTimeMinutes;
      const obsElapsedMinutes = holdMinutesForStagnant - triggeredAtMinutes;
      if (obsElapsedMinutes >= stagnantObsMinutes && !position.stagnantState.cancelled) {
        position.stagnantState.confirmed = true;

        // V5.31: Exit at market if currently in profit
        if (stagnantExitIfProfit && pnlPct > 0) {
          return {
            shouldExit: true,
            reason: 'stagnant_profit_exit',
            pnlPct,
            holdMinutes
          };
        }
      }
    }
  }

  // Calculate effective SL % (tightened if stagnant confirmed AND trailing not active)
  const isStagnantConfirmed = !trailingIsActive && position.stagnantState.confirmed && !position.stagnantState.cancelled;

  // V5.85: Tier-based + volatility-based dynamic SL
  let baseSlPct: number;
  if (MomentumConfig.EXIT.STOP_LOSS_TYPE === 'dynamic') {
    const exitConfig = MomentumConfig.EXIT as any;
    const tierBasedEnabled = exitConfig.TIER_BASED_SL_ENABLED ?? false;

    // Extract base symbol (e.g., "SOL/USDT:USDT" → "SOL")
    const baseSymbol = position.symbol?.split('/')[0]?.split(':')[0] ?? '';

    if (tierBasedEnabled && baseSymbol) {
      // Determine tier
      const tier1 = exitConfig.TIER1_SYMBOLS ?? ['BTC', 'ETH'];
      const tier2 = exitConfig.TIER2_SYMBOLS ?? [];
      const tier3 = exitConfig.TIER3_SYMBOLS ?? [];

      let tierPrefix: string;
      if (tier1.includes(baseSymbol)) {
        tierPrefix = 'TIER1';
      } else if (tier3.includes(baseSymbol)) {
        tierPrefix = 'TIER3';
      } else {
        // Default to TIER2 for all other symbols
        tierPrefix = 'TIER2';
      }

      // Get SL based on tier + volatility regime
      if (volatilityRegime.regime === 'LOW') {
        baseSlPct = exitConfig[`${tierPrefix}_SL_LOW_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
      } else if (volatilityRegime.regime === 'HIGH') {
        baseSlPct = exitConfig[`${tierPrefix}_SL_HIGH_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
      } else {
        baseSlPct = exitConfig[`${tierPrefix}_SL_MED_VOL_PCT`] ?? exitConfig.DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
      }
    } else {
      // Legacy behavior: volatility-only SL
      if (volatilityRegime.regime === 'LOW') {
        baseSlPct = exitConfig.DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
      } else if (volatilityRegime.regime === 'HIGH') {
        baseSlPct = exitConfig.DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
      } else {
        baseSlPct = exitConfig.DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
      }
    }
  } else {
    baseSlPct = position.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
  }

  // V5.81: Breakeven move — when profit reached trigger, SL moves to entry + offset
  const breakevenEnabled = (MomentumConfig.EXIT as any).BREAKEVEN_ENABLED ?? false;
  const breakevenTrigger = (MomentumConfig.EXIT as any).BREAKEVEN_TRIGGER_PCT ?? 1.0;
  const breakevenOffset = (MomentumConfig.EXIT as any).BREAKEVEN_OFFSET_PCT ?? 0.1;
  const maxPnl = position.maxPnlPct ?? 0;

  let useBreakeven = false;
  if (breakevenEnabled && maxPnl >= breakevenTrigger && !trailingIsActive) {
    // Trade proved direction — protect at breakeven instead of full SL
    useBreakeven = true;
  }

  // V5.84: Stagnant SL respects adaptive SL — use ratio of current baseSlPct
  const stagnantTightenSlPct = baseSlPct * stagnantTightenSlRatio;
  const effectiveSlPct = isStagnantConfirmed ? stagnantTightenSlPct : (useBreakeven ? breakevenOffset : baseSlPct);

  // ============================================================================
  // V5.38: CHECK SL ON WICK FIRST (like backtest) - BEFORE trailing
  // Even if trailing is active, check SL first (in case of violent crash)
  // ============================================================================
  if (position.side === 'long') {
    const slPrice = position.entryPrice * (1 - effectiveSlPct / 100);
    if (effectiveLow <= slPrice) {
      return {
        shouldExit: true,
        reason: isStagnantConfirmed ? 'stagnant_trade' : 'stoploss',
        pnlPct,
        holdMinutes,
        effectiveSlPct
      };
    }
  } else {
    const slPrice = position.entryPrice * (1 + effectiveSlPct / 100);
    if (effectiveHigh >= slPrice) {
      return {
        shouldExit: true,
        reason: isStagnantConfirmed ? 'stagnant_trade' : 'stoploss',
        pnlPct,
        holdMinutes,
        effectiveSlPct
      };
    }
  }

  // ============================================================================
  // V5.38 FIX: CHECK TRAILING (aligned with backtest)
  // - Check WICK first (like backtest does)
  // - Only then check CLOSE for 2-candle confirmation
  // - Return trailingBreachReset=true when wick hit but close didn't breach
  // ============================================================================
  if (trailingIsActive) {
    // V5.39 FIX: Use adaptive trailing distance (from volatility regime)
    // Then widen progressively based on move size
    let trailingDistance = baseTrailingDistance;

    // V5.39 FIX: Use hwmPct (max reached) for widen check, like backtest
    // Previously used pnlPct (current) which could differ when price retraces
    const hwmPct = position.side === 'long'
      ? position.highWaterMark
        ? ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100
        : pnlPct
      : position.lowWaterMark
        ? ((position.entryPrice - position.lowWaterMark) / position.entryPrice) * 100
        : pnlPct;

    // V5.88: Progressive trailing - wider on bigger moves to let winners run
    // XRP trade analysis: 4.55% move exited on 2.33% bounce, missing 55% more
    const progressiveEnabled = (MomentumConfig.EXIT as any).TRAILING_PROGRESSIVE_ENABLED ?? false;
    const volAdaptEnabled = (MomentumConfig.EXIT as any).TRAILING_VOL_ADAPT_ENABLED ?? false;

    // V5.88: Get volatility multiplier based on regime
    let volMultiplier = 1.0;
    if (volAdaptEnabled) {
      const lowMult = (MomentumConfig.EXIT as any).TRAILING_VOL_LOW_MULT ?? 0.8;
      const medMult = (MomentumConfig.EXIT as any).TRAILING_VOL_MED_MULT ?? 1.0;
      const highMult = (MomentumConfig.EXIT as any).TRAILING_VOL_HIGH_MULT ?? 1.6;

      if (volatilityRegime.regime === 'HIGH') {
        volMultiplier = highMult;
      } else if (volatilityRegime.regime === 'LOW') {
        volMultiplier = lowMult;
      } else {
        volMultiplier = medMult;
      }
    }

    if (progressiveEnabled) {
      // V5.118: ATR-scaled progressive trailing — adapt tiers per-asset using entry ATR
      const atrScaledEnabled = (MomentumConfig.EXIT as any).TRAILING_ATR_SCALED_ENABLED ?? false;
      const entryAtrPct = position.entryAtrPct;

      if (atrScaledEnabled && entryAtrPct && entryAtrPct > 0) {
        // ATR-scaled tiers: thresholds and distances scale with asset's ATR at entry
        const tier3AtMult = (MomentumConfig.EXIT as any).TRAILING_TIER3_ATR_MULT ?? 4.5;
        const tier2AtMult = (MomentumConfig.EXIT as any).TRAILING_TIER2_ATR_MULT ?? 3.0;
        const tier1AtMult = (MomentumConfig.EXIT as any).TRAILING_TIER1_ATR_MULT ?? 2.0;

        const tier3DistMult = (MomentumConfig.EXIT as any).TRAILING_TIER3_DIST_ATR_MULT ?? 1.5;
        const tier2DistMult = (MomentumConfig.EXIT as any).TRAILING_TIER2_DIST_ATR_MULT ?? 1.0;
        const tier1DistMult = (MomentumConfig.EXIT as any).TRAILING_TIER1_DIST_ATR_MULT ?? 0.5;

        if (hwmPct >= tier3AtMult * entryAtrPct) {
          trailingDistance = tier3DistMult * entryAtrPct * volMultiplier;
        } else if (hwmPct >= tier2AtMult * entryAtrPct) {
          trailingDistance = tier2DistMult * entryAtrPct * volMultiplier;
        } else if (hwmPct >= tier1AtMult * entryAtrPct) {
          trailingDistance = tier1DistMult * entryAtrPct * volMultiplier;
        }
        // Below tier1: use baseTrailingDistance (from volatility regime)
      } else {
        // Fallback: fixed % tiers (legacy behavior, or entryAtrPct unavailable)
        const tier3At = (MomentumConfig.EXIT as any).TRAILING_TIER3_AT_PCT ?? 6.0;
        const tier2At = (MomentumConfig.EXIT as any).TRAILING_TIER2_AT_PCT ?? 4.0;
        const tier1At = MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT;

        if (hwmPct >= tier3At) {
          const baseDist = (MomentumConfig.EXIT as any).TRAILING_TIER3_DISTANCE_PCT ?? 2.5;
          trailingDistance = baseDist * volMultiplier;
        } else if (hwmPct >= tier2At) {
          const baseDist = (MomentumConfig.EXIT as any).TRAILING_TIER2_DISTANCE_PCT ?? 1.5;
          trailingDistance = baseDist * volMultiplier;
        } else if (hwmPct >= tier1At) {
          trailingDistance = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT * volMultiplier;
        }
      }
    } else {
      // Legacy behavior: single widen threshold
      if (hwmPct >= MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT) {
        trailingDistance = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT * volMultiplier;
      }
    }

    let trailingStopPrice: number;

    if (position.side === 'long') {
      const highWaterMark = position.highWaterMark
        ? Math.max(position.highWaterMark, effectiveHigh)
        : effectiveHigh;

      trailingStopPrice = highWaterMark * (1 - trailingDistance / 100);

      // V5.38 FIX: Check WICK first (like backtest)
      const wickBreached = effectiveLow <= trailingStopPrice;

      if (wickBreached) {
        // Wick touched the stop - now check if CLOSE also breached
        const closeBreached = currentPrice <= trailingStopPrice;

        if (closeBreached) {
          // Both wick AND close breached - signal for 2-candle confirmation
          return {
            shouldExit: false,  // Caller handles 2-close confirmation
            reason: 'trailing_breach',
            pnlPct,
            holdMinutes,
            newStopLoss: trailingStopPrice,
            trailingActivated: true,
            trailingBreached: true
          };
        } else {
          // Wick hit but close recovered - reset breach counter (like backtest)
          return {
            shouldExit: false,
            reason: 'none',
            pnlPct,
            holdMinutes,
            newStopLoss: trailingStopPrice,
            trailingActivated: true,
            trailingBreached: false  // Explicit false = reset counter
          };
        }
      }

      // No wick breach - trailing active but not triggered
      return {
        shouldExit: false,
        reason: 'none',
        pnlPct,
        holdMinutes,
        newStopLoss: trailingStopPrice,
        trailingActivated: true
      };

    } else {
      const lowWaterMark = position.lowWaterMark
        ? Math.min(position.lowWaterMark, effectiveLow)
        : effectiveLow;

      trailingStopPrice = lowWaterMark * (1 + trailingDistance / 100);

      // V5.38 FIX: Check WICK first (like backtest)
      const wickBreached = effectiveHigh >= trailingStopPrice;

      if (wickBreached) {
        // Wick touched the stop - now check if CLOSE also breached
        const closeBreached = currentPrice >= trailingStopPrice;

        if (closeBreached) {
          // Both wick AND close breached - signal for 2-candle confirmation
          return {
            shouldExit: false,
            reason: 'trailing_breach',
            pnlPct,
            holdMinutes,
            newStopLoss: trailingStopPrice,
            trailingActivated: true,
            trailingBreached: true
          };
        } else {
          // Wick hit but close recovered - reset breach counter (like backtest)
          return {
            shouldExit: false,
            reason: 'none',
            pnlPct,
            holdMinutes,
            newStopLoss: trailingStopPrice,
            trailingActivated: true,
            trailingBreached: false  // Explicit false = reset counter
          };
        }
      }

      // No wick breach - trailing active but not triggered
      return {
        shouldExit: false,
        reason: 'none',
        pnlPct,
        holdMinutes,
        newStopLoss: trailingStopPrice,
        trailingActivated: true
      };
    }
  }

  // Return stagnant SL info if confirmed but not yet hit
  if (isStagnantConfirmed) {
    return {
      shouldExit: false,
      reason: 'none',
      pnlPct,
      holdMinutes,
      stagnantSlTightened: true,
      effectiveSlPct
    };
  }

  return { shouldExit: false, reason: 'none', pnlPct, holdMinutes };
}
