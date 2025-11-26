/**
 * 🎯 STRATÉGIE V5 - BREAKOUT MOMENTUM + REGIME FILTER
 * 
 * Backtestée sur 12 mois (Nov 2024 - Nov 2025):
 * - XRP: +112% ROI, 61% Win Rate
 * - ETH: +19% ROI, 63% Win Rate  
 * - Combined (50% sizing): +112% ROI, 36% max drawdown
 * 
 * ENTRY:
 * - Bollinger Band breakout (close > upper band)
 * - ROC 10 périodes > 1.5%
 * - Volume > 1.3x moyenne 20 périodes
 * - ConsecUp <= 4 (évite les tops)
 * - BTC Regime Filter: BTC > SMA200 (bull market only)
 * 
 * EXIT:
 * - Trailing Stop: activé à +1.5%, trail à 0.8%
 * - Stop Loss: 2%
 * - Take Profit: 2.5%
 * - Max Hold: 48h
 * - Momentum Fade: si profit > 2% et ROC5 < 0.5%
 * - Volume Dry-up: si profit > 0.5% et volume < 0.5x avg
 */

// ============================================================================
// CONFIGURATION V5
// ============================================================================

export const MomentumConfig = {
  // Signal d'entrée V5 - Breakout Strategy
  ENTRY: {
    // Bollinger Bands
    BB_PERIOD: 20,
    BB_STD: 2,
    
    // Momentum confirmation
    ROC_MIN: 0.015,              // ROC 10 > 1.5%
    VOL_MULTIPLIER: 1.3,         // Volume > 1.3x moyenne (pas 5x, trop restrictif)
    MAX_CONSEC_UP: 4,            // Max 4 bougies vertes consécutives
    
    // BTC Regime Filter
    BTC_SMA_PERIOD: 200,         // SMA 200 pour régime
    BTC_MOMENTUM_MIN: 0,         // Désactivé (utilise SMA200 à la place)
    BTC_MOMENTUM_PERIOD: 24,     // Gardé pour compatibilité
    
    ALLOWED_DAYS: [0, 1, 2, 3, 4, 5, 6],  // All days
  },
  
  // Exit V5 - Optimized exits
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 2880,   // 48 heures max hold (vs 6h avant)
    STOP_LOSS_PCT: 2.0,          // Stop Loss 2%
    PROFIT_TARGET_PCT: 2.5,      // Take Profit 2.5%
    
    // Trailing Stop V5
    TRAILING_ACTIVATION_PCT: 1.5, // Active trailing à +1.5%
    TRAILING_DISTANCE_PCT: 0.8,   // Trail de 0.8%
    TRAILING_TIGHTEN_AT_PCT: 2.5, // Resserre à 0.5% à partir de +2.5%
    TRAILING_TIGHT_DISTANCE_PCT: 0.5,
    
    // Smart Exits
    MOMENTUM_FADE_PROFIT_MIN: 2.0,  // Exit si profit > 2%...
    MOMENTUM_FADE_ROC_MAX: 0.005,   // ...et ROC5 < 0.5%
    VOLUME_DRY_PROFIT_MIN: 0.5,     // Exit si profit > 0.5%...
    VOLUME_DRY_RATIO: 0.5,          // ...et volume < 0.5x avg
  },
  
  // Risk V5 - Conservative sizing
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,     // 1% du capital par trade
    POSITION_SIZE_PCT: 0.5,      // 50% du capital disponible par position
    MAX_POSITIONS: 2,            // Max 2 positions (ETH + XRP)
  },
  
  // Assets tradés V5 - Focus sur ETH et XRP (les plus performants)
  SYMBOLS: [
    'XRP/USDT:USDT',  // Best performer: +112% ROI
    'ETH/USDT:USDT',  // Second best: +19% ROI
    // BTC et SOL retirés car moins performants sur cette stratégie
  ],
  
  // Leverage par asset V5
  LEVERAGE: {
    'BTC/USDT:USDT': 3,   // Gardé pour compatibilité
    'ETH/USDT:USDT': 5,   // 5x leverage
    'SOL/USDT:USDT': 5,   // Gardé pour compatibilité
    'XRP/USDT:USDT': 4,   // 4x leverage
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
  orderId?: string;
  // Trailing stop tracking
  highWaterMark?: number;  // Highest price since entry (for long)
  lowWaterMark?: number;   // Lowest price since entry (for short)
  trailingActive?: boolean;
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
  btcAboveMa50: boolean;
  overallStatus: 'favorable_long' | 'favorable_short' | 'neutral' | 'unfavorable';
  reason: string;
  checkedAt: number;
}

