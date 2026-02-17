/**
 * V5.101: Parity Verification Service V2 — via Backtest Engine
 *
 * Uses runBacktest() with forcedEntry mode instead of reimplementing
 * signal detection and exit logic. This ensures parity automatically
 * includes all strategy changes (SR filter, NFS, trailing, regime exits).
 *
 * Categories:
 * - MATCH: Same signal validity, same exit reason
 * - EXIT_MISMATCH: Same entry but different exit reason (BUG!)
 * - NO_SIGNAL: Backtest wouldn't have entered (potential live bug)
 * - PNL_VARIANCE: Same exit reason but PnL differs (acceptable slippage)
 * - DURATION_MISMATCH: Same exit reason but duration differs too much
 * - DATA_ERROR: Couldn't load data for backtest
 */

import { prisma } from '../db/client.js';
import { runBacktest, type BacktestResult, type BacktestTrade } from './backtestService.js';
import { createLogger } from '../utils/logger.js';
import { normalizeToFamily } from '../types/exitReasons.js';

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
    durationMin: number;
  } | null;

  // Comparison
  comparison: {
    signalMatch: boolean;
    exitReasonMatch: boolean;
    pnlDiffPct: number | null;
    durationDiffMin: number | null;
    category: ParityCategory;
    details: string;
  };

  // Metadata
  candlesFetched: number;
  verificationTimeMs: number;
}

export type ParityCategory =
  | 'MATCH'
  | 'EXIT_MISMATCH'
  | 'NO_SIGNAL'
  | 'PNL_VARIANCE'
  | 'DURATION_MISMATCH'
  | 'DATA_ERROR';

// ============================================================================
// CONSTANTS
// ============================================================================

