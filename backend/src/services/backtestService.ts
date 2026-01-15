/**
 * 🔬 Backtest Service - Unified Backtest Engine
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 OBJECTIF DU BACKTEST (NE PAS MODIFIER)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Le backtest représente le POTENTIEL IDÉAL de la stratégie:
 * - EXIT PARFAITE: Sortir exactement au trailing stop quand il est touché
 * - Le trailing stop = HWM × (1 - TRAILING_DISTANCE_PCT)
 * - Pas de slippage, pas de latence, exécution instantanée
 * 
 * C'est l'OBJECTIF que le live doit essayer d'atteindre avec:
 * - WebSocket pour mettre à jour le trailing en temps réel
 * - Ordres LIMIT au niveau du trailing stop
 * 
 * Le live devrait s'approcher à ±20% du backtest.
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Uses momentumSimple strategy helpers for entries.
 * Uses intrabar execution for stops/trailing/TP.
 * Single mode - no legacy/agent split.
 */

import {
  loadLocalJsonCandles,
  mergeDedupCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from './backtest/localOhlcvJsonStore.js';

import {
  MomentumConfig,
  checkMomentumSignal,  // V5.36: Use shared signal function (includes MTF + BTC Vol filters)
  shouldExitPosition,   // V5.41: Use shared exit function (single source of truth)
  updatePositionWaterMarks,  // V5.41: Use shared water mark update
  // V5.41: Import shared indicator functions (single source of truth)
  calcSMA,
  calcBB,
  calcROC,
  calcVolRatio,
  countConsecUp,
  countConsecDown,
  getCooldownBars,  // V5.41: Shared cooldown logic
  // V5.46 PARITY: Both backtest and live now use the same time calculation:
  // - entryTime = candle.timestamp (candle START/OPEN time)
  // - nowMs = entryTime + holdBars * 15 * 60000 (backtest) 
  //         = candleTimestamp + 15min via calculateExitNowMs() (live)
  // - holdMinutes = (nowMs - entryTime) / 60000 = holdBars * 15 (EXACT parity)
  type Position,
  type ExitSignal,
} from '../strategies/momentumSimple.js';

// V5.25: Import cached exchange client to avoid loadMarkets on every backtest
import { getCachedExchange } from '../exchange/ccxtClient.js';

// V5.25: Import global REST circuit breaker to avoid bans
import { globalRestCircuitBreaker } from './globalRestCircuitBreaker.js';

// V5.22: Import shared signal scoring function (ensures backtest = production)
import { calculateSignalScore } from '../strategies/signalRanker.js';

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


interface BacktestSimPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  entryIdx: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  capitalBefore: number;
  wasCapped: boolean;
  stopLossPct: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  appTrailingStop?: number;
  trailingBreachCandles?: number; // V5.18: Track consecutive 1m-simulated breaches (like prod)
  trailingActive?: boolean; // V5.26: Once trailing activates, it stays active
  maxPnlPct?: number;  // V5.28: Track max raw PnL % for stagnant trade detection
  entryReason?: string;  // V5.32: Track entry reason (anticipatory vs classic)
  // V5.30: Multi-position tracking
  positionIndex?: number;     // 0 = primary, 1+ = additional positions
  totalPositions?: number;    // Total positions in this group
  // V5.31: Smart Stagnant - observation window state machine
  stagnantState: {
    triggered: boolean;      // Has 60min passed without trailing activation?
    triggeredIdx?: number;   // Candle index when triggered
    triggeredAtMinutes?: number; // V5.38: Hold time in minutes when triggered
    confirmed: boolean;      // Has 150min passed without recovery?
    cancelled: boolean;      // Did we see peak >= 0.4% during observation?
    obsPeakPct: number;      // Max PnL % observed during 60-150min window
  };
}

export interface SignalOverrides {
  ROC_MIN?: number;        // Override for LONG ROC threshold (default 0.025 = 2.5%)
  VOL_MULTIPLIER?: number; // Override for LONG volume multiplier (default 1.5)
  MAX_CONSEC_UP?: number;  // Override for max consecutive up candles (default 5)
}

export interface BacktestParams {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols: string[];
  leverage: number;
  mode?: 'legacy' | 'agent'; // Ignored - kept for API compatibility
  signalOverrides?: SignalOverrides; // V5.12.1: Allow testing different entry thresholds
  trailingConfirmCandles?: number; // V5.38: How many consecutive closes to confirm trailing exit (default: 1 for live parity)
  // V5.51: Parity mode - ignores position limits to test pure signal logic
  // When true, enters on EVERY valid signal regardless of open positions
  // Used by parity verification to match exact live trade signals
  parityMode?: boolean;
  dataStartDate?: Date; // V5.47: Load data from this date (for indicator warmup) but start simulation at startDate
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  holdMinutes: number;
  grossPnlPct: number;
  netPnlPct: number;
  netPnlUsd: number;
  feesUsd: number;
  exitReason: string;
  entryReason?: string;  // V5.32: Track entry reason (anticipatory vs classic)
  capitalBefore: number;
  capitalAfter: number;
  month: string;
  day: string;
  wasCapped: boolean;
  slippagePct: number;
}

export interface MonthlyStats {
  month: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  pnlPct: number;
  longTrades: number;
  shortTrades: number;
  avgTradeUsd: number;
  maxWinUsd: number;
  maxLossUsd: number;
  capitalStart: number;
  capitalEnd: number;
}

export interface BacktestResult {
  params: BacktestParams;
  summary: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    totalPnlPct: number;
    maxDrawdownPct: number;
    avgTradeUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
    sharpeRatio: number;
    finalCapital: number;
    longTrades: number;
    shortTrades: number;
    avgHoldMinutes: number;
    totalFeesUsd: number;
  };
  trades: BacktestTrade[];
  monthlyStats: MonthlyStats[];
  equityCurve: { date: string; equity: number }[];
  drawdownCurve: { date: string; drawdown: number }[];
  // V5.51: Valid signals detected (for parity mode)
  // In parity mode, this includes ALL valid signals regardless of position limits
  validSignals?: {
    symbol: string;
    side: 'long' | 'short';
    timestamp: number;
    price: number;
    reason?: string;  // May be undefined
  }[];
}

// ============================================================================
// CONFIG (synced with MomentumConfig) - V5.27: Uses getters for dynamic values
// ============================================================================

const CONFIG = {
  // V5.27: Use getters to read MomentumConfig dynamically (for testing)
  get EXIT() {
    return {
      STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,
      TAKE_PROFIT_PCT: MomentumConfig.EXIT.PROFIT_TARGET_PCT,
      TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
      TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
      TRAILING_WIDEN_AT_PCT: MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT,
      TRAILING_WIDE_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT,
      MAX_HOLD_BARS: 192, // 48h in 15m bars
      // V5.34: Optimized stagnant trade parameters
      STAGNANT_TRADE_EXIT_ENABLED: MomentumConfig.EXIT.STAGNANT_TRADE_EXIT_ENABLED,
      STAGNANT_TRADE_TIME_MINUTES: MomentumConfig.EXIT.STAGNANT_TRADE_TIME_MINUTES,
      STAGNANT_TRADE_OBS_MINUTES: MomentumConfig.EXIT.STAGNANT_TRADE_OBS_MINUTES ?? 60,        // V5.34: 60 (was 90)
      STAGNANT_TRADE_MIN_PROFIT_PCT: MomentumConfig.EXIT.STAGNANT_TRADE_MIN_PROFIT_PCT,
      STAGNANT_TRADE_RECOVERY_PCT: MomentumConfig.EXIT.STAGNANT_TRADE_RECOVERY_PCT ?? 0.6,    // V5.34: 0.6 (was 0.4)
      STAGNANT_TRADE_TIGHTEN_SL_PCT: MomentumConfig.EXIT.STAGNANT_TRADE_TIGHTEN_SL_PCT,
      STAGNANT_TRADE_EXIT_IF_PROFIT: MomentumConfig.EXIT.STAGNANT_TRADE_EXIT_IF_PROFIT ?? false, // V5.34: false (was true)
    };
  },
  get REGIME_CHANGE_EXIT() {
    return MomentumConfig.REGIME_CHANGE_EXIT;
  },
  COSTS: {
    TRADING_FEE_PCT: 0.04, // Binance taker fee
    SLIPPAGE_PCT: 0.05, // Realistic slippage
    FUNDING_RATE_PCT: 0.01, // 8h funding
    FUNDING_INTERVAL_BARS: 32, // 32 × 15min = 8h
  },
  // V5.18: Fine-tuned capital utilization for consistent ROI scaling
  SIZING: {
    // Minimum thresholds
    MIN_AVAILABLE_CAPITAL_PCT: 0.02,     // 2% of initial capital minimum
    MIN_AVAILABLE_CAPITAL_FLOOR: 15,     // Absolute floor $15
    MIN_MARGIN_USD: 5,                   // Minimum margin per trade
    // V5.18: More moderate position sizing boost
    POSITION_SIZE_PCT_BASE: 0.40,        // 40% for small accounts
    POSITION_SIZE_PCT_BOOST_PER_5K: 0.03, // +3% per $5k capital (gentler scaling)
    POSITION_SIZE_PCT_MAX: 0.55,         // Cap at 55% (was 70%)
    // V5.18: Max concurrent positions - more aggressive scaling
    MAX_POSITIONS_BASE: 2,               // Base for tiny accounts
    POSITIONS_PER_1500: 1,               // Add 1 slot per $1.5k (faster scaling)
    MAX_POSITIONS_CAP: 10,               // Cap at 10 (was 8)
  },
};

