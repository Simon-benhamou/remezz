/**
 * 🎯 STRATÉGIE MOMENTUM SIMPLE
 * 
 * Backtestée sur 12 mois (Nov 2024 - Nov 2025):
 * - 91% mois positifs (10/11)
 * - ~$500/mois sur $10k avec leverage 4.5x
 * - Win Rate: 55.7%
 * 
 * Signal LONG: Vol 5x + Bullish + MA20 + BTC MA50 + BTC momentum 6h > 0.75%
 * Signal SHORT: Vol 5x + Bearish + below MA20 + BTC below MA50 + BTC momentum 6h < -0.75%
 * Exit: Trailing Stop (activé à +1%) + SL 2% + Max 6h
 * Jours: Dim, Lun, Mer, Jeu (0, 1, 3, 4)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

export const MomentumConfig = {
  // Signal d'entrée
  ENTRY: {
    VOL_MULTIPLIER: 5,           // Volume > 5x moyenne 20 périodes
    BTC_MOMENTUM_MIN: 0.75,      // BTC momentum 6h > 0.75% (long) ou < -0.75% (short)
    BTC_MOMENTUM_PERIOD: 24,     // 24 bougies 15m = 6h
    ALLOWED_DAYS: [0, 1, 3, 4],  // Dim, Lun, Mer, Jeu (UTC)
  },
  
  // Exit avec Trailing Stop
  EXIT: {
    HOLD_PERIOD_MAX_MIN: 360,    // 6 heures max hold
    STOP_LOSS_PCT: 2.0,          // Stop Loss initial 2%
    // Trailing Stop Config
    TRAILING_ACTIVATION_PCT: 1.0, // Active le trailing à +1% de profit
    TRAILING_DISTANCE_PCT: 0.5,   // Trail de 0.5% sous le high (ou au-dessus du low pour short)
    TRAILING_TIGHTEN_AT_PCT: 2.0, // Resserre à 0.3% à partir de +2%
    TRAILING_TIGHT_DISTANCE_PCT: 0.3,
  },
  
  // Risk
  RISK: {
    RISK_PCT_PER_TRADE: 1.0,     // 1% du capital par trade
    MAX_POSITIONS: 4,            // Max 4 positions simultanées
  },
  
  // Assets tradés
  SYMBOLS: [
    'BTC/USDT:USDT',
    'ETH/USDT:USDT', 
    'SOL/USDT:USDT',
    'XRP/USDT:USDT',
  ],
  
  // Leverage par asset
  LEVERAGE: {
    'BTC/USDT:USDT': 3,
    'ETH/USDT:USDT': 4,
    'SOL/USDT:USDT': 5,
    'XRP/USDT:USDT': 5,
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
 * Get current market conditions status
 * Use this to display in dashboard whether conditions are favorable
 */
