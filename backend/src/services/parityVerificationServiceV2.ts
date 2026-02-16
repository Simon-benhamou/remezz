/**
 * 🔬 Parity Verification Service V2
 *
 * Redesigned parity verification focused on bug detection.
 *
 * Philosophy:
 * - Fetch candles dynamically from API (not local files)
 * - Isolated trade simulation (not full backtest)
 * - Answer: "Given this exact entry, would backtest exit the same way?"
 * - Not affected by max positions, cooldowns, or other strategy constraints
 *
 * Categories:
 * - MATCH: Same signal validity, same exit reason
 * - EXIT_MISMATCH: Same entry but different exit reason (BUG!)
 * - NO_SIGNAL: Backtest wouldn't have entered (potential live bug)
 * - PNL_VARIANCE: Same exit reason but PnL differs (acceptable slippage)
 */

import { prisma } from '../db/client.js';
import * as ccxt from 'ccxt';
import { binanceRestQueue, BINANCE_WEIGHTS } from './binanceRestQueue.js';
import {
  checkMomentumSignal,
  shouldExitPosition,
  updatePositionWaterMarks,
  calcDynamicStopLoss,
  MomentumConfig,
  type Candle,
  type Position,
  type SignalResult,
  type ExitSignal,
} from '../strategies/momentumSimple.js';
import { createLogger } from '../utils/logger.js';
import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH, EXIT_TRAIL_NFS_MED, EXIT_TRAIL_NFS_LOW,
  EXIT_TIME, EXIT_SIGNAL_REASON_MAP,
  normalizeToFamily,
} from '../types/exitReasons.js';

const logger = createLogger('parity-v2');

// ============================================================================
// TYPES
// ============================================================================

export interface ParityResultV2 {
  tradeId: string;
  symbol: string;
  side: 'long' | 'short';

  // Live trade data
  liveEntry: {
    timestamp: Date;
    price: number;
  };
  liveExit: {
    timestamp: Date;
    price: number;
    reason: string;
  };
  livePnlPct: number;
  liveDurationMin: number;

  // Signal verification
  signalCheck: {
    wouldBacktestEnter: boolean;
    signalStrength: number | null;
    signalReason: string | null;
  };

  // Exit simulation
  exitSimulation: {
    exitReason: string;
    exitPrice: number;
    exitCandleIndex: number;
    pnlPct: number;
    durationMin: number;  // V5.70: Simulated duration in minutes
  } | null;

  // Comparison
  comparison: {
    signalMatch: boolean;
    exitReasonMatch: boolean;
    pnlDiffPct: number | null;
    durationDiffMin: number | null;  // V5.70: Duration difference in minutes
    category: ParityCategory;
    details: string;
  };

  // Metadata
  candlesFetched: number;
  verificationTimeMs: number;
}

export type ParityCategory =
  | 'MATCH'              // Everything matches
  | 'EXIT_MISMATCH'      // Same entry, different exit reason (BUG!)
  | 'NO_SIGNAL'          // Backtest wouldn't have entered
  | 'PNL_VARIANCE'       // Same exit but PnL differs
  | 'DURATION_MISMATCH'  // V5.70: Same exit reason but duration differs too much
  | 'DATA_ERROR';        // Couldn't fetch data

// ============================================================================
// EXCHANGE SETUP
// ============================================================================

let exchange: ccxt.binance | null = null;

function getExchange(): ccxt.binance {
  if (!exchange) {
    exchange = new ccxt.binance({
      enableRateLimit: true,
      options: { defaultType: 'future' },
    });
  }
  return exchange;
}

// ============================================================================
// CANDLE FETCHING (Always from API)
// ============================================================================

interface FetchedCandles {
  symbol: Candle[];
  btc: Candle[];
  btc1h: Candle[];  // V5.86: BTC 1h candles for regime SMA200
}

