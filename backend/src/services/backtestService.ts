/**
 * 🔬 Backtest Service - Unified Realistic Backtest Engine
 *
 * Uses momentumSimple strategy helpers for entries.
 * Uses intrabar execution for stops/trailing/TP (realistic).
 * Single mode - no legacy/agent split.
 */

import ccxt from 'ccxt';
import {
  loadLocalJsonCandles,
  mergeDedupCandles,
  sliceCandlesByTime,
  type BacktestCandle,
} from './backtest/localOhlcvJsonStore.js';

import {
  MomentumConfig,
} from '../strategies/momentumSimple.js';

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
}

export interface BacktestParams {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  symbols: string[];
  leverage: number;
  mode?: 'legacy' | 'agent'; // Ignored - kept for API compatibility
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
}

// ============================================================================
// CONFIG (synced with MomentumConfig)
// ============================================================================

const CONFIG = {
  EXIT: {
    STOP_LOSS_PCT: MomentumConfig.EXIT.STOP_LOSS_PCT,
    TAKE_PROFIT_PCT: MomentumConfig.EXIT.PROFIT_TARGET_PCT,
    TRAILING_ACTIVATION_PCT: MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT,
    TRAILING_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_DISTANCE_PCT,
    TRAILING_WIDEN_AT_PCT: MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT,
    TRAILING_WIDE_DISTANCE_PCT: MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT,
    MAX_HOLD_BARS: 192, // 48h in 15m bars
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
    ROC_MIN: MomentumConfig.ENTRY_LONG.ROC_MIN, // 0.025 = 2.5% as ratio
    VOL_MULTIPLIER: MomentumConfig.ENTRY_LONG.VOL_MULTIPLIER,
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
};

// ============================================================================
// INDICATORS
// ============================================================================

function calcSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes: number[], period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  return { upper: middle + std * mult, middle, lower: middle - std * mult };
}

function calcROC(closes: number[], period: number): number {
  if (closes.length < period + 1) return 0;
  const current = closes[closes.length - 1];
  const past = closes[closes.length - period - 1];
  return past > 0 ? (current - past) / past : 0; // Returns ratio like production
}

function calcVolRatio(volumes: number[]): number {
  if (volumes.length < 21) return 0;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  return avg > 0 ? current / avg : 0;
}

function countConsecUp(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close > candles[i].open) count++;
    else break;
  }
  return count;
}

function countConsecDown(candles: Candle[]): number {
  let count = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].close < candles[i].open) count++;
    else break;
  }
  return count;
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

function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let atrSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1]?.close || high;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    atrSum += tr;
  }

  return atrSum / period;
}

// Adaptive trailing: tighter in low vol, wider in high vol
function calcAdaptiveTrailing(candles: Candle[]): { activation: number; distance: number } {
  // Check if adaptive trailing is enabled
  if (!MomentumConfig.EXIT.ADAPTIVE_TRAILING) {
    return {
      activation: CONFIG.EXIT.TRAILING_ACTIVATION_PCT,
      distance: CONFIG.EXIT.TRAILING_DISTANCE_PCT,
    };
  }

  const atr = calcATR(candles, 14);
  
  if (!atr || candles.length === 0) {
    return {
      activation: CONFIG.EXIT.TRAILING_ACTIVATION_PCT,
      distance: CONFIG.EXIT.TRAILING_DISTANCE_PCT,
    };
  }
  
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = (atr / currentPrice) * 100;
  
  // Low volatility: tighter trailing (use production config)
  if (atrPct < MomentumConfig.EXIT.LOW_VOL_ATR_MAX) {
    return { 
      activation: MomentumConfig.EXIT.LOW_VOL_ACTIVATION, 
      distance: MomentumConfig.EXIT.LOW_VOL_DISTANCE,
    };
  }
  
  // High volatility: wider trailing (use production config)
  if (atrPct > MomentumConfig.EXIT.HIGH_VOL_ATR_MIN) {
    return { 
      activation: MomentumConfig.EXIT.HIGH_VOL_ACTIVATION, 
      distance: MomentumConfig.EXIT.HIGH_VOL_DISTANCE,
    };
  }
  
  // Medium: default
  return {
    activation: CONFIG.EXIT.TRAILING_ACTIVATION_PCT,
    distance: CONFIG.EXIT.TRAILING_DISTANCE_PCT,
  };
}

// ============================================================================
// SIGNAL CHECK V5.12
// ============================================================================

interface Signal {
  valid: boolean;
  side?: 'long' | 'short';
  reason?: string;
}

