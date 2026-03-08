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
 * - Volume > 1.0x moyenne (V5.125: was 2.0x)
 * - Price < MA20
 * - ConsecDown <= 6 (V5.93: was 4)
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
  },

  // Signal d'entrée LONG (Bull Market: BTC > SMA200)
  // V5.13: Lower thresholds for earlier entries (+25% ROI validated on 2024)
  ENTRY_LONG: {
    // Momentum confirmation - V5.13 OPTIMIZED (2024 backtest: +25% ROI vs V5.12)
    ROC_MIN: 0.0175,             // V5.13: ROC 10 > 1.75% (was 2.5%) - Earlier entries
    VOL_MULTIPLIER: 1.5,         // V5.141: 1.5x (was 1.15) — BT sweep: +$1,866 PnL, Sharpe 1.14 (was -$718, 0.07)
    MAX_CONSEC_UP: 5,            // V5.12: 5 (was 3) - +34% PnL
    REQUIRE_BB_BREAKOUT: true,   // V5.125: Require close > BB upper (can be disabled for sweep)
  },

  // Signal d'entrée SHORT (Bear Market: BTC < SMA200)
  // V5.125: Sweep-validated — BB Lower OFF + Vol 1.0x (was 2.0x, BB=true)
  // Backtest 18mo (Jun24-Dec25): Sharpe 3.54→4.33, PnL +$106K, DD 28.6%→27.0%, WR 66.2%→66.0%
  // OOS (ADA/DOT/STX/TIA): PnL +$31K, WR 63.2%. BB Lower was mean-reversion in momentum strat.
  ENTRY_SHORT: {
    ROC_DROP_MIN: -0.015,        // ROC 5 < -1.5% (unchanged)
    VOL_SPIKE: 1.0,              // V5.125: Volume > 1.0x (was 2.0x) — captures breakouts earlier
    PRICE_BELOW_MA20: true,      // Prix < MA20
    MAX_CONSEC_DOWN: 6,          // V5.93: Max 6 (was 4)
  },

  // V5.140: RANGE POSITION FILTER — reject entries in the "death zone" of the recent range
  // Enabled permanently with V5.140 realistic BT pricing (NFS HIGH → candle.close).
  // Validated OOS: H1 +322% PnL, H2 +597% PnL (OOS stronger than IS = structural).
  // L/W ratio 2.3 full year, 3.2 OOS — removes 2-3x more losers than winners.
  // Mid 40-80% of 20-candle range = 28-33% WR (death zone). Extremes = 65-69% WR.
  // WHY: breakout strategy MUST enter at range extremes (breakout imminent), not mid-range (indecision).
  // Per-symbol: ALL 9 symbols improved. Works for both LONG (L/W 2.0) and SHORT (L/W 2.7).
  RANGE_POSITION_FILTER: {
    ENABLED: true,               // V5.140: ON — validated with realistic exit pricing
    DEATH_ZONE_LOW: 0.40,       // Reject if range position >= 40%
    DEATH_ZONE_HIGH: 0.80,      // Reject if range position < 80%
    LOOKBACK_CANDLES: 20,       // Swing range lookback (20 × 15m = 5h)
  },

  // V5.141: ENTRY QUALITY FILTERS — additional signal quality checks
  // Body ratio rejects doji/indecision candles; ADX rising requires trend strengthening
  ENTRY_QUALITY: {
    // Body ratio: reject doji candles (body < X% of total range)
    BODY_RATIO_ENABLED: false,         // V5.141: OFF by default
    BODY_RATIO_MIN: 0.5,              // Minimum body/range ratio (0.5 = 50%)

    // ADX rising: require ADX to be increasing (trend strengthening)
    ADX_RISING_ENABLED: true,          // V5.141: ON — BT: SL trades -36%, stagnant -37%, Sharpe 0.07→1.14
    ADX_RISING_LOOKBACK: 3,           // Compare ADX now vs N candles ago

    // V5.145: ADX minimum for SHORT — require minimum trend strength before shorting
    // Sweep: ADX_MIN=15 removes 22 weak SHORT trades → +$985 PnL, -5.5pp DD, +0.26 Sharpe
    // Walk-forward: PARTIAL (H2 great, H1 marginal) — but baseline SHORT is already -$63 in H1
    ADX_MIN_SHORT: 15,                // V5.145: Minimum ADX(14) for SHORT entries (was 0)

    // V5.145: Wick rejection filter for SHORT — skip if lower wick signals buying pressure
    // If lower_wick / range > threshold → skip (potential reversal bounce)
    // Combo ADX15+WICK60: $4,547 PnL (+$2,681), Sharpe 1.72 (+0.57), DD 38.7% (-7.4pp)
    // SHORT PnL: $502 → $2,593 (+$2,091). Walk-forward: H2 dominant, H1 marginal.
    WICK_REJECTION_SHORT_ENABLED: true,  // V5.145: ON
    WICK_REJECTION_SHORT_THRESHOLD: 0.6, // V5.145: Lower wick > 60% of range = rejection (was 0.4)

    // V5.146: Consecutive red BTC candles before SHORT — require confirmed downtrend
    // Analysis: consecRed=0 → 45% WR, -$6,472. consecRed≥4 → 84% WR, +$6,578.
    // Shorting without prior red candles = shorting into bounces.
    SHORT_MIN_CONSEC_RED: 0,           // V5.146: Min consecutive red BTC candles (0 = disabled)

    // V5.146: BTC 24h price change filter for SHORT — skip if BTC already crashed too much
    // Analysis: BTC Δ24h < -5% → 35% WR on shorts (exhausted move, violent bounces)
    // Skipping these = +$2,675 PnL (63 trades removed, 41 losers vs 22 winners)
    SHORT_BTC_DROP_24H_MAX: -5,        // V5.146: Skip SHORT when BTC dropped >5% in 24h (exhausted move, violent bounces)
    SHORT_BTC_DROP_24H_TOLERANCE: 1.0, // V5.147: Tolerance buffer for WS/REST candle variance (effective threshold = MAX - TOLERANCE = -6%)
    // Sweep: $5,119→$9,782 PnL (+91%), DD 42.4%→36.0% (-6.4pp), Sharpe 1.81→2.39
    // Walk-forward: H1 +$377 (Sharpe 1.01→1.30), H2 +$2,343 (Sharpe 2.73→3.57, DD 37.5%→22.7%)

    // V5.144: ROC Acceleration filter — require momentum to be INCREASING (not just positive)
    // ROC1 current vs ROC1 previous: if current > prev = accelerating = REAL breakout
    // Post-hoc Cohen's d = 0.698. HIGH ROC accel: 91.7% WR, LOW: 54% WR.
    // MUST validate with real BT (post-hoc overstates — V5.143 lesson).
    ROC_ACCEL_ENABLED: false,           // Default OFF — sweep first

    // V5.144: RSI Divergence filter — reject signals with bearish/bullish divergence
    // LONG: price Higher High but RSI(14) Lower High = exhausted momentum
    // SHORT: price Lower Low but RSI(14) Higher Low = exhausted selling
    // Post-hoc Cohen's d = 0.312. No divergence: 64.2% WR, Divergence: 42.7% WR.
    RSI_DIVERGENCE_ENABLED: false,      // Default OFF — sweep first
    RSI_DIVERGENCE_LOOKBACK: 10,        // Candles to look back for divergence comparison
    RSI_DIVERGENCE_BUFFER: 2,           // RSI points buffer to avoid noise
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
    VOL_MULTIPLIER: 1.5,         // V5.141: 1.5x (was 1.15x) — aligned with ENTRY_LONG
    MAX_CONSEC_UP: 5,            // V5.12: 5

    // BTC Regime Filter
    BTC_SMA_PERIOD: 200,         // SMA 200 (on 15m = 50h = ~2 days — fast regime for momentum breakout)
    BTC_REGIME_TIMEFRAME: '15m' as const,  // V5.102: Use 15m for regime SMA200 (validated: +2325% ROI, +0.19 Sharpe on 9 symbols)
    BTC_REGIME_TOLERANCE_PCT: 0.2, // V5.113: Dead zone ±0.2% around SMA200 — when price is in band, use SMA slope to determine regime (prevents whipsaw). Validated: +$4.4K PnL, -2.7pp DD, +0.09 Sharpe
    BTC_SMA200_SKIP_ZONE_PCT: 1.0,  // V5.129: Skip entries when BTC is within X% of SMA200. Data: -17.8pp DD, +0.19 Sharpe, -9% PnL. Sweet spot validated on 2025 full year.
    BTC_SMA200_SKIP_ZONE_QUALITY_BYPASS: 0, // V5.129: Quality score threshold to bypass skip zone (0 = no bypass). Composite from volRatio+ROC10+ROC5+BTC_ADX+SMA_slope.
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
    TIER2_SYMBOLS: ['SOL', 'SEI', 'DOGE', 'AVAX', 'XRP', 'LINK', 'ADA', 'ATOM', 'DOT', 'ARB', 'NEAR', 'SUI', 'APT', 'STX', 'TIA', 'UNI', 'SONIC', 'BCH'],
    TIER2_SL_LOW_VOL_PCT: 2.0,       // Low vol: 2.0% (was 1.5% - too tight!)
    TIER2_SL_MED_VOL_PCT: 2.5,       // Med vol: 2.5%
    TIER2_SL_HIGH_VOL_PCT: 3.0,      // High vol: 3.0%

    // TIER 3: High volatility alts (P90 > 1.2%)
    TIER3_SYMBOLS: ['IMX', 'OP', 'FTM', 'FET', 'WIF', 'RENDER'],
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
    BREAKEVEN_TRIGGER_PCT: 0.7,       // V5.145: Move SL to breakeven when +0.7% profit reached (was 1.0%, sweep showed +$338/+0.09 Sharpe, walk-forward stable)
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
    EXHAUSTION_PLACEMENT_THRESHOLD: 25,       // V5.136: Lowered from 35 for earlier proactive STOP placement
    EXHAUSTION_CANCEL_THRESHOLD: 15,          // V5.136: Lowered from 20 (10pt hysteresis gap)
    EXHAUSTION_MIN_CANDLES: 10,               // Min candles needed for reliable calculation
    EXHAUSTION_SHARP_REVERSAL_ENABLED: true,   // V5.136: Enabled — BT shows +$1K PnL, -3pp DD, +18 proactive exits vs OFF
    PRE_BREACH_DISTANCE_PCT: 1.5,             // V5.136: Widened from 0.6% for earlier exhaustion detection zone
    // V5.136: Crash safety STOP — permanent STOP_MARKET 3% below trailing as flash crash insurance
    CRASH_SAFETY_STOP_ENABLED: true,
    CRASH_SAFETY_DISTANCE_PCT: 3.0,           // Distance below trailing stop (3% = ~0 false exits based on 1m data)
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

  // V5.130: All 26 symbols tested individually (Jan-Dec 2025, $2000, 5x)
  // Tier A = Sharpe>=2, PF>=1.3 | Tier B = Sharpe>=1, PF>=1.1 | Tier C = Marginal | X = Negative
  SYMBOLS_V5_COMPATIBLE: [
    // TIER A (9 symbols) — $73,730 combined individual PnL
    'WIF/USDT:USDT',    // A: $28,969, 71.5% WR, Sharpe 4.40, PF 2.15
    'UNI/USDT:USDT',    // A: $8,275, 62.8% WR, Sharpe 2.69, PF 1.40
    'FET/USDT:USDT',    // A: $7,727, 63.0% WR, Sharpe 2.58, PF 1.44
    'STX/USDT:USDT',    // A: $7,674, 66.2% WR, Sharpe 3.06, PF 1.86
    'IMX/USDT:USDT',    // A: $6,374, 67.5% WR, Sharpe 2.40, PF 1.47
    'ARB/USDT:USDT',    // A: $4,077, 62.1% WR, Sharpe 2.08, PF 1.34
    'SEI/USDT:USDT',    // A: $3,675, 59.3% WR, Sharpe 2.16, PF 1.34
    'SUI/USDT:USDT',    // A: $3,504, 64.0% WR, Sharpe 2.08, PF 1.43
    'NEAR/USDT:USDT',   // A: $3,456, 61.1% WR, Sharpe 2.03, PF 1.31
    // TIER B (10 symbols) — $19,717 combined individual PnL
    'ADA/USDT:USDT',    // B: $3,220, 59.5% WR, Sharpe 1.69, PF 1.34
    'APT/USDT:USDT',    // B: $2,615, 59.3% WR, Sharpe 1.79, PF 1.25
    'ETH/USDT:USDT',    // B: $2,503, 56.7% WR, Sharpe 1.99, PF 1.39
    'SONIC/USDT:USDT',  // B: $2,321, 60.7% WR, Sharpe 1.56, PF 1.28
    'RENDER/USDT:USDT', // B: $1,997, 58.6% WR, Sharpe 1.58, PF 1.22
    'XRP/USDT:USDT',    // B: $1,575, 61.3% WR, Sharpe 1.35, PF 1.29
    'DOGE/USDT:USDT',   // B: $1,508, 59.6% WR, Sharpe 1.29, PF 1.20
    'DOT/USDT:USDT',    // B: $1,491, 59.9% WR, Sharpe 1.38, PF 1.28
    'BCH/USDT:USDT',    // B: $1,276, 62.5% WR, Sharpe 1.47, PF 1.29
    'SOL/USDT:USDT',    // B: $1,212, 61.7% WR, Sharpe 1.19, PF 1.19
  ],

  // V5.132: NOT COMPATIBLE — marginal or negative in combined multi-symbol backtest
  // NOTE: V5.132 optimal 9 (AVAX, FET, WIF, DOT, IMX, STX, ADA, RENDER, XRP) must NOT be in this list
  SYMBOLS_NOT_COMPATIBLE: [
    'SEI/USDT:USDT',   // Negative in combined BT (good solo, loses signal competition)
    'SUI/USDT:USDT',   // Marginal in combined BT
    'SONIC/USDT:USDT', // <$1000 in combined BT
    'DOGE/USDT:USDT',  // <$1000 in combined BT
    'BCH/USDT:USDT',   // <$1000 in combined BT
    'SOL/USDT:USDT',   // <$1000 in combined BT
    'LTC/USDT:USDT',   // Negative full year
    'FTM/USDT:USDT',   // Rebranded to SONIC, 5 trades
    'OP/USDT:USDT',    // Marginal
    'LINK/USDT:USDT',  // Marginal
    'TIA/USDT:USDT',   // Marginal
    'ATOM/USDT:USDT',  // Negative
    'BTC/USDT:USDT',   // Too few trades
    'INJ/USDT:USDT',   // Not tested
    'JUP/USDT:USDT',   // Not tested
    'BNB/USDT:USDT',   // Not tested
  ],

  // V5.132: Signal tier classification for ranking priority
  // Tier A = top combined-backtest PnL contributors (>$5K in combined BT)
  SIGNAL_TIER_A: [
    'WIF/USDT:USDT', 'AVAX/USDT:USDT', 'FET/USDT:USDT', 'ADA/USDT:USDT',
    'STX/USDT:USDT',
  ] as string[],

  // V5.132: 9 symbols — validated via COMBINED multi-symbol backtest (2025, $2K, 5x)
  // Combined BT: $86,524 PnL, 65.9% WR, 33.2% DD, Sharpe 3.53
  // Beats V5.131 baseline ($59,018) by +47%. AVAX, ADA, IMX added back; UNI, ARB, NEAR, APT, ETH removed.
  SYMBOLS: [
    'AVAX/USDT:USDT',   // $15,725 combined — Tier A
    'FET/USDT:USDT',    // $14,058 combined — Tier A
    'WIF/USDT:USDT',    // $17,122 combined — Tier A
    'DOT/USDT:USDT',    // $5,170 combined — Tier B
    'IMX/USDT:USDT',    // $3,910 combined — Tier B
    'STX/USDT:USDT',    // $10,145 combined — Tier A
    'ADA/USDT:USDT',    // $10,502 combined — Tier A
    'RENDER/USDT:USDT', // $4,179 combined — Tier B
    'XRP/USDT:USDT',    // $5,713 combined — Tier B
  ],

  // V5.8: Leverage 5x uniforme - Validé sûr (SL max 4.5% × 5 = 22.5% << 80% liquidation)
  // Backtest 24 mois: Gains augmentés, pas de risque de liquidation
  // V5.132: Leverage 5x for all active symbols
  LEVERAGE: {
    'BTC/USDT:USDT': 5,
    'AVAX/USDT:USDT': 5,
    'FET/USDT:USDT': 5,
    'WIF/USDT:USDT': 5,
    'DOT/USDT:USDT': 5,
    'IMX/USDT:USDT': 5,
    'STX/USDT:USDT': 5,
    'ADA/USDT:USDT': 5,
    'RENDER/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
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
    roc1?: number;      // V5.33: Current candle momentum (ROC 1-period %)
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