async function fetchCandlesForTrade(
  symbol: string,
  entryTs: number,
  exitTs: number
): Promise<FetchedCandles> {
  const ex = getExchange();

  // Fetch window for 15m candles: 3 days before entry to 1 hour after exit
  const warmupMs15m = 3 * 24 * 60 * 60 * 1000;
  // V5.87 FIX: BTC 1h candles need 200+ for SMA200 regime = 200h = 8.3 days minimum
  // Use 10 days to have buffer (240 candles)
  const warmupMs1h = 10 * 24 * 60 * 60 * 1000;
  const bufferMs = 60 * 60 * 1000;
  const since15m = entryTs - warmupMs15m;
  const since1h = entryTs - warmupMs1h;
  const until = exitTs + bufferMs;

  // V5.86: Generic candle fetcher with configurable timeframe
  const fetchCandlesWithTimeframe = async (sym: string, timeframe: string, sinceTs: number): Promise<Candle[]> => {
    const candles: Candle[] = [];
    let cursor = sinceTs;

    while (cursor < until) {
      try {
        // Route through binanceRestQueue — single gateway for ALL Binance REST calls.
        // Queue handles weight tracking, IP ban detection, and rate limiting.
        const ohlcv = await binanceRestQueue.enqueue(
          () => ex.fetchOHLCV(sym, timeframe, cursor, 1000),
          {
            weight: BINANCE_WEIGHTS.FETCH_OHLCV,
            priority: 'low',
            tag: `parity-v2:${sym}:${timeframe}`,
          },
        );
        if (!ohlcv || ohlcv.length === 0) break;

        for (const c of ohlcv) {
          const ts = c[0] as number;
          if (ts > until) break;
          if (candles.length && ts <= candles[candles.length - 1].timestamp) continue;

          candles.push({
            timestamp: ts,
            open: c[1] as number,
            high: c[2] as number,
            low: c[3] as number,
            close: c[4] as number,
            volume: c[5] as number,
          });
        }

        const lastTs = ohlcv[ohlcv.length - 1][0] as number;
        if (lastTs <= cursor) break;
        cursor = lastTs + 1;
      } catch (e: any) {
        logger.error(`Error fetching ${sym} ${timeframe}: ${e.message}`);
        break;
      }
    }

    return candles;
  };

  // V5.87 FIX: Fetch 15m and 1h candles with appropriate warmup periods
  // BTC 1h candles need 200+ for SMA200 regime calculation (matches live/backtest)
  const [symbolCandles, btcCandles, btcCandles1h] = await Promise.all([
    fetchCandlesWithTimeframe(symbol, '15m', since15m),
    fetchCandlesWithTimeframe('BTC/USDT:USDT', '15m', since15m),
    fetchCandlesWithTimeframe('BTC/USDT:USDT', '1h', since1h),  // V5.87: 10 days for 200+ candles
  ]);

  return {
    symbol: symbolCandles,
    btc: btcCandles,
    btc1h: btcCandles1h,
  };
}

// ============================================================================
// SIGNAL VERIFICATION
// ============================================================================

interface SignalCheckResult {
  wouldEnter: boolean;
  strength: number | null;
  reason: string;
}

function checkSignalAtEntry(
  symbol: string,
  candles: Candle[],
  btcCandles: Candle[],
  btcCandles1h: Candle[],  // V5.86: BTC 1h candles for regime SMA200
  entryTs: number,
  side: 'long' | 'short'
): SignalCheckResult {
  // V5.80 FIX: Correct candle selection to match live behavior EXACTLY
  //
  // CRITICAL: Live records entryTime as lastCandle.timestamp (V5.46)
  // This is the timestamp of the candle that JUST CLOSED and triggered the entry.
  //
  // Understanding Binance timestamps:
  //   - Candle timestamp = OPEN time (e.g., 09:45:00 for 09:45-10:00 candle)
  //   - Candle CLOSES at timestamp + 15 minutes (e.g., 10:00:00)
  //   - At 10:00:01, the 09:45 candle has isFinal=true, the 10:00 candle is forming
  //
  // Example: If trade entered at 10:00:02 (2 seconds after 09:45 candle closed)
  //   - lastCandle.timestamp = 09:45:00 (the candle that just closed)
  //   - entryTime stored in DB = 09:45:00
  //   - Live used candles with timestamp <= 09:45:00
  //
  // V5.87 FIX: The DB stores ACTUAL entry time (e.g., 10:15:03), not candle open time.
  // Entry happens ~2-3 seconds AFTER a candle closes (due to processing time).
  // If entry is at 10:15:03, the LAST CLOSED candle is 10:00 (which closed at 10:15:00).
  // The candle 10:15 is STILL FORMING at 10:15:03, so we must NOT include it.
  const CANDLE_MS = 15 * 60 * 1000; // 15-minute candles
  const currentCandleStart = Math.floor(entryTs / CANDLE_MS) * CANDLE_MS;
  const lastClosedCandleTs = currentCandleStart - CANDLE_MS;  // V5.87: Previous candle, not current

  // V5.61 FIX: Apply same filter to BOTH symbol and BTC candles
  // V5.80: Use < instead of <= to exclude the candle AT lastClosedCandleTs if it's still forming
  // But since entryTs is the OPEN time of the closed candle (not the close time), we use <=
  const windowCandles = candles.filter(c => c.timestamp <= lastClosedCandleTs);
  const btcWindow = btcCandles.filter(c => c.timestamp <= lastClosedCandleTs);

  // V5.80: Log for debugging parity issues
  const lastSymbolCandle = windowCandles[windowCandles.length - 1];
  const lastBtcCandle = btcWindow[btcWindow.length - 1];
  logger.debug(
    `[Parity] ${symbol} entry @ ${new Date(entryTs).toISOString()} | ` +
    `lastClosedCandleTs=${new Date(lastClosedCandleTs).toISOString()} | ` +
    `symbolCandles=${windowCandles.length} (last=${new Date(lastSymbolCandle?.timestamp || 0).toISOString()}, close=${lastSymbolCandle?.close?.toFixed(6)}) | ` +
    `btcCandles=${btcWindow.length} (last=${new Date(lastBtcCandle?.timestamp || 0).toISOString()})`
  );

  if (windowCandles.length < 50 || btcWindow.length < 50) {
    return { wouldEnter: false, strength: null, reason: 'Insufficient candle data' };
  }

  // Find the candle index at entry time (for reference only now)
  const entryIdx = candles.findIndex(c => c.timestamp >= entryTs);
  if (entryIdx < 50) {
    return { wouldEnter: false, strength: null, reason: 'Not enough warmup candles' };
  }

  if (windowCandles.length < 50 || btcWindow.length < 50) {
    return { wouldEnter: false, strength: null, reason: 'Insufficient candle data' };
  }

  // V5.86: Filter BTC 1h candles to entry time for regime calculation
  // FIX: Use close time (timestamp + 1h) not open time — must only include CLOSED 1h candles.
  // Matches backtest (c.timestamp + 1h <= btcCandle.timestamp) and live (isFinal filter).
  // Old filter (c.timestamp <= lastClosedCandleTs) included the forming 1h candle,
  // which used its FINAL close price (look-ahead bias) and could flip the regime.
  const CANDLE_1H_MS = 60 * 60 * 1000;
  const btcWindow1h = btcCandles1h.filter(c => c.timestamp + CANDLE_1H_MS <= lastClosedCandleTs);

  // Check if signal would fire
  try {
    // V5.86: Pass btcCandles1h for regime SMA200 (critical for bull/bear regime detection)
    const signal: SignalResult = checkMomentumSignal(symbol, windowCandles, btcWindow, {
      nowMs: entryTs,
      btcCandles1h: btcWindow1h,  // V5.86: Critical for regime parity!
    });

    if (!signal.valid) {
      return {
        wouldEnter: false,
        strength: null,
        reason: signal.reason || 'No signal',
      };
    }

    // Check if side matches
    if (signal.side !== side) {
      return {
        wouldEnter: false,
        strength: signal.confidence ?? null,
        reason: `Signal is ${signal.side}, live was ${side}`,
      };
    }

    return {
      wouldEnter: true,
      strength: signal.confidence ?? null,
      reason: 'Valid signal matches',
    };
  } catch (e: any) {
    return { wouldEnter: false, strength: null, reason: `Error: ${e.message}` };
  }
}