function checkSignal(candles: Candle[], isBull: boolean): Signal {
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

  const stochRsi = SIGNAL_CONFIG.STOCHRSI.ENABLED ? calcStochRSI(closes, 14, 14, 3) : null;

  if (isBull) {
    // LONG conditions V5.12
    const breakoutOk = current.close > bb.upper;
    const rocOk = roc10 >= SIGNAL_CONFIG.LONG.ROC_MIN;
    const volOk = volRatio >= SIGNAL_CONFIG.LONG.VOL_MULTIPLIER;
    const consecOk = countConsecUp(candles) <= SIGNAL_CONFIG.LONG.MAX_CONSEC_UP;

    if (isBullish && breakoutOk && rocOk && volOk && consecOk) {
      return { valid: true, side: 'long', reason: 'bull_breakout' };
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

    if (isBearish && dropOk && volOk && belowMa20 && belowBB && consecOk) {
      return { valid: true, side: 'short', reason: 'bear_breakdown' };
    }
  }

  return { valid: false, reason: 'no_signal' };
}

// ============================================================================
// DATA FETCHING
// ============================================================================

const exchange = new ccxt.binanceusdm({ enableRateLimit: true });

async function fetchCandlesFromCcxt(symbol: string, since: number, until: number): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = since;

  while (cursor < until) {
    try {
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
      await new Promise((r) => setTimeout(r, 100));
    } catch (e) {
      console.error(`Error fetching ${symbol}:`, e);
      break;
    }
  }

  return out;
}

async function fetchCandles(symbol: string, startDate: Date, endDate: Date): Promise<Candle[]> {
  const until = endDate.getTime();
  const extraBarsMs = 200 * 15 * 60 * 1000; // 200 bars × 15min
  const since = startDate.getTime() - extraBarsMs;

  const local = await loadLocalJsonCandles(symbol, '15m');
  if (!local) {
    return await fetchCandlesFromCcxt(symbol, since, until);
  }

  const needBefore = since < local.startTs;
  const needAfter = until > local.endTs;

  const localSlice = sliceCandlesByTime(local.candles, since, until);
  const parts: BacktestCandle[][] = [localSlice];

  if (needBefore) {
    const beforeCandles = await fetchCandlesFromCcxt(symbol, since, local.startTs - 1);
    parts.unshift(beforeCandles);
  }
  if (needAfter) {
    const afterCandles = await fetchCandlesFromCcxt(symbol, local.endTs + 1, until);
    parts.push(afterCandles);
  }

  return mergeDedupCandles(parts);
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
  const pricePct =
    side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

  const grossPnlPct = pricePct * leverage;

  // Costs
  const tradingFees = CONFIG.COSTS.TRADING_FEE_PCT * 2; // Entry + Exit
  const slippage = CONFIG.COSTS.SLIPPAGE_PCT * 2;
  const fundingPeriods = Math.floor(holdBars / CONFIG.COSTS.FUNDING_INTERVAL_BARS);
  const funding = fundingPeriods * CONFIG.COSTS.FUNDING_RATE_PCT;

  const totalCostsPct = (tradingFees + slippage + funding) * leverage;
  const netPnlPct = grossPnlPct - totalCostsPct;

  const feesUsd = (totalCostsPct / 100) * marginUsd;
  const netPnlUsd = (netPnlPct / 100) * marginUsd;

  return { grossPnlPct, netPnlPct, netPnlUsd, feesUsd };
}

// ============================================================================
// MAIN BACKTEST FUNCTION
// ============================================================================

