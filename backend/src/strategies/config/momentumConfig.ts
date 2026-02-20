/**
 * 🎯 STRATÉGIE V5.33 - BREAKOUT CONFIRMATION FILTER
 *
 * V5.33 CHANGES (Dec 30, 2025):
 * ═════════════════════════════════════════════════════════════
 * BREAKTHROUGH DISCOVERY: Confirmation > Anticipation
 * ═════════════════════════════════════════════════════════════
 * Analysis of 60,000+ breakouts revealed that "anticipatory entry"
 * (entering on squeeze/pressure) is a TRAP - it reduces win rate!
 *
 * The REAL winning pattern is CONFIRMATION:
 * - Distance from BB > 0.75% = 60-66% WR (vs 36% baseline)
 * - Distance from BB > 1.0%  = 66-71% WR
 * - Distance from BB > 1.5%  = 74-76% WR
 *
 * NEW FILTERS:
 * - BREAKOUT_CONFIRMATION_PCT: 0.75% distance from BB required
 * - ROC1_MIN: 0.3% current candle momentum (LONG)
 * - ROC1_MAX: -0.3% current candle momentum (SHORT)
 * - VOLUME_MIN: 1.2x average volume confirmation
 *
 * BACKTEST PROJECTION:
 * - LONG: 36% → 60% WR
 * - SHORT: 44% → 66% WR
 * - Big Winners: 14% → 32-38%
 *
 * ═════════════════════════════════════════════════════════════
 * V5.27 REGIME CHANGE EXIT IMPROVEMENT:
 * ═════════════════════════════════════════════════════════════
 * - Only exit on regime change if BTC volume >= 1.5x average
 * - Filters out weak/noisy SMA200 crosses (choppy markets)
 * - Validated on Dec 26-27 2025 real trades analysis
 *
 * ═════════════════════════════════════════════════════════════
 * V5.12 FILTRES OPTIMISÉS:
 * ═════════════════════════════════════════════════════════════
 * LONG:
 * - Volume >= 1.5x (relaxed from 2.0x)
 * - ConsecUp <= 5 (relaxed from 3)
 * - RSI+BTC filter REMOVED
 *
 * ═════════════════════════════════════════════════════════════
 * V5.9 FILTRES (unchanged):
 * ═════════════════════════════════════════════════════════════
 * SHORT: Skip if StochRSI < 15 AND volRatio < 4.0
 *   → Filtre les shorts en zone oversold extrême (sauf panic selling)
 *
 * ═════════════════════════════════════════════════════════════
 * LONG ENTRY (BTC > SMA200 = Bull Market):
 * ═════════════════════════════════════════════════════════════
 * - Bollinger Band breakout (close > upper band)
 * - ROC 10 périodes > 1.75%
 * - Volume > 1.15x moyenne (V5.13)
 * - ConsecUp <= 5 (V5.12)
 *
 * ═════════════════════════════════════════════════════════════
 * SHORT ENTRY (BTC < SMA200 = Bear Market):
 * ═════════════════════════════════════════════════════════════
 * - ROC 5 périodes < -1.5%
 * - Volume > 2x moyenne
 * - Price < MA20 & BB Lower
 * - ConsecDown <= 4
 * - StochRSI >= 15 OR volRatio >= 4 (V5.9)
 *
 * EXIT (V5.27):
 * - Stop Loss: 2.5% fixe
 * - Take Profit: 3%
 * - Trailing: activé à +0.8%, trail à 0.5%
 * - Regime Change: Exit si BTC cross SMA200 AVEC volume 1.5x
 * - Max Hold: 48h
 */

// ============================================================================
// SHARED CONSTANTS FOR PARITY (used by both backtest and live)
// ============================================================================

/** 15-minute candle interval in milliseconds */
export const CANDLE_15M_MS = 15 * 60 * 1000;

/**
 * V5.46: Calculate the correct `nowMs` for exit checks to ensure backtest/live parity.
 *
 * CRITICAL: This function ensures EXACT holdMinutes calculation parity between backtest and live.
 *
 * V5.46 PARITY FIX:
 * Both backtest and live now use the SAME time calculation:
 *
 * BACKTEST:
 *   entryTime = candle.timestamp (candle START/OPEN time)
 *   nowMs = entryTime + holdBars * 15 * 60000
 *   holdMinutes = holdBars * 15
 *
 * LIVE (V5.46):
 *   entryTime = candle.timestamp (candle START/OPEN time) ← FIXED in V5.46
 *   nowMs = calculateExitNowMs(nextCandle.timestamp) = nextCandle.timestamp + 15min
 *   holdMinutes = (nowMs - entryTime) / 60000 = holdBars * 15
 *
 * This ensures trailing stops, stagnant detection, and all time-based exits
 * behave IDENTICALLY between live and backtest.
 *
 * @param candleTimestamp - The timestamp of the closed candle (its START time)
 * @returns The correct nowMs to use for exit checks (candle END time = next candle START)
 */
export function calculateExitNowMs(candleTimestamp: number): number {
  return candleTimestamp + CANDLE_15M_MS;
}

// ============================================================================
// CONFIGURATION V5
// ============================================================================