export function getMarketConditions(btcCandles: Candle[]): MarketConditions {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const isTradingDay = MomentumConfig.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
  
  if (btcCandles.length < 50) {
    return {
      isTradingDay,
      dayOfWeek,
      btcTrend: 'neutral',
      btcMomentum6h: 0,
      btcAboveMa50: false,
      overallStatus: 'unfavorable',
      reason: 'Insufficient BTC data',
      checkedAt: Date.now(),
    };
  }
  
  const btcCloses = btcCandles.map(c => c.close);
  const btcNow = btcCloses[btcCloses.length - 1];
  const btcMa50 = calcMA(btcCloses, 50);
  const btcAboveMa50 = btcNow > btcMa50;
  
  // BTC momentum 6h
  const btc6hAgoIndex = Math.max(0, btcCloses.length - MomentumConfig.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  // Determine trend
  let btcTrend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  if (btcMomentum6h > MomentumConfig.ENTRY.BTC_MOMENTUM_MIN && btcAboveMa50) {
    btcTrend = 'bullish';
  } else if (btcMomentum6h < -MomentumConfig.ENTRY.BTC_MOMENTUM_MIN && !btcAboveMa50) {
    btcTrend = 'bearish';
  }
  
  // Overall status
  let overallStatus: MarketConditions['overallStatus'] = 'neutral';
  let reason = '';
  
  if (!isTradingDay) {
    overallStatus = 'unfavorable';
    reason = `Not a trading day (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dayOfWeek]})`;
  } else if (btcTrend === 'bullish') {
    overallStatus = 'favorable_long';
    reason = `BTC bullish: +${btcMomentum6h.toFixed(2)}% (6h), above MA50`;
  } else if (btcTrend === 'bearish') {
    overallStatus = 'favorable_short';
    reason = `BTC bearish: ${btcMomentum6h.toFixed(2)}% (6h), below MA50`;
  } else {
    overallStatus = 'neutral';
    reason = `BTC sideways: ${btcMomentum6h.toFixed(2)}% (6h) - waiting for momentum`;
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

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avgVol > 0 ? current / avgVol : 0;
}

// ============================================================================
// SIGNAL CHECK (LONG + SHORT)
// ============================================================================

/**
 * Check momentum signal from candles - supports LONG and SHORT
 * @param symbol Trading symbol
 * @param candles Symbol candles (15m)
 * @param btcCandles BTC candles (15m) for correlation
 */
export function checkMomentumSignal(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[]
): SignalResult {
  if (candles.length < 50 || btcCandles.length < 50) {
    return { valid: false, reason: 'insufficient_candles' };
  }
  
  // Données bougie actuelle
  const current = candles[candles.length - 1];
  const { open, close } = current;
  
  // Extraire closes et volumes
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const btcCloses = btcCandles.map(c => c.close);
  
  // Calculs indicateurs
  const volRatio = calcVolRatio(volumes);
  const ma20 = calcMA(closes, 20);
  const btcMa50 = calcMA(btcCloses, 50);
  
  // BTC momentum 6h (24 bougies de 15m)
  const btcNow = btcCloses[btcCloses.length - 1];
  const btc6hAgoIndex = Math.max(0, btcCloses.length - MomentumConfig.ENTRY.BTC_MOMENTUM_PERIOD - 1);
  const btc6hAgo = btcCloses[btc6hAgoIndex];
  const btcMomentum6h = btc6hAgo > 0 ? ((btcNow - btc6hAgo) / btc6hAgo) * 100 : 0;
  
  // Conditions de base
  const isBullish = close > open;
  const isBearish = close < open;
  const priceAboveMa20 = close > ma20;
  const priceBelowMa20 = close < ma20;
  const btcAboveMa50 = btcNow > btcMa50;
  const btcBelowMa50 = btcNow < btcMa50;
  const btcMomentumBullish = btcMomentum6h > MomentumConfig.ENTRY.BTC_MOMENTUM_MIN;
  const btcMomentumBearish = btcMomentum6h < -MomentumConfig.ENTRY.BTC_MOMENTUM_MIN;
  const volOk = volRatio >= MomentumConfig.ENTRY.VOL_MULTIPLIER;
  
  // Filtre jour
  const dayOfWeek = new Date().getUTCDay();
  const dayAllowed = MomentumConfig.ENTRY.ALLOWED_DAYS.includes(dayOfWeek);
  
  const features = {
    volRatio,
    isBullish,
    priceAboveMa20,
    btcAboveMa50,
    btcMomentum6h,
    dayOfWeek,
  };
  
  // Check day first
  if (!dayAllowed) {
    return { valid: false, reason: `day_not_allowed(${dayOfWeek})`, features };
  }
  
  // Check volume
  if (!volOk) {
    return { valid: false, reason: `vol_low(${volRatio.toFixed(1)}x)`, features };
  }
  
  // ========== CHECK LONG SIGNAL ==========
  if (isBullish && priceAboveMa20 && btcAboveMa50 && btcMomentumBullish) {
    const confidence = Math.min(1, volRatio / 10 + btcMomentum6h / 5);
    return { 
      valid: true, 
      side: 'long',
      reason: 'long_signal_confirmed',
      confidence,
      features 
    };
  }
  
  // ========== CHECK SHORT SIGNAL ==========
  if (isBearish && priceBelowMa20 && btcBelowMa50 && btcMomentumBearish) {
    const confidence = Math.min(1, volRatio / 10 + Math.abs(btcMomentum6h) / 5);
    return { 
      valid: true, 
      side: 'short',
      reason: 'short_signal_confirmed',
      confidence,
      features 
    };
  }
  
  // No valid signal
  if (!isBullish && !isBearish) {
    return { valid: false, reason: 'doji_candle', features };
  }
  
  if (isBullish) {
    if (!priceAboveMa20) return { valid: false, reason: 'long_rejected:below_ma20', features };
    if (!btcAboveMa50) return { valid: false, reason: 'long_rejected:btc_below_ma50', features };
    if (!btcMomentumBullish) return { valid: false, reason: `long_rejected:btc_momentum_low(${btcMomentum6h.toFixed(2)}%)`, features };
  }
  
  if (isBearish) {
    if (!priceBelowMa20) return { valid: false, reason: 'short_rejected:above_ma20', features };
    if (!btcBelowMa50) return { valid: false, reason: 'short_rejected:btc_above_ma50', features };
    if (!btcMomentumBearish) return { valid: false, reason: `short_rejected:btc_momentum_not_bearish(${btcMomentum6h.toFixed(2)}%)`, features };
  }
  
  return { valid: false, reason: 'no_clear_signal', features };
}

// ============================================================================
// EXIT CHECK WITH TRAILING STOP
// ============================================================================

/**
 * Check if position should be closed - with intelligent trailing stop
 */
export function shouldExitPosition(
  position: Position, 
  currentPrice: number
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
  
  // 1. Time-based exit (6 heures max)
  if (holdMinutes >= MomentumConfig.EXIT.HOLD_PERIOD_MAX_MIN) {
    return { shouldExit: true, reason: 'time', pnlPct, holdMinutes };
  }
  
  // 2. Initial Stop loss (before trailing activates)
  if (pnlPct <= -MomentumConfig.EXIT.STOP_LOSS_PCT) {
    return { shouldExit: true, reason: 'stoploss', pnlPct, holdMinutes };
  }
  
  // 3. Trailing Stop Logic
  const trailingActivation = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;
  
  if (pnlPct >= trailingActivation) {
    // Trailing is active or should activate
    let trailingDistance = MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;
    
    // Tighten trailing at higher profits
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
// POSITION SIZING
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
 * Calculate position size based on risk management
 */
export function calculatePositionSize(input: PositionSizeInput): PositionSizeResult {
  const { symbol, currentPrice, totalCapitalUsd, riskPerTradePct, stopLossPct } = input;
  
  const leverage = MomentumConfig.LEVERAGE[symbol] || 4;
  const riskUsd = totalCapitalUsd * (riskPerTradePct / 100);
  const stopPrice = currentPrice * (1 - stopLossPct / 100);
  
  // Position value based on risk
  const positionValue = riskUsd / (stopLossPct / 100);
  const qty = positionValue / currentPrice;
  
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