// ============================================================================
// V5.62: NFS (NOISE FILTER SCORE) FOR ADAPTIVE TRAILING
// ============================================================================

const NFS_CONFIG = {
  HIGH_THRESHOLD: 70,
  MEDIUM_THRESHOLD: 40,
  WEIGHT_BREACH_ATR: 35,
  WEIGHT_BREACH_DEPTH: 25,
  WEIGHT_VOLUME: 20,
  WEIGHT_BODY_RATIO: 10,
  WEIGHT_MOMENTUM: 10,
  BREACH_ATR_THRESHOLD: 0.40,
  BREACH_DEPTH_THRESHOLD: 0.25,
  VOLUME_RATIO_THRESHOLD: 1.5,
  BODY_RATIO_THRESHOLD: 0.5,
  MOMENTUM_THRESHOLD: 0.5,
};

interface NfsScore {
  score: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

function calculateNfsScoreForBreach(
  candle: Candle,
  prevCandles: Candle[],
  side: 'long' | 'short',
  trailingStopPrice: number
): NfsScore {
  // Breach depth
  let breachDepthAbs: number;
  let breachDepthPct: number;
  if (side === 'long') {
    breachDepthAbs = Math.max(0, trailingStopPrice - candle.close);
    breachDepthPct = trailingStopPrice > 0 ? (breachDepthAbs / trailingStopPrice) * 100 : 0;
  } else {
    breachDepthAbs = Math.max(0, candle.close - trailingStopPrice);
    breachDepthPct = trailingStopPrice > 0 ? (breachDepthAbs / trailingStopPrice) * 100 : 0;
  }

  // ATR
  const atrPeriod = Math.min(14, prevCandles.length);
  let atrSum = 0;
  for (let i = prevCandles.length - atrPeriod; i < prevCandles.length; i++) {
    const c = prevCandles[i];
    const prevClose = i > 0 ? prevCandles[i - 1].close : c.open;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    atrSum += tr;
  }
  const atr = atrPeriod > 0 ? atrSum / atrPeriod : 1;
  const breachAtrRatio = atr > 0 ? breachDepthAbs / atr : 0;

  // Volume ratio
  const avgVolume = prevCandles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, prevCandles.length);
  const volumeRatio = avgVolume > 0 ? candle.volume / avgVolume : 1;

  // Candle body ratio
  const bodySize = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;
  const bodyRatio = candleRange > 0 ? bodySize / candleRange : 0;

  // ROC5 momentum
  const roc5Close = prevCandles[prevCandles.length - 5]?.close ?? candle.open;
  const roc5 = roc5Close > 0 ? ((candle.close - roc5Close) / roc5Close) * 100 : 0;
  const momentumAligned = side === 'long' ? roc5 <= -NFS_CONFIG.MOMENTUM_THRESHOLD : roc5 >= NFS_CONFIG.MOMENTUM_THRESHOLD;