export async function runBacktest(params: BacktestParams): Promise<BacktestResult> {
  const { startDate, endDate, initialCapital, symbols, leverage } = params;

  console.log(`[Backtest] Fetching data for ${symbols.length} symbols...`);

  // Fetch BTC for regime detection
  const btcCandles = await fetchCandles('BTC/USDT:USDT', startDate, endDate);
  const btcCloses = btcCandles.map((c) => c.close);
  console.log(`[Backtest] BTC: ${btcCandles.length} candles`);

  // Fetch all symbol data
  const allData: Record<string, Candle[]> = {};
  for (const symbol of symbols) {
    allData[symbol] = await fetchCandles(symbol, startDate, endDate);
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
  const cooldowns: Record<string, number> = {};
  symbols.forEach((s) => {
    positions[s] = null;
    cooldowns[s] = 0;
  });

  // Find start index (need 200 bars for SMA200)
  const startTimestamp = startDate.getTime();
  let startIdx = btcCandles.findIndex((c) => c.timestamp >= startTimestamp);
  if (startIdx < 200) startIdx = 200;

  console.log(`[Backtest] Starting simulation at index ${startIdx}...`);

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

    // Process each symbol
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
      // MANAGE EXISTING POSITION
      // ═══════════════════════════════════════════════════════════════════
      if (positions[symbol]) {
        const pos = positions[symbol]!;
        const holdBars = idx - pos.entryIdx;

        let shouldExit = false;
        let exitPrice = current.close;
        let exitReason = 'UNKNOWN';

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

        // Get adaptive trailing params
        const { activation, distance } = calcAdaptiveTrailing(windowCandles);

        // Check exits in priority order:
        // 0. REGIME CHANGE (NEW V5.13) - Exit if BTC regime flips
        // 0b. MOMENTUM REVERSAL (NEW V5.13) - Exit if momentum reverses
        // 1. Stop Loss (intrabar - check if wick hit stop)
        // 2. Take Profit (intrabar - check if wick hit TP)
        // 3. Trailing Stop (intrabar - if activated, check if wick hit trail)
        // 4. Max Hold Time

        // ═══════════════════════════════════════════════════════════════════
        // 0. REGIME CHANGE EXIT (V5.13)
        // ═══════════════════════════════════════════════════════════════════
        const btcSma200Current = calcSMA(btcCloses.slice(0, btcIdx + 1), 200);
        const btcPriceCurrent = btcCloses[btcIdx];
        const currentlyBullRegime = btcPriceCurrent > btcSma200Current;
        const positionOpenedInBullRegime = pos.side === 'long';

        if (positionOpenedInBullRegime && !currentlyBullRegime) {
          // LONG position but now in BEAR regime
          shouldExit = true;
          exitReason = 'REGIME_CHANGE';
          exitPrice = current.close;
        } else if (!positionOpenedInBullRegime && currentlyBullRegime) {
          // SHORT position but now in BULL regime
          shouldExit = true;
          exitReason = 'REGIME_CHANGE';
          exitPrice = current.close;
        }

        // ═══════════════════════════════════════════════════════════════════
        // 0b. MOMENTUM REVERSAL EXIT (V5.13)
        // ═══════════════════════════════════════════════════════════════════
        if (!shouldExit && windowCandles.length >= 6) {
          const closes = windowCandles.map(c => c.close);
          const roc5 = calcROC(closes, 5);

          if (pos.side === 'long' && roc5 < -0.015) {
            // LONG position but momentum turned bearish (-1.5%)
            shouldExit = true;
            exitReason = 'MOMENTUM_REVERSAL';
            exitPrice = current.close;
          } else if (pos.side === 'short' && roc5 > 0.015) {
            // SHORT position but momentum turned bullish (+1.5%)
            shouldExit = true;
            exitReason = 'MOMENTUM_REVERSAL';
            exitPrice = current.close;
          }
        }

        const slPct = pos.stopLossPct;

        // Only check SL/Trailing if regime change or momentum reversal didn't trigger
        if (!shouldExit && pos.side === 'long') {
          const slPrice = pos.entryPrice * (1 - slPct / 100);

          // SL hit? (wick went below stop)
          if (current.low <= slPrice) {
            shouldExit = true;
            exitReason = 'SL';
            exitPrice = slPrice;
          }
          // Trailing?
          else {
            const hwm = pos.highWaterMark!;
            const hwmPct = ((hwm - pos.entryPrice) / pos.entryPrice) * 100;

            if (hwmPct >= activation) {
              // V5.12: Smart trailing - widen distance at higher profits
              let trailDist = distance;
              if (hwmPct >= CONFIG.EXIT.TRAILING_WIDEN_AT_PCT) {
                trailDist = CONFIG.EXIT.TRAILING_WIDE_DISTANCE_PCT;
              }
              
              const trailStop = hwm * (1 - trailDist / 100);
              pos.appTrailingStop = trailStop;

              if (current.low <= trailStop) {
                shouldExit = true;
                exitReason = 'TRAIL';
                exitPrice = trailStop;
              }
            }
          }
        } else if (!shouldExit && pos.side === 'short') {
          // SHORT
          const slPrice = pos.entryPrice * (1 + slPct / 100);

          // SL hit?
          if (current.high >= slPrice) {
            shouldExit = true;
            exitReason = 'SL';
            exitPrice = slPrice;
          }
          // Trailing?
          else {
            const lwm = pos.lowWaterMark!;
            const lwmPct = ((pos.entryPrice - lwm) / pos.entryPrice) * 100;

            if (lwmPct >= activation) {
              let trailDist = distance;
              if (lwmPct >= CONFIG.EXIT.TRAILING_WIDEN_AT_PCT) {
                trailDist = CONFIG.EXIT.TRAILING_WIDE_DISTANCE_PCT;
              }
              
              const trailStop = lwm * (1 + trailDist / 100);
              pos.appTrailingStop = trailStop;

              if (current.high >= trailStop) {
                shouldExit = true;
                exitReason = 'TRAIL';
                exitPrice = trailStop;
              }
            }
          }
        }

        // Max hold time
        if (!shouldExit && holdBars >= CONFIG.EXIT.MAX_HOLD_BARS) {
          shouldExit = true;
          exitReason = 'TIME';
          exitPrice = current.close;
        }

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
            capitalBefore: pos.capitalBefore,
            capitalAfter: capital,
            month,
            day: exitDay,
            wasCapped: pos.wasCapped,
            slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
          });

          positions[symbol] = null;
          cooldowns[symbol] = 8; // 2h cooldown
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // CHECK FOR NEW ENTRY
      // ═══════════════════════════════════════════════════════════════════
      if (!positions[symbol] && cooldowns[symbol] <= 0) {
        // Count current open positions
        const openPositionCount = Object.values(positions).filter(p => p !== null).length;
        
        // V5.18: Dynamic max positions - faster scaling for better diversification
        const maxPositions = Math.min(
          CONFIG.SIZING.MAX_POSITIONS_BASE + Math.floor(initialCapital / 1500) * CONFIG.SIZING.POSITIONS_PER_1500,
          CONFIG.SIZING.MAX_POSITIONS_CAP
        );
        
        // Skip if we already have max positions open
        if (openPositionCount >= maxPositions) continue;
        
        const availableCapital = capital - capitalInUse;
        
        // V5.17: Low minimum to maximize trade opportunities
        const minAvailableCapital = Math.max(
          initialCapital * CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_PCT,
          CONFIG.SIZING.MIN_AVAILABLE_CAPITAL_FLOOR
        );
        if (availableCapital < minAvailableCapital) continue;

        // BTC regime: use PRIOR BTC close for regime (avoid look-ahead)
        const btcSma200 = calcSMA(btcCloses.slice(0, btcIdx), 200);
        const btcPriceForRegime = btcIdx > 0 ? btcCloses[btcIdx - 1] : btcCloses[0];
        const isBullRegime = btcPriceForRegime > btcSma200;

        // Use local checkSignal (V5.12 strategy)
        const signal = checkSignal(windowCandles, isBullRegime);
        if (!signal.valid || !signal.side) continue;

        // V5.18: Keep leverage high for all accounts
        const posLev = leverage || 5;

        // V5.18: Dynamic position sizing - moderate boost for bigger accounts
        const positionSizePct = Math.min(
          CONFIG.SIZING.POSITION_SIZE_PCT_BASE + (initialCapital / 5000) * CONFIG.SIZING.POSITION_SIZE_PCT_BOOST_PER_5K,
          CONFIG.SIZING.POSITION_SIZE_PCT_MAX
        );
        let marginUsd = availableCapital * positionSizePct;
        let notionalUsd = marginUsd * posLev;

        // Apply liquidity caps
        const LIQUIDITY_CAPS: Record<string, number> = {
          'BTC/USDT:USDT': 500_000,
          'ETH/USDT:USDT': 500_000,
          'XRP/USDT:USDT': 100_000,
          'SOL/USDT:USDT': 100_000,
          'SEI/USDT:USDT': 25_000,
          'IMX/USDT:USDT': 25_000,
          'DOT/USDT:USDT': 25_000,
          'DOGE/USDT:USDT': 100_000,
          'SUI/USDT:USDT': 50_000,
          'ADA/USDT:USDT': 100_000,
          'LINK/USDT:USDT': 50_000,
          'AVAX/USDT:USDT': 50_000,
        };
        const cap = LIQUIDITY_CAPS[symbol] ?? Infinity;
        const wasCapped = Number.isFinite(cap) && notionalUsd > cap;
        if (wasCapped) {
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
        };
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
        capitalBefore: pos.capitalBefore,
        capitalAfter: capital,
        month: new Date(lastCandle.timestamp).toISOString().slice(0, 7),
        day: new Date(lastCandle.timestamp).toISOString().slice(0, 10),
        wasCapped: pos.wasCapped,
        slippagePct: CONFIG.COSTS.SLIPPAGE_PCT * 2,
      });
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
  };

  console.log(
    `[Backtest] Completed: ${trades.length} trades, ${wins.length} wins, ROI: ${result.summary.totalPnlPct.toFixed(1)}%`,
  );

  return result;
}