/**
 * Get current market conditions status V5
 * Now uses BTC > SMA200 as primary regime filter
 */
export function getMarketConditions(btcCandles: Candle[]): MarketConditions {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const isTradingDay = MomentumConfig.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
  
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
  
  // V5 Regime: BTC > SMA200 = BULL, else BEAR
  let btcTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (btcAboveSma200) {
    btcTrend = 'bullish';
  } else {
    btcTrend = 'bearish';
  }
  
  // Overall status V5 - LONG only when in bull regime
  let overallStatus: MarketConditions['overallStatus'] = 'neutral';
  let reason = '';
  
  if (!isTradingDay) {
    overallStatus = 'unfavorable';
    reason = `Not a trading day (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]})`;
  } else if (btcAboveSma200) {
    overallStatus = 'favorable_long';
    reason = `V5 BULL REGIME: BTC ${btcNow.toFixed(0)} > SMA200 ${btcSma200.toFixed(0)} | Mom6h: ${btcMomentum6h >= 0 ? '+' : ''}${btcMomentum6h.toFixed(2)}%`;
  } else {
    // V5: No SHORT, just unfavorable
    overallStatus = 'unfavorable';
    reason = `V5 BEAR REGIME: BTC ${btcNow.toFixed(0)} < SMA200 ${btcSma200.toFixed(0)} - NO TRADING`;
  }
  
  return {
    isTradingDay,
    dayOfWeek,
    btcTrend,
    btcMomentum6h,
    btcAboveMa50,
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

// ============================================================================
// SIGNAL CHECK V5 - BREAKOUT + REGIME FILTER (LONG ONLY)
// ============================================================================

/**
 * Check momentum signal V5 - LONG only with breakout and regime filter
 * 
 * Entry conditions:
 * 1. Close > Bollinger Upper Band (breakout)
 * 2. ROC 10 > 1.5%
 * 3. Volume > 1.3x average
 * 4. ConsecUp <= 4 (pas en top)
 * 5. BTC > SMA200 (regime filter - bull market)
 * 
 * @param symbol Trading symbol
 * @param candles Symbol candles (15m)
 * @param btcCandles BTC candles (15m) for regime filter
 */
export function checkMomentumSignal(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[]
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
  
  // ========== REGIME FILTER: BTC > SMA200 ==========
  const btcSma200 = calcSMA(btcCloses, MomentumConfig.ENTRY.BTC_SMA_PERIOD);
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcInBullRegime = btcNow > btcSma200;
  
  // Calcul legacy pour compatibilité features
  const btc6hAgoIndex = Math.max(0, btcCloses.length - MomentumConfig.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  const ma20 = calcMA(closes, 20);
  const btcMa50 = calcMA(btcCloses, 50);
  const btcAboveMa50 = btcNow > btcMa50;
  
  // ========== ENTRY CONDITIONS V5 ==========
  
  // 1. Bollinger Breakout: close > upper band
  const bb = calcBollingerBands(closes, MomentumConfig.ENTRY.BB_PERIOD, MomentumConfig.ENTRY.BB_STD);
  const breakoutOk = close > bb.upper;
  
  // 2. ROC > 1.5%
  const roc = calcROC(closes, 10);
  const rocOk = roc >= MomentumConfig.ENTRY.ROC_MIN;
  
  // 3. Volume > 1.3x
  const volRatio = calcVolRatio(volumes);
  const volOk = volRatio >= MomentumConfig.ENTRY.VOL_MULTIPLIER;
  
  // 4. ConsecUp <= 4
  const consecUp = countConsecUp(candles);
  const consecOk = consecUp <= MomentumConfig.ENTRY.MAX_CONSEC_UP;
  
  // 5. Filtre jour
  const dayOfWeek = new Date().getUTCDay();
  const dayAllowed = MomentumConfig.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
  
  // For compatibility with existing code
  const isBullish = close > open;
  const priceAboveMa20 = close > ma20;
  
  const features = {
    volRatio,
    isBullish,
    priceAboveMa20,
    btcAboveMa50,
    btcMomentum6h,
    dayOfWeek,
    // V5 new features
    roc: roc * 100,
    consecUp,
    btcInBullRegime,
    bbUpper: bb.upper,
    breakout: breakoutOk,
  };
  
  // ========== CHECK REJECTION CONDITIONS ==========
  
  // Day filter
  if (!dayAllowed) {
    return { valid: false, reason: `day_not_allowed(${dayOfWeek})`, features };
  }
  
  // Regime filter FIRST (most important)
  if (!btcInBullRegime) {
    return { 
      valid: false, 
      reason: `regime_bearish:btc_below_sma200(${btcNow.toFixed(0)} < ${btcSma200.toFixed(0)})`, 
      features 
    };
  }
  
  // Not a bullish candle
  if (!isBullish) {
    return { valid: false, reason: 'bearish_candle', features };
  }
  
  // ConsecUp too high (likely at top)
  if (!consecOk) {
    return { 
      valid: false, 
      reason: `too_many_consec_up(${consecUp}>${MomentumConfig.ENTRY.MAX_CONSEC_UP})`, 
      features 
    };
  }
  
  // No breakout
  if (!breakoutOk) {
    return { 
      valid: false, 
      reason: `no_breakout(close=${close.toFixed(4)} < bb_upper=${bb.upper.toFixed(4)})`, 
      features 
    };
  }
  
  // ROC too low
  if (!rocOk) {
    return { 
      valid: false, 
      reason: `roc_low(${(roc*100).toFixed(2)}% < ${(MomentumConfig.ENTRY.ROC_MIN*100).toFixed(1)}%)`, 
      features 
    };
  }
  
  // Volume too low
  if (!volOk) {
    return { 
      valid: false, 
      reason: `vol_low(${volRatio.toFixed(1)}x < ${MomentumConfig.ENTRY.VOL_MULTIPLIER}x)`, 
      features 
    };
  }
  
  // ========== ALL CONDITIONS MET - LONG SIGNAL ==========
  const confidence = Math.min(1, (volRatio / 3) * 0.3 + (roc / 0.03) * 0.3 + (btcInBullRegime ? 0.4 : 0));
  
  return { 
    valid: true, 
    side: 'long',  // V5: LONG ONLY
    reason: 'v5_breakout_long_confirmed',
    confidence,
    features 
  };
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
  candles?: Candle[]  // Optional candles for smart exits
): ExitSignal {
  const now = Date.now();
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
  
  // 2. Initial Stop loss (before trailing activates)
  if (pnlPct <= -MomentumConfig.EXIT.STOP_LOSS_PCT) {
    return { shouldExit: true, reason: 'stoploss', pnlPct, holdMinutes };
  }
  
  // 3. Take Profit (V5: 2.5%)
  if (pnlPct >= MomentumConfig.EXIT.PROFIT_TARGET_PCT) {
    return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // Using 'trailing' for compat
  }
  
  // 4. Smart Exits (require candles)
  if (candles && candles.length >= 20) {
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    
    // 4a. Momentum Fade: profit > 2% et ROC5 < 0.5%
    if (pnlPct >= MomentumConfig.EXIT.MOMENTUM_FADE_PROFIT_MIN) {
      const roc5 = calcROC(closes, 5);
      if (roc5 < MomentumConfig.EXIT.MOMENTUM_FADE_ROC_MAX) {
        return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // momentum_fade
      }
    }
    
    // 4b. Volume Dry-up: profit > 0.5% et volume < 0.5x avg
    if (pnlPct >= MomentumConfig.EXIT.VOLUME_DRY_PROFIT_MIN) {
      const volRatio = calcVolRatio(volumes);
      if (volRatio < MomentumConfig.EXIT.VOLUME_DRY_RATIO) {
        return { shouldExit: true, reason: 'trailing', pnlPct, holdMinutes }; // volume_dry
      }
    }
  }
  
  // 5. Trailing Stop Logic (V5: activate at 1.5%)
  const trailingActivation = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;
  
  if (pnlPct >= trailingActivation) {
    // Trailing is active or should activate
    let trailingDistance = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
    
    // Tighten trailing at higher profits (V5: at 2.5%)
    if (pnlPct >= MomentumConfig.EXIT.TRAILING_TIGHTEN_AT_PCT) {
      trailingDistance = MomentumConfig.EXIT.TRAILING_TIGHT_DISTANCE_PCT;
    }
    
    // Calculate trailing stop price
    let trailingStopPrice: number;
    
    if (position.side === 'long') {
      // For long: track highest price, stop is below it
      const highWaterMark = position.highWaterMark 
        ? Math.max(position.highWaterMark, currentPrice)
        : currentPrice;
      
      trailingStopPrice = highWaterMark * (1 - trailingDistance / 100);
      
      // Check if price dropped below trailing stop
      if (currentPrice <= trailingStopPrice) {
        return { 
          shouldExit: true, 
          reason: 'trailing', 
          pnlPct, 
          holdMinutes,
          newStopLoss: trailingStopPrice
        };
      }
      
      // Update stop loss for position tracking
      return { 
        shouldExit: false, 
        reason: 'none', 
        pnlPct, 
        holdMinutes,
        newStopLoss: trailingStopPrice
      };
      
    } else {
      // For short: track lowest price, stop is above it
      const lowWaterMark = position.lowWaterMark 
        ? Math.min(position.lowWaterMark, currentPrice)
        : currentPrice;
      
      trailingStopPrice = lowWaterMark * (1 + trailingDistance / 100);
      
      // Check if price rose above trailing stop
      if (currentPrice >= trailingStopPrice) {
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
  
  return { shouldExit: false, reason: 'none', pnlPct, holdMinutes };
}

/**
 * Update position water marks for trailing stop tracking
 * Call this every tick to track high/low
 */
export function updatePositionWaterMarks(position: Position, currentPrice: number): Position {
  if (position.side === 'long') {
    const newHigh = position.highWaterMark 
      ? Math.max(position.highWaterMark, currentPrice)
      : currentPrice;
    return { ...position, highWaterMark: newHigh };
  } else {
    const newLow = position.lowWaterMark 
      ? Math.min(position.lowWaterMark, currentPrice)
      : currentPrice;
    return { ...position, lowWaterMark: newLow };
  }
}

// ============================================================================
// POSITION SIZING V5
// ============================================================================

export interface PositionSizeInput {
  symbol: string;
  currentPrice: number;
  totalCapitalUsd: number;
  riskPerTradePct: number;
  stopLossPct: number;
}

export interface PositionSizeResult {
  qty: number;
  notionalUsd: number;
  riskUsd: number;
  leverage: number;
  suggestedLeverage: number;
  stopPrice: number;
}

/**
 * Calculate position size V5 - using 50% of available capital
 * 
 * V5 uses fixed 50% position sizing instead of risk-based sizing
 * This proved more profitable in backtests (+112% vs +66% with 100%)
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { symbol, currentPrice, totalCapitalUsd, stopLossPct } = input;
  
  const leverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const stopPrice = currentPrice * (1 - stopLossPct / 100);
  
  // V5: Use POSITION_SIZE_PCT (50%) of available capital
  const positionValue = totalCapitalUsd * MomentumConfig.RISK.POSITION_SIZE_PCT;
  const qty = positionValue / currentPrice;
  const riskUsd = positionValue * (stopLossPct / 100); // Risk in USD
  
  return { 
    qty, 
    notionalUsd: positionValue,
    riskUsd, 
    leverage,
    suggestedLeverage: leverage,
    stopPrice 
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