  // Score calculation
  let score = 0;
  if (breachAtrRatio >= NFS_CONFIG.BREACH_ATR_THRESHOLD) score += NFS_CONFIG.WEIGHT_BREACH_ATR;
  else if (breachAtrRatio >= NFS_CONFIG.BREACH_ATR_THRESHOLD * 0.5) score += NFS_CONFIG.WEIGHT_BREACH_ATR * 0.5;
  if (breachDepthPct >= NFS_CONFIG.BREACH_DEPTH_THRESHOLD) score += NFS_CONFIG.WEIGHT_BREACH_DEPTH;
  else if (breachDepthPct >= NFS_CONFIG.BREACH_DEPTH_THRESHOLD * 0.5) score += NFS_CONFIG.WEIGHT_BREACH_DEPTH * 0.5;
  if (volumeRatio >= NFS_CONFIG.VOLUME_RATIO_THRESHOLD) score += NFS_CONFIG.WEIGHT_VOLUME;
  else if (volumeRatio >= NFS_CONFIG.VOLUME_RATIO_THRESHOLD * 0.8) score += NFS_CONFIG.WEIGHT_VOLUME * 0.5;
  if (bodyRatio >= NFS_CONFIG.BODY_RATIO_THRESHOLD) score += NFS_CONFIG.WEIGHT_BODY_RATIO;
  if (momentumAligned) score += NFS_CONFIG.WEIGHT_MOMENTUM;

  let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  if (score >= NFS_CONFIG.HIGH_THRESHOLD) confidence = 'HIGH';
  else if (score >= NFS_CONFIG.MEDIUM_THRESHOLD) confidence = 'MEDIUM';
  else confidence = 'LOW';

  return { score, confidence };
}

// ============================================================================
// EXIT SIMULATION
// ============================================================================

interface ExitSimResult {
  exitReason: string;
  exitPrice: number;
  exitCandleIndex: number;
  pnlPct: number;
  durationMin: number;  // V5.70: Duration in minutes for parity comparison
}

