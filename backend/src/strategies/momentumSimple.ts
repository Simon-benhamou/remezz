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
    MIN_ROC5_BULL: 0.015,             // (unused)
    MIN_ROC5_BEAR: -0.015,            // (unused)
  },
  
  // Signal d'entrée LONG (Bull Market: BTC > SMA200)
  // V5.13: Lower thresholds for earlier entries (+25% ROI validated on 2024)
  ENTRY_LONG: {
    // Bollinger Bands
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
    MAX_CONSEC_DOWN: 4,          // V5.8.1: Max 4 (was 5) - +13% ROI
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
    BTC_SMA_PERIOD: 200,         // SMA 200 pour régime (on 1h = 200h = ~8 days)
    BTC_REGIME_TIMEFRAME: '1h' as const,  // V5.82: Use 1h for regime SMA200 (more stable, less noise)
    BTC_MOMENTUM_MIN: 0,         // Désactivé (utilise SMA200 à la place)
    BTC_MOMENTUM_PERIOD: 24,     // Gardé pour compatibilité
    
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],  // All days
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
    TIMEFRAME: '1h',                  // Use 1h candles for higher timeframe
    MIN_BTC_ROC_LONG: 0.0,            // LONG: Require BTC 1h ROC > 0% (bullish)
    MAX_BTC_ROC_SHORT: 0.0,           // SHORT: Require BTC 1h ROC < 0% (bearish)
    LOOKBACK_CANDLES: 10,             // Calculate ROC over 10 candles (10 hours)
    CACHE_1H_CANDLES: true,           // Cache 1h candles to reduce API calls
    CACHE_REFRESH_MINUTES: 15,        // Refresh cache every 15 minutes
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

    // V5.81: Dynamic SL by volatility regime
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
    TRAILING_ACTIVATION_PCT: 0.8,       // Activate trailing at +0.8% profit
    TRAILING_DISTANCE_PCT: 0.5,         // Initial callback: 0.5% (tight protection)
    TRAILING_WIDEN_AT_PCT: 3.0,         // V5.35: Widen at 3% (was 2%) - tighter on medium winners
    TRAILING_WIDE_DISTANCE_PCT: 0.8,    // Widened callback: 0.8% (let big winner run)
    
    // Protection setup
    // - Emergency stop is placed on exchange (wide, crash protection)
    // - Trailing exit is managed app-side (do NOT move exchange SL above entry)
    USE_EXCHANGE_TRAILING: false,         // App-side trailing is default

    // Emergency Stop Loss (Exchange)
    EMERGENCY_STOP_MULTIPLIER: 2.5,       // Emergency SL = dynamic SL × multiplier, capped
    EMERGENCY_STOP_MAX_PCT: 2.5,          // V5.81: Aligned with logical SL (was 3.0%, now 2.5%)
                                          // Parity data shows live loses 2-4% more on SL hits because
                                          // exchange SL was 3% while backtest exits at exactly 2.5%
                                          // Example: ATR SL 2% → Emergency 5%
                                          // Example: ATR SL 3% → Emergency 7.5%

    // Realtime App-Side Exit (WebSocket)
    // Goal: react faster than 15m candle close while filtering micro-noise.
    // This does NOT move the exchange emergency STOP_MARKET; it only decides when to close.
    // V5.37: DISABLED to match backtest behavior - let winners run on 15m candle logic
    // The exchange emergency SL still protects against flash crashes
    REALTIME_APP_EXIT_ENABLED: false,
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
    NFS_ENABLED: true,                        // Master switch for NFS system
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
    STAGNANT_TRADE_TIME_MINUTES: 45,       // V5.34: Faster check at 45 minutes
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
  
  // ✅ TOP PERFORMERS (ROI >200% sur 24 mois)
  SYMBOLS_V5_COMPATIBLE: [
    'DOGE/USDT:USDT',  // 🏆 #1: +438% ROI, 65.5% WR
    'IMX/USDT:USDT',   // 🏆 #2: +344% ROI, 67.9% WR
    'SEI/USDT:USDT',   // 🏆 #3: +280% ROI, 65.8% WR
    'SUI/USDT:USDT',   // 🏆 #4: +266% ROI, 65.4% WR
    'XRP/USDT:USDT',   // ✅ +185% ROI, 65.0% WR
    'ETH/USDT:USDT',   // ✅ +173% ROI, 67.8% WR
    'ADA/USDT:USDT',   // ✅ +173% ROI, 65.8% WR
    'DOT/USDT:USDT',   // ✅ +173% ROI, 64.8% WR
    'LINK/USDT:USDT',  // ✅ +143% ROI, 65.9% WR
    'AVAX/USDT:USDT',  // ✅ +118% ROI, 66.1% WR
    'SOL/USDT:USDT',   // ✅ +111% ROI, 65.5% WR
    'BTC/USDT:USDT',   // ⚡ +65% ROI, 69.9% WR (plus stable)
  ],
  
  // ❌ NON TESTÉS (pas de données 24 mois)
  SYMBOLS_NOT_COMPATIBLE: [
    'BNB/USDT:USDT',   // Non testé
    'ATOM/USDT:USDT',  // Non testé
    'UNI/USDT:USDT',   // Non testé
    'LTC/USDT:USDT',   // Non testé
    'BCH/USDT:USDT',   // Non testé
  ],
  
  // Default: TOP 6 performers pour les nouveaux agents
  SYMBOLS: [
    'DOGE/USDT:USDT',  // 🏆 #1
    'IMX/USDT:USDT',   // 🏆 #2
    'SEI/USDT:USDT',   // 🏆 #3
    'SUI/USDT:USDT',   // 🏆 #4
    'XRP/USDT:USDT',   // #5
    'ETH/USDT:USDT',   // #6
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
  } as Record<string, number>,
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