export const MomentumConfig = {
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.11 - SL LARGE (ATR×3.0) + TRAILING AGRESSIF (+0.5%, 0.3%)
  // Backtest 24 mois avec frais 0.08%: +2547% equity, 832 trades, 89.1% WR
  // Évite 138 stop hunts, SL rate 10.6% (vs 27.2% avec ATR×2.0)
  // ═══════════════════════════════════════════════════════════════════════════

  // V5.8: StochRSI Filter for SHORT - Skip if oversold AND no volume spike
  STOCHRSI_FILTER: {
    ENABLED: true,                    // Enable StochRSI filter (SHORT only)
    MIN_STOCHRSI: 15,                 // Skip SHORT if StochRSI < 15...
    VOLUME_EXCEPTION_MULTIPLIER: 4.0, // ...unless volRatio >= 4x (panic selling)
    RSI_PERIOD: 14,                   // RSI period for StochRSI
    STOCH_PERIOD: 14,                 // Stochastic period for StochRSI
    STOCH_SMOOTH: 3,                  // Smoothing period for StochRSI
  },

  // V5.13 → V5.27: Regime Change Exit with Volume Confirmation
  // Backtest validated: +1.4% PnL, -0.5% MaxDD vs no confirmation
  // Volume confirmation filters out weak regime changes (choppy markets)
  REGIME_CHANGE_EXIT: {
    ENABLED: true,                    // Enable regime change exit
    BUFFER_ZONE_PCT: 0.0,             // NO buffer - exit immediately on cross
    REQUIRE_VOLUME_CONFIRMATION: true, // V5.27: Require volume spike to confirm regime change
    MIN_VOLUME_MULTIPLIER: 1.5,       // V5.27: Need 1.5x avg volume to confirm
    REQUIRE_MOMENTUM_CONFIRMATION: false, // NO momentum confirmation (reduces PnL)
    MIN_ROC5_BULL: 0.015,             // DEAD — REQUIRE_MOMENTUM_CONFIRMATION is false
    MIN_ROC5_BEAR: -0.015,            // DEAD — REQUIRE_MOMENTUM_CONFIRMATION is false
  },

  // Signal d'entrée LONG (Bull Market: BTC > SMA200)
  // V5.13: Lower thresholds for earlier entries (+25% ROI validated on 2024)
  ENTRY_LONG: {
    // Bollinger Bands — DEAD: code uses ENTRY.BB_PERIOD/BB_STD instead
    BB_PERIOD: 20,
    BB_STD: 2,

    // Momentum confirmation - V5.13 OPTIMIZED (2024 backtest: +25% ROI vs V5.12)
    ROC_MIN: 0.0175,             // V5.13: ROC 10 > 1.75% (was 2.5%) - Earlier entries
    VOL_MULTIPLIER: 1.15,        // V5.13: 1.15x (was 1.5) - +25% ROI, 62.2% win rate
    MAX_CONSEC_UP: 5,            // V5.12: 5 (was 3) - +34% PnL
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.33: BREAKOUT CONFIRMATION FILTER (OPTIMIZED)
  // ═══════════════════════════════════════════════════════════════════════════
  // OPTIMIZATION RESULT (13,135 trades analyzed):
  // - Baseline: 46.1% WR, 0.029% avg PnL
  // - Distance 0.5%: 47.0% WR, 0.074% avg PnL (+155% improvement!)
  // - Distance 0.75%: 46.8% WR, 0.069% avg PnL
  // - Distance 1.0%+: Diminishing returns, fewer trades
  //
  // BEST CONFIG: Distance 0.5%, no ROC1 filter needed
  // - 49% fewer trades (13,135 → 6,724)
  // - +155% better avg PnL per trade
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.34 UPDATE: DISABLED - Distance filter reduces trades without WR improvement
  // Test showed: 4943 trades → 2051 trades but same 55% WR
  // Better to keep all trades and rely on V5.34 optimized stagnant exit
  // ═══════════════════════════════════════════════════════════════════════════
  // DEAD CONFIG — V5.34 disabled, kept for reference only
  BREAKOUT_CONFIRMATION: {
    ENABLED: false,                     // V5.34: DISABLED - let stagnant exit handle filtering

    // LONG entry confirmation (Bull Regime) - DISABLED
    LONG_MIN_DISTANCE_PCT: 0.5,         // Not used when ENABLED: false
    LONG_MIN_ROC1_PCT: 0,
    LONG_MIN_VOL_RATIO: 1.2,

    // SHORT entry confirmation (Bear Regime) - DISABLED
    SHORT_MIN_DISTANCE_PCT: 0.5,
    SHORT_MAX_ROC1_PCT: 0,
    SHORT_MIN_VOL_RATIO: 1.2,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.32: ANTICIPATORY ENTRY - DISABLED (proven counterproductive)
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTEST RESULTS (Dec 30, 2025):
  // - Anticipatory: 386 trades, 53.6% WR, +0.07% avg PnL
  // - Classic: 2103 trades, 59.9% WR, +1.89% avg PnL
  // CONCLUSION: Classic breakout outperforms anticipatory by 27x per trade
  // DISABLED pending further optimization of squeeze detection
  // ═══════════════════════════════════════════════════════════════════════════
  // DEAD CONFIG — V5.32 disabled, proven counterproductive
  ANTICIPATORY_ENTRY: {
    ENABLED: false,                    // DISABLED - underperforms classic breakout

    // BB Squeeze Detection
    BB_SQUEEZE_LOOKBACK: 10,           // Compare current bandwidth to last N candles
    BB_SQUEEZE_THRESHOLD: 0.7,         // Current BW < 70% of avg BW = squeeze detected

    // Pre-breakout Position (close approaching upper band)
    PRE_BREAKOUT_ZONE_PCT: 0.3,        // Enter if close >= upper - 0.3% (within 0.3% of upper)
    PRE_BREAKOUT_MIN_ROC5: 0.003,      // Require ROC5 > 0.3% (building momentum, not flat)
    PRE_BREAKOUT_MAX_ROC10: 0.015,     // ROC10 < 1.5% (not already exhausted)

    // Volume Accumulation (rising volume before spike)
    VOL_ACCUMULATION_CANDLES: 3,       // Look at last 3 candles
    VOL_ACCUMULATION_MIN_TREND: 1.05,  // Each candle should have ~5% more volume than prev
    VOL_ACCUMULATION_MIN_RATIO: 0.8,   // But absolute volume >= 0.8x average (not dead)

    // Confirmation filters
    REQUIRE_BULLISH_CANDLE: true,      // Current candle must be bullish
    REQUIRE_PRICE_ABOVE_MA20: true,    // Price must be above MA20 (uptrend)
    MAX_DISTANCE_FROM_ENTRY: 0.5,      // Don't enter if we're already >0.5% above MA20 (late)
  },

  // Signal d'entrée SHORT (Bear Market: BTC < SMA200)
  // V5.4: BB Breakdown - Plus stable (10/12 mois positifs)
  ENTRY_SHORT: {
    // Conditions SHORT optimisées
    ROC_DROP_MIN: -0.015,        // ROC 5 < -1.5% (était -2%)
    VOL_SPIKE: 2.0,              // Volume > 2x moyenne (était 2.5x)
    PRICE_BELOW_MA20: true,      // Prix < MA20
    PRICE_BELOW_BB_LOWER: true,  // Prix < BB Lower (nouveau filtre)
    MAX_CONSEC_DOWN: 6,          // V5.93: Max 6 (was 4) - backtest 2025: +30% PnL, +0.21 Sharpe, +1.3% WR, -3% DD
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.64: WICK BREAKOUT EARLY ENTRY (2-Year Validated: +0.48% PnL/trade)
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTEST RESULTS (2024 + 2025):
  //   Entry Improvement: +0.48% average better entry price
  //   PnL Improvement: +0.48% per trade
  //   Win Rate: 87.6% vs 78.1% classic (+9.5pp)
  //   Applicable: 77% of all trades
  //
  // CONCEPT: Enter when wick breaks BB band instead of waiting for close
  //   LONG: If high > BB_upper × 1.005 → entry at BB_upper × 1.003
  //   SHORT: If low < BB_lower × 0.995 → entry at BB_lower × 0.997
  //
  // WHY IT WORKS:
  //   - Captures breakout at better price before candle completes
  //   - Strong breakouts (wick > buffer) have higher follow-through
  //   - Filters naturally select stronger signals
  // ═══════════════════════════════════════════════════════════════════════════
  WICK_BREAKOUT: {
    ENABLED: true,                  // Enable wick breakout early entry

    // LONG: How much above BB_upper must high be to trigger early entry
    LONG_BB_BUFFER: 0.005,          // high > BB_upper × 1.005 (0.5% above)
    // LONG: Entry price when triggered
    LONG_ENTRY_BUFFER: 0.003,       // Entry at BB_upper × 1.003 (0.3% above)

    // SHORT: How much below BB_lower must low be to trigger early entry
    SHORT_BB_BUFFER: 0.005,         // low < BB_lower × 0.995 (0.5% below)
    // SHORT: Entry price when triggered
    SHORT_ENTRY_BUFFER: 0.003,      // Entry at BB_lower × 0.997 (0.3% below)

    // V5.72: LIMIT ORDER FOR WICK BREAKOUT (Live trading)
    // When wick breakout triggers, use limit order at wick price instead of market
    LIMIT_ORDER_ENABLED: true,      // Use limit order at wick price in live
    LIMIT_ORDER_TIMEOUT_MS: 10_000, // Wait 10 seconds for limit order to fill
    LIMIT_ORDER_FALLBACK: true,     // If not filled, cancel and use market order
  },

  // Config commune
  ENTRY: {
    // Bollinger Bands (legacy, utilisé par LONG)
    BB_PERIOD: 20,
    BB_STD: 2,

    // Legacy fields for compatibility - V5.13 Moderate
    ROC_MIN: 0.0175,             // V5.13: 1.75% (was 2.5%)
    VOL_MULTIPLIER: 1.15,        // V5.13: 1.15x (was 1.5x)
    MAX_CONSEC_UP: 5,            // V5.12: 5

    // BTC Regime Filter
    BTC_SMA_PERIOD: 200,         // SMA 200 (on 15m = 50h = ~2 days — fast regime for momentum breakout)
    BTC_REGIME_TIMEFRAME: '15m' as const,  // V5.102: Use 15m for regime SMA200 (validated: +2325% ROI, +0.19 Sharpe on 9 symbols)
    BTC_REGIME_TOLERANCE_PCT: 0.2, // V5.113: Dead zone ±0.2% around SMA200 — when price is in band, use SMA slope to determine regime (prevents whipsaw). Validated: +$4.4K PnL, -2.7pp DD, +0.09 Sharpe
    BTC_MOMENTUM_MIN: 0,         // DEAD — superseded by SMA200 regime
    BTC_MOMENTUM_PERIOD: 24,     // DEAD — kept for type compatibility

    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],  // DEAD — never checked in checkMomentumSignal
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.36: VALIDATED PATTERN FILTERS (2-Year Backtest: +22.4pp WR)
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTEST RESULTS (2024 + 2025):
  //   Baseline: 57.8% WR, 2,010 trades/year
  //   With Patterns: 80.2% WR, 1,449 trades/year
  //   Win Rate Improvement: +22.4pp (57.8% → 80.2%)
  //   Loss Reduction: -1,122 losses over 2 years (-66%)
  //   Trade Reduction: -28% (more selective, higher quality)
  //
  // PATTERN 1: Multi-Timeframe Confluence (MTF)
  //   - ROOT CAUSE: Altcoin breakouts without BTC confirmation = 100% false signals
  //   - SOLUTION: Require 15m signal + 1h BTC trend alignment
  //   - IMPACT: +13.5pp WR, removes 762 losses (100% filter accuracy)
  //
  // PATTERN 2: BTC Volatility Filter
  //   - ROOT CAUSE: Low BTC volatility = choppy market = stagnant trades
  //   - SOLUTION: Only enter when BTC ATR > threshold (trending market)
  //   - IMPACT: +8.9pp WR, reduces stagnant trades by 45%
  // ═══════════════════════════════════════════════════════════════════════════

  MULTI_TIMEFRAME_FILTER: {
    ENABLED: true,                    // V5.36: Enable MTF filter (2-year validated)
    TIMEFRAME: '15m',                 // V5.102: Use 15m candles (same as signal TF — faster regime)
    MIN_BTC_ROC_LONG: 0.0,            // LONG: Require BTC 15m ROC > 0% (bullish)
    MAX_BTC_ROC_SHORT: 0.0,           // SHORT: Require BTC 15m ROC < 0% (bearish)
    LOOKBACK_CANDLES: 40,             // V5.102: 40 × 15m = 10h (was 10 × 1h = 10h — same window)
    CACHE_1H_CANDLES: true,           // DEAD — vestige from 1h regime, no longer used
    CACHE_REFRESH_MINUTES: 15,        // DEAD — vestige from 1h regime
  },

  BTC_VOLATILITY_FILTER: {
    ENABLED: true,                    // V5.36: Enable BTC volatility filter
    MIN_ATR_PCT: 0.15,                // V5.39 FIX: Adjusted for 15m timeframe (was 1.5% which blocked all trades)
                                      // 15m ATR typically ranges 0.08%-0.6%, so 0.15% filters only dead markets
    ATR_PERIOD: 14,                   // 14-period ATR (standard)
    TIMEFRAME: '15m',                 // Use 15m BTC candles for ATR calculation
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.78: CANDLE PATTERN QUALITY FILTERS (2-Year OOS Validated)
  // ═══════════════════════════════════════════════════════════════════════════
  // COMBO2 filters validated on 2024 (OOS) + 2025 (IS):
  //   Baseline:   10,276 tr  WR 66.7%  Avg +0.21%  Total 2,191%  (2024)
  //   COMBO2:      5,688 tr  WR 67.9%  Avg +0.73%  Total 4,164%  (2024)
  //   Baseline:    7,198 tr  WR 68.5%  Avg +0.30%  Total 2,175%  (2025)
  //   COMBO2:      4,046 tr  WR 68.8%  Avg +0.50%  Total 2,030%  (2025)
  //
  // LONG filters (L3):
  //   - Skip LONG if greenRatio10 >= 0.70 (overbought candle pattern)
  //   - Skip LONG if alternation5 >= 3 (choppy market, no trend)
  //   - Skip LONG if BB touches == 0 in last 10 candles (no band pressure)
  //
  // SHORT filter (S4):
  //   - Skip SHORT if ROC acceleration > 0 (momentum turning against short)
  //
  // Net effect: ~45% fewer trades but +250% avg PnL per trade improvement
  // ═══════════════════════════════════════════════════════════════════════════
  CANDLE_PATTERN_FILTER: {
    ENABLED: true,

    // LONG: Skip if green ratio (bullish candles / total) in last 10 candles >= threshold
    LONG_MAX_GREEN_RATIO: 0.70,
    GREEN_RATIO_LOOKBACK: 10,

    // LONG: Skip if alternation rate in last 5 candles >= threshold (choppy)
    LONG_MAX_ALT5: 2,               // alt5 >= 3 = choppy → skip

    // LONG: Skip if 0 BB band touches in last 10 candles (no pressure)
    LONG_MIN_BB_TOUCHES: 1,
    BB_TOUCH_LOOKBACK: 10,
    BB_TOUCH_THRESHOLD: 0.002,      // Within 0.2% of band = "touch"

    // SHORT: Skip if ROC acceleration > 0 (momentum turning bullish)
    SHORT_MAX_ROC_ACCEL: 0.0,
    ROC_ACCEL_FAST_PERIOD: 5,       // ROC of last 5 candles
    ROC_ACCEL_SLOW_PERIOD: 5,       // compared to ROC of 5 candles before that

    // V5.118: SHORT choppiness filter — skip SHORT if market is alternating (choppy)
    // Mirrors LONG's alternation5 filter. Choppy markets = breakdowns fail
    SHORT_MAX_ALT5: 2,              // alt5 >= 3 = choppy → skip SHORT
  },

  // Exit V5.14 - ADAPTIVE TRAILING ONLY
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTEST RESULTS: Trailing adaptatif 0.3-0.8% basé sur volatilité (ATR)
  // - +320% ROI vs +4% baseline (72× amélioration)
  // - 80.6% win rate vs 70.6%
  // - 38.5% max DD vs 61.7% (drawdown divisé par 2)
  // - 18.9% SL rate vs 28.4% (moins de stop hunts)
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.35 OPTIMIZATIONS:
  // - TRAILING_WIDEN_AT_PCT: 2.0% → 3.0% (tighter trail on medium winners)
  // - MOMENTUM_REVERSAL_CONFIRMATION: Added 2-candle requirement
  // ═══════════════════════════════════════════════════════════════════════════
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 2880,   // 48 heures max hold

    // V5.81: DYNAMIC SL based on volatility regime (ATR)
    // Low vol: tighter SL (less noise), High vol: wider SL (more noise)
    // Parity data shows fixed 2.5% is too wide in calm markets (unnecessary losses)
    // and the asymmetry between fixed losses and variable wins hurts expectancy.
    STOP_LOSS_TYPE: 'dynamic' as const,  // V5.81: 'fixed' | 'atr' | 'dynamic'
    STOP_LOSS_PCT: 2.5,              // Base SL / fallback when dynamic unavailable
    STOP_LOSS_ATR_MULT: 3.0,         // ATR × 3.0 (was 2.0) - plus large
    STOP_LOSS_MIN_PCT: 1.0,          // Min 1.0% (was 0.8%)
    STOP_LOSS_MAX_PCT: 4.5,          // Max 4.5% (was 3.0%)

    // V5.85: TIER-BASED SL - Different cryptos have different volatility profiles
    // Based on historical P90 of 45-min moves:
    // - TIER 1 (Majors): BTC, ETH - P90 < 0.8%, very stable
    // - TIER 2 (Large-caps): SOL, SEI, DOGE, etc. - P90 0.8-1.2%, need wider SL
    // - TIER 3 (Mid-caps): IMX, OP - P90 > 1.2%, very volatile
    TIER_BASED_SL_ENABLED: true,

    // TIER 1: BTC, ETH (P90 < 0.8%)
    TIER1_SYMBOLS: ['BTC', 'ETH'],
    TIER1_SL_LOW_VOL_PCT: 1.5,       // Low vol: 1.5%
    TIER1_SL_MED_VOL_PCT: 2.0,       // Med vol: 2.0%
    TIER1_SL_HIGH_VOL_PCT: 2.5,      // High vol: 2.5%

    // TIER 2: Most altcoins (P90 0.8-1.2%)
    // SOL, SEI, DOGE, AVAX, XRP, LINK, ADA, ATOM, DOT, ARB, NEAR, SUI, APT
    TIER2_SYMBOLS: ['SOL', 'SEI', 'DOGE', 'AVAX', 'XRP', 'LINK', 'ADA', 'ATOM', 'DOT', 'ARB', 'NEAR', 'SUI', 'APT', 'STX', 'TIA'],
    TIER2_SL_LOW_VOL_PCT: 2.0,       // Low vol: 2.0% (was 1.5% - too tight!)
    TIER2_SL_MED_VOL_PCT: 2.5,       // Med vol: 2.5%
    TIER2_SL_HIGH_VOL_PCT: 3.0,      // High vol: 3.0%

    // TIER 3: High volatility alts (P90 > 1.2%)
    TIER3_SYMBOLS: ['IMX', 'OP', 'FTM', 'FET', 'WIF'],
    TIER3_SL_LOW_VOL_PCT: 2.5,       // Low vol: 2.5%
    TIER3_SL_MED_VOL_PCT: 3.0,       // Med vol: 3.0%
    TIER3_SL_HIGH_VOL_PCT: 3.5,      // High vol: 3.5%

    // V5.81: Dynamic SL by volatility regime (LEGACY - used when TIER_BASED_SL_ENABLED = false)
    DYNAMIC_SL_LOW_VOL_PCT: 1.5,     // ATR < 2%: tighter SL, market is calm
    DYNAMIC_SL_MED_VOL_PCT: 2.0,     // ATR 2-3.5%: standard SL
    DYNAMIC_SL_HIGH_VOL_PCT: 2.5,    // ATR > 3.5%: wider SL, market is wild

    // V5.81: Breakeven move — eliminate losses on trades that prove direction
    // When trade reaches +BREAKEVEN_TRIGGER_PCT, move SL to entry + fees
    BREAKEVEN_ENABLED: true,
    BREAKEVEN_TRIGGER_PCT: 1.0,       // Move SL to breakeven when +1% profit reached
    BREAKEVEN_OFFSET_PCT: 0.1,        // Offset above entry to cover fees (0.1%)

    PROFIT_TARGET_PCT: 3.0,      // Take Profit 3% → 15% avec 5x leverage

    // V5.35: OPTIMIZED Trailing Stop - Tighter trail on medium winners
    // Changed TRAILING_WIDEN_AT_PCT from 2.0% to 3.0% to keep tight control longer
    TRAILING_ACTIVATION_PCT: 1.0,       // V5.92: Optimized from 0.8 → 1.0 (+34% PnL, same DD)
    TRAILING_DISTANCE_PCT: 0.4,         // V5.92: Optimized from 0.5 → 0.4 (tighter trail, faster lock-in)
    TRAILING_WIDEN_AT_PCT: 3.0,         // V5.35: Widen at 3% (was 2%) - tighter on medium winners
    TRAILING_WIDE_DISTANCE_PCT: 0.8,    // Widened callback: 0.8% (let big winner run)

    // V5.88: Progressive trailing - wider trailing on bigger moves to let winners run
    // XRP analysis showed 4.55% move exited on 2.33% bounce, missing 55% more profit
    // On strong trending days, initial moves often continue after pullbacks
    TRAILING_PROGRESSIVE_ENABLED: true,
    TRAILING_TIER2_AT_PCT: 4.0,         // At 4% raw profit, widen to tier 2 (lowered from 5%)
    TRAILING_TIER2_DISTANCE_PCT: 1.5,   // Tier 2 base: 1.5% trailing
    TRAILING_TIER3_AT_PCT: 6.0,         // At 6% raw profit, widen to tier 3 (lowered from 7%)
    TRAILING_TIER3_DISTANCE_PCT: 2.5,   // Tier 3 base: 2.5% trailing

    // V5.118: ATR-SCALED PROGRESSIVE TRAILING
    // Instead of fixed % tiers, scale by entry ATR for per-asset adaptation
    // When enabled, TRAILING_TIER*_AT_PCT and TRAILING_TIER*_DISTANCE_PCT become fallbacks
    TRAILING_ATR_SCALED_ENABLED: true,
    // Tier activation: HWM must exceed N × entryAtrPct to enter tier
    TRAILING_TIER1_ATR_MULT: 2.0,       // Tier 1 at 2×ATR (e.g., DOGE ATR=1.2% → 2.4%)
    TRAILING_TIER2_ATR_MULT: 3.0,       // Tier 2 at 3×ATR (e.g., DOGE ATR=1.2% → 3.6%)
    TRAILING_TIER3_ATR_MULT: 4.5,       // Tier 3 at 4.5×ATR (e.g., DOGE ATR=1.2% → 5.4%)
    // Tier distance: trailing distance = N × entryAtrPct × volMult
    TRAILING_TIER1_DIST_ATR_MULT: 0.5,  // 0.5×ATR (e.g., DOGE → 0.6%)
    TRAILING_TIER2_DIST_ATR_MULT: 1.0,  // 1.0×ATR (e.g., DOGE → 1.2%)
    TRAILING_TIER3_DIST_ATR_MULT: 1.5,  // 1.5×ATR (e.g., DOGE → 1.8%)

    // V5.88: Volatility-adaptive progressive trailing
    // On HIGH volatility days (like XRP crash), bounces are larger → need wider trailing
    // Multipliers applied to progressive tier distances based on volatility regime
    // XRP had 2.33% bounce on HIGH vol day → need 1.6x to survive (1.5% × 1.6 = 2.4%)
    TRAILING_VOL_ADAPT_ENABLED: true,
    TRAILING_VOL_LOW_MULT: 0.8,         // LOW vol: tighter (0.8x base distance)
    TRAILING_VOL_MED_MULT: 1.0,         // MEDIUM vol: base distance (1.0x)
    TRAILING_VOL_HIGH_MULT: 1.6,        // HIGH vol: wider (1.6x) - handles 2.4%+ bounces

    // Protection setup
    // - Emergency stop is placed on exchange (wide, crash protection)
    // - Trailing exit is managed app-side (do NOT move exchange SL above entry)
    USE_EXCHANGE_TRAILING: false,         // App-side trailing is default

    // Emergency Stop Loss (Exchange)
    // V5.113: Tier-aware — emergency = baseSlPct + buffer, so exchange SL never
    // fires before the app-side dynamic SL. Old flat 2.5% cap was tighter than
    // TIER2 HIGH (3.0%) and TIER3 HIGH (3.5%), causing premature stop-outs.
    EMERGENCY_BUFFER_PCT: 0.5,            // Emergency SL = dynamic SL + buffer (always wider than app SL)
    EMERGENCY_ABSOLUTE_MAX_PCT: 4.0,      // Hard safety cap (TIER3 HIGH 3.5% + 0.5% = 4.0%)

    // Realtime App-Side Exit (WebSocket)
    // Goal: react faster than 15m candle close while filtering micro-noise.
    // This does NOT move the exchange emergency STOP_MARKET; it only decides when to close.
    // V5.37: Was disabled to match backtest behavior
    // V5.87: RE-ENABLED for proactive limit orders - places LIMIT at trailing stop BEFORE breach
    // so fills happen at exact trailing price (backtest parity). Without this, live uses market
    // orders after breach which have slippage (XRP trade lost 7% to bounce/slippage).
    REALTIME_APP_EXIT_ENABLED: true,
    // Realtime trailing can be evaluated either on ticker (fast but noisy) or on closed 1m candles (filters wicks).
    // Recommended for "avoid noise": use 1m close-based trailing with 2 consecutive closes.
    REALTIME_APP_EXIT_TRAILING_MODE: 'kline_1m_close' as const, // 'ticker' | 'kline_1m_close'
    REALTIME_APP_EXIT_KLINE_INTERVAL: '1m' as const,
    REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES: 2,
    // V5.36: Disable realtime trailing - live now behaves like paper/backtest (15m close)
    // This prevents premature exits that reduce ROE. Emergency stop still protects crashes.
    // V5.62: Enable realtime trailing to use NFS_ADAPTIVE (faster exits, better fills)
    REALTIME_APP_EXIT_TRAILING_ENABLED: true,
    REALTIME_APP_EXIT_STOPLOSS_ENABLED: true,
    REALTIME_APP_EXIT_POLL_MS: 1000,          // How often we check WS price when in position
    REALTIME_APP_EXIT_CONFIRM_MS: 1800,       // Require breach to persist for at least this long
    REALTIME_APP_EXIT_CONFIRM_TICKS: 2,       // ...or for this many consecutive checks
    REALTIME_APP_EXIT_BUFFER_PCT: 0.05,       // Extra buffer beyond stop to avoid spread/mark noise
    REALTIME_APP_EXIT_USE_MID_PRICE: true,    // Use (bid+ask)/2 when available

    // ═══════════════════════════════════════════════════════════════════════════
    // NFS (Noise Filter Score) - Smart Exit System
    // ═══════════════════════════════════════════════════════════════════════════
    // Goal: Exit reactively on REAL signals while filtering noise/wicks
    // Based on statistical analysis: 80.6% of breaches are TRUE signals
    // NFS score >= 70: High confidence exit (LIMIT order)
    // NFS score 40-69: Medium confidence (wait more or use confirmation)
    // NFS score < 40: Low confidence (likely noise, use 2-candle confirmation)
    NFS_PROACTIVE_LIMIT_ENABLED: true,        // Legacy: now replaced by exhaustion stop
    NFS_ENABLED: true,                        // Master switch for NFS system

    // ═══════════════════════════════════════════════════════════════════
    // V5.110: EXHAUSTION-BASED PROACTIVE STOP
    // Detects when momentum is dying BEFORE trailing breach using 5 indicators:
    // ROC deceleration, volume dry-up, body shrinkage, rejection wicks, proximity.
    // When exhaustion confirmed: places STOP_MARKET at trailing stop on exchange.
    // The exhaustion score IS the noise filter (replaces NFS partial-candle scoring).
    // ═══════════════════════════════════════════════════════════════════
    EXHAUSTION_STOP_ENABLED: true,            // Master switch for exhaustion detection
    EXHAUSTION_PLACEMENT_THRESHOLD: 35,       // Score >= this → place STOP_MARKET (0-100)
    EXHAUSTION_CANCEL_THRESHOLD: 20,          // Score < this → cancel STOP (hysteresis)
    EXHAUSTION_MIN_CANDLES: 10,               // Min candles needed for reliable calculation
    NFS_HIGH_SCORE_THRESHOLD: 70,             // Score >= this = immediate LIMIT exit
    NFS_MEDIUM_SCORE_THRESHOLD: 40,           // Score >= this = monitor closely

    // NFS Component Weights (sum = 100)
    // Based on analysis: Breach/ATR ratio is most discriminative (Cohen's d = 0.687)
    NFS_WEIGHT_BREACH_ATR: 35,                // Breach depth vs ATR (most important)
    NFS_WEIGHT_BREACH_DEPTH: 25,              // Raw breach depth %
    NFS_WEIGHT_VOLUME: 20,                    // Volume confirmation
    NFS_WEIGHT_CANDLE_BODY: 10,               // Candle body vs range ratio
    NFS_WEIGHT_MOMENTUM: 10,                  // ROC5 momentum

    // NFS Component Thresholds (from statistical analysis)
    NFS_BREACH_ATR_THRESHOLD: 0.40,           // P50 of true signals
    NFS_BREACH_DEPTH_THRESHOLD: 0.25,         // Between P25-P50 of true signals
    NFS_VOLUME_RATIO_THRESHOLD: 1.5,          // ~P50 of true signals
    NFS_CANDLE_BODY_RATIO_THRESHOLD: 0.5,     // Body >= 50% of candle range
    NFS_MOMENTUM_ROC5_THRESHOLD: 0.5,         // |ROC5| >= 0.5%

    // NFS Low-Volume Breach Demotion (V5.93)
    // When trailing breach happens on low volume, demote confidence one level
    // HIGH→MED (wait 1 more candle), MED→LOW (wait 2 more candles)
    // Prevents noise exits on big winners where bounce has no volume conviction
    NFS_LOW_VOL_DEMOTION_ENABLED: true,       // Demote NFS confidence when breach volume is low
    NFS_LOW_VOL_DEMOTION_THRESHOLD: 0.7,      // Volume ratio < 0.7x average → demote one level

    // NFS Order Execution
    NFS_USE_LIMIT_ORDER: true,                // Use LIMIT order for exits (vs market)
    NFS_LIMIT_ORDER_TIMEOUT_MS: 3000,         // Max wait for LIMIT fill
    NFS_MARKET_FALLBACK_ENABLED: true,        // Fall back to market if LIMIT fails
    NFS_PARTIAL_FILL_MIN_RATIO: 0.7,          // Accept partial if >= 70% filled
    NFS_MAX_SLIPPAGE_PCT: 0.5,                // Alert if slippage exceeds this

    // V5.65: General Order Slippage Protection
    // Applied to ALL market orders (entry and exit)
    MAX_ENTRY_SLIPPAGE_PCT: 1.0,              // Max acceptable entry slippage (1%)
    MAX_EXIT_SLIPPAGE_PCT: 2.0,               // Max acceptable exit slippage (2% - more lenient for exits)
    SLIPPAGE_ALERT_ENABLED: true,             // Send alert when slippage exceeds threshold
    SLIPPAGE_REJECT_ENABLED: false,           // If true, reject entries with excessive slippage (dangerous)

    // NFS 2-Close Fallback (for low confidence breaches)
    NFS_2CLOSE_TIMEOUT_MS: 180000,            // 3 minutes max wait for 2nd close
    NFS_2CLOSE_FALLBACK_TO_MARKET: true,      // Market exit if 2nd close not received

    // V5.62: NFS_ADAPTIVE - Uses NFS score to determine trailing exit strategy
    // When true:
    // - HIGH confidence (>=70): Exit at trailing stop price (theoretical/perfect)
    // - MEDIUM confidence (40-69): Exit at candle close with 1-candle confirm
    // - LOW confidence (<40): Exit at candle close with 2-candle confirm
    // Backtest shows +952% ROI improvement vs standard 2-candle confirmation
    NFS_ADAPTIVE_ENABLED: true,               // Enable NFS adaptive trailing in backtest

    // Profit-protection (Exchange, ratcheting)
    // Starts only after sufficient profit to avoid wick/mark noise.
    // Example long:
    // - at +2% PnL → stop @ breakeven (0%)
    // - at +3% PnL → stop @ +1%
    // Keeps an approximate 2% buffer to current price.
    EMERGENCY_PROFIT_LOCK_START_PCT: 2.0,
    EMERGENCY_PROFIT_LOCK_DISTANCE_PCT: 2.0,
    EMERGENCY_PROFIT_LOCK_STEP_PCT: 1.0,

    // Layer 2: Adaptive Trailing Distance (App-Side)
    // Distance varies by volatility regime (detected via ATR)
    ADAPTIVE_TRAILING: true,              // Enable ATR-based distance adjustment
    LOW_VOL_ATR_MAX: 2.0,                 // ATR < 2% = low volatility
    HIGH_VOL_ATR_MIN: 3.5,                // ATR > 3.5% = high volatility

    // Low volatility (ATR < 2%): Tight trailing, early activation
    LOW_VOL_DISTANCE: 0.3,                // Callback 0.3% (tight, safe from noise)
    LOW_VOL_ACTIVATION: 0.6,              // Activate at +0.6%

    // High volatility (ATR > 3.5%): Wide trailing, late activation
    HIGH_VOL_DISTANCE: 0.8,               // Callback 0.8% (avoid noise)
    HIGH_VOL_ACTIVATION: 1.2,             // Activate at +1.2%

    // Smart Exits
    MOMENTUM_FADE_PROFIT_MIN: 1.5,  // Exit si profit > 1.5%...
    MOMENTUM_FADE_ROC_MAX: 0.005,   // ...et ROC5 < 0.5%
    VOLUME_DRY_PROFIT_MIN: 0.5,     // Exit si profit > 0.5%...
    VOLUME_DRY_RATIO: 0.5,          // ...et volume < 0.5x avg

    // V5.29: STAGNANT TRADE EARLY EXIT (aligned with trailing activation)
    // ═══════════════════════════════════════════════════════════════════════════
    // V5.34: OPTIMIZED STAGNANT TRADE - Based on 4943 trades analysis
    // Key insight: DON'T exit when in profit, just tighten SL and let it run!
    // Validated: +501% total PnL vs +383% for V5.31 (+31% improvement)
    // 1. Trigger stagnant at 45min if maxPnl < 0.8%
    // 2. Observe for 60min more (until 105min total)
    // 3. If peak >= 0.6% during observation → big move forming, DON'T cut
    // 4. Else confirm stagnant → tighten SL to 0.8% (don't exit, just protect)
    // ═══════════════════════════════════════════════════════════════════════════
    STAGNANT_TRADE_EXIT_ENABLED: true,     // Enable stagnant trade early exit
    STAGNANT_TRADE_TIME_MINUTES: 60,       // V5.92: Optimized from 45 → 60 (+67% PnL, -6% DD, +1.8% WR)
    STAGNANT_TRADE_OBS_MINUTES: 60,        // V5.34: Shorter observation (45+60=105min)
    STAGNANT_TRADE_MIN_PROFIT_PCT: 0.8,    // Threshold for initial stagnant trigger
    STAGNANT_TRADE_RECOVERY_PCT: 0.6,      // V5.34: Higher recovery threshold
    STAGNANT_TRADE_TIGHTEN_SL_RATIO: 0.5,   // V5.84: Ratio of adaptive SL (e.g. 0.5 × 2.0% = 1.0%)
    STAGNANT_TRADE_EXIT_IF_PROFIT: false,  // V5.34: DON'T exit, let trade continue!
  },

  // Risk V5.18 - Adaptive sizing for capital scalability
  // ⚠️ MATH: Avec SL 2.5% × Lev 5x × Position 40% = 5% du capital total par trade
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,           // 1% du capital par trade
    // V5.18: Adaptive position sizing - scales with capital
    POSITION_SIZE_PCT: 0.4,            // Base: 40% du capital disponible par position
    POSITION_SIZE_PCT_BASE: 0.40,      // 40% for small accounts (<$2k)
    POSITION_SIZE_PCT_BOOST_PER_5K: 0.03, // +3% per $5k capital
    POSITION_SIZE_PCT_MAX: 0.55,       // Cap at 55%
    // V5.18: Dynamic max positions based on capital
    MAX_POSITIONS: 4,                  // Legacy: base max positions
    MAX_POSITIONS_BASE: 2,             // Base for tiny accounts (<$500)
    POSITIONS_PER_1500: 1,             // Add 1 slot per $1.5k capital
    MAX_POSITIONS_CAP: 10,             // Cap at 10 concurrent positions
    // V5.18: Minimum thresholds
    MIN_AVAILABLE_CAPITAL_PCT: 0.02,   // 2% of initial capital minimum
    MIN_AVAILABLE_CAPITAL_FLOOR: 15,   // Absolute floor $15
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // ASSETS V5.6 - Backtest 24 mois (Nov 2023 - Nov 2025) - Tous ROI positifs
  // ═══════════════════════════════════════════════════════════════════════════

  // V5.92: All tested symbols (Jan-Dec 2025, individual backtest)
  SYMBOLS_V5_COMPATIBLE: [
    'IMX/USDT:USDT',   // STRONG: +264%, 70.2% WR, Sharpe 2.74
    'AVAX/USDT:USDT',  // STRONG: +155%, 69.7% WR, Sharpe 2.61
    'SEI/USDT:USDT',   // STRONG: +98%, 61.1% WR, Sharpe 1.61
    'ADA/USDT:USDT',   // STRONG: +92%, 61.1% WR, Sharpe 1.58
    'DOT/USDT:USDT',   // STRONG: +50%, 55.8% WR, Sharpe 1.23
    'DOGE/USDT:USDT',  // STRONG: +33%, 58.1% WR, Sharpe 0.88
    'BTC/USDT:USDT',   // STRONG: +29%, 71.4% WR, Sharpe 1.58
    'APT/USDT:USDT',   // STRONG: +27%, 59.3% WR, Sharpe 0.80
    'OP/USDT:USDT',    // STRONG: +30%, 57.4% WR, Sharpe 0.76
    'SUI/USDT:USDT',   // OK: +33%, 54.5% WR
    'SOL/USDT:USDT',   // OK: +25%, 59.1% WR
    'XRP/USDT:USDT',   // OK: +12%, 58.6% WR
    'NEAR/USDT:USDT',  // OK: +19%, 56.8% WR
    'ATOM/USDT:USDT',  // OK: +16%, 54.0% WR
    'LINK/USDT:USDT',  // OK: +7%, 50.6% WR
  ],

  // V5.93: AVOID — negative or marginal PnL in combined backtests
  SYMBOLS_NOT_COMPATIBLE: [
    'ETH/USDT:USDT',   // MARGINAL: ~0% ROI, 49.4% WR (worse than coin flip)
    'SEI/USDT:USDT',   // NEGATIVE in combined: -$1,160 (positive solo but loses slots to better symbols)
    'ARB/USDT:USDT',   // MARGINAL: -3%, 49.5% WR (negative PnL)
    'FTM/USDT:USDT',   // N/A: only 1 trade in 12 months
    'INJ/USDT:USDT',   // MARGINAL: +0.3% ROI, not worth a slot
    'JUP/USDT:USDT',   // AVOID: -29% ROI, 52.6% WR
    'APT/USDT:USDT',   // NEGATIVE in combined: -$319 (ok solo but loses in competition)
    'OP/USDT:USDT',    // NEGATIVE in combined: -$389 (ok solo but loses in competition)
    'BNB/USDT:USDT',   // Not tested
    'UNI/USDT:USDT',   // Not tested
    'LTC/USDT:USDT',   // Not tested
    'BCH/USDT:USDT',   // Not tested
  ],

  // V5.93: Combined backtest 11 symbols (Jan-Dec 2025, $2000, 4.5x) → +1308% ROI, 61% WR, 29.8% DD
  // Ranked by combined PnL — SEI/APT/OP dropped (negative in combined mode)
  SYMBOLS: [
    'AVAX/USDT:USDT',  // #1 PnL=$4,850, 54 trades, avg=$89.81
    'FET/USDT:USDT',   // #2 PnL=$4,558, 81 trades, avg=$56.28 (NEW - AI narrative)
    'WIF/USDT:USDT',   // #3 PnL=$3,686, 86 trades, avg=$42.86 (NEW - meme momentum)
    'DOT/USDT:USDT',   // #4 PnL=$3,630, 49 trades, avg=$74.07
    'TIA/USDT:USDT',   // #5 PnL=$3,087, 79 trades, avg=$39.07 (NEW - L1 volatile)
    'IMX/USDT:USDT',   // #6 PnL=$2,552, 69 trades, avg=$36.98
    'STX/USDT:USDT',   // #7 PnL=$1,761, 50 trades, avg=$35.23 (NEW - Bitcoin L2)
    'DOGE/USDT:USDT',  // #8 PnL=$1,617, 84 trades, avg=$19.25
    'ADA/USDT:USDT',   // #9 PnL=$1,241, 66 trades, avg=$18.81
    'BTC/USDT:USDT',   // #10 PnL=$339, 25 trades, avg=$13.56
  ],

  // V5.8: Leverage 5x uniforme - Validé sûr (SL max 4.5% × 5 = 22.5% << 80% liquidation)
  // Backtest 24 mois: Gains augmentés, pas de risque de liquidation
  LEVERAGE: {
    'BTC/USDT:USDT': 5,
    'ETH/USDT:USDT': 5,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
    'SEI/USDT:USDT': 5,
    'IMX/USDT:USDT': 5,
    'DOT/USDT:USDT': 5,
    'DOGE/USDT:USDT': 5,
    'SUI/USDT:USDT': 5,
    'ADA/USDT:USDT': 5,
    'LINK/USDT:USDT': 5,
    'AVAX/USDT:USDT': 5,
    'APT/USDT:USDT': 5,
    'OP/USDT:USDT': 5,
    'NEAR/USDT:USDT': 5,
    'FET/USDT:USDT': 5,
    'WIF/USDT:USDT': 5,
    'TIA/USDT:USDT': 5,
    'STX/USDT:USDT': 5,
  } as Record<string, number>,

  // ═══════════════════════════════════════════════════════════════════════════
  // CASH MODE - Choppy / Low-Vol Market Detection
  // When enabled, skips entries in unfavorable market regimes.
  // ═══════════════════════════════════════════════════════════════════════════
  CASH_MODE: {
    ENABLED: true,
    ADX_NO_TREND_THRESHOLD: 20,       // ADX < 20 = no trend
    ATR_DECLINING_LOOKBACK: 5,        // Compare current ATR to N periods ago
    ATR_DECLINING_RATIO: 0.85,        // ATR declining > 15% = volatility drying up
    SMA200_SLOPE_FLAT_PCT: 0.05,      // SMA200 slope near zero = ranging market
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.101: S/R Proximity Filter (inside checkMomentumSignal)
  // Replaces V5.99 DRASH_CONTEXT — filter is now internal to signal detection.
  // No external application needed (backtest, live, parity all automatic).
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.98: SR filter disabled — destroys ROI even with loosened thresholds.
  // Internalized here (V5.101) for future use; toggle ENABLED when ready.
  // DEAD CONFIG — V5.98 disabled, destroys ROI
  SR_FILTER: {
    ENABLED: false,
    FILTER_THRESHOLD: -0.3,
    LOOKBACK_CANDLES: 200,
    PIVOT_LOOKBACK: 5,
    MIN_TOUCHES: 2,
    CLUSTER_PCT: 0.3,
    NEAR_THRESHOLD_PCT: 1.5,
    FAR_THRESHOLD_PCT: 5.0,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.118: CENTRALIZED FEE MODEL — Single source of truth for all cost calculations
  // Used by: backtestService.ts, trailingReplay1m.ts, positionPersistence.ts
  // ═══════════════════════════════════════════════════════════════════════════
  COSTS: {
    TRADING_FEE_PCT: 0.04,       // Binance taker fee (0.04%)
    SLIPPAGE_PCT: 0.05,          // Realistic slippage estimate (0.05%)
    FUNDING_RATE_PCT: 0.01,      // 8h funding rate (0.01%)
    FUNDING_INTERVAL_BARS: 32,   // 32 × 15min = 8h
    PAPER_FEE_RATE: 0.0004,      // Fee rate for paper trades (0.04% as decimal)
  },
};

// Alias pour rétrocompatibilité
export const CONFIG = MomentumConfig;

// ============================================================================
// TYPES
// ============================================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal?: boolean;  // V5.50: Added for accurate candle close detection (from WebSocket)
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  entryTime: number;
  realEntryTime?: number;  // V5.86: Actual entry time for stagnant detection (vs candle timestamp for parity)
  stopLoss?: number;
  appTrailingStop?: number;  // App-side trailing stop (distinct from exchange emergency stop)
  stopLossPct?: number;      // V5.7: Store the SL percentage used (for dynamic SL tracking)
  orderId?: string;
  stopLossOrderId?: string;  // Track SL order ID for updates/cancellation
  trailingOrderId?: string;  // V5.10: Track native TRAILING_STOP_MARKET order ID
  // V5.6: Store leverage and margin for proper capital management
  leverage?: number;         // The leverage used for this position
  marginUsd?: number;        // The margin blocked in capital pool
  // Trailing stop tracking
  highWaterMark?: number;  // Highest price since entry (for long)
  lowWaterMark?: number;   // Lowest price since entry (for short)
  trailingActive?: boolean;
  maxPnlPct?: number;      // V5.11: Track max PnL reached (for exit analysis)
  entryAtrPct?: number;    // V5.118: ATR% at entry time (for ATR-scaled trailing)
  trailingBreachCandles?: number;  // V5.38: Count consecutive candles that breached trailing stop
  // V5.31: Smart Stagnant - observation window state machine
  stagnantState?: {
    triggered: boolean;      // Has 45min passed without trailing activation?
    triggeredAtMinutes?: number;  // V5.38 FIX: holdMinutes when triggered (not timestamp)
    confirmed: boolean;      // Has observation window passed without recovery?
    cancelled: boolean;      // Did we see peak >= recovery threshold during observation?
    obsPeakPct: number;      // Max PnL % observed during observation window
  };
  // Emergency protection (exchange-side)
  emergencyStopPrice?: number;   // Wide emergency stop (catastrophe protection)
  // V5.30: Multi-position support
  positionId?: string;       // Unique ID for this position (for multi-position tracking)
  groupId?: string;          // Group ID for related positions (same signal, staggered entries)
  entryIndex?: number;       // Entry index (0, 1, 2...) for multi-position stagger
}

export interface SignalResult {
  valid: boolean;
  side?: 'long' | 'short';
  reason?: string;
  confidence?: number;
  features?: {
    volRatio: number;
    isBullish: boolean;
    priceAboveMa20: boolean;
    btcAboveMa50: boolean;
    btcMomentum6h: number;
    dayOfWeek: number;
    // V5.3+ additional features
    roc?: number;
    roc5?: number;
    consecUp?: number;
    consecDown?: number;
    btcInBullRegime?: boolean;
    btcInBearRegime?: boolean;
    bbUpper?: number;
    bbLower?: number;
    stochRsi?: number;  // V5.8
  };
}

export interface ExitSignal {
  shouldExit: boolean;
  reason?: 'time' | 'stoploss' | 'trailing' | 'trailing_breach' | 'regime_change' | 'momentum_reversal' | 'stagnant_trade' | 'stagnant_profit_exit' | 'none';
  pnlPct?: number;
  holdMinutes?: number;
  newStopLoss?: number;  // Updated trailing stop
  trailingActivated?: boolean;  // V5.26: Flag to persist trailing activation
  trailingBreached?: boolean;   // V5.38: Flag for 2-close confirmation (breach detected but not confirmed)
  stagnantSlTightened?: boolean;  // V5.28: Flag to indicate SL was tightened due to stagnant trade
  effectiveSlPct?: number;  // V5.28: The effective SL % after tightening
}

// ============================================================================
// MARKET CONDITIONS STATUS
// ============================================================================

export interface MarketConditions {
  isTradingDay: boolean;
  dayOfWeek: number;
  btcTrend: 'bullish' | 'bearish' | 'neutral';
  btcMomentum6h: number;
  btcAboveMa50: boolean;       // V5: Set to btcAboveSma200 for dashboard compatibility
  btcAboveSma200?: boolean;    // V5: Explicit SMA200 regime
  overallStatus: 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable';
  reason: string;
  checkedAt: number;
  // V5.5: Market quality tracking
  marketQuality?: 'momentum' | 'consolidation' | 'unknown' | 'analyzing';
  qualityReason?: string;
}