const CANDLE_15M_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

  // 2. Compute forced entry timestamp
  // Entry happens ~2s after a candle closes. The BTC candle open time at that moment
  // is the floor of entryTs to the 15m boundary. This matches the backtest main loop
  // where btcCandle.timestamp === forcedEntry.entryTimestamp.
  const forcedEntryTimestamp = Math.floor(entryTs / CANDLE_15M_MS) * CANDLE_15M_MS;

  // 3. Run backtest with forcedEntry
  let btResult: BacktestResult;
  try {
    btResult = await runBacktest({
      startDate: new Date(entryTs - 3 * DAY_MS),           // 3 days warmup for indicators
      endDate: new Date(exitTs + 4 * HOUR_MS),              // buffer after exit
      dataStartDate: new Date(entryTs - 11 * DAY_MS),       // 1h SMA200 warmup (200h = ~8.3 days)
      initialCapital: 2000,
      symbols: [symbol],
      leverage,
      parityMode: true,
      forcedEntry: {
        symbol,
        side,
        entryTimestamp: forcedEntryTimestamp,
        entryPrice,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[PARITY-V2] Backtest failed: ${msg}`);
    return makeDataErrorResult(trade, startTime, `Backtest failed: ${msg}`);
  }

  // 4. Extract the backtest trade (should be exactly 1 with forcedEntry)
  const btTrade = btResult.trades[0] ?? null;

  // 5. Check signal validity from validSignals
  // Look specifically for the NO_SIGNAL_AT_FORCED_TIME entry (not other valid signals
  // from parityMode which may be from different candles)
  const noSignalEntry = btResult.validSignals?.find(
    s => s.symbol === symbol && s.reason === 'NO_SIGNAL_AT_FORCED_TIME'
  );
  const hadValidSignal = !noSignalEntry;

  const signalCheck = {
    wouldBacktestEnter: hadValidSignal,
    signalStrength: null as number | null,
    signalReason: hadValidSignal
      ? 'Valid signal matches'
      : 'No signal at forced entry time',
  };

  logger.info(`[PARITY-V2] Signal check: wouldEnter=${hadValidSignal}, reason=${signalCheck.signalReason}`);

  // 6. Build exit simulation from backtest trade
  let exitSimulation: ParityResultV2['exitSimulation'] = null;

  if (btTrade) {
    const btExitTs = new Date(btTrade.exitTime).getTime();
    const btEntryTs = new Date(btTrade.entryTime).getTime();
    const durationMin = btTrade.holdMinutes;
    const candlesHeld = Math.round(durationMin / 15);

    exitSimulation = {
      exitReason: btTrade.exitReason,
      exitPrice: btTrade.exitPrice,
      exitCandleIndex: candlesHeld,
      pnlPct: btTrade.netPnlPct,
      durationMin,
    };

    logger.info(
      `[PARITY-V2] Exit sim: reason=${btTrade.exitReason}, price=${btTrade.exitPrice.toFixed(4)}, ` +
      `pnl=${btTrade.netPnlPct.toFixed(2)}%, duration=${durationMin}min`
    );
  } else {
    logger.warn(`[PARITY-V2] No backtest trade produced — data may be insufficient`);
    return makeDataErrorResult(trade, startTime, 'Backtest produced no trades — insufficient data after entry');
  }

  // 7. Compare results
  const liveExitReason = normalizeToFamily(trade.exitReason || 'UNKNOWN');
  const simExitReason = normalizeToFamily(exitSimulation.exitReason);
  const livePnlPct = (trade.roiPct || 0) * leverage;
  const pnlDiff = Math.abs(livePnlPct - exitSimulation.pnlPct);

  const liveDurationMin = trade.durationMinutes || 0;
  const simDurationMin = exitSimulation.durationMin;
  const durationDiff = Math.abs(liveDurationMin - simDurationMin);
  const durationTolerance = Math.max(30, liveDurationMin * 0.2);
  const durationMatch = durationDiff <= durationTolerance;

  const exitReasonMatch = liveExitReason === simExitReason;

  let category: ParityCategory;
  let details: string;

  if (!signalCheck.wouldBacktestEnter) {
    category = 'NO_SIGNAL';
    details = `Backtest would NOT enter: ${signalCheck.signalReason}`;
  } else if (!exitReasonMatch) {
    category = 'EXIT_MISMATCH';
    details = `Exit reason mismatch: Live=${liveExitReason}, Sim=${simExitReason}`;
  } else if (pnlDiff > 3.0) {
    category = 'PNL_VARIANCE';
    details = `Same exit reason but PnL differs by ${pnlDiff.toFixed(2)}% (Live=${livePnlPct.toFixed(2)}%, Sim=${exitSimulation.pnlPct.toFixed(2)}%)`;
  } else if (!durationMatch) {
    category = 'DURATION_MISMATCH';
    details = `Same exit reason but duration differs by ${durationDiff}min (Live=${liveDurationMin}min, Sim=${simDurationMin}min, tolerance=${durationTolerance.toFixed(0)}min)`;
  } else {
    category = 'MATCH';
    details = `Signal and exit match (PnL diff: ${pnlDiff.toFixed(2)}%, duration diff: ${durationDiff}min)`;
  }

  const result: ParityResultV2 = {
    tradeId,
    symbol,
    side,
    liveEntry: { timestamp: trade.entryTs, price: entryPrice },
    liveExit: { timestamp: trade.exitTs, price: trade.exitPrice, reason: trade.exitReason || 'UNKNOWN' },
    livePnlPct,
    liveDurationMin: trade.durationMinutes || 0,
    signalCheck,
    exitSimulation,
    comparison: {
      signalMatch: signalCheck.wouldBacktestEnter,
      exitReasonMatch,
      pnlDiffPct: pnlDiff,
      durationDiffMin: durationDiff,
      category,
      details,
    },
    candlesFetched: btResult.trades.length > 0 ? 1 : 0, // Backtest loads its own data
    verificationTimeMs: Date.now() - startTime,
  };

  const icon = category === 'MATCH' ? '✅' : category === 'NO_SIGNAL' ? '⚠️' : category === 'DURATION_MISMATCH' ? '⏱️' : '❌';
  logger.info(`[PARITY-V2] ${icon} ${category}: ${details}`);

  await saveParityResultV2(result);

  return result;
}

// ============================================================================
// HELPERS
// ============================================================================

function makeDataErrorResult(
  trade: { id: string; symbol: string; positionSide: string; entryTs: Date; exitTs: Date; entryPrice: number; exitPrice: number; exitReason: string | null; roiPct: number | null; leverage: number | null; durationMinutes: number | null },
  startTime: number,
  details: string,
): ParityResultV2 {
  const side = trade.positionSide.toLowerCase() as 'long' | 'short';
  const leverage = trade.leverage || 5;
  return {
    tradeId: trade.id,
    symbol: trade.symbol,
    side,
    liveEntry: { timestamp: trade.entryTs, price: trade.entryPrice },
    liveExit: { timestamp: trade.exitTs, price: trade.exitPrice, reason: trade.exitReason || 'UNKNOWN' },
    livePnlPct: (trade.roiPct || 0) * leverage,
    liveDurationMin: trade.durationMinutes || 0,
    signalCheck: { wouldBacktestEnter: false, signalStrength: null, signalReason: details },
    exitSimulation: null,
    comparison: {
      signalMatch: false,
      exitReasonMatch: false,
      pnlDiffPct: null,
      durationDiffMin: null,
      category: 'DATA_ERROR',
      details,
    },
    candlesFetched: 0,
    verificationTimeMs: Date.now() - startTime,
  };
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
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`Failed to save parity result: ${msg}`);
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
    DURATION_MISMATCH: 0,
    DATA_ERROR: 0,
  };

  for (const trade of trades) {
    try {
      const result = await verifyTradeV2(trade.id);
      categories[result.comparison.category]++;

      // Rate limiting between trades
      await new Promise(r => setTimeout(r, 500));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`Failed to verify ${trade.id}: ${msg}`);
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

export function triggerVerificationV2(tradeId: string): void {
  if (process.env.AUTO_VERIFY_PARITY !== 'true') {
    return;
  }

  setImmediate(async () => {
    try {
      logger.info(`[PARITY-V2] Auto-verifying trade ${tradeId}`);
      await verifyTradeV2(tradeId);
      logger.info(`[PARITY-V2] Auto-verification complete for ${tradeId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[PARITY-V2] Background verification failed for ${tradeId}: ${msg}`);
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

  const where: any = {};
  if (opts.onlyMismatches) where.overallMatch = false;

  if (opts.userId || opts.mode) {
    const sessionWhere: any = {};
    if (opts.userId) sessionWhere.userId = opts.userId;
    if (opts.mode) sessionWhere.mode = opts.mode;

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