function simulateExit(
  candles: Candle[],
  btcCandles: Candle[],
  entryTs: number,
  entryPrice: number,
  side: 'long' | 'short',
  leverage: number,
  symbol: string
): ExitSimResult | null {
  // Find entry candle index
  const entryIdx = candles.findIndex(c => c.timestamp >= entryTs);
  if (entryIdx < 0) return null;

  // V5.95: Compute entry-time SL% using candles up to entry (matching live behavior).
  // Live places a fixed STOP_MARKET order at entry using calcDynamicStopLoss().
  // Previously, sim let shouldExitPosition() recalculate dynamic SL per candle,
  // which could shift with volatility regime changes → duration mismatch.
  const entrySlResult = calcDynamicStopLoss(candles.slice(0, entryIdx + 1), symbol);
  const entrySlPct = entrySlResult.slPct;
  const fixedSlPrice = side === 'long'
    ? entryPrice * (1 - entrySlPct / 100)
    : entryPrice * (1 + entrySlPct / 100);

  logger.info(`[SIM-EXIT] ${symbol} entry-time SL: ${entrySlPct.toFixed(2)}% (${entrySlResult.isDynamic ? 'dynamic' : 'static'}, tier=${entrySlResult.tier ?? 'default'}), fixedSlPrice=${fixedSlPrice.toFixed(4)}`);

  // Create position object with entry-time SL locked
  let position: Position = {
    symbol,
    side,
    entryPrice,
    entryTime: entryTs,
    qty: 1,
    leverage,
    stopLossPct: entrySlPct,
    highWaterMark: entryPrice,
    lowWaterMark: entryPrice,
    maxPnlPct: 0,
    trailingActive: false,
    trailingBreachCandles: 0,
    stagnantState: {
      triggered: false,
      confirmed: false,
      cancelled: false,
      obsPeakPct: 0,
    },
  };

  // Simulate candle by candle
  for (let i = entryIdx + 1; i < candles.length; i++) {
    const candle = candles[i];
    const holdMinutes = Math.round((candle.timestamp - entryTs) / 60000);

    // V5.95: Check fixed SL BEFORE shouldExitPosition (matches live exchange SL behavior).
    // Live uses STOP_MARKET with workingType=MARK_PRICE, sim uses candle.low/high.
    // This is checked first because the exchange SL triggers independently of the agent.
    const slTriggered = side === 'long'
      ? candle.low <= fixedSlPrice
      : candle.high >= fixedSlPrice;

    if (slTriggered) {
      const pnlPct = side === 'long'
        ? ((fixedSlPrice - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - fixedSlPrice) / entryPrice) * 100 * leverage;
      const candlesHeld = i - entryIdx;

      return {
        exitReason: EXIT_SIGNAL_REASON_MAP['stoploss'] ?? 'STOP_LOSS',
        exitPrice: fixedSlPrice,
        exitCandleIndex: candlesHeld,
        pnlPct,
        durationMin: candlesHeld * 15,
      };
    }

    // Get BTC candles up to this point
    const btcWindow = btcCandles.filter(c => c.timestamp <= candle.timestamp);

    // Update watermarks
    position = updatePositionWaterMarks(position, candle.close, candle.high, candle.low);

    // Get window of candles
    const windowStart = Math.max(0, i - 200);
    const windowCandles = candles.slice(windowStart, i + 1);

    // Check exit (shouldExitPosition still handles trailing, NFS, stagnant, regime, time)
    const exitSignal = shouldExitPosition(position, candle.close, windowCandles, {
      nowMs: candle.timestamp,
      priceHigh: candle.high,
      priceLow: candle.low,
      btcCandles: btcWindow,
    });

    // Update position state
    if (exitSignal.trailingActivated) {
      position.trailingActive = true;
    }
    if (exitSignal.newStopLoss) {
      position.appTrailingStop = exitSignal.newStopLoss;
    }
    // Stagnant state is tracked internally by shouldExitPosition via the position object

    // V5.62: Handle trailing breach with NFS_ADAPTIVE
    // NFS determines exit strategy based on confidence:
    // - HIGH: Exit at trailing stop price (theoretical/perfect)
    // - MEDIUM: 1-candle confirmation, exit at close
    // - LOW: 2-candle confirmation, exit at close
    if (exitSignal.reason === 'trailing_breach' || exitSignal.reason === 'trailing') {
      position.trailingBreachCandles = (position.trailingBreachCandles ?? 0) + 1;
      const trailingStopPrice = exitSignal.newStopLoss ?? position.appTrailingStop ?? candle.close;

      // Calculate NFS score
      const nfsScore = calculateNfsScoreForBreach(
        candle,
        windowCandles.slice(-20),
        side,
        trailingStopPrice
      );

      let shouldExit = false;
      let exitPrice = candle.close;
      let exitReason = EXIT_TRAIL;

      if (nfsScore.confidence === 'HIGH') {
        // HIGH confidence: Exit at trailing stop price (perfect)
        shouldExit = true;
        exitPrice = trailingStopPrice;
        exitReason = EXIT_TRAIL_NFS_HIGH;
      } else if (nfsScore.confidence === 'MEDIUM') {
        // MEDIUM: 1-candle confirmation, exit at close
        if (position.trailingBreachCandles >= 1) {
          shouldExit = true;
          exitPrice = candle.close;
          exitReason = EXIT_TRAIL_NFS_MED;
        }
      } else {
        // LOW: 2-candle confirmation, exit at close
        if (position.trailingBreachCandles >= 2) {
          shouldExit = true;
          exitPrice = candle.close;
          exitReason = EXIT_TRAIL_NFS_LOW;
        }
      }

      if (shouldExit) {
        const pnlPct = side === 'long'
          ? ((exitPrice - entryPrice) / entryPrice) * 100 * leverage
          : ((entryPrice - exitPrice) / entryPrice) * 100 * leverage;
        const candlesHeld = i - entryIdx;

        return {
          exitReason,
          exitPrice,
          exitCandleIndex: candlesHeld,
          pnlPct,
          durationMin: candlesHeld * 15,  // V5.70: 15m candles
        };
      }
    } else {
      // Reset breach counter if no breach
      position.trailingBreachCandles = 0;
    }

    // Check other exit conditions (skip stoploss - already handled by fixed SL above)
    if (exitSignal.shouldExit && exitSignal.reason !== 'trailing_breach' && exitSignal.reason !== 'stoploss') {
      let exitPrice = candle.close;
      if (exitSignal.reason === 'stagnant_trade') {
        // Stagnant exits at the fixed SL price (same as live)
        exitPrice = fixedSlPrice;
      }

      const pnlPct = side === 'long'
        ? ((exitPrice - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - exitPrice) / entryPrice) * 100 * leverage;
      const candlesHeld = i - entryIdx;

      return {
        exitReason: EXIT_SIGNAL_REASON_MAP[exitSignal.reason ?? ''] ?? exitSignal.reason?.toUpperCase() ?? 'UNKNOWN',
        exitPrice,
        exitCandleIndex: candlesHeld,
        pnlPct,
        durationMin: candlesHeld * 15,  // V5.70: 15m candles
      };
    }

    // Max hold time safety (48 hours)
    if (holdMinutes > 48 * 60) {
      const pnlPct = side === 'long'
        ? ((candle.close - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - candle.close) / entryPrice) * 100 * leverage;
      const candlesHeld = i - entryIdx;

      return {
        exitReason: EXIT_TIME,
        exitPrice: candle.close,
        exitCandleIndex: candlesHeld,
        pnlPct,
        durationMin: candlesHeld * 15,  // V5.70: 15m candles
      };
    }
  }

  // If we reach here, no exit triggered (shouldn't happen with proper data)
  return null;
}