// ============================================================================
// SIGNAL CONFIG (V5.12)
// ============================================================================

// Use production config values directly for exact parity
const SIGNAL_CONFIG = {
  LONG: {
    BB_PERIOD: MomentumConfig.ENTRY_LONG.BB_PERIOD,
    BB_STD: MomentumConfig.ENTRY_LONG.BB_STD,
    ROC_MIN: MomentumConfig.ENTRY_LONG.ROC_MIN, // V5.13: 0.0175 = 1.75% as ratio
    VOL_MULTIPLIER: MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER, // V5.13: 1.15x
    MAX_CONSEC_UP: MomentumConfig.ENTRY_LONG.MAX_CONSEC_UP,
  },
  SHORT: {
    ROC_DROP_MIN: MomentumConfig.ENTRY_SHORT.ROC_DROP_MIN, // -0.015 = -1.5% as ratio
    VOL_SPIKE: MomentumConfig.ENTRY_SHORT.VOL_SPIKE,
    MAX_CONSEC_DOWN: MomentumConfig.ENTRY_SHORT.MAX_CONSEC_DOWN,
  },
  STOCHRSI: {
    ENABLED: MomentumConfig.STOCHRSI_FILTER.ENABLED,
    MIN_STOCHRSI: MomentumConfig.STOCHRSI_FILTER.MIN_STOCHRSI,
    VOL_EXCEPTION: MomentumConfig.STOCHRSI_FILTER.VOLUME_EXCEPTION_MULTIPLIER,
  },
  // V5.33: BREAKOUT CONFIRMATION - Wait for clear confirmation before entry
  BREAKOUT_CONFIRM: MomentumConfig.BREAKOUT_CONFIRMATION,
};

// ============================================================================
// INDICATORS - V5.41: Now imported from momentumSimple.ts for single source of truth
// calcSMA, calcBB, calcROC, calcVolRatio, countConsecUp, countConsecDown
// are imported above and no longer duplicated here
// ============================================================================

// V5.23: Calculate ATR (Average True Range) as % of price
// NOTE: This returns % directly, different from momentumSimple.ts which returns absolute
function calcATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  
  const trValues: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = i > 0 ? candles[i - 1].close : candles[i].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }
  
  const atr = trValues.reduce((sum, tr) => sum + tr, 0) / period;
  const currentPrice = candles[candles.length - 1].close;
  return currentPrice > 0 ? (atr / currentPrice) * 100 : 0; // Return as %
}

// V5.23: Calculate BB position (0 = lower band, 0.5 = middle, 1 = upper band)
function calcBBPosition(candles: Candle[], period = 20, mult = 2): number {
  const bb = calcBB(candles.map(c => c.close), period, mult);
  const currentPrice = candles[candles.length - 1].close;
  
  if (bb.upper <= bb.lower) return 0.5; // Fallback
  
  // Normalize position: 0 = at lower band, 1 = at upper band
  const position = (currentPrice - bb.lower) / (bb.upper - bb.lower);
  return Math.max(0, Math.min(1, position)); // Clamp to [0, 1]
}

// V5.23: Calculate trend strength (distance from SMA50 as %)
function calcTrendStrength(closes: number[], period = 50): number {
  if (closes.length < period) return 0;
  
  const sma = calcSMA(closes, period);
  const currentPrice = closes[closes.length - 1];
  
  if (sma === 0) return 0;
  
  // Positive = uptrend, Negative = downtrend
  return (currentPrice - sma) / sma;
}

// ═══════════════════════════════════════════════════════════════════════════
// V5.32: BB SQUEEZE DETECTION - Identify volatility compression
// When bandwidth is contracting, a big move is coming (works 70%+ of the time)
// ═══════════════════════════════════════════════════════════════════════════

interface BBSqueezeResult {
  isSqueeze: boolean;
  currentBW: number;
  avgBW: number;
  squeezeRatio: number;
}

