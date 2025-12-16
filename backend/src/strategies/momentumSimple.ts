/**
 * 🎯 STRATÉGIE V5.12 - OPTIMIZED FILTERS (2-year backtest)
 * 
 * V5.12 CHANGES (Dec 2025):
 * - VOL_MULTIPLIER: 2.0 → 1.5 (+36% PnL)
 * - MAX_CONSEC_UP: 3 → 5 (+34% PnL)
 * - RSI+BTC filter: REMOVED (blocked profitable trades)
 * 
 * Backtested sur 24 mois (Dec 2023 - Dec 2025) avec frais 0.08%:
 * - Total PnL: +1807% (vs +1346% V5.11) = +34% amélioration
 * - Trades: 1178 (vs 910) = +29% plus de trades
 * - Win Rate: 86% (stable)
 * - SL Rate: 14% (stable)
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
 * - ROC 10 périodes > 2.5%
 * - Volume > 1.5x moyenne (V5.12)
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
 * EXIT (V5.11):
 * - Stop Loss: ATR × 3.0 (clampé 1.0%-4.5%)
 * - Take Profit: 3%
 * - Trailing: activé à +0.5%, trail à 0.3%
 * - Max Hold: 48h
 */

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
  
  // Signal d'entrée LONG (Bull Market: BTC > SMA200)
  // V5.8: Volume > 2x - Standard filter
  ENTRY_LONG: {
    // Bollinger Bands
    BB_PERIOD: 20,
    BB_STD: 2,
    
    // Momentum confirmation - V5.12 OPTIMIZED (2-year backtest)
    ROC_MIN: 0.025,              // ROC 10 > 2.5% - Keep strict
    VOL_MULTIPLIER: 1.5,         // V5.12: 1.5x (was 2.0) - +36% PnL
    MAX_CONSEC_UP: 5,            // V5.12: 5 (was 3) - +34% PnL
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
  
  // Config commune
  ENTRY: {
    // Bollinger Bands (legacy, utilisé par LONG)
    BB_PERIOD: 20,
    BB_STD: 2,
    
    // Legacy fields for compatibility
    ROC_MIN: 0.025,              // V5.12: 2.5%
    VOL_MULTIPLIER: 1.5,         // V5.12: 1.5x
    MAX_CONSEC_UP: 5,            // V5.12: 5
    
    // BTC Regime Filter
    BTC_SMA_PERIOD: 200,         // SMA 200 pour régime
    BTC_MOMENTUM_MIN: 0,         // Désactivé (utilise SMA200 à la place)
    BTC_MOMENTUM_PERIOD: 24,     // Gardé pour compatibilité
    
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],  // All days
  },
  
  // Exit V5.14 - ADAPTIVE TRAILING ONLY
  // ═══════════════════════════════════════════════════════════════════════════
  // BACKTEST RESULTS: Trailing adaptatif 0.3-0.8% basé sur volatilité (ATR)
  // - +320% ROI vs +4% baseline (72× amélioration)
  // - 80.6% win rate vs 70.6%
  // - 38.5% max DD vs 61.7% (drawdown divisé par 2)
  // - 18.9% SL rate vs 28.4% (moins de stop hunts)
  // ═══════════════════════════════════════════════════════════════════════════
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 2880,   // 48 heures max hold
    
    // V5.14: SL FIXE - 2.5% constant
    // Layer 3 (Profit Lock) déplacera ce SL vers le haut pour sécuriser gains
    STOP_LOSS_TYPE: 'fixed' as const,  // 'fixed' | 'atr'
    STOP_LOSS_PCT: 2.5,              // SL fixe 2.5% (Emergency exchange = min(SL×mult, 3%))
    STOP_LOSS_ATR_MULT: 3.0,         // ATR × 3.0 (was 2.0) - plus large
    STOP_LOSS_MIN_PCT: 1.0,          // Min 1.0% (was 0.8%)
    STOP_LOSS_MAX_PCT: 4.5,          // Max 4.5% (was 3.0%)
    
    PROFIT_TARGET_PCT: 3.0,      // Take Profit 3% → 15% avec 5x leverage
    
    // V5.12: SMART Trailing Stop - Starts tight, WIDENS at higher profit
    // This lets winners run while protecting early gains
    TRAILING_ACTIVATION_PCT: 0.8,       // Activate trailing at +0.8% profit
    TRAILING_DISTANCE_PCT: 0.5,         // Initial callback: 0.5% (tight protection)
    TRAILING_WIDEN_AT_PCT: 2.0,         // Widen callback when profit reaches 2%
    TRAILING_WIDE_DISTANCE_PCT: 0.8,    // Widened callback: 0.8% (let winner run)
    
    // Protection setup
    // - Emergency stop is placed on exchange (wide, crash protection)
    // - Trailing exit is managed app-side (do NOT move exchange SL above entry)
    USE_EXCHANGE_TRAILING: false,         // App-side trailing is default

    // Emergency Stop Loss (Exchange)
    EMERGENCY_STOP_MULTIPLIER: 2.5,       // Emergency SL = dynamic SL × multiplier, capped
    EMERGENCY_STOP_MAX_PCT: 3.0,          // Hard cap (user request): max 3% from entry on exchange
                                          // Example: ATR SL 2% → Emergency 5%
                                          // Example: ATR SL 3% → Emergency 7.5%

    // Realtime App-Side Exit (WebSocket)
    // Goal: react faster than 15m candle close while filtering micro-noise.
    // This does NOT move the exchange emergency STOP_MARKET; it only decides when to close.
    REALTIME_APP_EXIT_ENABLED: true,
    // Realtime trailing can be evaluated either on ticker (fast but noisy) or on closed 1m candles (filters wicks).
    // Recommended for "avoid noise": use 1m close-based trailing with 2 consecutive closes.
    REALTIME_APP_EXIT_TRAILING_MODE: 'kline_1m_close' as const, // 'ticker' | 'kline_1m_close'
    REALTIME_APP_EXIT_KLINE_INTERVAL: '1m' as const,
    REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES: 2,
    // If you want live to behave more like paper on exits, disable realtime trailing exits.
    // You'll still be protected by the exchange emergency STOP_MARKET.
    REALTIME_APP_EXIT_TRAILING_ENABLED: false,
    REALTIME_APP_EXIT_STOPLOSS_ENABLED: true,
    REALTIME_APP_EXIT_POLL_MS: 1000,          // How often we check WS price when in position
    REALTIME_APP_EXIT_CONFIRM_MS: 1800,       // Require breach to persist for at least this long
    REALTIME_APP_EXIT_CONFIRM_TICKS: 2,       // ...or for this many consecutive checks
    REALTIME_APP_EXIT_BUFFER_PCT: 0.05,       // Extra buffer beyond stop to avoid spread/mark noise
    REALTIME_APP_EXIT_USE_MID_PRICE: true,    // Use (bid+ask)/2 when available

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
  },
  
  // Risk V5 - Sizing ajusté pour le risque
  // ⚠️ MATH: Avec SL 1.5% × Lev 5x × Position 40% = 3% du capital total par trade
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,     // 1% du capital par trade
    POSITION_SIZE_PCT: 0.4,      // 40% du capital disponible par position (was 50%)
    MAX_POSITIONS: 4,            // Max 4 positions
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
  // Emergency protection (exchange-side)
  emergencyStopPrice?: number;   // Wide emergency stop (catastrophe protection)
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
  reason?: 'time' | 'stoploss' | 'trailing' | 'none';
  pnlPct?: number;
  holdMinutes?: number;
  newStopLoss?: number;  // Updated trailing stop
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
 * Now uses BTC > SMA200 as primary regime filter
 */