// ============================================================================
// MAIN VERIFICATION FUNCTION
// ============================================================================

export async function verifyTradeV2(tradeId: string): Promise<ParityResultV2> {
  const startTime = Date.now();

  // 1. Fetch trade from DB
  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
  });

  if (!trade) {
    throw new Error(`Trade not found: ${tradeId}`);
  }

  const symbol = trade.symbol;
  const side = trade.positionSide.toLowerCase() as 'long' | 'short';
  const entryTs = trade.entryTs.getTime();
  const exitTs = trade.exitTs.getTime();
  const entryPrice = trade.entryPrice;
  const leverage = trade.leverage || 5;

  logger.info(`[PARITY-V2] Verifying ${symbol} ${side} @ ${trade.entryTs.toISOString()}`);

  // 2. Fetch candles dynamically from API
  // V5.86: Now fetches BTC 1h candles for regime SMA200 (critical for parity)
  logger.info(`[PARITY-V2] Fetching candles from API...`);
  const { symbol: symbolCandles, btc: btcCandles, btc1h: btcCandles1h } = await fetchCandlesForTrade(
    symbol,
    entryTs,
    exitTs
  );

  // V5.86: Also check BTC 1h candles (need 200+ for SMA200)
  if (symbolCandles.length < 100 || btcCandles.length < 100) {
    return {
      tradeId,
      symbol,
      side,
      liveEntry: { timestamp: trade.entryTs, price: entryPrice },
      liveExit: { timestamp: trade.exitTs, price: trade.exitPrice, reason: trade.exitReason || 'UNKNOWN' },
      livePnlPct: (trade.roiPct || 0) * leverage,
      liveDurationMin: trade.durationMinutes || 0,
      signalCheck: { wouldBacktestEnter: false, signalStrength: null, signalReason: 'Insufficient candle data' },
      exitSimulation: null,
      comparison: {
        signalMatch: false,
        exitReasonMatch: false,
        pnlDiffPct: null,
        durationDiffMin: null,  // V5.70
        category: 'DATA_ERROR',
        details: `Only ${symbolCandles.length} symbol candles and ${btcCandles.length} BTC candles fetched`,
      },
      candlesFetched: symbolCandles.length + btcCandles.length,
      verificationTimeMs: Date.now() - startTime,
    };
  }

  // V5.86: Log BTC 1h candle count (important for regime parity)
  logger.info(`[PARITY-V2] Fetched ${symbolCandles.length} symbol candles, ${btcCandles.length} BTC 15m candles, ${btcCandles1h.length} BTC 1h candles`);

  // 3. Check if backtest would have entered on same signal
  // V5.86: Now passes BTC 1h candles for regime SMA200 calculation
  const signalCheck = checkSignalAtEntry(symbol, symbolCandles, btcCandles, btcCandles1h, entryTs, side);
  logger.info(`[PARITY-V2] Signal check: wouldEnter=${signalCheck.wouldEnter}, reason=${signalCheck.reason} | btc1h=${btcCandles1h.length} candles`);

  // 4. Simulate exit (regardless of signal validity - we want to compare exit logic)
  const exitSim = simulateExit(symbolCandles, btcCandles, entryTs, entryPrice, side, leverage, symbol);

  if (!exitSim) {
    return {
      tradeId,
      symbol,
      side,
      liveEntry: { timestamp: trade.entryTs, price: entryPrice },
      liveExit: { timestamp: trade.exitTs, price: trade.exitPrice, reason: trade.exitReason || 'UNKNOWN' },
      livePnlPct: (trade.roiPct || 0) * leverage,
      liveDurationMin: trade.durationMinutes || 0,
      signalCheck: {
        wouldBacktestEnter: signalCheck.wouldEnter,
        signalStrength: signalCheck.strength,
        signalReason: signalCheck.reason,
      },
      exitSimulation: null,
      comparison: {
        signalMatch: signalCheck.wouldEnter,
        exitReasonMatch: false,
        pnlDiffPct: null,
        durationDiffMin: null,  // V5.70
        category: 'DATA_ERROR',
        details: 'Exit simulation failed - insufficient data after entry',
      },
      candlesFetched: symbolCandles.length + btcCandles.length,
      verificationTimeMs: Date.now() - startTime,
    };
  }

  logger.info(`[PARITY-V2] Exit sim: reason=${exitSim.exitReason}, price=${exitSim.exitPrice.toFixed(4)}, pnl=${exitSim.pnlPct.toFixed(2)}%, duration=${exitSim.durationMin}min`);

  // 5. Compare results
  const liveExitReason = normalizeToFamily(trade.exitReason || 'UNKNOWN');
  const simExitReason = normalizeToFamily(exitSim.exitReason);
  const livePnlPct = (trade.roiPct || 0) * leverage;
  const pnlDiff = Math.abs(livePnlPct - exitSim.pnlPct);

  // V5.70: Duration comparison with tolerance
  // Tolerance: max(30 min, 20% of live duration) - accounts for intrabar timing differences
  const liveDurationMin = trade.durationMinutes || 0;
  const simDurationMin = exitSim.durationMin;
  const durationDiff = Math.abs(liveDurationMin - simDurationMin);
  const durationTolerance = Math.max(30, liveDurationMin * 0.2);
  const durationMatch = durationDiff <= durationTolerance;

  const exitReasonMatch = liveExitReason === simExitReason;

  let category: ParityCategory;
  let details: string;

  if (!signalCheck.wouldEnter) {
    category = 'NO_SIGNAL';
    details = `Backtest would NOT enter: ${signalCheck.reason}`;
  } else if (!exitReasonMatch) {
    category = 'EXIT_MISMATCH';
    details = `Exit reason mismatch: Live=${liveExitReason}, Sim=${simExitReason}`;
  } else if (pnlDiff > 3.0) {
    category = 'PNL_VARIANCE';
    details = `Same exit reason but PnL differs by ${pnlDiff.toFixed(2)}% (Live=${livePnlPct.toFixed(2)}%, Sim=${exitSim.pnlPct.toFixed(2)}%)`;
  } else if (!durationMatch) {
    // V5.70: Duration mismatch - exit reason matches but timing is significantly off
    category = 'DURATION_MISMATCH';
    details = `Same exit reason but duration differs by ${durationDiff}min (Live=${liveDurationMin}min, Sim=${simDurationMin}min, tolerance=${durationTolerance.toFixed(0)}min)`;
  } else {
    category = 'MATCH';
    details = `✅ Signal and exit match (PnL diff: ${pnlDiff.toFixed(2)}%, duration diff: ${durationDiff}min)`;
  }

  const result: ParityResultV2 = {
    tradeId,
    symbol,
    side,
    liveEntry: { timestamp: trade.entryTs, price: entryPrice },
    liveExit: { timestamp: trade.exitTs, price: trade.exitPrice, reason: trade.exitReason || 'UNKNOWN' },
    livePnlPct,
    liveDurationMin: trade.durationMinutes || 0,
    signalCheck: {
      wouldBacktestEnter: signalCheck.wouldEnter,
      signalStrength: signalCheck.strength,
      signalReason: signalCheck.reason,
    },
    exitSimulation: exitSim,
    comparison: {
      signalMatch: signalCheck.wouldEnter,
      exitReasonMatch,
      pnlDiffPct: pnlDiff,
      durationDiffMin: durationDiff,  // V5.70
      category,
      details,
    },
    candlesFetched: symbolCandles.length + btcCandles.length,
    verificationTimeMs: Date.now() - startTime,
  };

  // Log summary
  // V5.70: DURATION_MISMATCH uses ⏱️ to indicate timing issue (less severe than EXIT_MISMATCH)
  const icon = category === 'MATCH' ? '✅' : category === 'NO_SIGNAL' ? '⚠️' : category === 'DURATION_MISMATCH' ? '⏱️' : '❌';
  logger.info(`[PARITY-V2] ${icon} ${category}: ${details}`);

  // Save to DB
  await saveParityResultV2(result);

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