/**
 * Get current market conditions status V5
 * V5.82: Uses BTC 1h SMA200 for regime (more stable than 15m)
 */
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
// INDICATEURS - V5.41: Exported for shared use across backtest and live
// ============================================================================

export function calcMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calcSMA(values: number[], period: number): number {
  return calcMA(values, period);
}

export function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

// Bollinger Bands - V5.41: Unified function (alias for calcBB)
export function calcBollingerBands(closes: number[], period: number = 20, stdMultiplier: number = 2): { upper: number; middle: number; lower: number } {
  if (closes.length < period) {
    const last = closes[closes.length - 1] || 0;
    return { upper: last, middle: last, lower: last };
  }
  
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  
  return {
    upper: middle + std * stdMultiplier,
    middle,
    lower: middle - std * stdMultiplier,
  };
}

// V5.41: Alias for backwards compatibility with backtest (uses calcBB name)
export function calcBB(closes: number[], period = 20, mult = 2): { upper: number; middle: number; lower: number } {
  return calcBollingerBands(closes, period, mult);
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.41: SHARED COOLDOWN LOGIC - Single source of truth
// Used by both backtest and live agent after position exit
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get cooldown bars based on exit reason
 * - Profitable exits (TRAILING) = short cooldown (momentum continues)
 * - Loss exits (STOP_LOSS) = longer cooldown (bad signal)
 * - Regime/Momentum change = medium/long cooldown (wait for confirmation)
 * 
 * @param exitReason - The exit reason string (case insensitive)
 * @param defaultCooldown - Default cooldown in bars (default 8 = 2h)
 * @returns Number of 15m bars to wait before next entry
 */
export function getCooldownBars(exitReason: string, defaultCooldown: number = 8): number {
  const reason = exitReason.toLowerCase();
  
  if (reason.includes('trailing') || reason.includes('trail') || reason === 'take_profit' || reason === 'tp') {
    return 2; // 30 minutes - profitable exit, quick re-entry allowed
  } else if (reason.includes('stop') || reason.includes('sl') || reason === 'stoploss') {
    return 10; // 2h30 - stop loss, extended wait
  } else if (reason.includes('stagnant')) {
    return 8; // 2h - stagnant trade (tightened SL hit)
  } else if (reason.includes('momentum')) {
    return 8; // 2h - momentum reversal
  } else if (reason.includes('regime')) {
    return 12; // 3h - regime change, wait for confirmation
  } else if (reason.includes('time') || reason === 'max_hold') {
    return 4; // 1h - max hold time reached
  }
  
  return defaultCooldown;
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.32: BB SQUEEZE DETECTION - Identify volatility compression
// When bandwidth is contracting, a big move is coming (works 70%+ of the time)
// ═══════════════════════════════════════════════════════════════════════════

interface BBSqueezeResult {
  isSqueeze: boolean;        // Is there a squeeze? (bandwidth contracting)
  currentBW: number;         // Current bandwidth %
  avgBW: number;             // Average bandwidth over lookback period
  squeezeRatio: number;      // currentBW / avgBW (< 1 = squeezing)
}

/**
 * Detect BB Squeeze - volatility compression before explosive moves
 * @param closes - Array of closing prices
 * @param period - BB period (default 20)
 * @param lookback - How many candles to compare (default 10)
 * @param threshold - Squeeze threshold (default 0.7 = 70%)
 */
function detectBBSqueeze(
  closes: number[], 
  period: number = 20, 
  lookback: number = 10,
  threshold: number = 0.7
): BBSqueezeResult {
  if (closes.length < period + lookback) {
    return { isSqueeze: false, currentBW: 0, avgBW: 0, squeezeRatio: 1 };
  }
  
  // Calculate current bandwidth
  const currentBB = calcBollingerBands(closes, period);
  const currentBW = (currentBB.upper - currentBB.lower) / currentBB.middle;
  
  // Calculate average bandwidth over lookback period
  const bandwidths: number[] = [];
  for (let i = lookback; i >= 1; i--) {
    const pastCloses = closes.slice(0, -i);
    if (pastCloses.length >= period) {
      const pastBB = calcBollingerBands(pastCloses, period);
      const pastBW = (pastBB.upper - pastBB.lower) / pastBB.middle;
      bandwidths.push(pastBW);
    }
  }
  
  if (bandwidths.length === 0) {
    return { isSqueeze: false, currentBW, avgBW: currentBW, squeezeRatio: 1 };
  }
  
  const avgBW = bandwidths.reduce((a, b) => a + b, 0) / bandwidths.length;
  const squeezeRatio = avgBW > 0 ? currentBW / avgBW : 1;
  
  return {
    isSqueeze: squeezeRatio < threshold,
    currentBW,
    avgBW,
    squeezeRatio,
  };
}

/**
 * Detect Volume Accumulation - rising volume pattern before spike
 * @param volumes - Array of volume values
 * @param lookback - How many candles to check (default 3)
 * @param minTrend - Minimum trend multiplier (default 1.05 = 5% increase)
 * @param minRatio - Minimum absolute volume ratio vs avg (default 0.8)
 */
function detectVolumeAccumulation(
  volumes: number[],
  lookback: number = 3,
  minTrend: number = 1.05,
  minRatio: number = 0.8
): { isAccumulating: boolean; trendScore: number; avgRatio: number } {
  if (volumes.length < lookback + 10) {
    return { isAccumulating: false, trendScore: 0, avgRatio: 0 };
  }
  
  // Get recent volumes
  const recentVols = volumes.slice(-lookback);
  
  // Calculate average volume (excluding recent)
  const avgSlice = volumes.slice(-20, -lookback);
  const avgVol = avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length;
  
  // Check if each candle has more volume than the previous
  let trendCount = 0;
  for (let i = 1; i < recentVols.length; i++) {
    if (recentVols[i] >= recentVols[i - 1] * minTrend) {
      trendCount++;
    }
  }
  const trendScore = trendCount / (lookback - 1);
  
  // Check absolute volume level
  const recentAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const avgRatio = avgVol > 0 ? recentAvg / avgVol : 0;
  
  return {
    isAccumulating: trendScore >= 0.5 && avgRatio >= minRatio,
    trendScore,
    avgRatio,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.36: PATTERN FILTER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V5.36 PATTERN 1: Multi-Timeframe Confluence Filter
 * Checks if BTC higher timeframe (1h) trend aligns with signal direction
 *
 * @param btcCandles1h - BTC 1h candles (at least 11 candles needed)
 * @param side - Trade direction (LONG or SHORT)
 * @returns true if MTF aligned, false if divergent
 */
export function checkMTFAlignment(
  btcCandles1h: any[],
  side: 'LONG' | 'SHORT'
): boolean {
  const config = MomentumConfig.MULTI_TIMEFRAME_FILTER;

  if (!config.ENABLED) {
    return true; // Pass-through if disabled
  }

  if (!btcCandles1h || btcCandles1h.length < config.LOOKBACK_CANDLES + 1) {
    // Not enough data - fail safe: allow trade (log warning in production)
    return true;
  }

  // Calculate BTC 1h ROC
  const closes = btcCandles1h.map((c: any) => c.close);
  const btcRoc1h = calcROC(closes, config.LOOKBACK_CANDLES);

  // Check alignment
  if (side === 'LONG') {
    // LONG requires BTC 1h trend to be bullish (ROC > threshold)
    return btcRoc1h > config.MIN_BTC_ROC_LONG;
  } else if (side === 'SHORT') {
    // SHORT requires BTC 1h trend to be bearish (ROC < threshold)
    return btcRoc1h < config.MAX_BTC_ROC_SHORT;
  }

  return false;
}

/**
 * V5.36 PATTERN 2: BTC Volatility Filter
 * Checks if BTC has sufficient volatility for trending moves
 * Low volatility = choppy/ranging = stagnant trades
 *
 * @param btcCandles - BTC candles (15m timeframe)
 * @returns true if volatility sufficient, false if too low
 */
export function checkBTCVolatility(btcCandles: any[]): boolean {
  const config = MomentumConfig.BTC_VOLATILITY_FILTER;

  if (!config.ENABLED) {
    return true; // Pass-through if disabled
  }

  if (!btcCandles || btcCandles.length < config.ATR_PERIOD + 1) {
    // Not enough data - fail safe: allow trade
    return true;
  }

  // Calculate BTC ATR (returns absolute value in $)
  const btcATR = calcATR(btcCandles, config.ATR_PERIOD);

  // Handle null case (fail safe: allow trade)
  if (btcATR === null || btcATR === undefined) {
    return true;
  }

  // V5.39 FIX: Convert ATR to percentage for comparison with MIN_ATR_PCT
  // calcATR returns absolute value (e.g., $450 for BTC)
  // MIN_ATR_PCT is in % (e.g., 1.5%)
  // Without this fix, the filter ALWAYS passed because $450 >> 1.5!
  const btcPrice = btcCandles[btcCandles.length - 1].close;
  const btcATRPct = btcPrice > 0 ? (btcATR / btcPrice) * 100 : 0;

  // Check if volatility meets minimum threshold
  return btcATRPct >= config.MIN_ATR_PCT;
}

// Rate of Change (ROC) - V5.41: Exported for shared use
export function calcROC(closes: number[], period: number = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0;
}

// Count consecutive up candles - V5.41: Exported for shared use
export function countConsecUp(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// Count consecutive down candles (for SHORT) - V5.41: Exported for shared use
export function countConsecDown(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ============================================================================
// V5.78: CANDLE PATTERN QUALITY HELPER FUNCTIONS
// ============================================================================

/**
 * Green Ratio: proportion of bullish candles in the last N candles.
 * Used to detect overbought candle patterns before LONG entries.
 */
export function calcGreenRatio(candles: Candle[], lookback: number): number {
  const window = candles.slice(-lookback);
  if (window.length === 0) return 0.5;
  return window.filter(c => c.close > c.open).length / window.length;
}

/**
 * Alternation rate: count direction changes in the last 5 candles.
 * 0 = fully trending (all same direction), 4 = maximum chop (alternating every candle).
 */
export function calcAlternation5(candles: Candle[]): number {
  const tail = candles.slice(-5);
  if (tail.length < 2) return 0;
  const dirs = tail.map(c => c.close > c.open);
  let alt = 0;
  for (let i = 1; i < dirs.length; i++) {
    if (dirs[i] !== dirs[i - 1]) alt++;
  }
  return alt;
}

/**
 * Count how many of the last N candles touched or breached a BB band.
 * A "touch" = high >= upper * (1 - threshold) OR low <= lower * (1 + threshold).
 */
export function calcBBTouchCount(
  candles: Candle[],
  lookback: number,
  bbPeriod: number,
  threshold: number
): number {
  const n = candles.length;
  if (n < bbPeriod + lookback) return 0;
  let touches = 0;
  for (let i = n - lookback; i < n; i++) {
    const slice = candles.slice(Math.max(0, i - bbPeriod + 1), i + 1).map(c => c.close);
    if (slice.length < bbPeriod) continue;
    const bb = calcBB(slice, bbPeriod);
    if (candles[i].high >= bb.upper * (1 - threshold) || candles[i].low <= bb.lower * (1 + threshold)) {
      touches++;
    }
  }
  return touches;
}

/**
 * ROC Acceleration: difference between recent ROC and previous ROC.
 * Positive = momentum accelerating upward, negative = accelerating downward.
 */
export function calcRocAcceleration(closes: number[], fastPeriod: number): number {
  const n = closes.length;
  if (n < fastPeriod * 2 + 1) return 0;
  const rocNow = ((closes[n - 1] - closes[n - 1 - fastPeriod]) / closes[n - 1 - fastPeriod]) * 100;
  const rocPrev = ((closes[n - 1 - fastPeriod] - closes[n - 1 - fastPeriod * 2]) / closes[n - 1 - fastPeriod * 2]) * 100;
  return rocNow - rocPrev;
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

    // ✅ ALL LONG CONDITIONS MET (V5.78: with pattern quality filters)
    const confidence = Math.min(1, (volRatio / 3) * 0.3 + (roc10 / 0.04) * 0.3 + (distanceFromUpper * 50) * 0.2 + 0.2);
    return {
      valid: true,
      side: 'long',
      reason: `v5.78_bull_long_confirmed|mtf_aligned|btc_vol_ok|pattern_ok|dist=${(distanceFromUpper*100).toFixed(2)}%`,
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
    if (stochRsi !== null && stochRsi < 15 && volRatio < 4.0) {
      return { 
        valid: false, 
        reason: `v5.9_stochrsi_filter(stochRsi=${stochRsi.toFixed(1)}<15 AND volRatio=${volRatio.toFixed(1)}<4)`, 
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

    // ✅ ALL SHORT CONDITIONS MET (V5.78: with pattern quality filters)
    const confidence = Math.min(1, (volRatio / 4) * 0.3 + (Math.abs(roc5) / 0.04) * 0.3 + (distanceFromLower * 50) * 0.2 + 0.2);
    return {
      valid: true,
      side: 'short',
      reason: `v5.78_bear_short_confirmed|mtf_aligned|btc_vol_ok|pattern_ok|dist=${(distanceFromLower*100).toFixed(2)}%`,
      confidence,
      features
    };
  }
  
  // Neither bull nor bear (shouldn't happen but safety)
  return { valid: false, reason: 'regime_neutral', features };
}

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
    btcCandles1h?: Candle[];  // V5.82: BTC 1h candles for regime SMA200
  }
): ExitSignal {
  const now = opts?.nowMs ?? Date.now();
  const holdMinutes = (now - position.entryTime) / 60000;
  
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
    const btcCandles1hExit = opts.btcCandles1h;
    if (btcCandles1hExit && btcCandles1hExit.length >= MomentumConfig.ENTRY.BTC_SMA_PERIOD) {
      const btcCloses1h = btcCandles1hExit.map(c => c.close);
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
          if (btcRoc5 < MomentumConfig.REGIME_CHANGE_EXIT.MIN_ROC5_BULL) {
            confirmed = false; // Not enough bullish momentum
          }
        } else {
          // Flipped to bear - require bearish momentum
          if (btcRoc5 > MomentumConfig.REGIME_CHANGE_EXIT.MIN_ROC5_BEAR) {
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
    // Step 1: Check if initial stagnant trigger (at 45min, no trailing, low maxPnl)
    if (stagnantEnabled && 
        !position.stagnantState.triggered && 
        holdMinutes >= stagnantTimeMinutes &&
        (position.maxPnlPct ?? 0) < stagnantMinProfitPct) {
      position.stagnantState.triggered = true;
      position.stagnantState.triggeredAtMinutes = holdMinutes;  // V5.38 FIX: Use minutes like backtest
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
      
      // V5.38 FIX: End of observation window = triggered time + obsMinutes
      // Use holdMinutes-based approach like backtest for consistency
      // Store triggeredAtMinutes when triggered, then check if obsElapsed >= obsMinutes
      const triggeredAtMinutes = position.stagnantState.triggeredAtMinutes ?? stagnantTimeMinutes;
      const obsElapsedMinutes = holdMinutes - triggeredAtMinutes;
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

  // V5.81: Dynamic SL based on volatility regime
  let baseSlPct: number;
  if (MomentumConfig.EXIT.STOP_LOSS_TYPE === 'dynamic') {
    if (volatilityRegime.regime === 'LOW') {
      baseSlPct = (MomentumConfig.EXIT as any).DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
    } else if (volatilityRegime.regime === 'HIGH') {
      baseSlPct = (MomentumConfig.EXIT as any).DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
    } else {
      baseSlPct = (MomentumConfig.EXIT as any).DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
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
    // Then widen to WIDE_DISTANCE if hwmPct >= 3%
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
    
    if (hwmPct >= MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT) {
      trailingDistance = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT;
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

/**
 * V5.14: Determine volatility regime and adaptive trailing parameters
 * 
 * Returns trailing configuration adapted to current market volatility:
 * - LOW volatility (ATR < 2%): Tight trailing (0.3%), early activation (0.6%)
 * - MEDIUM volatility (2% < ATR < 3.5%): Standard trailing (0.5%), normal activation (0.8%)
 * - HIGH volatility (ATR > 3.5%): Wide trailing (0.8%), late activation (1.2%)
 */
export function determineVolatilityRegime(
  candles: { high: number; low: number; close: number }[]
): {
  regime: 'LOW' | 'MEDIUM' | 'HIGH';
  atrPct: number | null;
  trailingDistance: number;
  trailingActivation: number;
  reason: string;
} {
  const config = MomentumConfig.EXIT;
  
  // If adaptive trailing disabled, use defaults
  if (!config.ADAPTIVE_TRAILING) {
    return {
      regime: 'MEDIUM',
      atrPct: null,
      trailingDistance: config.TRAILING_DISTANCE_PCT,
      trailingActivation: config.TRAILING_ACTIVATION_PCT,
      reason: 'Adaptive trailing disabled - using defaults'
    };
  }
  
  // Calculate ATR
  const atr = calcATR(candles, 14);
  if (!atr || candles.length === 0) {
    return {
      regime: 'MEDIUM',
      atrPct: null,
      trailingDistance: config.TRAILING_DISTANCE_PCT,
      trailingActivation: config.TRAILING_ACTIVATION_PCT,
      reason: 'ATR unavailable - using defaults'
    };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // LOW VOLATILITY: ATR < 2%
  // Market is calm, tight trailing is safe
  if (atrPct < config.LOW_VOL_ATR_MAX) {
    return {
      regime: 'LOW',
      atrPct,
      trailingDistance: config.LOW_VOL_DISTANCE,
      trailingActivation: config.LOW_VOL_ACTIVATION,
      reason: `Low volatility (ATR ${atrPct.toFixed(2)}%) - tight trailing safe`
    };
  }
  
  // HIGH VOLATILITY: ATR > 3.5%
  // Market is wild, wide trailing needed to avoid noise exits
  if (atrPct > config.HIGH_VOL_ATR_MIN) {
    return {
      regime: 'HIGH',
      atrPct,
      trailingDistance: config.HIGH_VOL_DISTANCE,
      trailingActivation: config.HIGH_VOL_ACTIVATION,
      reason: `High volatility (ATR ${atrPct.toFixed(2)}%) - wide trailing to avoid noise`
    };
  }
  
  // MEDIUM VOLATILITY: 2% < ATR < 3.5%
  // Normal market conditions, standard trailing
  return {
    regime: 'MEDIUM',
    atrPct,
    trailingDistance: config.TRAILING_DISTANCE_PCT,
    trailingActivation: config.TRAILING_ACTIVATION_PCT,
    reason: `Medium volatility (ATR ${atrPct.toFixed(2)}%) - standard trailing`
  };
}

/**
 * V5.14: Calculate 3-layer protection prices with progressive profit lock
 * 
 * Returns the 3 protection levels for a position:
 * - Emergency Stop: Wide stop loss on exchange (catastrophe protection)
 * - Trailing Stop: Intelligent app-side trailing (main exit logic)
 * - Profit Lock Stop: Progressive stop that moves up to lock profits
 */
/**
 * Update position water marks for trailing stop tracking
 * Call this every tick to track high/low
 */
export function updatePositionWaterMarks(
  position: Position,
  currentPrice: number,
  priceHigh?: number,
  priceLow?: number,
): Position {
  // Calculate current PnL %
  const currentPnlPct = position.side === 'long'
    ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
    : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  
  // Track max PnL reached (for exit analysis)
  const newMaxPnlPct = position.maxPnlPct !== undefined
    ? Math.max(position.maxPnlPct, currentPnlPct)
    : currentPnlPct;
  
  if (position.side === 'long') {
    const effectiveHigh = priceHigh ?? currentPrice;
    const newHigh = position.highWaterMark
      ? Math.max(position.highWaterMark, effectiveHigh)
      : effectiveHigh;
    return { ...position, highWaterMark: newHigh, maxPnlPct: newMaxPnlPct };
  } else {
    const effectiveLow = priceLow ?? currentPrice;
    const newLow = position.lowWaterMark
      ? Math.min(position.lowWaterMark, effectiveLow)
      : effectiveLow;
    return { ...position, lowWaterMark: newLow, maxPnlPct: newMaxPnlPct };
  }
}

// ============================================================================
// POSITION SIZING V5.5 - LIQUIDITY-AWARE
// ============================================================================

/**
 * V5.6 Liquidation Protection Configuration
 * Dynamic leverage based on market volatility
 */
export const LIQUIDATION_CONFIG = {
  // Enable dynamic leverage reduction
  DYNAMIC_LEVERAGE: true,
  
  // ATR configuration
  ATR_PERIOD: 14,
  
  // If ATR/price > this threshold, reduce leverage
  HIGH_VOLATILITY_ATR_PCT: 2,  // ATR > 2% = high volatility
  
  // Reduced leverage in high volatility
  REDUCED_LEVERAGE: 3,
  
  // Max simulated gap for safety checks
  MAX_SIMULATED_GAP_PCT: 5,
  
  // Liquidation threshold (% loss on margin before liquidation)
  LIQUIDATION_THRESHOLD_PCT: 80,
};

/**
 * Calculate ATR (Average True Range) from candles
 */
export function calcATR(candles: { high: number; low: number; close: number }[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  
  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || candles[i].high;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    atrSum += tr;
  }
  
  return atrSum / period;
}

/**
 * V5.6: Calculate safe leverage based on volatility
 * Returns reduced leverage if ATR indicates high volatility
 */
export function calcSafeLeverage(
  candles: { high: number; low: number; close: number }[],
  baseLeverage: number
): { leverage: number; wasReduced: boolean; atrPct: number | null } {
  if (!LIQUIDATION_CONFIG.DYNAMIC_LEVERAGE) {
    return { leverage: baseLeverage, wasReduced: false, atrPct: null };
  }
  
  const atr = calcATR(candles, LIQUIDATION_CONFIG.ATR_PERIOD);
  if (!atr || candles.length === 0) {
    return { leverage: baseLeverage, wasReduced: false, atrPct: null };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // High volatility = reduce leverage
  if (atrPct > LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT) {
    return { 
      leverage: LIQUIDATION_CONFIG.REDUCED_LEVERAGE, 
      wasReduced: true, 
      atrPct 
    };
  }
  
  return { leverage: baseLeverage, wasReduced: false, atrPct };
}

/**
 * V5.11: Calculate dynamic stop loss based on ATR
 * 
 * Backtested results (24 months, 8 cryptos):
 * - ATR × 3.0: +2547% PnL, 89.1% WR, 10.6% SL rate
 * - vs ATR × 2.0: +915% amélioration, 138 stop hunts évités
 * - Fonctionne en BULL (+401%) et BEAR (+2145%)
 * 
 * @param candles - Array of OHLCV candles
 * @returns Dynamic SL percentage and debug info
 */
export function calcDynamicStopLoss(
  candles: { high: number; low: number; close: number }[]
): { slPct: number; atrPct: number | null; isDynamic: boolean } {
  const config = MomentumConfig.EXIT;

  // V5.81: Dynamic SL based on volatility regime
  if (config.STOP_LOSS_TYPE === 'dynamic') {
    const regime = determineVolatilityRegime(candles);
    let slPct: number;
    if (regime.regime === 'LOW') {
      slPct = (config as any).DYNAMIC_SL_LOW_VOL_PCT ?? 1.5;
    } else if (regime.regime === 'HIGH') {
      slPct = (config as any).DYNAMIC_SL_HIGH_VOL_PCT ?? 2.5;
    } else {
      slPct = (config as any).DYNAMIC_SL_MED_VOL_PCT ?? 2.0;
    }
    return { slPct, atrPct: regime.atrPct, isDynamic: true };
  }

  // Fallback: Fixed SL
  return {
    slPct: config.STOP_LOSS_PCT,
    atrPct: null,
    isDynamic: false
  };
}

/**
 * V5.5 Liquidity Configuration
 * Max position as % of 24h volume to avoid market impact
 */
export const LIQUIDITY_CONFIG = {
  // Maximum position as percentage of symbol's 24h volume
  // Above this, slippage becomes significant (>0.5%)
  MAX_POSITION_PCT_OF_VOLUME: 0.5,  // 0.5% of 24h volume max
  
  // Absolute caps per symbol tier based on typical liquidity
  POSITION_CAPS: {
    // Tier 1: High liquidity (BTC, ETH) - $5B+ daily volume on futures
    HIGH: {
      symbols: ['BTC/USDT:USDT', 'ETH/USDT:USDT'],
      maxPositionUsd: 500_000,  // $500K max per position
      minVolume24h: 1_000_000_000,  // $1B minimum
    },
    // Tier 2: Medium liquidity - $500M-$5B daily volume
    MEDIUM: {
      symbols: [
        'XRP/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT',
        // V5.30: Added missing cryptos from scanner
        'BNB/USDT:USDT', 'MATIC/USDT:USDT', 'UNI/USDT:USDT', 'LTC/USDT:USDT', 'BCH/USDT:USDT', 'ATOM/USDT:USDT',
        'TRX/USDT:USDT', 'NEAR/USDT:USDT', 'APT/USDT:USDT', 'ARB/USDT:USDT', 'OP/USDT:USDT', 'INJ/USDT:USDT', 'TIA/USDT:USDT',
      ],
      maxPositionUsd: 100_000,  // $100K max
      minVolume24h: 500_000_000,
    },
    // Tier 3: Low liquidity - <$500M daily volume
    LOW: {
      symbols: [
        'SEI/USDT:USDT', 'IMX/USDT:USDT', 'DOT/USDT:USDT', 'SUI/USDT:USDT',
        // V5.30: Added missing low-liquidity cryptos from scanner
        'FIL/USDT:USDT', 'ETC/USDT:USDT', 'WLD/USDT:USDT', 'ORDI/USDT:USDT', 'STX/USDT:USDT', 'JUP/USDT:USDT',
      ],
      maxPositionUsd: 25_000,  // $25K max - beyond this, massive slippage
      minVolume24h: 50_000_000,
    },
  } as Record<string, { symbols: string[]; maxPositionUsd: number; minVolume24h: number }>,
  
  // Slippage model: estimated slippage based on position size vs volume
  // slippage% = (positionUsd / volume24h) * SLIPPAGE_FACTOR
  SLIPPAGE_FACTOR: 50,  // 0.5% slippage for 1% of volume
};

/**
 * Get liquidity tier for a symbol
 */
export function getLiquidityTier(symbol: string): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (LIQUIDITY_CONFIG.POSITION_CAPS.HIGH.symbols.includes(symbol)) return 'HIGH';
  if (LIQUIDITY_CONFIG.POSITION_CAPS.MEDIUM.symbols.includes(symbol)) return 'MEDIUM';
  return 'LOW';
}

/**
 * Calculate maximum safe position size based on liquidity
 */
export function getMaxSafePositionSize(symbol: string, volume24h?: number): number {
  const tier = getLiquidityTier(symbol);
  const config = LIQUIDITY_CONFIG.POSITION_CAPS[tier];
  
  // If we have actual volume data, use it
  if (volume24h && volume24h > 0) {
    const volumeBasedMax = volume24h * (LIQUIDITY_CONFIG.MAX_POSITION_PCT_OF_VOLUME / 100);
    return Math.min(volumeBasedMax, config.maxPositionUsd);
  }
  
  // Otherwise use tier-based cap
  return config.maxPositionUsd;
}

/**
 * Estimate slippage for a given position size
 */
export function estimateSlippage(positionUsd: number, volume24h: number): number {
  if (volume24h <= 0) return 0.5; // Default 0.5% if no volume data
  const pctOfVolume = (positionUsd / volume24h) * 100;
  return pctOfVolume * (LIQUIDITY_CONFIG.SLIPPAGE_FACTOR / 100);
}

export interface PositionSizeInput {
  symbol: string;
  currentPrice: number;
  totalCapitalUsd: number;
  riskPerTradePct: number;
  stopLossPct: number;
  volume24h?: number;    // V5.5: Optional 24h volume for liquidity-aware sizing
  safeLeverage?: number; // V5.6: Optional ATR-adjusted leverage (from calcSafeLeverage)
  initialCapitalUsd?: number; // V5.18: Initial account capital for adaptive sizing
}

export interface PositionSizeResult {
  qty: number;
  notionalUsd: number;      // Position size (margin × leverage)
  marginUsd: number;        // Capital blocked (what we reserve)
  riskUsd: number;
  leverage: number;
  suggestedLeverage: number;
  stopPrice: number;
  // V5.5: Liquidity info
  liquidityTier?: 'HIGH' | 'MEDIUM' | 'LOW';
  maxSafePosition?: number;
  estimatedSlippage?: number;
  wasLiquidityCapped?: boolean;
  // V5.30: Multi-position info
  multiPositionPlan?: {
    enabled: boolean;
    totalPositions: number;
    positionSizeUsd: number;
    totalNotionalUsd: number;
    totalMarginUsd: number;
    entryPrices: number[];
    efficiency: number;
  };
}

/**
 * Calculate position size V5.30 - MULTI-POSITION SCALING
 *
 * This version caps position size based on:
 * 1. Available capital (40-55% rule based on account size) - this is the MARGIN we use
 * 2. Symbol liquidity tier
 * 3. Actual 24h volume (if provided)
 * 4. V5.6: Dynamic leverage based on ATR volatility
 * 5. V5.18: Adaptive sizing - bigger accounts use higher % to compensate for liquidity caps
 * 6. V5.30: Multi-position support - allows multiple positions per symbol for large accounts
 *
 * IMPORTANT: With leverage, the NOTIONAL = margin × leverage
 * - margin = what we block from capital pool
 * - notional = actual position size (what we trade on exchange)
 *
 * V5.30 MULTI-POSITION LOGIC:
 * - If MULTI_POSITION_ENABLED=true and capital exceeds threshold ($30K+)
 * - Calculate multi-position allocation plan
 * - Return plan in multiPositionPlan field
 * - Caller (SimpleAgent/Backtest) decides whether to use single or multi-position
 *
 * V5.18 LOGIC:
 * - Small accounts (<$2k): 40% sizing - aggressive for growth
 * - Medium accounts ($2k-$10k): 40-46% - moderate scaling
 * - Large accounts (>$10k): up to 55% - compensate for liquidity caps
 *
 * This ensures ROI scales better with capital while respecting liquidity limits
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { symbol, currentPrice, totalCapitalUsd, stopLossPct, volume24h, safeLeverage, initialCapitalUsd } = input;
  
  // V5.18: Use initial capital for adaptive sizing (fallback to available capital)
  const accountCapital = initialCapitalUsd ?? totalCapitalUsd;
  
  // V5.6: Use safe leverage if provided (from ATR calculation), otherwise use base leverage
  const baseLeverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const leverage = safeLeverage ?? baseLeverage;
  const stopPrice = currentPrice * (1 - stopLossPct / 100);
  
  // V5.18: Adaptive position sizing - bigger accounts use higher % to compensate for liquidity caps
  const positionSizePct = Math.min(
    MomentumConfig.RISK.POSITION_SIZE_PCT_BASE + (accountCapital / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
    MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
  );
  
  // Step 1: Calculate target margin using adaptive sizing
  const targetMargin = totalCapitalUsd * positionSizePct;
  
  // Step 2: Calculate target notional (margin × leverage) - this is the TARGET position size
  const targetNotional = targetMargin * leverage;
  
  // Step 3: Get liquidity-based maximum (for NOTIONAL)
  const liquidityTier = getLiquidityTier(symbol);
  const maxSafeNotional = getMaxSafePositionSize(symbol, volume24h);
  
  // Step 4: Apply liquidity cap to NOTIONAL
  const wasLiquidityCapped = targetNotional > maxSafeNotional;
  let notional = Math.min(targetNotional, maxSafeNotional);
  
  // Step 5: Calculate actual margin needed
  // If capped, margin = notional / leverage (we use less margin)
  // This is key: with big capital and liquidity cap, we don't need full margin
  let actualMargin = notional / leverage;
  
  // Step 6: Cap margin to available capital (safety check)
  if (actualMargin > totalCapitalUsd * 0.95) {
    actualMargin = totalCapitalUsd * 0.95;
    notional = actualMargin * leverage;
  }
  
  // 🔧 SAFETY: Hard cap on notional - max 10x of capital regardless of leverage settings
  // This prevents catastrophic positions if capital sync fails
  const MAX_NOTIONAL_MULTIPLIER = 10;
  const absoluteMaxNotional = totalCapitalUsd * MAX_NOTIONAL_MULTIPLIER;
  if (notional > absoluteMaxNotional) {
    console.warn(`⚠️ [${symbol}] Position capped by safety limit: $${notional.toFixed(2)} → $${absoluteMaxNotional.toFixed(2)} (max ${MAX_NOTIONAL_MULTIPLIER}x capital)`);
    notional = absoluteMaxNotional;
    actualMargin = notional / leverage;
  }
  
  // 🔧 SAFETY: If capital is very small (<$50), limit position size even further
  if (totalCapitalUsd < 50 && notional > totalCapitalUsd * 5) {
    console.warn(`⚠️ [${symbol}] Small capital mode: capping notional to 5x capital ($${(totalCapitalUsd * 5).toFixed(2)})`);
    notional = totalCapitalUsd * 5;
    actualMargin = notional / leverage;
  }
  
  // Step 7: Apply minimum threshold
  const MIN_NOTIONAL_USD = 20;
  if (notional < MIN_NOTIONAL_USD) {
    notional = totalCapitalUsd >= MIN_NOTIONAL_USD / leverage ? MIN_NOTIONAL_USD : 0;
    actualMargin = notional / leverage;
  }
  
  // Step 8: Calculate estimated slippage (based on notional)
  const estimatedSlippage = volume24h ? estimateSlippage(notional, volume24h) : undefined;
  
  // qty = notional / price (NOT margin / price)
  const qty = notional / currentPrice;
  const riskUsd = actualMargin * (stopLossPct / 100) * leverage;  // Risk on margin, amplified by leverage
  
  // V5.6: Calculate effective leverage (may be lower if capped)
  // This is informational - shows the "real" amplification we're getting
  const effectiveLeverage = actualMargin > 0 ? notional / actualMargin : leverage;

  // V5.30: Calculate multi-position allocation plan (if enabled and large balance)
  // This only kicks in for accounts >= $30K AND when position would be liquidity-capped
  // Small accounts (<$30K) always use single position - no impact on them
  let multiPositionPlan: PositionSizeResult['multiPositionPlan'] = undefined;
  
  const MULTI_POSITION_MIN_CAPITAL = 30_000;  // Minimum capital to enable multi-position
  const MULTI_POSITION_ENABLED = process.env.MULTI_POSITION_ENABLED === 'true';
  
  if (MULTI_POSITION_ENABLED && accountCapital >= MULTI_POSITION_MIN_CAPITAL && wasLiquidityCapped) {
    // Only use multi-position when:
    // 1. Feature is enabled
    // 2. Account is large enough ($30K+)
    // 3. Position would be capped by liquidity (otherwise no benefit)
    
    // Calculate how many positions we need to deploy target capital
    const idealPositions = Math.ceil(targetNotional / maxSafeNotional);
    
    // Cap by capital tier
    const capitalTiers: { [minCap: number]: number } = {
      300_000: 5,  // $300K+: 5 positions
      150_000: 4,  // $150K-$300K: 4 positions
      75_000: 3,   // $75K-$150K: 3 positions
      30_000: 2,   // $30K-$75K: 2 positions
    };
    
    let maxPositions = 1;
    for (const [minCap, positions] of Object.entries(capitalTiers).sort((a, b) => Number(b[0]) - Number(a[0]))) {
      if (accountCapital >= Number(minCap)) {
        maxPositions = positions;
        break;
      }
    }
    
    const totalPositions = Math.min(idealPositions, maxPositions);
    
    if (totalPositions > 1) {
      // Each position uses max safe notional (liquidity cap)
      const positionSizeUsd = maxSafeNotional;
      const totalNotionalUsd = positionSizeUsd * totalPositions;
      const marginPerPosition = positionSizeUsd / leverage;
      const totalMarginUsd = marginPerPosition * totalPositions;
      
      // Generate staggered entry prices (0.3% to 1.5% spread)
      const minSpreadPct = 0.3;
      const maxSpreadPct = 1.5;
      const spreadPct = minSpreadPct + (maxSpreadPct - minSpreadPct) * Math.min(1, (totalPositions - 1) / 4);
      const spreadUsd = currentPrice * (spreadPct / 100);
      
      const entryPrices: number[] = [];
      for (let i = 0; i < totalPositions; i++) {
        const spreadFactor = totalPositions > 1 ? i / (totalPositions - 1) : 0;
        entryPrices.push(currentPrice - (spreadUsd * spreadFactor));
      }
      
      const efficiency = Math.min(1, totalNotionalUsd / targetNotional);
      
      multiPositionPlan = {
        enabled: true,
        totalPositions,
        positionSizeUsd,
        totalNotionalUsd,
        totalMarginUsd,
        entryPrices,
        efficiency,
      };
    }
  }

  return {
    qty,
    notionalUsd: notional,      // The actual position size
    marginUsd: actualMargin,    // What we block from capital pool
    riskUsd,
    leverage,                   // The leverage we're USING
    suggestedLeverage: leverage,
    stopPrice,
    // V5.5 liquidity info
    liquidityTier,
    maxSafePosition: maxSafeNotional,
    estimatedSlippage,
    wasLiquidityCapped,
    // V5.30: Multi-position plan
    multiPositionPlan,
  };
}

// Legacy function signature for compatibility
export function calculatePositionSizeLegacy(
  capitalUsd: number,
  entryPrice: number,
  symbol: string,
): { qty: number; riskUsd: number; leverage: number; stopPrice: number } {
  const leverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const riskUsd = capitalUsd * (MomentumConfig.RISK.RISK_PCT_PER_TRADE / 100);
  const stopPrice = entryPrice * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100);
  const positionValue = riskUsd / (MomentumConfig.EXIT.STOP_LOSS_PCT / 100);
  const qty = positionValue / entryPrice;
  
  return { qty, riskUsd, leverage, stopPrice };
}