export function getMarketConditions(btcCandles: Candle[]): MarketConditions {
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
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcMa50 = calcMA(btcCloses, 50);
  const btcSma200 = calcMA(btcCloses, 200);
  const btcAboveMa50 = btcNow > btcMa50;
  const btcAboveSma200 = btcNow > btcSma200;
  
  // BTC momentum 6h (legacy, for display)
  const btc6hAgoIndex = Math.max(0, btcCloses.length - MomentumConfig.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
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
// INDICATEURS
// ============================================================================

function calcMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcSMA(values: number[], period: number): number {
  return calcMA(values, period);
}

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

// Bollinger Bands
function calcBollingerBands(closes: number[], period: number = 20, stdMultiplier: number = 2): { upper: number; middle: number; lower: number } {
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

// Rate of Change (ROC)
function calcROC(closes: number[], period: number = 10): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0;
}

// Count consecutive up candles
function countConsecUp(candles: Candle[]): number {
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

// Count consecutive down candles (for SHORT)
function countConsecDown(candles: Candle[]): number {
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
 * @param btcCandles BTC candles (15m) for regime filter
 */
export function checkMomentumSignal(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[],
  opts?: {
    nowMs?: number;
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
  const btcSma200 = calcSMA(btcCloses, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcInBullRegime = btcNow > btcSma200;
  const btcInBearRegime = btcNow < btcSma200;
  
  // Calcul legacy pour compatibilité features
  const btc6hAgoIndex = Math.max(0, btcCloses.length - MomentumConfig.ENTRY.BTC_MOMENTUM_PERIOD - 1);
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
  // ═══════════════════════════════════════════════════════════════════════════
  if (btcInBullRegime) {
    // LONG conditions V5.12 (optimized)
    const breakoutOk = close > bb.upper;
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
    
    // ✅ ALL LONG CONDITIONS MET
    const confidence = Math.min(1, (volRatio / 3) * 0.3 + (roc10 / 0.04) * 0.3 + 0.4);
    return { 
      valid: true, 
      side: 'long',
      reason: 'v5.3_bull_long_confirmed',
      confidence,
      features 
    };
  }
  
  // ═══════════════════════════════════════════════════════════════════════════
  // V5.4 BEAR REGIME → SHORT ONLY (BB Breakdown)
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
    
    // ✅ ALL SHORT CONDITIONS MET (V5.4 BB Breakdown)
    const confidence = Math.min(1, (volRatio / 4) * 0.3 + (Math.abs(roc5) / 0.04) * 0.3 + 0.4);
    return { 
      valid: true, 
      side: 'short',
      reason: 'v5.3_bear_short_confirmed',
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
 * 1. Max Hold: 48h
 * 2. Stop Loss: 2%
 * 3. Take Profit: 2.5%
 * 4. Trailing: activé à +1.5%, trail 0.8%
 * 5. Momentum Fade: profit > 2% et ROC5 < 0.5%
 * 6. Volume Dry-up: profit > 0.5% et volume < 0.5x avg
 */
export function shouldExitPosition(
  position: Position, 
  currentPrice: number,
  candles?: Candle[],  // Optional candles for smart exits
  opts?: {
    nowMs?: number;
    priceHigh?: number;
    priceLow?: number;
  }
): ExitSignal {
  const now = opts?.nowMs ?? Date.now();
  const holdMinutes = (now - position.entryTime) / 60000;
  
  // Calculate PnL based on position side
  let pnlPct: number;
  if (position.side === 'long') {
    pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  } else {
    pnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
  }
  
  // 1. Time-based exit (48h max - V5)
  if (holdMinutes >= MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN) {
    return { shouldExit: true, reason: 'time', pnlPct, holdMinutes };
  }
  
  // 2. V5.12 SMART TRAILING: Starts tight, WIDENS at higher profit
  // This lets winners run while protecting early gains
  const trailingActivation = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;
  
  if (pnlPct >= trailingActivation) {
    // Trailing is active or should activate
    let trailingDistance = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
    
    // V5.12: WIDEN callback at higher profits (opposite of old logic!)
    // At 2%+ profit, give trade more room to breathe
    if (pnlPct >= MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT) {
      trailingDistance = MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT;
    }
    
    // Calculate trailing stop price
    let trailingStopPrice: number;
    
    if (position.side === 'long') {
      // For long: track highest price, stop is below it
      const effectiveHigh = opts?.priceHigh ?? currentPrice;
      const highWaterMark = position.highWaterMark
        ? Math.max(position.highWaterMark, effectiveHigh)
        : effectiveHigh;
      
      trailingStopPrice = highWaterMark * (1 - trailingDistance / 100);
      
      // Check if price dropped below trailing stop
      const effectiveLow = opts?.priceLow ?? currentPrice;
      if (effectiveLow <= trailingStopPrice) {
        return { 
          shouldExit: true, 
          reason: 'trailing', 
          pnlPct, 
          holdMinutes,
          newStopLoss: trailingStopPrice
        };
      }
      
      // Update stop loss for position tracking (trailing active but not triggered)
      return { 
        shouldExit: false, 
        reason: 'none', 
        pnlPct, 
        holdMinutes,
        newStopLoss: trailingStopPrice
      };
      
    } else {
      // For short: track lowest price, stop is above it
      const effectiveLow = opts?.priceLow ?? currentPrice;
      const lowWaterMark = position.lowWaterMark
        ? Math.min(position.lowWaterMark, effectiveLow)
        : effectiveLow;
      
      trailingStopPrice = lowWaterMark * (1 + trailingDistance / 100);
      
      // Check if price rose above trailing stop
      const effectiveHigh = opts?.priceHigh ?? currentPrice;
      if (effectiveHigh >= trailingStopPrice) {
        return { 
          shouldExit: true, 
          reason: 'trailing', 
          pnlPct, 
          holdMinutes,
          newStopLoss: trailingStopPrice
        };
      }
      
      return { 
        shouldExit: false, 
        reason: 'none', 
        pnlPct, 
        holdMinutes,
        newStopLoss: trailingStopPrice
      };
    }
  }
  
  // 3. Stop loss - V5.7: Use dynamic SL from position if available (only if trailing not active)
  const slPct = position.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
  if (pnlPct <= -slPct) {
    return { shouldExit: true, reason: 'stoploss', pnlPct, holdMinutes };
  }
  
  // 4. Take Profit (V5: 3%)
  if (pnlPct >= MomentumConfig.EXIT.PROFIT_TARGET_PCT) {
    return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // Using 'trailing' for compat
  }
  
  // 5. Smart Exits (require candles)
  if (candles && candles.length >= 20) {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    
    // 5a. Momentum Fade: profit > 1.5% et ROC5 < 0.5%
    if (pnlPct >= MomentumConfig.EXIT.MOMENTUM_FADE_PROFIT_MIN) {
      const roc5 = calcROC(closes, 5);
      if (roc5 < MomentumConfig.EXIT.MOMENTUM_FADE_ROC_MAX) {
        return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // momentum_fade
      }
    }
    
    // 5b. Volume Dry-up: profit > 0.5% et volume < 0.5x avg
    if (pnlPct >= MomentumConfig.EXIT.VOLUME_DRY_PROFIT_MIN) {
      const volRatio = calcVolRatio(volumes);
      if (volRatio < MomentumConfig.EXIT.VOLUME_DRY_RATIO) {
        return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // volume_dry
      }
    }
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
  
  // V5.14: Fixed SL only (dynamic SL disabled)
  // Always return fixed SL since STOP_LOSS_TYPE is 'fixed'
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
    // Tier 2: Medium liquidity (XRP, SOL, DOGE, AVAX, LINK) - $500M-$5B daily volume
    MEDIUM: {
      symbols: ['XRP/USDT:USDT', 'SOL/USDT:USDT', 'DOGE/USDT:USDT', 'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ADA/USDT:USDT'],
      maxPositionUsd: 100_000,  // $100K max
      minVolume24h: 500_000_000,
    },
    // Tier 3: Low liquidity (SEI, IMX, SUI, DOT) - <$500M daily volume
    LOW: {
      symbols: ['SEI/USDT:USDT', 'IMX/USDT:USDT', 'DOT/USDT:USDT', 'SUI/USDT:USDT'],
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
}

/**
 * Calculate position size V5.6 - LIQUIDITY-AWARE + DYNAMIC LEVERAGE
 * 
 * This version caps position size based on:
 * 1. Available capital (40% rule) - this is the MARGIN we use
 * 2. Symbol liquidity tier
 * 3. Actual 24h volume (if provided)
 * 4. V5.6: Dynamic leverage based on ATR volatility
 * 
 * IMPORTANT: With leverage, the NOTIONAL = margin × leverage
 * - margin = what we block from capital pool
 * - notional = actual position size (what we trade on exchange)
 * 
 * V5.6 LOGIC:
 * - If position is capped by liquidity, effective leverage may be lower
 * - Example: $500K capital, SEI cap $25K notional
 *   → margin = $200K (40% of $500K), but notional capped at $25K
 *   → effective leverage = $25K / margin_used = ~0.125x (no leverage needed!)
 *   → We only block margin_used = $25K / base_leverage = $5K
 * 
 * This prevents market impact problems when scaling up capital
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { symbol, currentPrice, totalCapitalUsd, stopLossPct, volume24h, safeLeverage } = input;
  
  // V5.6: Use safe leverage if provided (from ATR calculation), otherwise use base leverage
  const baseLeverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const leverage = safeLeverage ?? baseLeverage;
  const stopPrice = currentPrice * (1 - stopLossPct / 100);
  
  // Step 1: Calculate target margin (40% of capital) - this is what we'd LIKE to use
  const targetMargin = totalCapitalUsd * MomentumConfig.RISK.POSITION_SIZE_PCT;
  
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