async function saveParityResultV2(result: ParityResultV2): Promise<void> {
  try {
    await prisma.tradeParityResult.upsert({
      where: { tradeId: result.tradeId },
      update: {
        symbol: result.symbol,
        side: result.side,
        liveEntryTs: result.liveEntry.timestamp,
        liveExitTs: result.liveExit.timestamp,
        liveExitReason: result.liveExit.reason,
        livePnlPct: result.livePnlPct,
        btEntryTs: result.liveEntry.timestamp, // Same entry forced
        btExitTs: result.exitSimulation
          ? new Date(result.liveEntry.timestamp.getTime() + result.exitSimulation.exitCandleIndex * 15 * 60000)
          : null,
        btExitReason: result.exitSimulation?.exitReason ?? null,
        btPnlPct: result.exitSimulation?.pnlPct ?? null,
        entryMatch: true, // We force same entry
        exitMatch: result.comparison.exitReasonMatch,
        pnlMatch: (result.comparison.pnlDiffPct ?? 100) < 3.0,
        overallMatch: result.comparison.category === 'MATCH',
        mismatchDetails: JSON.stringify({
          category: result.comparison.category,
          details: result.comparison.details,
          signalCheck: result.signalCheck,
        }),
        backtestDurationMs: result.verificationTimeMs,
        verifiedAt: new Date(),
      },
      create: {
        tradeId: result.tradeId,
        symbol: result.symbol,
        side: result.side,
        liveEntryTs: result.liveEntry.timestamp,
        liveExitTs: result.liveExit.timestamp,
        liveExitReason: result.liveExit.reason,
        livePnlPct: result.livePnlPct,
        btEntryTs: result.liveEntry.timestamp,
        btExitTs: result.exitSimulation
          ? new Date(result.liveEntry.timestamp.getTime() + result.exitSimulation.exitCandleIndex * 15 * 60000)
          : null,
        btExitReason: result.exitSimulation?.exitReason ?? null,
        btPnlPct: result.exitSimulation?.pnlPct ?? null,
        entryMatch: true,
        exitMatch: result.comparison.exitReasonMatch,
        pnlMatch: (result.comparison.pnlDiffPct ?? 100) < 3.0,
        overallMatch: result.comparison.category === 'MATCH',
        mismatchDetails: JSON.stringify({
          category: result.comparison.category,
          details: result.comparison.details,
          signalCheck: result.signalCheck,
        }),
        backtestDurationMs: result.verificationTimeMs,
      },
    });
  } catch (e: any) {
    logger.error(`Failed to save parity result: ${e.message}`);
  }
}

