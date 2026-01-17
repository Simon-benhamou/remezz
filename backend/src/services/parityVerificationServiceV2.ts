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
import {
  checkMomentumSignal,
  shouldExitPosition,
  updatePositionWaterMarks,
  MomentumConfig,
  type Candle,
  type Position,
  type SignalResult,
  type ExitSignal,
} from '../strategies/momentumSimple.js';
import { createLogger } from '../utils/logger.js';

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
  } | null;

  // Comparison
  comparison: {
    signalMatch: boolean;
    exitReasonMatch: boolean;
    pnlDiffPct: number | null;
    category: ParityCategory;
    details: string;
  };

  // Metadata
  candlesFetched: number;
  verificationTimeMs: number;
}

export type ParityCategory =
  | 'MATCH'           // Everything matches
  | 'EXIT_MISMATCH'   // Same entry, different exit reason (BUG!)
  | 'NO_SIGNAL'       // Backtest wouldn't have entered
  | 'PNL_VARIANCE'    // Same exit but PnL differs
  | 'DATA_ERROR';     // Couldn't fetch data

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
}

async function fetchCandlesForTrade(
  symbol: string,
  entryTs: number,
  exitTs: number
): Promise<FetchedCandles> {
  const ex = getExchange();

  // Fetch window: 3 days before entry to 1 hour after exit
  const warmupMs = 3 * 24 * 60 * 60 * 1000;
  const bufferMs = 60 * 60 * 1000;
  const since = entryTs - warmupMs;
  const until = exitTs + bufferMs;

  const fetchCandles = async (sym: string): Promise<Candle[]> => {
    const candles: Candle[] = [];
    let cursor = since;

    while (cursor < until) {
      try {
        const ohlcv = await ex.fetchOHLCV(sym, '15m', cursor, 1000);
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

        await new Promise(r => setTimeout(r, 100)); // Rate limiting
      } catch (e: any) {
        logger.error(`Error fetching ${sym}: ${e.message}`);
        break;
      }
    }

    return candles;
  };

  // Fetch in parallel
  const [symbolCandles, btcCandles] = await Promise.all([
    fetchCandles(symbol),
    fetchCandles('BTC/USDT:USDT'),
  ]);

  return {
    symbol: symbolCandles,
    btc: btcCandles,
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
  entryTs: number,
  side: 'long' | 'short'
): SignalCheckResult {
  // Find the candle index at entry time
  const entryIdx = candles.findIndex(c => c.timestamp >= entryTs);
  if (entryIdx < 50) {
    return { wouldEnter: false, strength: null, reason: 'Not enough warmup candles' };
  }

  // Get window of candles up to (not including) entry candle
  const windowCandles = candles.slice(0, entryIdx);
  const btcWindow = btcCandles.filter(c => c.timestamp < entryTs);

  if (windowCandles.length < 50 || btcWindow.length < 50) {
    return { wouldEnter: false, strength: null, reason: 'Insufficient candle data' };
  }

  // Check if signal would fire
  try {
    const signal: SignalResult = checkMomentumSignal(symbol, windowCandles, btcWindow, {
      nowMs: entryTs,
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
// EXIT SIMULATION
// ============================================================================

interface ExitSimResult {
  exitReason: string;
  exitPrice: number;
  exitCandleIndex: number;
  pnlPct: number;
}

function simulateExit(
  candles: Candle[],
  btcCandles: Candle[],
  entryTs: number,
  entryPrice: number,
  side: 'long' | 'short',
  leverage: number
): ExitSimResult | null {
  // Find entry candle index
  const entryIdx = candles.findIndex(c => c.timestamp >= entryTs);
  if (entryIdx < 0) return null;

  // Create position object
  let position: Position = {
    symbol: 'SIM',
    side,
    entryPrice,
    entryTime: entryTs,
    qty: 1,
    leverage,
    stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
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

    // Get BTC candles up to this point
    const btcWindow = btcCandles.filter(c => c.timestamp <= candle.timestamp);

    // Update watermarks
    position = updatePositionWaterMarks(position, candle.close, candle.high, candle.low);

    // Get window of candles
    const windowStart = Math.max(0, i - 200);
    const windowCandles = candles.slice(windowStart, i + 1);

    // Check exit
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

    // Handle trailing breach confirmation (2 candles)
    if (exitSignal.reason === 'trailing_breach' || exitSignal.reason === 'trailing') {
      position.trailingBreachCandles = (position.trailingBreachCandles ?? 0) + 1;

      if (position.trailingBreachCandles >= 2) {
        const exitPrice = exitSignal.newStopLoss ?? candle.close;
        const pnlPct = side === 'long'
          ? ((exitPrice - entryPrice) / entryPrice) * 100 * leverage
          : ((entryPrice - exitPrice) / entryPrice) * 100 * leverage;

        return {
          exitReason: 'TRAIL',
          exitPrice,
          exitCandleIndex: i - entryIdx,
          pnlPct,
        };
      }
    } else {
      // Reset breach counter if no breach
      position.trailingBreachCandles = 0;
    }

    // Check other exit conditions
    if (exitSignal.shouldExit && exitSignal.reason !== 'trailing_breach') {
      const reasonMap: Record<string, string> = {
        'time': 'TIME',
        'stoploss': 'SL',
        'regime_change': 'REGIME_CHANGE',
        'momentum_reversal': 'MOMENTUM_REVERSAL',
        'stagnant_trade': 'STAGNANT_TRADE',
        'trailing': 'TRAIL',
      };

      let exitPrice = candle.close;
      if (exitSignal.reason === 'stoploss' || exitSignal.reason === 'stagnant_trade') {
        const slPct = exitSignal.effectiveSlPct ?? position.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
        exitPrice = side === 'long'
          ? entryPrice * (1 - slPct / 100)
          : entryPrice * (1 + slPct / 100);
      }

      const pnlPct = side === 'long'
        ? ((exitPrice - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - exitPrice) / entryPrice) * 100 * leverage;

      return {
        exitReason: reasonMap[exitSignal.reason ?? ''] ?? exitSignal.reason?.toUpperCase() ?? 'UNKNOWN',
        exitPrice,
        exitCandleIndex: i - entryIdx,
        pnlPct,
      };
    }

    // Max hold time safety (48 hours)
    if (holdMinutes > 48 * 60) {
      const pnlPct = side === 'long'
        ? ((candle.close - entryPrice) / entryPrice) * 100 * leverage
        : ((entryPrice - candle.close) / entryPrice) * 100 * leverage;

      return {
        exitReason: 'TIME',
        exitPrice: candle.close,
        exitCandleIndex: i - entryIdx,
        pnlPct,
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
  logger.info(`[PARITY-V2] Fetching candles from API...`);
  const { symbol: symbolCandles, btc: btcCandles } = await fetchCandlesForTrade(
    symbol,
    entryTs,
    exitTs
  );

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
        category: 'DATA_ERROR',
        details: `Only ${symbolCandles.length} symbol candles and ${btcCandles.length} BTC candles fetched`,
      },
      candlesFetched: symbolCandles.length + btcCandles.length,
      verificationTimeMs: Date.now() - startTime,
    };
  }

  logger.info(`[PARITY-V2] Fetched ${symbolCandles.length} symbol candles, ${btcCandles.length} BTC candles`);

  // 3. Check if backtest would have entered on same signal
  const signalCheck = checkSignalAtEntry(symbol, symbolCandles, btcCandles, entryTs, side);
  logger.info(`[PARITY-V2] Signal check: wouldEnter=${signalCheck.wouldEnter}, reason=${signalCheck.reason}`);

  // 4. Simulate exit (regardless of signal validity - we want to compare exit logic)
  const exitSim = simulateExit(symbolCandles, btcCandles, entryTs, entryPrice, side, leverage);

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
        category: 'DATA_ERROR',
        details: 'Exit simulation failed - insufficient data after entry',
      },
      candlesFetched: symbolCandles.length + btcCandles.length,
      verificationTimeMs: Date.now() - startTime,
    };
  }

  logger.info(`[PARITY-V2] Exit sim: reason=${exitSim.exitReason}, price=${exitSim.exitPrice.toFixed(4)}, pnl=${exitSim.pnlPct.toFixed(2)}%`);

  // 5. Compare results
  const liveExitReason = normalizeExitReason(trade.exitReason || 'UNKNOWN');
  const simExitReason = normalizeExitReason(exitSim.exitReason);
  const livePnlPct = (trade.roiPct || 0) * leverage;
  const pnlDiff = Math.abs(livePnlPct - exitSim.pnlPct);

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
  } else {
    category = 'MATCH';
    details = `✅ Signal and exit match (PnL diff: ${pnlDiff.toFixed(2)}%)`;
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
      category,
      details,
    },
    candlesFetched: symbolCandles.length + btcCandles.length,
    verificationTimeMs: Date.now() - startTime,
  };

  // Log summary
  const icon = category === 'MATCH' ? '✅' : category === 'NO_SIGNAL' ? '⚠️' : '❌';
  logger.info(`[PARITY-V2] ${icon} ${category}: ${details}`);

  // Save to DB
  await saveParityResultV2(result);

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

function normalizeExitReason(reason: string): string {
  const r = reason.toUpperCase();
  if (r.includes('TRAIL')) return 'TRAIL';
  if (r.includes('STOP') || r === 'SL') return 'SL';
  if (r.includes('REGIME')) return 'REGIME_CHANGE';
  if (r.includes('MOMENTUM') || r.includes('REVERSAL')) return 'MOMENTUM_REVERSAL';
  if (r.includes('STAGNANT')) return 'STAGNANT_TRADE';
  if (r.includes('TIME') || r.includes('MAX_HOLD')) return 'TIME';
  return r;
}

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
  limit?: number;
} = {}): Promise<{
  total: number;
  results: { category: ParityCategory; count: number }[];
}> {
  const days = opts.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const trades = await prisma.trade.findMany({
    where: {
      exitTs: { gte: since },
      ...(opts.symbol ? { symbol: opts.symbol } : {}),
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
    results: Object.entries(categories).map(([category, count]) => ({
      category: category as ParityCategory,
      count,
    })),
  };
}
