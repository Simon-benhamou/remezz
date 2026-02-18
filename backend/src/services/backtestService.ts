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
  detectAndWarnGaps,
  CANDLE_15M_MS,
  CANDLE_1H_MS,
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
  calcATR,
  calcBBPosition,
  calcTrendStrength,
  countConsecUp,
  countConsecDown,
  getCooldownBars,  // V5.41: Shared cooldown logic
  // V5.64: Wick breakout early entry functions
  checkWickBreakout,
  calcBollingerBands,
  calcDynamicStopLoss,
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
import { ipWeightTracker } from './ipWeightTracker.js';

// V5.22: Import shared signal scoring function (ensures backtest = production)
import { calculateSignalScore } from '../strategies/signalRanker.js';

import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH, EXIT_TRAIL_NFS_MED, EXIT_TRAIL_NFS_LOW,
  EXIT_SL, EXIT_TIME, EXIT_REGIME_CHANGE, EXIT_MOMENTUM_REVERSAL,
  EXIT_STAGNANT, EXIT_STAGNANT_PROFIT, EXIT_END,
  EXIT_SIGNAL_REASON_MAP,
} from '../types/exitReasons.js';

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

/**
 * Aggregate 15m candles to a larger timeframe.
 * Groups candles into buckets of targetMinutes and merges OHLCV.
 */