// ============================================================================
// BATCH VERIFICATION
// ============================================================================

export async function verifyAllTradesV2(opts: {
  days?: number;
  symbol?: string;
  sessionId?: string;
  limit?: number;
} = {}): Promise<{
  total: number;
  matched: number;
  mismatched: number;
  failed: number;
  results: { category: ParityCategory; count: number }[];
}> {
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const trades = await prisma.trade.findMany({
    where: {
      exitTs: { gte: since },
      ...(opts.symbol ? { symbol: opts.symbol } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    },
    orderBy: { exitTs: 'desc' },
    take: opts.limit ?? 100,
  });

  logger.info(`[PARITY-V2] Verifying ${trades.length} trades...`);

  const categories: Record<ParityCategory, number> = {
    MATCH: 0,
    EXIT_MISMATCH: 0,
    NO_SIGNAL: 0,
    PNL_VARIANCE: 0,
    DURATION_MISMATCH: 0,  // V5.70
    DATA_ERROR: 0,
  };

  for (const trade of trades) {
    try {
      const result = await verifyTradeV2(trade.id);
      categories[result.comparison.category]++;

      // Rate limiting between trades
      await new Promise(r => setTimeout(r, 500));
    } catch (e: any) {
      logger.error(`Failed to verify ${trade.id}: ${e.message}`);
      categories.DATA_ERROR++;
    }
  }

  return {
    total: trades.length,
    matched: categories.MATCH,
    mismatched: categories.EXIT_MISMATCH + categories.NO_SIGNAL,
    failed: categories.DATA_ERROR,
    results: Object.entries(categories).map(([category, count]) => ({
      category: category as ParityCategory,
      count,
    })),
  };
}

// ============================================================================
// AUTO-VERIFICATION TRIGGER (called after each trade closes)
// ============================================================================

/**
 * Trigger verification for a trade (non-blocking, for use after trade exit)
 * This is the V2 version that uses the improved parity logic.
 */
export function triggerVerificationV2(tradeId: string): void {
  if (process.env.AUTO_VERIFY_PARITY !== 'true') {
    return;
  }

  setImmediate(async () => {
    try {
      logger.info(`[PARITY-V2] Auto-verifying trade ${tradeId}`);
      await verifyTradeV2(tradeId);
      logger.info(`[PARITY-V2] Auto-verification complete for ${tradeId}`);
    } catch (err: any) {
      logger.warn(`[PARITY-V2] Background verification failed for ${tradeId}: ${err.message}`);
    }
  });
}

/**
 * Get parity results for display (compatible with V1 API format)
 */
export async function getParityResultsV2(opts: {
  limit?: number;
  offset?: number;
  onlyMismatches?: boolean;
  userId?: string;
  mode?: 'paper' | 'live';
} = {}): Promise<{
  results: any[];
  summary: {
    total: number;
    matched: number;
    mismatched: number;
    matchRate: number;
  };
}> {
  const limit = opts.limit || 100;
  const offset = opts.offset || 0;

  // Build where clause with user/mode filtering via trade → session join
  const where: any = {};
  if (opts.onlyMismatches) where.overallMatch = false;

  // Filter by userId and/or mode through Trade → AgentSession
  if (opts.userId || opts.mode) {
    const sessionWhere: any = {};
    if (opts.userId) sessionWhere.userId = opts.userId;
    if (opts.mode) sessionWhere.mode = opts.mode;

    // Get tradeIds belonging to this user/mode
    const trades = await prisma.trade.findMany({
      where: { session: sessionWhere },
      select: { id: true },
    });
    const tradeIds = trades.map(t => t.id);

    if (tradeIds.length === 0) {
      return { results: [], summary: { total: 0, matched: 0, mismatched: 0, matchRate: 0 } };
    }

    where.tradeId = { in: tradeIds };
  }

  // Fetch results
  const [results, totalCount, matchedCount] = await Promise.all([
    prisma.tradeParityResult.findMany({
      where,
      orderBy: { verifiedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.tradeParityResult.count({ where }),
    prisma.tradeParityResult.count({ where: { ...where, overallMatch: true } }),
  ]);

  return {
    results,
    summary: {
      total: totalCount,
      matched: matchedCount,
      mismatched: totalCount - matchedCount,
      matchRate: totalCount > 0 ? (matchedCount / totalCount) * 100 : 0,
    },
  };
}