function detectBBSqueeze(
  closes: number[], 
  period: number = 20, 
  lookback: number = 10,
  threshold: number = 0.7
): BBSqueezeResult {
  if (closes.length < period + lookback) {
    return { isSqueeze: false, currentBW: 0, avgBW: 0, squeezeRatio: 1 };
  }
  
  const currentBB = calcBB(closes, period);
  const currentBW = currentBB.middle > 0 ? (currentBB.upper - currentBB.lower) / currentBB.middle : 0;
  
  const bandwidths: number[] = [];
  for (let i = lookback; i >= 1; i--) {
    const pastCloses = closes.slice(0, -i);
    if (pastCloses.length >= period) {
      const pastBB = calcBB(pastCloses, period);
      const pastBW = pastBB.middle > 0 ? (pastBB.upper - pastBB.lower) / pastBB.middle : 0;
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

function detectVolumeAccumulation(
  volumes: number[],
  lookback: number = 3,
  minTrend: number = 1.05,
  minRatio: number = 0.8
): { isAccumulating: boolean; trendScore: number; avgRatio: number } {
  if (volumes.length < lookback + 10) {
    return { isAccumulating: false, trendScore: 0, avgRatio: 0 };
  }
  
  const recentVols = volumes.slice(-lookback);
  const avgSlice = volumes.slice(-20, -lookback);
  const avgVol = avgSlice.reduce((a, b) => a + b, 0) / avgSlice.length;
  
  let trendCount = 0;
  for (let i = 1; i < recentVols.length; i++) {
    if (recentVols[i] >= recentVols[i - 1] * minTrend) {
      trendCount++;
    }
  }
  const trendScore = trendCount / (lookback - 1);
  
  const recentAvg = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const avgRatio = avgVol > 0 ? recentAvg / avgVol : 0;
  
  return {
    isAccumulating: trendScore >= 0.5 && avgRatio >= minRatio,
    trendScore,
    avgRatio,
  };
}

function calcRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcStochRSI(closes: number[], rsiPeriod = 14, stochPeriod = 14, smooth = 3): number | null {
  const minLength = rsiPeriod + stochPeriod + smooth;
  if (closes.length < minLength) return null;

  const rsiValues: number[] = [];
  for (let i = rsiPeriod + 1; i <= closes.length; i++) {
    const slice = closes.slice(0, i);
    const rsi = calcRSI(slice, rsiPeriod);
    if (rsi !== null) rsiValues.push(rsi);
  }

  if (rsiValues.length < stochPeriod) return null;

  const stochRsiRaw: number[] = [];
  for (let i = stochPeriod; i <= rsiValues.length; i++) {
    const rsiSlice = rsiValues.slice(i - stochPeriod, i);
    const rsiHigh = Math.max(...rsiSlice);
    const rsiLow = Math.min(...rsiSlice);
    const currentRsi = rsiSlice[rsiSlice.length - 1];
    if (rsiHigh === rsiLow) {
      stochRsiRaw.push(50);
    } else {
      stochRsiRaw.push(((currentRsi - rsiLow) / (rsiHigh - rsiLow)) * 100);
    }
  }

  if (stochRsiRaw.length < smooth) return null;
  const smoothSlice = stochRsiRaw.slice(-smooth);
  return smoothSlice.reduce((a, b) => a + b, 0) / smooth;
}

// Removed: Duplicate calcATR function - using V5.23 version below
// V5.41: Removed calcAdaptiveTrailing() - dead code since exit logic now uses shouldExitPosition()
// which has its own determineVolatilityRegime() for adaptive trailing

// ============================================================================
// V5.41: BACKTEST EXIT HELPER - Uses shared shouldExitPosition()
// ============================================================================
// This function wraps shouldExitPosition() for backtest use:
// - Converts BacktestSimPosition to Position type
// - Handles trailing breach counter (2-candle confirmation)
// - Maps exit reason names to backtest format (TRAIL, SL, etc.)
// ============================================================================

interface BacktestExitResult {
  shouldExit: boolean;
  exitReason: string;
  exitPrice: number;
}

function checkBacktestExit(
  pos: BacktestSimPosition,
  current: BacktestCandle,
  windowCandles: BacktestCandle[],
  btcWindowCandles: Candle[],
  idx: number,
  params: BacktestParams
): BacktestExitResult {
  const holdBars = idx - pos.entryIdx;
  const holdMinutes = holdBars * 15;
  
  // Convert BacktestSimPosition to Position for shouldExitPosition()
  const position: Position = {
    symbol: pos.symbol,
    side: pos.side,
    entryPrice: pos.entryPrice,
    entryTime: pos.entryTime,
    qty: pos.qty,
    stopLossPct: pos.stopLossPct,
    highWaterMark: pos.highWaterMark,
    lowWaterMark: pos.lowWaterMark,
    appTrailingStop: pos.appTrailingStop,
    trailingActive: pos.trailingActive,
    trailingBreachCandles: pos.trailingBreachCandles,
    maxPnlPct: pos.maxPnlPct,
    stagnantState: pos.stagnantState,
  };
  
  // Call shared exit function with timestamp override for consistent time calculation
  const exitSignal = shouldExitPosition(position, current.close, windowCandles as Candle[], {
    nowMs: pos.entryTime + holdMinutes * 60000,  // Simulate correct time
    priceHigh: current.high,
    priceLow: current.low,
    btcCandles: btcWindowCandles,
  });
  
  // Sync state back to pos (stagnant, trailing, etc.)
  if (position.stagnantState) {
    pos.stagnantState = position.stagnantState;
  }
  pos.trailingActive = position.trailingActive ?? exitSignal.trailingActivated;
  
  // Handle trailing breach counter for 2-candle confirmation
  if (exitSignal.reason === 'trailing_breach') {
    // Close breached - increment counter
    pos.trailingBreachCandles = (pos.trailingBreachCandles ?? 0) + 1;
    const confirmCandles = params.trailingConfirmCandles ?? 2;
    
    if (pos.trailingBreachCandles >= confirmCandles) {
      // ═══════════════════════════════════════════════════════════════════════
      // 🎯 EXIT PARFAITE - Sortir exactement au trailing stop (NE PAS MODIFIER)
      // ═══════════════════════════════════════════════════════════════════════
      // 
      // Le backtest représente l'IDÉAL: sortir au niveau exact du trailing stop
      // exitPrice = newStopLoss = HWM × (1 - TRAILING_DISTANCE_PCT)
      // 
      // C'est l'objectif que le live doit atteindre avec:
      // - WebSocket pour mettre à jour le trailing en temps réel
      // - Ordres LIMIT au niveau du trailing stop
      //
      const exitPrice = exitSignal.newStopLoss ?? current.close;
      
      return {
        shouldExit: true,
        exitReason: 'TRAIL',
        exitPrice,
      };
    }
    // Not yet confirmed - continue
    return { shouldExit: false, exitReason: '', exitPrice: current.close };
  } else if (exitSignal.trailingActivated && exitSignal.trailingBreached === false) {
    // Wick hit but close didn't breach - reset counter
    pos.trailingBreachCandles = 0;
  } else if (exitSignal.trailingActivated && !exitSignal.trailingBreached) {
    // Trailing active, no breach - reset counter
    pos.trailingBreachCandles = 0;
  }
  
  // Update trailing stop price if available
  if (exitSignal.newStopLoss) {
    pos.appTrailingStop = exitSignal.newStopLoss;
  }
  
  // Handle other exit signals
  if (exitSignal.shouldExit) {
    // Map reason names to backtest format
    const reasonMap: Record<string, string> = {
      'time': 'TIME',
      'regime_change': 'REGIME_CHANGE',
      'momentum_reversal': 'MOMENTUM_REVERSAL',
      'stoploss': 'SL',
      'stagnant_trade': 'STAGNANT_TRADE',
      'stagnant_profit_exit': 'STAGNANT_PROFIT_EXIT',
      'trailing': 'TRAIL',
    };
    
    const reason = exitSignal.reason ?? 'unknown';
    const exitReason = reasonMap[reason] ?? reason.toUpperCase();
    
    // Calculate exit price based on reason
    let exitPrice = current.close;
    if (exitSignal.reason === 'stoploss' || exitSignal.reason === 'stagnant_trade') {
      // Use actual stop price for SL exits
      const effectiveSlPct = exitSignal.effectiveSlPct ?? pos.stopLossPct;
      exitPrice = pos.side === 'long'
        ? pos.entryPrice * (1 - effectiveSlPct / 100)
        : pos.entryPrice * (1 + effectiveSlPct / 100);
    }
    
    return { shouldExit: true, exitReason, exitPrice };
  }
  
  return { shouldExit: false, exitReason: '', exitPrice: current.close };
}

// ============================================================================
// SIGNAL CHECK V5.12 (DEPRECATED - Kept for reference only)
// ============================================================================
// V5.36: This function is DEPRECATED and no longer used.
// We now use the shared checkMomentumSignal() from momentumSimple.ts
// to ensure 100% parity between backtest and production.
// Keeping this code for historical reference only.
// ============================================================================

interface Signal {
  valid: boolean;
  side?: 'long' | 'short';
  reason?: string;
}

function checkSignal_DEPRECATED(candles: Candle[], isBull: boolean, overrides?: SignalOverrides): Signal {
  if (candles.length < 50) return { valid: false, reason: 'insufficient_data' };

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const current = candles[candles.length - 1];
  const isBullish = current.close > current.open;
  const isBearish = current.close < current.open;

  const bb = calcBB(closes, SIGNAL_CONFIG.LONG.BB_PERIOD, SIGNAL_CONFIG.LONG.BB_STD);
  const ma20 = calcSMA(closes, 20);
  const volRatio = calcVolRatio(volumes);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const roc1 = calcROC(closes, 1);  // V5.33: Current candle momentum

  const stochRsi = SIGNAL_CONFIG.STOCHRSI.ENABLED ? calcStochRSI(closes, 14, 14, 3) : null;

  // Use overrides if provided, otherwise use default SIGNAL_CONFIG
  const rocMin = overrides?.ROC_MIN ?? SIGNAL_CONFIG.LONG.ROC_MIN;
  const volMultiplier = overrides?.VOL_MULTIPLIER ?? SIGNAL_CONFIG.LONG.VOL_MULTIPLIER;
  const maxConsecUp = overrides?.MAX_CONSEC_UP ?? SIGNAL_CONFIG.LONG.MAX_CONSEC_UP;
  
  // V5.33: Breakout confirmation config
  const confirmConfig = SIGNAL_CONFIG.BREAKOUT_CONFIRM;

  if (isBull) {
    // V5.32: ANTICIPATORY ENTRY - Catch momentum BEFORE it happens
    const anticipatoryConfig = MomentumConfig.ANTICIPATORY_ENTRY;
    
    if (anticipatoryConfig.ENABLED) {
      const squeeze = detectBBSqueeze(
        closes, 
        SIGNAL_CONFIG.LONG.BB_PERIOD, 
        anticipatoryConfig.BB_SQUEEZE_LOOKBACK,
        anticipatoryConfig.BB_SQUEEZE_THRESHOLD
      );
      
      const volAccum = detectVolumeAccumulation(
        volumes,
        anticipatoryConfig.VOL_ACCUMULATION_CANDLES,
        anticipatoryConfig.VOL_ACCUMULATION_MIN_TREND,
        anticipatoryConfig.VOL_ACCUMULATION_MIN_RATIO
      );
      
      const distanceToUpper = (bb.upper - current.close) / current.close;
      const inPreBreakoutZone = distanceToUpper <= anticipatoryConfig.PRE_BREAKOUT_ZONE_PCT / 100;
      
      const roc5Building = roc5 >= anticipatoryConfig.PRE_BREAKOUT_MIN_ROC5;
      const roc10NotExhausted = roc10 < anticipatoryConfig.PRE_BREAKOUT_MAX_ROC10;
      
      const priceAboveMa20 = current.close > ma20;
      const distanceFromMa20 = (current.close - ma20) / ma20;
      const maDistanceOk = distanceFromMa20 <= anticipatoryConfig.MAX_DISTANCE_FROM_ENTRY / 100;
      
      const bullishOk = !anticipatoryConfig.REQUIRE_BULLISH_CANDLE || isBullish;
      const priceAboveOk = !anticipatoryConfig.REQUIRE_PRICE_ABOVE_MA20 || priceAboveMa20;
      
      const anticipatoryValid = 
        squeeze.isSqueeze &&
        inPreBreakoutZone &&
        roc5Building &&
        roc10NotExhausted &&
        bullishOk &&
        priceAboveOk &&
        maDistanceOk &&
        (volAccum.isAccumulating || volRatio >= 0.9);
      
      if (anticipatoryValid) {
        return { valid: true, side: 'long', reason: 'v5.32_anticipatory_entry' };
      }
    }
    
    // FALLBACK: Classic LONG conditions V5.12 (with overrides support)
    // V5.33: Added BREAKOUT CONFIRMATION filter for higher win rate
    const breakoutOk = current.close > bb.upper;
    const rocOk = roc10 >= rocMin;
    const volOk = volRatio >= volMultiplier;
    const consecOk = countConsecUp(candles) <= maxConsecUp;
    
    // V5.33: BREAKOUT CONFIRMATION - Wait for clear breakout confirmation
    // Analysis of 30,000+ LONG breakouts shows:
    // - Distance > 0.5%: 53% WR (vs 36% baseline)
    // - Distance > 0.75%: 60% WR
    // - Distance > 1.0%: 66% WR
    const distanceFromUpper = bb.upper > 0 ? (current.close - bb.upper) / bb.upper : 0;
    const distanceOk = !confirmConfig.ENABLED || 
      distanceFromUpper >= confirmConfig.LONG_MIN_DISTANCE_PCT / 100;
    const roc1Ok = !confirmConfig.ENABLED || 
      roc1 >= confirmConfig.LONG_MIN_ROC1_PCT;
    const confirmVolOk = !confirmConfig.ENABLED || 
      volRatio >= confirmConfig.LONG_MIN_VOL_RATIO;

    if (isBullish && breakoutOk && rocOk && volOk && consecOk && distanceOk && roc1Ok && confirmVolOk) {
      return { valid: true, side: 'long', reason: `v5.33_bull_breakout|dist=${(distanceFromUpper*100).toFixed(2)}%` };
    }
  } else {
    // SHORT conditions
    // StochRSI filter
    if (stochRsi !== null && stochRsi < SIGNAL_CONFIG.STOCHRSI.MIN_STOCHRSI && volRatio < SIGNAL_CONFIG.STOCHRSI.VOL_EXCEPTION) {
      return { valid: false, reason: 'stochrsi_filter' };
    }

    const dropOk = roc5 <= SIGNAL_CONFIG.SHORT.ROC_DROP_MIN;
    const volOk = volRatio >= SIGNAL_CONFIG.SHORT.VOL_SPIKE;
    const belowMa20 = current.close < ma20;
    const belowBB = current.close < bb.lower;
    const consecOk = countConsecDown(candles) <= SIGNAL_CONFIG.SHORT.MAX_CONSEC_DOWN;
    
    // V5.33: BREAKOUT CONFIRMATION for SHORT
    // Analysis of 29,000+ SHORT breakdowns shows:
    // - Distance > 0.5%: 61% WR (vs 44% baseline)
    // - Distance > 0.75%: 66% WR
    // - Distance > 1.0%: 71% WR
    const distanceFromLower = bb.lower > 0 ? (bb.lower - current.close) / bb.lower : 0;
    const shortDistanceOk = !confirmConfig.ENABLED || 
      distanceFromLower >= confirmConfig.SHORT_MIN_DISTANCE_PCT / 100;
    const shortRoc1Ok = !confirmConfig.ENABLED || 
      roc1 <= confirmConfig.SHORT_MAX_ROC1_PCT;
    const shortConfirmVolOk = !confirmConfig.ENABLED || 
      volRatio >= confirmConfig.SHORT_MIN_VOL_RATIO;

    if (isBearish && dropOk && volOk && belowMa20 && belowBB && consecOk && shortDistanceOk && shortRoc1Ok && shortConfirmVolOk) {
      return { valid: true, side: 'short', reason: `v5.33_bear_breakdown|dist=${(distanceFromLower*100).toFixed(2)}%` };
    }
  }

  return { valid: false, reason: 'no_signal' };
}

// ============================================================================
// DATA FETCHING
// ============================================================================

// V5.24: Remove global exchange instance to prevent rate limiting issues
// Exchange will be created per backtest run and markets pre-loaded once

async function fetchCandlesFromCcxt(
  exchange: any,
  symbol: string,
  since: number,
  until: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = since;

  while (cursor < until) {
    try {
      // V5.25: Check circuit breaker before each REST call
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        console.error(`[Backtest] 🚫 REST circuit breaker is OPEN - cannot fetch ${symbol}`);
        console.error(`[Backtest] Please wait for rate limit to expire before running backtest`);
        throw new Error('REST_CIRCUIT_BREAKER_OPEN');
      }
      
      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
      if (!ohlcv || ohlcv.length === 0) break;

      let progressed = false;
      for (const c of ohlcv) {
        const ts = c[0] as number;
        if (!Number.isFinite(ts)) continue;
        if (ts > until) break;
        if (out.length && ts <= out[out.length - 1].timestamp) continue;
        out.push({
          timestamp: ts,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
        progressed = true;
      }

      if (!progressed) break;
      cursor = (ohlcv[ohlcv.length - 1][0] as number) + 1;
      // V5.25: Increase delay significantly to prevent rate limiting (was 250ms, now 500ms)
      await new Promise((r) => setTimeout(r, 500));
    } catch (e: any) {
      // V5.25: Handle rate limit errors properly
      if (e?.message?.includes('418') || e?.message?.includes('banned') || e?.message?.includes('-1003')) {
        // Extract ban timestamp if present
        const match = e.message?.match(/banned until (\d+)/);
        if (match) {
          const banUntil = parseInt(match[1], 10);
          globalRestCircuitBreaker.forceOpen(`Backtest banned: ${symbol}`, banUntil);
        } else {
          globalRestCircuitBreaker.forceOpen(`Backtest rate limited: ${symbol}`);
        }
      }
      console.error(`Error fetching ${symbol}:`, e);
      break;
    }
  }

  return out;
}

async function fetchCandles(
  exchange: any,
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Candle[]> {
  const until = endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000; // 200 bars × 15min
  const since = startDate.getTime() - extraBarsMs;

  const local = await loadLocalJsonCandles(symbol, '15m');
  if (!local) {
    return await fetchCandlesFromCcxt(exchange, symbol, since, until);
  }

  const needBefore = since < local.startTs;
  const needAfter = until > local.endTs;

  const localSlice = sliceCandlesByTime(local.candles, since, until);
  const parts: BacktestCandle[][] = [localSlice];

  if (needBefore) {
    const beforeCandles = await fetchCandlesFromCcxt(exchange, symbol, since, local.startTs - 1);
    parts.unshift(beforeCandles);
  }
  if (needAfter) {
    const afterCandles = await fetchCandlesFromCcxt(exchange, symbol, local.endTs + 1, until);
    parts.push(afterCandles);
  }

  return mergeDedupCandles(parts);
}

// V5.36: Fetch 1h candles for Multi-Timeframe Confluence filter
async function fetchCandles1h(
  exchange: any,
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Candle[]> {
  const out: Candle[] = [];
  const until = endDate.getTime();
  const extraBarsMs = 50 * 60 * 60 * 1000; // 50 bars × 1h
  let cursor = startDate.getTime() - extraBarsMs;

  while (cursor < until) {
    try {
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        console.error(`[Backtest] 🚫 REST circuit breaker is OPEN - cannot fetch 1h ${symbol}`);
        throw new Error('REST_CIRCUIT_BREAKER_OPEN');
      }

      const ohlcv = await exchange.fetchOHLCV(symbol, '1h', cursor, 1000);
      if (!ohlcv || ohlcv.length === 0) break;

      let progressed = false;
      for (const c of ohlcv) {
        const ts = c[0] as number;
        if (!Number.isFinite(ts)) continue;
        if (ts > until) break;
        if (out.length && ts <= out[out.length - 1].timestamp) continue;
        out.push({
          timestamp: ts,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        });
        progressed = true;
      }

      if (!progressed) break;
      cursor = (ohlcv[ohlcv.length - 1][0] as number) + 1;
      await new Promise((r) => setTimeout(r, 500));
    } catch (e: any) {
      if (e?.message?.includes('418') || e?.message?.includes('banned') || e?.message?.includes('-1003')) {
        const match = e.message?.match(/banned until (\d+)/);
        if (match) {
          const banUntil = parseInt(match[1], 10);
          globalRestCircuitBreaker.forceOpen(`Backtest 1h banned: ${symbol}`, banUntil);
        } else {
          globalRestCircuitBreaker.forceOpen(`Backtest 1h rate limited: ${symbol}`);
        }
      }
      console.error(`Error fetching 1h ${symbol}:`, e);
      break;
    }
  }

  return out;
}

// ============================================================================
// PNL CALCULATION
// ============================================================================

function calculatePnl(
  entryPrice: number,
  exitPrice: number,
  side: 'long' | 'short',
  marginUsd: number,
  leverage: number,
  holdBars: number,
): { grossPnlPct: number; netPnlPct: number; netPnlUsd: number; feesUsd: number } {
  // Calculate price change percentage
  const pricePct =
    side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

  // Calculate notional
  const notionalUsd = marginUsd * leverage;

  // PnL$ = price change % applied to notional (this is the absolute profit/loss in dollars)
  const grossPnlUsd = (pricePct / 100) * notionalUsd;

  // Costs in $ (calculated as % of notional)
  const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2; // Entry + Exit (0.08%)
  const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2; // (0.10%)
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;
  
  const totalCostsNotionalPct = tradingFees + slippage + funding; // % of notional
  const feesUsd = (totalCostsNotionalPct / 100) * notionalUsd;
  
  const netPnlUsd = grossPnlUsd - feesUsd;

  // PnL% on margin (ROE) for display purposes
  const grossPnlPct = (grossPnlUsd / marginUsd) * 100;
  const netPnlPct = (netPnlUsd / marginUsd) * 100;

  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd };
}

// ============================================================================
// MAIN BACKTEST FUNCTION
// ============================================================================

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const { startDate, endDate, initialCapital, symbols, leverage, signalOverrides, dataStartDate ,parityMode} = params;

  console.log(`[Backtest] Fetching data for ${symbols.length} symbols...`);

  // V5.25: Check circuit breaker BEFORE starting backtest
  if (!globalRestCircuitBreaker.canMakeRequest()) {
    throw new Error('REST circuit breaker is OPEN - Binance rate limit active. Please wait before running backtest.');
  }

  // V5.25: Use cached exchange to avoid loadMarkets on every backtest
  // getCachedExchange() loads markets ONCE and caches them globally
  const exchange = await getCachedExchange();
  
  console.log(`[Backtest] Exchange ready (using cached markets - 0 API weight)`);

  // V5.47: Use dataStartDate for loading data (indicator warmup) if provided, otherwise startDate
  const dataLoadStart = dataStartDate || startDate;

  // Fetch BTC for regime detection
  const btcCandles = await fetchCandles(exchange, 'BTC/USDT:USDT', dataLoadStart, endDate);
  const btcCloses = btcCandles.map((c) => c.close);
  console.log(`[Backtest] BTC 15m: ${btcCandles.length} candles`);

  // V5.36: Fetch BTC 1h candles for Multi-Timeframe Confluence filter
  const btcCandles1h = await fetchCandles1h(exchange, 'BTC/USDT:USDT', dataLoadStart, endDate);
  console.log(`[Backtest] BTC 1h: ${btcCandles1h.length} candles`);

  // V5.25: Add delay between symbols to avoid rate limiting
  const allData: Record<string, Candle[]> = {};
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    // Wait 1 second between each symbol to spread API calls
    if (i > 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
    allData[symbol] = await fetchCandles(exchange, symbol, dataLoadStart, endDate);
    console.log(`[Backtest] ${symbol}: ${allData[symbol].length} candles`);
  }

  // Track per-symbol candle cursor (avoid O(n²) findIndex)
  const symbolIdx: Record<string, number> = {};
  for (const symbol of symbols) symbolIdx[symbol] = -1;

  // Initialize state
  let capital = initialCapital;
  let capitalInUse = 0;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const drawdownCurve: { date: string; drawdown: number }[] = [];
  let tradeId = 0;

  const positions: Record<string, BacktestSimPosition | null> = {};
  // V5.30: Multi-position support - store additional positions per symbol
  const multiPositions: Record<string, BacktestSimPosition[]> = {};
  const cooldowns: Record<string, number> = {};
  symbols.forEach((s) => {
    positions[s] = null;
    multiPositions[s] = [];
    cooldowns[s] = 0;
  });

  // Find start index (need 200 bars for SMA200)
  const startTimestamp = startDate.getTime();
  let startIdx = btcCandles.findIndex((c) => c.timestamp >= startTimestamp);
  if (startIdx < 200) startIdx = 200;

  console.log(`[Backtest] Starting simulation at index ${startIdx}...`);

  // V5.51: In parity mode, collect ALL valid signals for matching with live trades
  // This captures signals even when position is already open on same symbol
  type ValidSignal = NonNullable<BacktestResult['validSignals']>[number];
  const allValidSignals: ValidSignal[] = [];

  // Main loop - iterate over BTC candles
  for (let btcIdx = startIdx; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];

    if (btcCandle.timestamp < startTimestamp) continue;
    if (btcCandle.timestamp > endDate.getTime()) break;

    // Prevent event-loop starvation
    if (btcIdx % 25 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const day = new Date(btcCandle.timestamp).toISOString().slice(0, 10);

    // Track equity
    const totalEquity = capital + capitalInUse;
    if (equityCurve.length === 0 || equityCurve[equityCurve.length - 1].date !== day) {
      equityCurve.push({ date: day, equity: totalEquity });

      if (totalEquity > peakCapital) peakCapital = totalEquity;
      const drawdownPct = ((peakCapital - totalEquity) / peakCapital) * 100;
      if (drawdownPct > maxDrawdown) maxDrawdown = drawdownPct;
      drawdownCurve.push({ date: day, drawdown: drawdownPct });
    }

    // ═══════════════════════════════════════════════════════════════════
    // V5.22: COLLECT SIGNALS FOR RANKING (Phase 1: Exits + Signal Detection)
    // ═══════════════════════════════════════════════════════════════════
    type SignalCandidate = {
      symbol: string;
      signal: { valid: boolean; side: 'long' | 'short'; reason?: string; };  // V5.32: Include reason
      score: number;
      candles: BacktestCandle[];
      current: BacktestCandle;
      idx: number;
      isBullRegime: boolean;
    };
    
    const signalCandidates: SignalCandidate[] = [];
    
    // Process each symbol - handle exits and collect entry signals
    for (const symbol of symbols) {
      const candles = allData[symbol];
      let idx = symbolIdx[symbol];

      // Find the latest CLOSED candle for this symbol
      // Candle timestamps are open-times, so "closed" means timestamp < btcCandle.timestamp
      while (idx + 1 < candles.length && candles[idx + 1].timestamp < btcCandle.timestamp) {
        idx += 1;
      }

      symbolIdx[symbol] = idx;
      if (idx < 50) continue;
      if (idx >= candles.length) continue;

      const windowCandles = candles.slice(Math.max(0, idx - 200), idx + 1);
      const current = candles[idx];

      // Decrement cooldown
      if (cooldowns[symbol] > 0) cooldowns[symbol]--;

      // ═══════════════════════════════════════════════════════════════════
      // MANAGE EXISTING POSITION (Exits processed immediately)
      // ═══════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;

        // Calculate current PnL %
        const pnlPct =
          pos.side === 'long'
            ? ((current.close - pos.entryPrice) / pos.entryPrice) * 100
            : ((pos.entryPrice - current.close) / pos.entryPrice) * 100;

        // Update water marks with candle extremes
        if (pos.side === 'long') {
          pos.highWaterMark = Math.max(pos.highWaterMark ?? pos.entryPrice, current.high);
        } else {
          pos.lowWaterMark = Math.min(pos.lowWaterMark ?? pos.entryPrice, current.low);
        }
        
        // V5.30: Update water marks for multi-positions too
        for (const multiPos of multiPositions[symbol]) {
          if (multiPos.side === 'long') {
            multiPos.highWaterMark = Math.max(multiPos.highWaterMark ?? multiPos.entryPrice, current.high);
          } else {
            multiPos.lowWaterMark = Math.min(multiPos.lowWaterMark ?? multiPos.entryPrice, current.low);
          }
          multiPos.maxPnlPct = Math.max(multiPos.maxPnlPct ?? 0, pnlPct);
        }
        
        // V5.28: Track max raw PnL % for stagnant trade detection
        pos.maxPnlPct = Math.max(pos.maxPnlPct ?? 0, pnlPct);

        // V5.41: Use shared shouldExitPosition() via helper function
        // This ensures 100% parity between backtest and production exit logic
        
        // V5.44 FIX: Use PREVIOUS CLOSED candle for BTC data (like live does)
        // 
        // PROBLEM: Live at 15:15:02 uses candle 15:00 (last CLOSED) because 15:15 is still forming.
        //          Backtest at 15:15 was using candle 15:15 (finalized historical data).
        //          This caused volume confirmation to differ:
        //          - Live @ 15:00: volRatio=1.39x < 1.5x → REGIME_CHANGE NOT confirmed → STAGNANT_TRADE
        //          - Backtest @ 15:15: volRatio=2.62x >= 1.5x → REGIME_CHANGE confirmed
        // 
        // FIX: Backtest should use candles BEFORE the current timestamp, not INCLUDING it.
        //      This simulates what live sees: only closed candles, not the one in progress.
        //
        // V5.43 logic found btcIdxForExit where timestamp <= current.timestamp
        // V5.44 now uses btcIdxForExit - 1 to exclude the current candle (simulating "in progress")
        let btcIdxForExit = btcIdx;
        while (btcIdxForExit > 0 && btcCandles[btcIdxForExit].timestamp > current.timestamp) {
          btcIdxForExit--;
        }
        // V5.44: Exclude current candle to match live behavior (use only CLOSED candles)
        if (btcIdxForExit > 0 && btcCandles[btcIdxForExit].timestamp === current.timestamp) {
          btcIdxForExit--;
        }
        
        const btcWindowStart = Math.max(0, btcIdxForExit - 200);
        const btcWindowCandles = btcCandles.slice(btcWindowStart, btcIdxForExit + 1);
        
        const exitResult = checkBacktestExit(
          pos, 
          current, 
          windowCandles, 
          btcWindowCandles as Candle[], 
          idx, 
          params
        );
        
        const shouldExit = exitResult.shouldExit;
        const exitReason = exitResult.exitReason;
        const exitPrice = exitResult.exitPrice;

        if (shouldExit) {
          const pnl = calculatePnl(
            pos.entryPrice,
            exitPrice,
            pos.side,
            pos.marginUsd,
            pos.leverage,
            holdBars,
          );
          capital += pnl.netPnlUsd + pos.marginUsd;
          capitalInUse -= pos.marginUsd;

          const month = new Date(current.timestamp).toISOString().slice(0, 7);
          const exitDay = new Date(current.timestamp).toISOString().slice(0, 10);

          trades.push({
            id: `trade_${++tradeId}`,
            symbol,
            side: pos.side,
            entryTime: new Date(pos.entryTime).toISOString(),
            exitTime: new Date(current.timestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            qty: pos.qty,
            notionalUsd: pos.notionalUsd,
            marginUsd: pos.marginUsd,
            leverage: pos.leverage,
            holdMinutes: holdBars * 15,
            grossPnlPct: pnl.grossPnlPct,
            netPnlPct: pnl.netPnlPct,
            netPnlUsd: pnl.netPnlUsd,
            feesUsd: pnl.feesUsd,
            exitReason,
            entryReason: pos.entryReason,  // V5.32: Track entry reason
            capitalBefore: pos.capitalBefore,
            capitalAfter: capital + capitalInUse, // Total capital (free + in use)
            month,
            day: exitDay,
            wasCapped: pos.wasCapped,
            slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
          });

          // V5.30: Close and record multi-positions as separate trades
          for (const multiPos of multiPositions[symbol]) {
            const multiHoldBars = idx - multiPos.entryIdx;
            const multiPnl = calculatePnl(
              multiPos.entryPrice,
              exitPrice,
              multiPos.side,
              multiPos.marginUsd,
              multiPos.leverage,
              multiHoldBars,
            );
            capital += multiPnl.netPnlUsd + multiPos.marginUsd;
            capitalInUse -= multiPos.marginUsd;

            trades.push({
              id: `trade_${++tradeId}`,
              symbol,
              side: multiPos.side,
              entryTime: new Date(multiPos.entryTime).toISOString(),
              exitTime: new Date(current.timestamp).toISOString(),
              entryPrice: multiPos.entryPrice,
              exitPrice,
              qty: multiPos.qty,
              notionalUsd: multiPos.notionalUsd,
              marginUsd: multiPos.marginUsd,
              leverage: multiPos.leverage,
              holdMinutes: multiHoldBars * 15,
              grossPnlPct: multiPnl.grossPnlPct,
              netPnlPct: multiPnl.netPnlPct,
              netPnlUsd: multiPnl.netPnlUsd,
              feesUsd: multiPnl.feesUsd,
              exitReason: `${exitReason}_MULTI${multiPos.positionIndex}`,
              entryReason: multiPos.entryReason,
              capitalBefore: multiPos.capitalBefore,
              capitalAfter: capital + capitalInUse,
              month,
              day: exitDay,
              wasCapped: multiPos.wasCapped,
              slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
            });
          }
          multiPositions[symbol] = []; // Clear multi-positions

          positions[symbol] = null;
          
          // V5.41: Use shared cooldown logic from momentumSimple.ts
          cooldowns[symbol] = getCooldownBars(exitReason);
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // COLLECT ENTRY SIGNAL (V5.22: Don't enter yet, collect for ranking)
      // ═══════════════════════════════════════════════════════════════════
      // V5.51: In parity mode, collect signals even if position is open
      // This allows finding all valid signals to match live trades that entered later
      const canCollectSignal = parityMode || (!positions[symbol] && cooldowns[symbol] <= 0);
      
      if (canCollectSignal) {
        // 🔧 FIX V5.43: availableCapital = capital (free capital)
        // `capital` is already the free capital (total - inUse), no need to subtract again
        const availableCapital = capital;
        
        // V5.51: In parity mode, skip capital check - testing pure signal logic
        if (!parityMode) {
          // V5.17: Low minimum to maximize trade opportunities
          const minAvailableCapital = Math.max(
            initialCapital * CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_PCT,
            CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_FLOOR
          );
          if (availableCapital < minAvailableCapital) continue;
        }

        // BTC regime: use PRIOR BTC close for regime (avoid look-ahead)
        const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
        const btcPriceForRegime = btcIdx > 0 ? btcCloses[btcIdx - 1] : btcCloses[0];
        const isBullRegime = btcPriceForRegime > btcSma200;

        // V5.39 FIX: Get BTC 1h window for MTF filter - only CLOSED candles (aligned with live)
        // Previously included candle in progress, which could cause look-ahead bias
        const CANDLE_1H_INTERVAL_MS = 60 * 60 * 1000;
        const btcCandles1hWindow = btcCandles1h.filter(c => c.timestamp + CANDLE_1H_INTERVAL_MS <= btcCandle.timestamp);

        // V5.36: Use shared checkMomentumSignal (includes MTF + BTC Vol filters)
        // This ensures 100% parity with production signal logic
        const signal = checkMomentumSignal(
          symbol,
          windowCandles,
          btcCandles.slice(Math.max(0, btcIdx - 200), btcIdx + 1), // BTC 15m candles for volatility filter
          {
            nowMs: btcCandle.timestamp,
            btcCandles1h: btcCandles1hWindow, // V5.36: Pass 1h candles for MTF filter
          }
        );
        if (!signal.valid || !signal.side) continue;
        
        // V5.51: In parity mode, collect ALL valid signals for matching with live trades
        // This allows finding the exact signal that matched a live trade entry time
        if (parityMode) {
          allValidSignals.push({
            symbol,
            side: signal.side!,
            timestamp: current.timestamp,
            price: current.close,
            reason: signal.reason,
          });
        }
        
        // V5.23: Calculate enhanced signal quality score
        const closes = windowCandles.map(c => c.close);
        const volumes = windowCandles.map(c => c.volume);
        
        // Core indicators
        const roc5 = calcROC(closes, 5);
        const volumeRatio = volumes[volumes.length - 1] / (volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19);
        
        // V5.23: New indicators for enhanced scoring
        const bbPosition = calcBBPosition(windowCandles, 20, 2);
        const atrPct = calcATR(windowCandles, 14);
        const trendStrength = calcTrendStrength(closes, 50);
        
        // V5.23: Use enhanced multi-factor scoring
        const score = calculateSignalScore({
          roc5,
          volumeRatio,
          bbPosition,
          atrPct,
          trendStrength,
          side: signal.side!,
        });
        
        // Add to candidates for ranking (signal.side guaranteed non-null here)
        signalCandidates.push({
          symbol,
          signal: { valid: signal.valid, side: signal.side!, reason: signal.reason },  // V5.32: Include reason
          score,
          candles: windowCandles,
          current,
          idx,
          isBullRegime
        });
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // V5.22: RANK SIGNALS AND ENTER BEST OPPORTUNITIES (Phase 2: Entries)
    // ═══════════════════════════════════════════════════════════════════
    if (signalCandidates.length > 0) {
      // Count current open positions
      const openPositionCount = Object.values(positions).filter(p => p !== null).length;
      
      // V5.51: In parity mode, ignore global position limits
      // We only care about per-symbol limits (1 position per symbol at a time)
      // This allows testing pure signal logic without capital/slot constraints
      let availableSlots: number;
      
      if (parityMode) {
        // In parity mode, allow unlimited concurrent positions across symbols
        // But still respect per-symbol limit (handled below by checking positions[symbol])
        availableSlots = signalCandidates.length; // Allow all signals
      } else {
        // V5.18: Dynamic max positions
        const maxPositions = Math.min(
          CONFIG.SIZING.MAX_POSITIONS_BASE + Math.floor(initialCapital / 1500) * CONFIG.SIZING.POSITIONS_PER_1500,
          CONFIG.SIZING.MAX_POSITIONS_CAP
        );
        availableSlots = maxPositions - openPositionCount;
      }
      
      if (availableSlots > 0) {
        // RANK by score (highest first)
        signalCandidates.sort((a, b) => b.score - a.score);
        
        // Take top N signals that fit available slots
        const signalsToEnter = signalCandidates.slice(0, availableSlots);
        
        for (const candidate of signalsToEnter) {
          const { symbol, signal, current, idx } = candidate;
          // 🔧 FIX V5.43: availableCapital = capital (free capital)
          // `capital` is already the free capital (total - inUse), no need to subtract again
          const availableCapital = capital;
          
          // V5.51: In parity mode, skip capital checks - we're testing pure signal logic
          if (!parityMode) {
            // Double-check capital still available
            const minAvailableCapital = Math.max(
              initialCapital * CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_PCT,
              CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_FLOOR
            );
            if (availableCapital < minAvailableCapital) break;
          }

          // V5.18: Keep leverage high for all accounts
          const posLev = leverage || 5;

          // V5.18: Dynamic position sizing - moderate boost for bigger accounts
          const positionSizePct = Math.min(
            CONFIG.SIZING.POSITION_SIZE_PCT_BASE + (initialCapital / 5000) * CONFIG.SIZING.POSITION_SIZE_PCT_BOOST_PER_5K,
            CONFIG.SIZING.POSITION_SIZE_PCT_MAX
          );
          let marginUsd = availableCapital * positionSizePct;
          let notionalUsd = marginUsd * posLev;

          // Apply liquidity caps (aligned with prod LIQUIDITY_CONFIG)
          const LIQUIDITY_CAPS: Record<string, number> = {
            // Tier HIGH: $500K
            'BTC/USDT:USDT': 500_000,
            'ETH/USDT:USDT': 500_000,
            // Tier MEDIUM: $100K
            'XRP/USDT:USDT': 100_000,
            'SOL/USDT:USDT': 100_000,
            'DOGE/USDT:USDT': 100_000,
            'ADA/USDT:USDT': 100_000,
            'AVAX/USDT:USDT': 100_000,
            'LINK/USDT:USDT': 100_000,
            'LTC/USDT:USDT': 100_000,
            'BCH/USDT:USDT': 100_000,
            'UNI/USDT:USDT': 100_000,
            // Tier LOW: $25K
            'SEI/USDT:USDT': 25_000,
            'IMX/USDT:USDT': 25_000,
            'DOT/USDT:USDT': 25_000,
            'SUI/USDT:USDT': 25_000,
            'SONIC/USDT:USDT': 25_000,
            'APT/USDT:USDT': 25_000,
          };
          const cap = LIQUIDITY_CAPS[symbol] ?? Infinity;
          const wasCapped = Number.isFinite(cap) && notionalUsd > cap;
          
          // V5.30: Multi-position logic for large accounts hitting liquidity caps
          // Only activate for accounts >= $30K with MULTI_POSITION_ENABLED=true
          const MULTI_POSITION_ENABLED = process.env.MULTI_POSITION_ENABLED === 'true';
          const MULTI_POSITION_MIN_CAPITAL = 30_000;
          
          // V5.35: Use CURRENT capital, not initial capital (allows growing into multi-position)
          const currentTotalCapital = capital + capitalInUse;
          
          let totalPositions = 1;
          let totalMarginUsd = marginUsd;
          let totalNotionalUsd = notionalUsd;
          
          if (wasCapped && MULTI_POSITION_ENABLED && currentTotalCapital >= MULTI_POSITION_MIN_CAPITAL) {
            // Calculate how many positions we need
            const targetNotional = marginUsd * posLev;
            const idealPositions = Math.ceil(targetNotional / cap);
            
            // Cap by capital tier - use current capital, not initial
            const capitalTiers: { [minCap: number]: number } = {
              300_000: 5,
              150_000: 4,
              75_000: 3,
              30_000: 2,
            };
            let maxPositions = 1;
            for (const [minCap, positions] of Object.entries(capitalTiers).sort((a, b) => Number(b[0]) - Number(a[0]))) {
              if (currentTotalCapital >= Number(minCap)) {
                maxPositions = positions;
                break;
              }
            }
            
            totalPositions = Math.min(idealPositions, maxPositions);
            
            if (totalPositions > 1) {
              // V5.30: Create SEPARATE positions instead of one big one
              // Each position uses cap notional
              const perPosNotional = cap;
              const perPosMargin = perPosNotional / posLev;
              
              // Make sure we have enough capital for all positions
              const totalNeededMargin = perPosMargin * totalPositions;
              if (totalNeededMargin > availableCapital * 0.95) {
                totalPositions = Math.floor((availableCapital * 0.95) / perPosMargin);
                if (totalPositions < 1) totalPositions = 1;
              }
              
              // Primary position uses cap
              notionalUsd = perPosNotional;
              marginUsd = perPosMargin;
              
              // Create additional positions (will be stored in multiPositions array)
              for (let posIdx = 1; posIdx < totalPositions; posIdx++) {
                const addQty = perPosNotional / current.close;
                capitalInUse += perPosMargin;
                capital -= perPosMargin;
                
                multiPositions[symbol].push({
                  symbol,
                  side: signal.side,
                  entryPrice: current.close * (1 + (posIdx * 0.003 * (signal.side === 'long' ? -1 : 1))), // Slight price spread
                  entryTime: current.timestamp,
                  entryIdx: idx,
                  qty: addQty,
                  notionalUsd: perPosNotional,
                  marginUsd: perPosMargin,
                  leverage: posLev,
                  capitalBefore: capital + perPosMargin,
                  wasCapped: true,
                  stopLossPct: CONFIG.EXIT.STOP_LOSS_PCT,
                  highWaterMark: signal.side === 'long' ? current.close : undefined,
                  lowWaterMark: signal.side === 'short' ? current.close : undefined,
                  entryReason: `${signal.reason}_MULTI${posIdx}`,
                  positionIndex: posIdx,
                  totalPositions,
                  stagnantState: { triggered: false, confirmed: false, cancelled: false, obsPeakPct: 0 }
                });
              }
            }
          } else if (wasCapped) {
            notionalUsd = cap;
            marginUsd = notionalUsd / posLev;
          }

          const qty = notionalUsd / current.close;
          if (!Number.isFinite(qty) || qty <= 0) continue;
          // V5.13: Lower minimum margin for small accounts
          if (marginUsd < CONFIG.SIZING.MIN_MARGIN_USD) continue;

          const slPct = CONFIG.EXIT.STOP_LOSS_PCT;

          capitalInUse += marginUsd;
          capital -= marginUsd;

          positions[symbol] = {
            symbol,
            side: signal.side,
            entryPrice: current.close,
            entryTime: current.timestamp,
            entryIdx: idx,
            qty,
            notionalUsd,
            marginUsd,
            leverage: posLev,
            capitalBefore: capital + marginUsd,
            wasCapped,
            stopLossPct: slPct,
            highWaterMark: signal.side === 'long' ? current.close : undefined,
            lowWaterMark: signal.side === 'short' ? current.close : undefined,
            entryReason: signal.reason,  // V5.32: Track entry reason
            // V5.30: Multi-position tracking
            positionIndex: 0,
            totalPositions,
            // V5.31: Smart Stagnant state initialization
            stagnantState: {
              triggered: false,
              confirmed: false,
              cancelled: false,
              obsPeakPct: 0
            }
          };
          
          // V5.30: Log multi-position if activated
          if (totalPositions > 1) {
            console.log(`📊 [BT] ${symbol} MULTI-POS: ${totalPositions}x positions | totalNotional=$${notionalUsd.toFixed(0)} | totalMargin=$${marginUsd.toFixed(0)}`);
          }
        }
      }
    }
  }

  // Close any remaining positions at market
  for (const symbol of symbols) {
    if (positions[symbol]) {
      const pos = positions[symbol]!;
      const candles = allData[symbol];
      const lastCandle = candles[candles.length - 1];
      const holdBars = candles.length - pos.entryIdx;

      const pnl = calculatePnl(
        pos.entryPrice,
        lastCandle.close,
        pos.side,
        pos.marginUsd,
        pos.leverage,
        holdBars,
      );
      capital += pnl.netPnlUsd + pos.marginUsd;
      capitalInUse -= pos.marginUsd;

      trades.push({
        id: `trade_${++tradeId}`,
        symbol,
        side: pos.side,
        entryTime: new Date(pos.entryTime).toISOString(),
        exitTime: new Date(lastCandle.timestamp).toISOString(),
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        qty: pos.qty,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
        leverage: pos.leverage,
        holdMinutes: holdBars * 15,
        grossPnlPct: pnl.grossPnlPct,
        netPnlPct: pnl.netPnlPct,
        netPnlUsd: pnl.netPnlUsd,
        feesUsd: pnl.feesUsd,
        exitReason: 'END',
        entryReason: pos.entryReason,  // V5.32: Track entry reason
        capitalBefore: pos.capitalBefore,
        capitalAfter: capital + capitalInUse, // Total capital (free + in use)
        month: new Date(lastCandle.timestamp).toISOString().slice(0, 7),
        day: new Date(lastCandle.timestamp).toISOString().slice(0, 10),
        wasCapped: pos.wasCapped,
        slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
      });

      // V5.30: Close and record remaining multi-positions
      for (const multiPos of multiPositions[symbol]) {
        const multiHoldBars = candles.length - multiPos.entryIdx;
        const multiPnl = calculatePnl(
          multiPos.entryPrice,
          lastCandle.close,
          multiPos.side,
          multiPos.marginUsd,
          multiPos.leverage,
          multiHoldBars,
        );
        capital += multiPnl.netPnlUsd + multiPos.marginUsd;
        capitalInUse -= multiPos.marginUsd;

        trades.push({
          id: `trade_${++tradeId}`,
          symbol,
          side: multiPos.side,
          entryTime: new Date(multiPos.entryTime).toISOString(),
          exitTime: new Date(lastCandle.timestamp).toISOString(),
          entryPrice: multiPos.entryPrice,
          exitPrice: lastCandle.close,
          qty: multiPos.qty,
          notionalUsd: multiPos.notionalUsd,
          marginUsd: multiPos.marginUsd,
          leverage: multiPos.leverage,
          holdMinutes: multiHoldBars * 15,
          grossPnlPct: multiPnl.grossPnlPct,
          netPnlPct: multiPnl.netPnlPct,
          netPnlUsd: multiPnl.netPnlUsd,
          feesUsd: multiPnl.feesUsd,
          exitReason: `END_MULTI${multiPos.positionIndex}`,
          entryReason: multiPos.entryReason,
          capitalBefore: multiPos.capitalBefore,
          capitalAfter: capital + capitalInUse,
          month: new Date(lastCandle.timestamp).toISOString().slice(0, 7),
          day: new Date(lastCandle.timestamp).toISOString().slice(0, 10),
          wasCapped: multiPos.wasCapped,
          slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
        });
      }
      multiPositions[symbol] = [];
    }
  }

  // Calculate monthly stats
  const monthlyMap = new Map<string, BacktestTrade[]>();
  trades.forEach((t) => {
    if (!monthlyMap.has(t.month)) monthlyMap.set(t.month, []);
    monthlyMap.get(t.month)!.push(t);
  });

  const monthlyStats: MonthlyStats[] = [];
  let prevCapital = initialCapital;

  for (const [month, monthTrades] of [...monthlyMap.entries()].sort()) {
    const wins = monthTrades.filter((t) => t.netPnlUsd > 0).length;
    const losses = monthTrades.filter((t) => t.netPnlUsd <= 0).length;
    const pnlUsd = monthTrades.reduce((sum, t) => sum + t.netPnlUsd, 0);
    const longTrades = monthTrades.filter((t) => t.side === 'long').length;
    const shortTrades = monthTrades.filter((t) => t.side === 'short').length;

    const capitalEnd =
      monthTrades.length > 0 ? monthTrades[monthTrades.length - 1].capitalAfter : prevCapital;

    monthlyStats.push({
      month,
      trades: monthTrades.length,
      wins,
      losses,
      winRate: monthTrades.length > 0 ? (wins / monthTrades.length) * 100 : 0,
      pnlUsd,
      pnlPct: prevCapital > 0 ? (pnlUsd / prevCapital) * 100 : 0,
      longTrades,
      shortTrades,
      avgTradeUsd: monthTrades.length > 0 ? pnlUsd / monthTrades.length : 0,
      maxWinUsd: monthTrades.length > 0 ? Math.max(...monthTrades.map((t) => t.netPnlUsd)) : 0,
      maxLossUsd: monthTrades.length > 0 ? Math.min(...monthTrades.map((t) => t.netPnlUsd)) : 0,
      capitalStart: prevCapital,
      capitalEnd,
    });

    prevCapital = capitalEnd;
  }

  // Calculate summary
  const wins = trades.filter((t) => t.netPnlUsd > 0);
  const losses = trades.filter((t) => t.netPnlUsd <= 0);
  const totalPnlUsd = trades.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const totalFeesUsd = trades.reduce((sum, t) => sum + t.feesUsd, 0);
  const grossWins = wins.reduce((sum, t) => sum + t.netPnlUsd, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.netPnlUsd, 0));

  // Calculate Sharpe Ratio
  const dailyReturns = equityCurve
    .map((e, i) => {
      if (i === 0) return 0;
      return ((e.equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity) * 100;
    })
    .slice(1);

  const avgReturn =
    dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn =
    dailyReturns.length > 1
      ? Math.sqrt(
          dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
            dailyReturns.length,
        )
      : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(365) : 0;

  const result: BacktestResult = {
    params,
    summary: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlUsd,
      totalPnlPct: (totalPnlUsd / initialCapital) * 100,
      maxDrawdownPct: maxDrawdown,
      avgTradeUsd: trades.length > 0 ? totalPnlUsd / trades.length : 0,
      avgWinUsd: wins.length > 0 ? grossWins / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLosses / losses.length : 0,
      profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0,
      sharpeRatio,
      finalCapital: capital,
      longTrades: trades.filter((t) => t.side === 'long').length,
      shortTrades: trades.filter((t) => t.side === 'short').length,
      avgHoldMinutes:
        trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdMinutes, 0) / trades.length : 0,
      totalFeesUsd,
    },
    trades,
    monthlyStats,
    equityCurve,
    drawdownCurve,
    validSignals: parityMode ? allValidSignals : undefined,  // V5.51: Include all valid signals in parity mode
  };

  console.log(
    `[Backtest] Completed: ${trades.length} trades, ${wins.length} wins, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`,
  );

  return result;
}