function aggregate15mCandles(candles: Candle[], targetMinutes: number): Candle[] {
  if (targetMinutes <= 15) return candles; // No aggregation needed
  const targetMs = targetMinutes * 60 * 1000;
  const out: Candle[] = [];
  let bucket: Candle | null = null;
  let bucketEnd = 0;

  for (const c of candles) {
    const bucketStart = Math.floor(c.timestamp / targetMs) * targetMs;
    const thisBucketEnd = bucketStart + targetMs;

    if (!bucket || c.timestamp >= bucketEnd) {
      // New bucket
      if (bucket) out.push(bucket);
      bucket = { ...c, timestamp: bucketStart };
      bucketEnd = thisBucketEnd;
    } else {
      // Merge into existing bucket
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

interface BacktestSimPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  entryIdx: number;
  entryCandle: BacktestCandle;  // V5.68: Store entry candle for realistic timing
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
  // EXIT parameter overrides for optimization
  TRAILING_ACTIVATION_PCT?: number;
  TRAILING_DISTANCE_PCT?: number;
  STOP_LOSS_PCT?: number;
  STOP_LOSS_MIN_PCT?: number;
  STOP_LOSS_MAX_PCT?: number;
  PROFIT_TARGET_PCT?: number;
  [key: string]: number | undefined;  // Allow arbitrary overrides for grid search
}

// V5.54: Forced entry for parity verification
// Forces backtest to enter at EXACT same time/price as live trade
export interface ForcedEntry {
  symbol: string;
  side: 'long' | 'short';
  entryTimestamp: number;  // Exact candle timestamp (must match a candle close time)
  entryPrice: number;      // Live entry price (for comparison/logging)
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
  // V5.54: Force entry at exact live trade time (for parity verification)
  // When set, ignores signal detection and enters at the specified timestamp
  // This ensures we test EXACTLY the same trade as live, regardless of earlier signals
  forcedEntry?: ForcedEntry;
  // V5.62: NFS_ADAPTIVE trailing exit mode
  // When true, uses NFS score to determine exit strategy:
  // - HIGH (>=70): Exit at trailing stop price (theoretical/perfect)
  // - MEDIUM (40-69): Exit at candle close with 1-candle confirmation
  // - LOW (<40): Exit at candle close with 2-candle confirmation
  nfsAdaptiveTrailing?: boolean;
  // Regime candle timeframe in minutes. Default 60 (1h).
  // Aggregates BTC 15m candles to the desired timeframe for SMA200 regime, MTF filter, cash mode.
  // Options: 15, 30, 60 (default), 120, 240
  regimeTimeframeMinutes?: number;
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

// Worker thread input: pre-loaded candle data for pure computation
export interface BacktestComputationInput {
  params: BacktestParams;
  btcCandles: BacktestCandle[];
  btcCandles1h: BacktestCandle[];
  allData: Record<string, BacktestCandle[]>;
  CANDLE_REGIME_INTERVAL_MS: number;
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
      STAGNANT_TRADE_TIGHTEN_SL_RATIO: (MomentumConfig.EXIT as any).STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5,
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
// INDICATORS - V5.41+: All imported from momentumSimple.ts for single source of truth
// calcSMA, calcBB, calcROC, calcVolRatio, countConsecUp, countConsecDown,
// calcATR, calcBBPosition, calcTrendStrength
// ============================================================================

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
// V5.62: NFS (NOISE FILTER SCORE) CALCULATOR FOR ADAPTIVE TRAILING EXIT
// ============================================================================
// Calculates a confidence score (0-100) for trailing stop breaches.
// Based on statistical analysis: strong breaches have high volume, momentum,
// and breach depth relative to ATR.
// ============================================================================

interface NfsScore {
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

// V5.91: Read NFS config from MomentumConfig.EXIT — single source of truth
// (was hardcoded; now shares values with live realtimeExitHandler)
const NFS_CONFIG = {
  get HIGH_THRESHOLD()          { return MomentumConfig.EXIT.NFS_HIGH_SCORE_THRESHOLD; },
  get MEDIUM_THRESHOLD()        { return MomentumConfig.EXIT.NFS_MEDIUM_SCORE_THRESHOLD; },
  get WEIGHT_BREACH_ATR()       { return MomentumConfig.EXIT.NFS_WEIGHT_BREACH_ATR; },
  get WEIGHT_BREACH_DEPTH()     { return MomentumConfig.EXIT.NFS_WEIGHT_BREACH_DEPTH; },
  get WEIGHT_VOLUME()           { return MomentumConfig.EXIT.NFS_WEIGHT_VOLUME; },
  get WEIGHT_BODY_RATIO()       { return MomentumConfig.EXIT.NFS_WEIGHT_CANDLE_BODY; },
  get WEIGHT_MOMENTUM()         { return MomentumConfig.EXIT.NFS_WEIGHT_MOMENTUM; },
  get BREACH_ATR_THRESHOLD()    { return MomentumConfig.EXIT.NFS_BREACH_ATR_THRESHOLD; },
  get BREACH_DEPTH_THRESHOLD()  { return MomentumConfig.EXIT.NFS_BREACH_DEPTH_THRESHOLD; },
  get VOLUME_RATIO_THRESHOLD()  { return MomentumConfig.EXIT.NFS_VOLUME_RATIO_THRESHOLD; },
  get BODY_RATIO_THRESHOLD()    { return MomentumConfig.EXIT.NFS_CANDLE_BODY_RATIO_THRESHOLD; },
  get MOMENTUM_THRESHOLD()      { return MomentumConfig.EXIT.NFS_MOMENTUM_ROC5_THRESHOLD; },
};

function calculateNfsScoreForBreach(
  candle: BacktestCandle,
  prevCandles: BacktestCandle[],
  side: 'long' | 'short',
  trailingStopPrice: number
): NfsScore {
  // 1. Calculate breach depth
  let breachDepthAbs: number;
  let breachDepthPct: number;

  if (side === 'long') {
    breachDepthAbs = Math.max(0, trailingStopPrice - candle.close);
    breachDepthPct = trailingStopPrice > 0
      ? (breachDepthAbs / trailingStopPrice) * 100
      : 0;
  } else {
    breachDepthAbs = Math.max(0, candle.close - trailingStopPrice);
    breachDepthPct = trailingStopPrice > 0
      ? (breachDepthAbs / trailingStopPrice) * 100
      : 0;
  }

  // 2. Calculate ATR for context
  const atrPeriod = Math.min(14, prevCandles.length);
  let atrSum = 0;
  for (let i = prevCandles.length - atrPeriod; i < prevCandles.length; i++) {
    const c = prevCandles[i];
    const prevClose = i > 0 ? prevCandles[i - 1].close : c.open;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    atrSum += tr;
  }
  const atr = atrPeriod > 0 ? atrSum / atrPeriod : 1;
  const breachAtrRatio = atr > 0 ? breachDepthAbs / atr : 0;

  // 3. Calculate volume ratio
  const avgVolume = prevCandles.slice(-20).reduce((s, c) => s + c.volume, 0) /
                    Math.min(20, prevCandles.length);
  const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 1;

  // 4. Calculate candle body ratio
  const bodySize = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;

  // 5. Calculate ROC5 momentum
  const roc5Close = prevCandles[prevCandles.length - 5]?.close ?? candle.open;
  const roc5 = roc5Close > 0 ? ((candle.close - roc5Close) / roc5Close) * 100 : 0;
  const momentumAligned = side === 'long'
    ? roc5 <= -NFS_CONFIG.MOMENTUM_THRESHOLD  // For LONG breach, momentum should be negative
    : roc5 >= NFS_CONFIG.MOMENTUM_THRESHOLD;  // For SHORT breach, momentum should be positive

  // Calculate score (0-100)
  let score = 0;

  // Breach/ATR (35 points)
  if (breachAtrRatio >= NFS_CONFIG.BREACH_ATR_THRESHOLD) {
    score += NFS_CONFIG.WEIGHT_BREACH_ATR;
  } else if (breachAtrRatio >= NFS_CONFIG.BREACH_ATR_THRESHOLD * 0.5) {
    score += NFS_CONFIG.WEIGHT_BREACH_ATR * 0.5;
  }

  // Breach depth (25 points)
  if (breachDepthPct >= NFS_CONFIG.BREACH_DEPTH_THRESHOLD) {
    score += NFS_CONFIG.WEIGHT_BREACH_DEPTH;
  } else if (breachDepthPct >= NFS_CONFIG.BREACH_DEPTH_THRESHOLD * 0.5) {
    score += NFS_CONFIG.WEIGHT_BREACH_DEPTH * 0.5;
  }

  // Volume (20 points)
  if (volumeRatio >= NFS_CONFIG.VOLUME_RATIO_THRESHOLD) {
    score += NFS_CONFIG.WEIGHT_VOLUME;
  } else if (volumeRatio >= NFS_CONFIG.VOLUME_RATIO_THRESHOLD * 0.8) {
    score += NFS_CONFIG.WEIGHT_VOLUME * 0.5;
  }

  // Body ratio (10 points)
  if (bodyRatio >= NFS_CONFIG.BODY_RATIO_THRESHOLD) {
    score += NFS_CONFIG.WEIGHT_BODY_RATIO;
  }

  // Momentum alignment (10 points)
  if (momentumAligned) {
    score += NFS_CONFIG.WEIGHT_MOMENTUM;
  }

  // Determine confidence level
  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (score >= NFS_CONFIG.HIGH_THRESHOLD) {
    confidence = 'HIGH';
  } else if (score >= NFS_CONFIG.MEDIUM_THRESHOLD) {
    confidence = 'MEDIUM';
  } else {
    confidence = 'LOW';
  }

  // V5.93: Low-volume breach demotion — demote confidence one level if volume is weak
  const lowVolEnabled = (MomentumConfig.EXIT as any).NFS_LOW_VOL_DEMOTION_ENABLED ?? false;
  const lowVolThreshold = (MomentumConfig.EXIT as any).NFS_LOW_VOL_DEMOTION_THRESHOLD ?? 0.7;
  if (lowVolEnabled && confidence !== 'LOW' && volumeRatio < lowVolThreshold) {
    confidence = confidence === 'HIGH' ? 'MEDIUM' : 'LOW';
  }

  return { score, confidence };
}

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
  btcCandles1hWindow: Candle[],  // V5.86: 1h candles for regime SMA200 (matches live)
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
  // V5.86: Pass btcCandles1h for regime SMA200 (matches live behavior)
  const exitSignal = shouldExitPosition(position, current.close, windowCandles as Candle[], {
    nowMs: pos.entryTime + holdMinutes * 60000,  // Simulate correct time
    priceHigh: current.high,
    priceLow: current.low,
    btcCandles: btcWindowCandles,
    btcCandles1h: btcCandles1hWindow,  // V5.86: 1h candles for regime SMA200
  });
  
  // Sync state back to pos (stagnant, trailing, etc.)
  if (position.stagnantState) {
    pos.stagnantState = position.stagnantState;
  }
  pos.trailingActive = position.trailingActive ?? exitSignal.trailingActivated;
  
  // Handle trailing breach counter with NFS_ADAPTIVE logic
  if (exitSignal.reason === 'trailing_breach') {
    // Close breached - increment counter
    pos.trailingBreachCandles = (pos.trailingBreachCandles ?? 0) + 1;
    const baseConfirmCandles = params.trailingConfirmCandles ?? 2;
    const trailingStopPrice = exitSignal.newStopLoss ?? pos.appTrailingStop ?? current.close;

    // ═══════════════════════════════════════════════════════════════════════
    // V5.62: NFS_ADAPTIVE TRAILING EXIT
    // ═══════════════════════════════════════════════════════════════════════
    //
    // When enabled, uses NFS (Noise Filter Score) to determine exit strategy:
    // - HIGH confidence (>=70): Exit immediately at trailing stop price (perfect)
    // - MEDIUM confidence (40-69): Exit at candle close with 1-candle confirm
    // - LOW confidence (<40): Exit at candle close with 2-candle confirm
    //
    // This captures more profit on strong signals while filtering noise.
    // Backtest shows +952% ROI improvement vs standard 2-candle confirmation.
    //
    // Default: Uses MomentumConfig.EXIT.NFS_ADAPTIVE_ENABLED (true by default)
    //
    const useNfsAdaptive = params.nfsAdaptiveTrailing ??
      (MomentumConfig.EXIT as any).NFS_ADAPTIVE_ENABLED ?? true;

    if (useNfsAdaptive) {
      const nfsScore = calculateNfsScoreForBreach(
        current,
        windowCandles.slice(-20) as BacktestCandle[],
        pos.side,
        trailingStopPrice
      );

      // NOTE: Backtest uses EXIT_TRAIL_NFS_HIGH/MED/LOW (immediate per-candle evaluation).
      // Live 15m layer uses EXIT_TRAIL_NFS_HIGH_15M/MED_15M/LOW_15M (deferred to 15m close
      // per V5.90). The _15M suffix distinguishes the deferral path — same scoring logic,
      // different timing. This is intentional, not a parity bug.
      if (nfsScore.confidence === 'HIGH') {
        // HIGH confidence: Exit at trailing stop price (best available fill).
        // In live, proactive limit order is placed at trailing stop BEFORE breach
        // (V5.87), so fill is at trailing price — matching this backtest behavior.
        return {
          shouldExit: true,
          exitReason: EXIT_TRAIL_NFS_HIGH,
          exitPrice: trailingStopPrice,
        };
      } else if (nfsScore.confidence === 'MEDIUM') {
        // MEDIUM confidence: 1-candle confirmation, exit at best of trailing stop or close
        if (pos.trailingBreachCandles >= 1) {
          // V5.81: Use best of trailing stop price or candle close for parity
          const medExitPrice = pos.side === 'long'
            ? Math.max(trailingStopPrice, current.close)
            : Math.min(trailingStopPrice, current.close);
          return {
            shouldExit: true,
            exitReason: EXIT_TRAIL_NFS_MED,
            exitPrice: medExitPrice,
          };
        }
      } else {
        // LOW confidence: 2-candle confirmation, exit at best of trailing stop or close
        if (pos.trailingBreachCandles >= 2) {
          // V5.81: Use best of trailing stop price or candle close for parity
          const lowExitPrice = pos.side === 'long'
            ? Math.max(trailingStopPrice, current.close)
            : Math.min(trailingStopPrice, current.close);
          return {
            shouldExit: true,
            exitReason: EXIT_TRAIL_NFS_LOW,
            exitPrice: lowExitPrice,
          };
        }
      }

      // Not yet confirmed - continue
      return { shouldExit: false, exitReason: '', exitPrice: current.close };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // V5.61 FALLBACK: Standard candle close exit (when NFS_ADAPTIVE disabled)
    // ═══════════════════════════════════════════════════════════════════════
    if (pos.trailingBreachCandles >= baseConfirmCandles) {
      const exitPrice = current.close;

      return {
        shouldExit: true,
        exitReason: EXIT_TRAIL,
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
    const reason = exitSignal.reason ?? 'unknown';
    const exitReason = EXIT_SIGNAL_REASON_MAP[reason] ?? reason.toUpperCase();
    
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
      // V5.25: Check circuit breaker + weight budget before each REST call
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        console.error(`[Backtest] 🚫 REST circuit breaker is OPEN - cannot fetch ${symbol}`);
        console.error(`[Backtest] Please wait for rate limit to expire before running backtest`);
        throw new Error('REST_CIRCUIT_BREAKER_OPEN');
      }
      if (!ipWeightTracker.canMakeCall(10)) {
        const ok = await ipWeightTracker.waitForBudget(10, `backtest:fetchOHLCV:15m:${symbol}`, 60_000);
        if (!ok) throw new Error('IP_WEIGHT_BUDGET_EXHAUSTED');
      }

      const ohlcv = await exchange.fetchOHLCV(symbol, '15m', cursor, 1000);
      ipWeightTracker.record(10, `backtest:fetchOHLCV:15m:${symbol}`);
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
    const candles = await fetchCandlesFromCcxt(exchange, symbol, since, until);
    detectAndWarnGaps(candles, symbol, CANDLE_15M_MS);
    return candles;
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

  const merged = mergeDedupCandles(parts);
  detectAndWarnGaps(merged, symbol, CANDLE_15M_MS);
  return merged;
}

// V5.36: Fetch 1h candles for Multi-Timeframe Confluence filter
// V5.67: Now tries local JSON files first (same pattern as fetchCandles)
async function fetchCandles1hFromCcxt(
  exchange: any,
  symbol: string,
  since: number,
  until: number
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = since;

  while (cursor < until) {
    try {
      if (!globalRestCircuitBreaker.canMakeRequest()) {
        console.error(`[Backtest] 🚫 REST circuit breaker is OPEN - cannot fetch 1h ${symbol}`);
        throw new Error('REST_CIRCUIT_BREAKER_OPEN');
      }
      if (!ipWeightTracker.canMakeCall(10)) {
        const ok = await ipWeightTracker.waitForBudget(10, `backtest:fetchOHLCV:1h:${symbol}`, 60_000);
        if (!ok) throw new Error('IP_WEIGHT_BUDGET_EXHAUSTED');
      }

      const ohlcv = await exchange.fetchOHLCV(symbol, '1h', cursor, 1000);
      ipWeightTracker.record(10, `backtest:fetchOHLCV:1h:${symbol}`);
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

async function fetchCandles1h(
  exchange: any,
  symbol: string,
  startDate: Date,
  endDate: Date
): Promise<Candle[]> {
  const until = endDate.getTime();
  const extraBarsMs = 250 * 60 * 60 * 1000; // V5.86: 250 bars × 1h (matches live SMA200 regime)
  const since = startDate.getTime() - extraBarsMs;

  // V5.67: Try local JSON files first (same pattern as fetchCandles)
  const local = await loadLocalJsonCandles(symbol, '1h');
  if (!local) {
    console.log(`[Backtest] No local 1h data for ${symbol}, fetching from API`);
    const candles = await fetchCandles1hFromCcxt(exchange, symbol, since, until);
    detectAndWarnGaps(candles, symbol, CANDLE_1H_MS);
    return candles;
  }

  const needBefore = since < local.startTs;
  const needAfter = until > local.endTs;

  // If local data covers everything, use it
  if (!needBefore && !needAfter) {
    console.log(`[Backtest] Using local 1h data for ${symbol} (full coverage)`);
    const sliced = sliceCandlesByTime(local.candles, since, until);
    detectAndWarnGaps(sliced, symbol, CANDLE_1H_MS);
    return sliced;
  }

  // Otherwise, merge local with API data for gaps
  const localSlice = sliceCandlesByTime(local.candles, since, until);
  const parts: BacktestCandle[][] = [localSlice];

  if (needBefore) {
    console.log(`[Backtest] Fetching 1h ${symbol} before local data (${new Date(since).toISOString()} to ${new Date(local.startTs).toISOString()})`);
    const beforeCandles = await fetchCandles1hFromCcxt(exchange, symbol, since, local.startTs - 1);
    parts.unshift(beforeCandles);
  }
  if (needAfter) {
    console.log(`[Backtest] Fetching 1h ${symbol} after local data (${new Date(local.endTs).toISOString()} to ${new Date(until).toISOString()})`);
    const afterCandles = await fetchCandles1hFromCcxt(exchange, symbol, local.endTs + 1, until);
    parts.push(afterCandles);
  }

  const merged1h = mergeDedupCandles(parts);
  detectAndWarnGaps(merged1h, symbol, CANDLE_1H_MS);
  return merged1h;
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

/**
 * Calculate hold time using candle-close timing for both entry and exit.
 *
 * Pshat-Emet: Only CLOSED candles are truth. We have no tick data, so all
 * timestamps are at candle close boundaries. This matches live behavior where
 * the 15m exit handler evaluates at candle close, even for SL/NFS_HIGH exits
 * whose exchange fills happen intra-candle.
 *
 * Exit PRICES (SL at stop, NFS_HIGH at trailing stop) remain correct — they
 * match live proactive limit / exchange SL fills.  Only the TIMING is
 * normalised to candle close, producing holdMinutes in multiples of 15.
 */
function calculateRealisticHoldMinutes(
  entryCandle: BacktestCandle,
  _entryPrice: number,
  exitCandle: BacktestCandle,
  _exitPrice: number,
  _exitReason: string,
  _side: 'long' | 'short'
): { holdMinutes: number; entryTimestamp: number; exitTimestamp: number } {
  const candleDurationMs = 15 * 60 * 1000;

  // Entry at candle close (V5.91 disabled wick breakout entry)
  const entryTimestamp = entryCandle.timestamp + candleDurationMs;

  // Exit at candle close — ALL exits evaluated at 15m boundary in live
  const exitTimestamp = exitCandle.timestamp + candleDurationMs;

  const holdMs = exitTimestamp - entryTimestamp;
  const holdMinutes = Math.max(15, Math.round(holdMs / 60000)); // Minimum 1 bar = 15 min

  return {
    holdMinutes,
    entryTimestamp,
    exitTimestamp,
  };
}

// ============================================================================
// BACKTEST COMPUTATION — Pure CPU simulation (can run on worker thread)
// ============================================================================

export async function runBacktestComputation(input: BacktestComputationInput): Promise<BacktestResult> {
  const { params, btcCandles, btcCandles1h, allData, CANDLE_REGIME_INTERVAL_MS } = input;
  const { startDate, endDate, initialCapital, symbols, leverage, parityMode, forcedEntry } = params;
  const btcCloses = btcCandles.map((c) => c.close);

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

  // V5.63: Skip-N-trades-then-resume rule after consecutive losers
  // Testing showed: Skip 1 trade after 2 consecutive losers = +70% PnL improvement
  // Skips more losers (727) than winners (382), improves win rate 58.5% → 66.7%
  let consecutiveLosers = 0;
  let tradesToSkip = 0;

  const CONSECUTIVE_LOSER_THRESHOLD = 2;  // Trigger after this many consecutive losers
  const TRADES_TO_SKIP = 1;               // Skip this many trades, then resume
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

  // Regime candle cursor: advances monotonically for O(1) per-step filtering
  // Tracks the largest index i where btcCandles1h[i].timestamp + CANDLE_REGIME_INTERVAL_MS <= btcCandle.timestamp
  let regimeCursorForEntry = 0;

  // Main loop - iterate over BTC candles
  for (let btcIdx = startIdx; btcIdx < btcCandles.length; btcIdx++) {
    const btcCandle = btcCandles[btcIdx];

    // Advance regime candle cursor for this BTC timestamp
    while (
      regimeCursorForEntry < btcCandles1h.length &&
      btcCandles1h[regimeCursorForEntry].timestamp + CANDLE_REGIME_INTERVAL_MS <= btcCandle.timestamp
    ) {
      regimeCursorForEntry++;
    }
    // regimeCursorForEntry is now the EXCLUSIVE end index (first candle that doesn't pass)

    if (btcCandle.timestamp < startTimestamp) continue;
    if (btcCandle.timestamp > endDate.getTime()) break;

    // Prevent event-loop starvation: yield every 3 BTC candles (~every 1-2ms)
    // to let WebSocket heartbeats, health checks, and agent ticks process.
    // Previously every 25 → caused WS disconnects during backtests (code 1006).
    if (btcIdx % 3 === 0) {
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
    
    let signalCandidates: SignalCandidate[] = [];

    // Process each symbol - handle exits and collect entry signals
    let symbolLoopIdx = 0;
    for (const symbol of symbols) {
      // Yield inside symbol loop to prevent blocking during heavy per-symbol computation
      if (symbolLoopIdx++ % 3 === 2) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
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

        // V5.86: Compute regime candles window for exit
        // Use regimeCursorForEntry as upper bound (current.timestamp <= btcCandle.timestamp)
        const btcCandles1hWindowForExit = btcCandles1h.slice(0, regimeCursorForEntry);

        const exitResult = checkBacktestExit(
          pos,
          current,
          windowCandles,
          btcWindowCandles as Candle[],
          btcCandles1hWindowForExit as Candle[],  // V5.86: 1h candles for regime
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

          // V5.68: Calculate realistic intrabar timing for entry/exit
          const realisticTiming = calculateRealisticHoldMinutes(
            pos.entryCandle,
            pos.entryPrice,
            current,
            exitPrice,
            exitReason,
            pos.side
          );

          const month = new Date(realisticTiming.exitTimestamp).toISOString().slice(0, 7);
          const exitDay = new Date(realisticTiming.exitTimestamp).toISOString().slice(0, 10);

          trades.push({
            id: `trade_${++tradeId}`,
            symbol,
            side: pos.side,
            entryTime: new Date(realisticTiming.entryTimestamp).toISOString(),
            exitTime: new Date(realisticTiming.exitTimestamp).toISOString(),
            entryPrice: pos.entryPrice,
            exitPrice,
            qty: pos.qty,
            notionalUsd: pos.notionalUsd,
            marginUsd: pos.marginUsd,
            leverage: pos.leverage,
            holdMinutes: realisticTiming.holdMinutes,  // V5.68: Realistic hold time
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

            // V5.68: Calculate realistic timing for multi-positions too
            const multiTiming = calculateRealisticHoldMinutes(
              multiPos.entryCandle,
              multiPos.entryPrice,
              current,
              exitPrice,
              exitReason,
              multiPos.side
            );

            trades.push({
              id: `trade_${++tradeId}`,
              symbol,
              side: multiPos.side,
              entryTime: new Date(multiTiming.entryTimestamp).toISOString(),
              exitTime: new Date(multiTiming.exitTimestamp).toISOString(),
              entryPrice: multiPos.entryPrice,
              exitPrice,
              qty: multiPos.qty,
              notionalUsd: multiPos.notionalUsd,
              marginUsd: multiPos.marginUsd,
              leverage: multiPos.leverage,
              holdMinutes: multiTiming.holdMinutes,  // V5.68: Realistic hold time
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

          // V5.63: Update consecutive loser count and trigger skip-N rule
          // Winner = positive net PnL after fees
          const isWinner = pnl.netPnlUsd > 0;
          if (isWinner) {
            consecutiveLosers = 0;
          } else {
            consecutiveLosers++;
            // Trigger skip-N rule when threshold reached
            if (consecutiveLosers >= CONSECUTIVE_LOSER_THRESHOLD) {
              tradesToSkip = TRADES_TO_SKIP;
              consecutiveLosers = 0; // Reset counter after triggering
            }
          }
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

        // BTC regime uses higher-TF SMA (configurable via regimeTimeframeMinutes)
        // Fallback to 15m if data insufficient
        const btcCandles1hWindow = btcCandles1h.slice(0, regimeCursorForEntry);
        let isBullRegime: boolean;
        const smaPeriod = MomentumConfig.ENTRY.BTC_SMA_PERIOD;
        if (btcCandles1hWindow.length >= smaPeriod) {
          const btcCloses1h = btcCandles1hWindow.map(c => c.close);
          const btcSma200_1h = calcSMA(btcCloses1h, smaPeriod);
          const btcNow1h = btcCloses1h[btcCloses1h.length - 1];
          isBullRegime = btcNow1h > btcSma200_1h;
        } else {
          // Fallback to 15m
          const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
          const btcPriceForRegime = btcIdx > 0 ? btcCloses[btcIdx - 1] : btcCloses[0];
          isBullRegime = btcPriceForRegime > btcSma200;
        }

        // V5.39 FIX: btcCandles1hWindow already computed above for regime + MTF filter

        // V5.36: Use shared checkMomentumSignal (includes MTF + BTC Vol filters)
        // This ensures 100% parity with production signal logic
        const signal = checkMomentumSignal(
          symbol,
          windowCandles,
          btcCandles.slice(Math.max(0, btcIdx - 201), btcIdx), // V5.94 FIX: Exclude current BTC 15m candle (match live behavior)
          // Live filters out isFinal=false candles, so it never sees the current forming candle.
          // Previously btcIdx+1 included the current candle with its FINAL values (look-ahead bias).
          {
            nowMs: btcCandle.timestamp,
            btcCandles1h: btcCandles1hWindow, // V5.36: Pass 1h candles for MTF filter
          }
        );
        if (!signal.valid || !signal.side) continue;

        // V5.80: TOXIC HOURS FILTER - Validated on 24 months (4297 trades)
        // Hours with WR significantly below 74.1% baseline:
        // 04:00: 58.2% | 05:00: 66.7% | 09:00: 65.6% | 18:00: 61.7% | 21:00: 62.1%
        // V5.95 FIX: Use candle CLOSE time (open + 15min) to match live wall-clock behavior.
        // Binance timestamps are candle OPEN time, but signal is detected at CLOSE.
        // Live uses new Date() ≈ close time, so backtest must align.
        const signalHourUtc = new Date(current.timestamp + 15 * 60 * 1000).getUTCHours();
        if (signalHourUtc === 4 || signalHourUtc === 5 || signalHourUtc === 9 || signalHourUtc === 18 || signalHourUtc === 21) {
          continue; // Skip toxic hours
        }

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
        // V5.95 FIX: Use calcVolRatio() for parity with live (20-bar avg instead of 19-bar)
        const volumeRatio = calcVolRatio(volumes);
        
        // V5.23: New indicators for enhanced scoring
        const bbPosition = calcBBPosition(windowCandles, 20, 2);
        // V5.103 FIX: Import calcATR from momentumSimple.ts (returns raw absolute ATR, same as live)
        // Previously used local calcATR that returned %, then double-converted here → near-zero ATR scoring
        const atrRaw = calcATR(windowCandles, 14) ?? 0;
        const atrPct = atrRaw ? (atrRaw / current.close) * 100 : 0;
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
    // V5.54: FORCED ENTRY MODE (for parity verification)
    // ═══════════════════════════════════════════════════════════════════
    // When forcedEntry is set, we ONLY enter at the exact specified timestamp
    // BUT we also verify that a valid signal exists at that time
    // If no signal, it means the live trade didn't follow the strategy!
    if (forcedEntry) {
      const forcedSymbol = forcedEntry.symbol;
      const forcedCandles = allData[forcedSymbol];
      const forcedIdx = symbolIdx[forcedSymbol];
      
      if (forcedCandles && forcedIdx < forcedCandles.length) {
        const currentCandle = forcedCandles[forcedIdx];
        
        // V5.56 FIX: Check if BTC candle matches the forced entry timestamp
        // Previously compared currentCandle.timestamp but that's the SIGNAL candle (15:00)
        // when forcedEntry.entryTimestamp is the ENTRY time (15:15).
        // 
        // The correct logic is: when btcCandle.timestamp === forcedEntry.entryTimestamp,
        // we're processing the moment when live entered. At this moment:
        // - currentCandle is the last CLOSED candle (e.g., 15:00) that generated the signal
        // - signalCandidates contains signals from that closed candle
        // - This is exactly when the signal would have been detected
        if (btcCandle.timestamp === forcedEntry.entryTimestamp && !positions[forcedSymbol]) {
          // V5.55: Check if there's a valid signal for this symbol at this time
          const hasValidSignal = signalCandidates.some(
            c => c.symbol === forcedSymbol && 
                 c.signal.valid && 
                 c.signal.side === forcedEntry.side
          );
          
          if (hasValidSignal) {
            // Signal is valid - enter the trade
            console.log(`[FORCED ENTRY] ✅ Valid signal found. Entering ${forcedSymbol} ${forcedEntry.side} @ ${new Date(currentCandle.timestamp).toISOString()}`);
          } else {
            // No valid signal - log warning but still enter for comparison
            // This allows us to see what would have happened even if signal was different
            console.log(`[FORCED ENTRY] ⚠️ NO VALID SIGNAL at ${new Date(currentCandle.timestamp).toISOString()} for ${forcedSymbol} ${forcedEntry.side}`);
            console.log(`[FORCED ENTRY] ⚠️ Live may have entered on different conditions or timing`);
            // Store this info for the parity result
            allValidSignals.push({
              symbol: forcedSymbol,
              side: forcedEntry.side,
              timestamp: currentCandle.timestamp,
              price: currentCandle.close,
              reason: 'NO_SIGNAL_AT_FORCED_TIME',
            });
          }
          
          // Enter the trade regardless (to compare exit behavior)
          const posLev = leverage || 5;
          const marginUsd = Math.min(capital * 0.25, 1000);
          const notionalUsd = marginUsd * posLev;
          const qty = notionalUsd / currentCandle.close;
          
          if (qty > 0 && marginUsd > 0) {
            capitalInUse += marginUsd;
            capital -= marginUsd;
            
            positions[forcedSymbol] = {
              symbol: forcedSymbol,
              side: forcedEntry.side,
              entryPrice: currentCandle.close,
              entryTime: currentCandle.timestamp,
              entryIdx: forcedIdx,
              entryCandle: currentCandle,  // V5.68: Store entry candle for realistic timing
              qty,
              notionalUsd,
              marginUsd,
              leverage: posLev,
              capitalBefore: capital + marginUsd,
              wasCapped: false,
              stopLossPct: CONFIG.EXIT.STOP_LOSS_PCT,
              highWaterMark: forcedEntry.side === 'long' ? currentCandle.close : undefined,
              lowWaterMark: forcedEntry.side === 'short' ? currentCandle.close : undefined,
              entryReason: 'FORCED_PARITY',
              positionIndex: 0,
              totalPositions: 1,
              stagnantState: {
                triggered: false,
                confirmed: false,
                cancelled: false,
                obsPeakPct: 0
              }
            };
          }
        }
      }
      
      // Skip normal signal processing when in forced entry mode
      continue;
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
        // V5.63: Skip-N-trades-then-resume rule
        // After 2 consecutive losers, skip the next N trades, then resume
        // Testing showed: Skip 1 = +70% PnL, skips 2x more losers than winners
        if (!parityMode && tradesToSkip > 0) {
          // We're in skip mode - clear all candidates and decrement counter
          signalCandidates.length = 0;
          tradesToSkip--;
        }

        // V5.52: In parity mode, enter on FIRST signal chronologically (like live does)
        // In normal mode, rank by score and enter best opportunities
        if (parityMode) {
          // PARITY: Sort by candle index (chronological order) - first signal wins
          // This matches live behavior where first valid signal triggers entry
          signalCandidates.sort((a, b) => a.idx - b.idx);
        } else {
          // NORMAL: RANK by score (highest first) for optimal entries
          signalCandidates.sort((a, b) => b.score - a.score);
        }
        
        // Take top N signals that fit available slots
        const signalsToEnter = signalCandidates.slice(0, availableSlots);
        
        for (const candidate of signalsToEnter) {
          const { symbol, signal, current, idx, candles: windowCandles } = candidate;
          // 🔧 FIX V5.43: availableCapital = capital (free capital)
          // `capital` is already the free capital (total - inUse), no need to subtract again
          const availableCapital = capital;

          // ═══════════════════════════════════════════════════════════════════
          // V5.64: WICK BREAKOUT EARLY ENTRY
          // ═══════════════════════════════════════════════════════════════════
          // Check if wick already broke BB band - if so, use better entry price
          const closes = windowCandles.map((c: BacktestCandle) => c.close);
          const bb = calcBollingerBands(closes, MomentumConfig.ENTRY.BB_PERIOD, MomentumConfig.ENTRY.BB_STD);
          const wickBreakout = checkWickBreakout(current, bb, signal.side);

          // V5.91: Use close price for entry — wick breakout is disabled in live since V5.78.
          // Wick breakout gives unrealistically better fills in backtest. Live always enters at
          // market price ~= close. Keep detection above for analysis/logging only.
          const entryPrice = current.close;
          
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
            'NEAR/USDT:USDT': 100_000,
            'TIA/USDT:USDT': 100_000,
            'OP/USDT:USDT': 100_000,
            'ARB/USDT:USDT': 100_000,
            'INJ/USDT:USDT': 100_000,
            // Tier LOW: $25K
            'SEI/USDT:USDT': 25_000,
            'IMX/USDT:USDT': 25_000,
            'DOT/USDT:USDT': 25_000,
            'SUI/USDT:USDT': 25_000,
            'SONIC/USDT:USDT': 25_000,
            'APT/USDT:USDT': 25_000,
            'FET/USDT:USDT': 25_000,
            'WIF/USDT:USDT': 25_000,
            'STX/USDT:USDT': 25_000,
            'RENDER/USDT:USDT': 25_000,
            'JUP/USDT:USDT': 25_000,
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
                // V5.64: Use wick breakout entry price for multi-positions too
                const multiEntryPrice = entryPrice * (1 + (posIdx * 0.003 * (signal.side === 'long' ? -1 : 1))); // Slight price spread
                const addQty = perPosNotional / multiEntryPrice;
                capitalInUse += perPosMargin;
                capital -= perPosMargin;

                multiPositions[symbol].push({
                  symbol,
                  side: signal.side,
                  entryPrice: multiEntryPrice,
                  entryTime: current.timestamp,
                  entryIdx: idx,
                  entryCandle: current,  // V5.68: Store entry candle for realistic timing
                  qty: addQty,
                  notionalUsd: perPosNotional,
                  marginUsd: perPosMargin,
                  leverage: posLev,
                  capitalBefore: capital + perPosMargin,
                  wasCapped: true,
                  stopLossPct: calcDynamicStopLoss(windowCandles, symbol).slPct,
                  highWaterMark: signal.side === 'long' ? multiEntryPrice : undefined,
                  lowWaterMark: signal.side === 'short' ? multiEntryPrice : undefined,
                  entryReason: `${signal.reason}_MULTI${posIdx}${wickBreakout.triggered ? '|wick_entry' : ''}`,
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

          const qty = notionalUsd / entryPrice;
          if (!Number.isFinite(qty) || qty <= 0) continue;
          // V5.13: Lower minimum margin for small accounts
          if (marginUsd < CONFIG.SIZING.MIN_MARGIN_USD) continue;

          const slPct = calcDynamicStopLoss(windowCandles, symbol).slPct;

          capitalInUse += marginUsd;
          capital -= marginUsd;

          // V5.64: Log wick breakout entry improvement
          const entryReason = wickBreakout.triggered
            ? `${signal.reason}|wick_entry(+${wickBreakout.improvement?.toFixed(2)}%)`
            : signal.reason;

          positions[symbol] = {
            symbol,
            side: signal.side,
            entryPrice,  // V5.64: Use wick breakout entry price if triggered
            entryTime: current.timestamp,
            entryIdx: idx,
            entryCandle: current,  // V5.68: Store entry candle for realistic timing
            qty,
            notionalUsd,
            marginUsd,
            leverage: posLev,
            capitalBefore: capital + marginUsd,
            wasCapped,
            stopLossPct: slPct,
            highWaterMark: signal.side === 'long' ? entryPrice : undefined,
            lowWaterMark: signal.side === 'short' ? entryPrice : undefined,
            entryReason,  // V5.64: Track entry reason with wick breakout info
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

      // V5.68: Calculate realistic entry timing for END trades (exit is at candle close)
      const endTiming = calculateRealisticHoldMinutes(
        pos.entryCandle,
        pos.entryPrice,
        lastCandle,
        lastCandle.close,
        'END',  // END exits at candle close
        pos.side
      );

      trades.push({
        id: `trade_${++tradeId}`,
        symbol,
        side: pos.side,
        entryTime: new Date(endTiming.entryTimestamp).toISOString(),
        exitTime: new Date(endTiming.exitTimestamp).toISOString(),
        entryPrice: pos.entryPrice,
        exitPrice: lastCandle.close,
        qty: pos.qty,
        notionalUsd: pos.notionalUsd,
        marginUsd: pos.marginUsd,
        leverage: pos.leverage,
        holdMinutes: endTiming.holdMinutes,  // V5.68: Realistic hold time
        grossPnlPct: pnl.grossPnlPct,
        netPnlPct: pnl.netPnlPct,
        netPnlUsd: pnl.netPnlUsd,
        feesUsd: pnl.feesUsd,
        exitReason: EXIT_END,
        entryReason: pos.entryReason,  // V5.32: Track entry reason
        capitalBefore: pos.capitalBefore,
        capitalAfter: capital + capitalInUse, // Total capital (free + in use)
        month: new Date(endTiming.exitTimestamp).toISOString().slice(0, 7),
        day: new Date(endTiming.exitTimestamp).toISOString().slice(0, 10),
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

        // V5.68: Realistic timing for multi-position END trades
        const multiEndTiming = calculateRealisticHoldMinutes(
          multiPos.entryCandle,
          multiPos.entryPrice,
          lastCandle,
          lastCandle.close,
          'END',
          multiPos.side
        );

        trades.push({
          id: `trade_${++tradeId}`,
          symbol,
          side: multiPos.side,
          entryTime: new Date(multiEndTiming.entryTimestamp).toISOString(),
          exitTime: new Date(multiEndTiming.exitTimestamp).toISOString(),
          entryPrice: multiPos.entryPrice,
          exitPrice: lastCandle.close,
          qty: multiPos.qty,
          notionalUsd: multiPos.notionalUsd,
          marginUsd: multiPos.marginUsd,
          leverage: multiPos.leverage,
          holdMinutes: multiEndTiming.holdMinutes,  // V5.68: Realistic hold time
          grossPnlPct: multiPnl.grossPnlPct,
          netPnlPct: multiPnl.netPnlPct,
          netPnlUsd: multiPnl.netPnlUsd,
          feesUsd: multiPnl.feesUsd,
          exitReason: `${EXIT_END}_MULTI${multiPos.positionIndex}`,
          entryReason: multiPos.entryReason,
          capitalBefore: multiPos.capitalBefore,
          capitalAfter: capital + capitalInUse,
          month: new Date(multiEndTiming.exitTimestamp).toISOString().slice(0, 7),
          day: new Date(multiEndTiming.exitTimestamp).toISOString().slice(0, 10),
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
    // V5.55: Include validSignals for both parityMode and forcedEntry (for signal validation)
    validSignals: (parityMode || forcedEntry) ? allValidSignals : undefined,
  };

  console.log(
    `[Backtest] Completed: ${trades.length} trades, ${wins.length} wins, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`,
  );

  return result;
}

// ============================================================================
// WORKER THREAD SPAWNING
// ============================================================================

import { Worker } from 'node:worker_threads';

// Resolve worker path using eval() to avoid parse errors in Jest/CJS.
// In ESM (production), eval has access to import.meta.url.
// In CJS (Jest), this returns null and we fall back to inline execution.
function resolveWorkerUrl(): URL | null {
  try {
    // eslint-disable-next-line no-eval
    return eval('new URL("./backtestWorker.js", import.meta.url)') as URL;
  } catch {
    return null;
  }
}

function runOnWorker(input: BacktestComputationInput): Promise<BacktestResult> {
  const workerUrl = resolveWorkerUrl();
  if (!workerUrl) return Promise.reject(new Error('Worker URL not available (CJS/test environment)'));

  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);

    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error('Backtest worker timeout (15min)'));
    }, 15 * 60 * 1000);

    worker.on('message', (msg: { success: boolean; result?: BacktestResult; error?: string }) => {
      clearTimeout(timeout);
      worker.terminate();
      if (msg.success) resolve(msg.result!);
      else reject(new Error(msg.error || 'Worker error'));
    });

    worker.on('error', (err) => {
      clearTimeout(timeout);
      worker.terminate();
      reject(err);
    });

    worker.postMessage(input);
  });
}

// ============================================================================
// MAIN BACKTEST FUNCTION — Loads data (main thread) then offloads computation
// ============================================================================

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const { startDate, endDate, symbols, dataStartDate } = params;

  console.log(`[Backtest] Fetching data for ${symbols.length} symbols...`);

  // V5.25: Check circuit breaker BEFORE starting backtest
  if (!globalRestCircuitBreaker.canMakeRequest()) {
    throw new Error('REST circuit breaker is OPEN - Binance rate limit active. Please wait before running backtest.');
  }

  // V5.25: Use cached exchange to avoid loadMarkets on every backtest
  const exchange = await getCachedExchange();
  console.log(`[Backtest] Exchange ready (using cached markets - 0 API weight)`);

  // V5.47: Use dataStartDate for loading data (indicator warmup) if provided
  const dataLoadStart = dataStartDate || startDate;

  // Fetch BTC for regime detection
  const btcCandles = await fetchCandles(exchange, 'BTC/USDT:USDT', dataLoadStart, endDate);
  console.log(`[Backtest] BTC 15m: ${btcCandles.length} candles`);

  // BTC candles for regime/MTF: derive default from config, or use param override
  const configTfStr = MomentumConfig.ENTRY.BTC_REGIME_TIMEFRAME;
  const configTfMin = parseInt(configTfStr) * (configTfStr.includes('h') ? 60 : 1);
  const regimeTfMin = params.regimeTimeframeMinutes ?? configTfMin;
  let btcCandles1h: BacktestCandle[];
  if (regimeTfMin === 60) {
    btcCandles1h = await fetchCandles1h(exchange, 'BTC/USDT:USDT', dataLoadStart, endDate);
    console.log(`[Backtest] BTC 1h: ${btcCandles1h.length} candles (native)`);
  } else if (regimeTfMin <= 15) {
    btcCandles1h = btcCandles;
    console.log(`[Backtest] BTC regime: using 15m candles directly (${btcCandles1h.length} candles)`);
  } else {
    btcCandles1h = aggregate15mCandles(btcCandles, regimeTfMin) as BacktestCandle[];
    console.log(`[Backtest] BTC ${regimeTfMin}m: ${btcCandles1h.length} candles (aggregated from 15m)`);
  }

  const CANDLE_REGIME_INTERVAL_MS = regimeTfMin * 60 * 1000;

  // Fetch symbol data — parallel batches of 3
  const allData: Record<string, BacktestCandle[]> = {};
  const BATCH_SIZE = 3;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(symbol => fetchCandles(exchange, symbol, dataLoadStart, endDate))
    );
    for (let j = 0; j < batch.length; j++) {
      allData[batch[j]] = results[j];
      console.log(`[Backtest] ${batch[j]}: ${results[j].length} candles`);
    }
    if (i + BATCH_SIZE < symbols.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  const input: BacktestComputationInput = {
    params,
    btcCandles,
    btcCandles1h,
    allData,
    CANDLE_REGIME_INTERVAL_MS,
  };

  // Run computation on worker thread to avoid blocking the event loop.
  // Falls back to inline execution if worker fails (e.g. tsx dev mode).
  try {
    console.log(`[Backtest] Starting computation on worker thread...`);
    const result = await runOnWorker(input);
    console.log(`[Backtest] Worker completed: ${result.trades.length} trades, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`);
    return result;
  } catch (workerError) {
    console.warn(`[Backtest] Worker thread unavailable, running on main thread:`, workerError);
    return runBacktestComputation(input);
  }
}
