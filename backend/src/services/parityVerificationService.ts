/**
 * 🔬 Parity Verification Service
 *
 * Compares live/paper trades against backtest to verify identical behavior.
 * Automatically runs after each trade exits (when AUTO_VERIFY_PARITY=true)
 * or can be triggered manually via API.
 */

import { prisma } from '../db/client.js';
import { runBacktest, type BacktestResult } from './backtestService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('parity');

// ============================================================================
// TYPES
// ============================================================================

export interface ParityResult {
  tradeId: string;
  symbol: string;
  side: string;

  // Live trade data
  liveEntryTs: Date;
  liveExitTs: Date;
  liveExitReason: string;
  livePnlPct: number;
  liveEntryPrice: number;  // NEW: Entry price from live

  // Backtest comparison
  btEntryTs: Date | null;
  btExitTs: Date | null;
  btExitReason: string | null;
  btPnlPct: number | null;
  btEntryPrice: number | null;  // NEW: Entry price from backtest

  // Entry price slippage analysis
  entryPriceDiffPct: number | null;  // NEW: % difference between live and BT entry price
  isSlippageExpected: boolean;       // NEW: true if slippage explains the PnL diff

  // Match results
  entryMatch: boolean;
  exitMatch: boolean;
  pnlMatch: boolean;
  overallMatch: boolean;
  
  // NEW: Mismatch categorization
  mismatchCategory: 'NONE' | 'EXPECTED_VARIANCE' | 'REAL_MISMATCH';
  mismatchDetails: string | null;

  // Metadata
  backtestDurationMs: number;
}

export interface VerifyAllOptions {
  days?: number;       // How many days back to verify (default: 30)
  sessionId?: string;  // Filter by session
  symbol?: string;     // Filter by symbol
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CANDLE_15M_MS = 15 * 60 * 1000;  // 15 minutes in milliseconds
const PNL_TOLERANCE_PCT = 0.5;          // 0.5% base tolerance for PnL matching
const EXPECTED_SLIPPAGE_PCT = 2.0;      // Up to 2% entry slippage is normal (live vs close price)
const SLIPPAGE_PNL_MULTIPLIER = 1.5;    // PnL tolerance = slippage * 1.5 (slippage cascades to PnL)

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if two timestamps are in the same 15-minute candle
 */
function isSameCandle(ts1: Date | number, ts2: Date | number | null | undefined): boolean {
  if (!ts2) return false;

  const t1 = typeof ts1 === 'number' ? ts1 : ts1.getTime();
  const t2 = typeof ts2 === 'number' ? ts2 : ts2.getTime();

  // Round down to nearest 15-minute boundary
  const candle1 = Math.floor(t1 / CANDLE_15M_MS);
  const candle2 = Math.floor(t2 / CANDLE_15M_MS);

  return candle1 === candle2;
}

/**
 * Normalize exit reason for comparison
 * DB and backtest may use slightly different formats
 */
function normalizeExitReason(reason: string | null | undefined): string {
  if (!reason) return 'UNKNOWN';

  const upper = reason.toUpperCase();

  // Normalize common variations
  const mappings: Record<string, string> = {
    'TRAIL': 'TRAIL',
    'TRAILING': 'TRAIL',
    'TRAILING_STOP': 'TRAIL',
    'SL': 'SL',
    'STOP_LOSS': 'SL',
    'STOPLOSS': 'SL',
    'TIME': 'TIME',
    'MAX_HOLD': 'TIME',
    'REGIME_CHANGE': 'REGIME_CHANGE',
    'MOMENTUM_REVERSAL': 'MOMENTUM_REVERSAL',
    'STAGNANT_TRADE': 'STAGNANT_TRADE',
    'STAGNANT': 'STAGNANT_TRADE',
    'TP': 'TP',
    'TAKE_PROFIT': 'TP',
  };

  return mappings[upper] || upper;
}

/**
 * Find a matching backtest trade for a live trade
 * Match by: same symbol, same side, same entry candle
 */
function findMatchingBacktestTrade(
  liveTrade: { symbol: string; positionSide: string; entryTs: Date },
  backtestTrades: BacktestResult['trades']
): BacktestResult['trades'][0] | null {
  if (!backtestTrades || backtestTrades.length === 0) return null;

  // Normalize symbol for comparison
  const liveSymbol = liveTrade.symbol.toUpperCase();

  for (const btTrade of backtestTrades) {
    const btSymbol = btTrade.symbol.toUpperCase();
    const btSide = btTrade.side.toLowerCase();
    const liveSide = liveTrade.positionSide.toLowerCase();

    // Check symbol and side match
    if (btSymbol !== liveSymbol) continue;
    if (btSide !== liveSide) continue;

    // Check entry time is in same 15m candle
    // btTrade.entryTime is a string (ISO date) from backtest result
    const btEntryTime = new Date(btTrade.entryTime);
    if (isSameCandle(liveTrade.entryTs, btEntryTime)) {
      return btTrade;
    }
  }

  return null;
}

// ============================================================================
// MAIN FUNCTIONS
// ============================================================================

/**
 * Verify a single trade against backtest
 */
export async function verifyTrade(tradeId: string): Promise<ParityResult> {
  const startTime = Date.now();

  // 1. Fetch trade from DB
  const trade = await prisma.trade.findUnique({
    where: { id: tradeId },
    include: { session: true },
  });

  if (!trade) {
    throw new Error(`Trade not found: ${tradeId}`);
  }

  logger.info(`[PARITY] Verifying trade ${trade.symbol} ${trade.positionSide} @ ${trade.entryTs.toISOString()}`);

  // 2. Run backtest for the trade's time period
  // We need a buffer before entry (to warm up indicators) and after exit
  const btStartDate = new Date(trade.entryTs.getTime() - 24 * 60 * 60 * 1000);  // 1 day before
  const btEndDate = new Date(trade.exitTs.getTime() + 2 * 60 * 60 * 1000);      // 2 hours after

  let btResult: BacktestResult;
  try {
    btResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      symbols: [trade.symbol],
      initialCapital: 1000,  // Doesn't matter for comparison
      leverage: trade.leverage || 5,
    });
  } catch (err) {
    logger.error(`[PARITY] Backtest failed for trade ${tradeId}:`, err);
    throw err;
  }

  // 3. Find matching backtest trade
  const btTrade = findMatchingBacktestTrade(trade, btResult.trades);

  // 4. Calculate entry price slippage
  const liveEntryPrice = trade.entryPrice || 0;
  const btEntryPrice = btTrade?.entryPrice ?? null;
  let entryPriceDiffPct: number | null = null;
  
  if (btEntryPrice && liveEntryPrice > 0) {
    entryPriceDiffPct = Math.abs((liveEntryPrice - btEntryPrice) / btEntryPrice) * 100;
  }

  // 5. Compare results with slippage-aware tolerance
  const liveExitReason = normalizeExitReason(trade.exitReason);
  const btExitReason = btTrade ? normalizeExitReason(btTrade.exitReason) : null;

  const entryMatch = btTrade !== null;  // If we found a trade, entry matched
  const exitMatch = btExitReason !== null && liveExitReason === btExitReason;
  
  // Calculate dynamic PnL tolerance based on entry slippage
  // If we have 1.5% slippage, we expect up to ~2.25% PnL difference
  const dynamicPnlTolerance = entryPriceDiffPct 
    ? Math.max(PNL_TOLERANCE_PCT, entryPriceDiffPct * SLIPPAGE_PNL_MULTIPLIER)
    : PNL_TOLERANCE_PCT;
  
  const pnlDiff = btTrade !== null 
    ? Math.abs((trade.roiPct || 0) - (btTrade.netPnlPct || 0))
    : Infinity;
  const pnlMatch = pnlDiff < dynamicPnlTolerance;
  
  // Check if slippage explains the variance
  const isSlippageExpected = entryPriceDiffPct !== null && 
    entryPriceDiffPct <= EXPECTED_SLIPPAGE_PCT && 
    pnlDiff <= (entryPriceDiffPct * SLIPPAGE_PNL_MULTIPLIER + PNL_TOLERANCE_PCT);

  const overallMatch = entryMatch && exitMatch && pnlMatch;

  // 6. Categorize the mismatch
  let mismatchCategory: 'NONE' | 'EXPECTED_VARIANCE' | 'REAL_MISMATCH' = 'NONE';
  
  if (overallMatch) {
    mismatchCategory = 'NONE';
  } else if (entryMatch && isSlippageExpected) {
    // Entry matched, and the PnL/exit differences are explained by slippage
    mismatchCategory = 'EXPECTED_VARIANCE';
  } else {
    mismatchCategory = 'REAL_MISMATCH';
  }

  // 7. Build mismatch details
  const mismatches: string[] = [];
  if (!entryMatch) {
    mismatches.push(`Entry: No matching backtest trade found for ${trade.entryTs.toISOString()}`);
  }
  if (entryMatch && entryPriceDiffPct !== null && entryPriceDiffPct > 0.1) {
    mismatches.push(`Entry Price Slippage: ${entryPriceDiffPct.toFixed(2)}% (Live=$${liveEntryPrice.toFixed(4)}, BT=$${btEntryPrice?.toFixed(4)})`);
  }
  if (entryMatch && !exitMatch) {
    mismatches.push(`Exit reason: Live=${liveExitReason}, Backtest=${btExitReason}`);
  }
  if (entryMatch && !pnlMatch) {
    const livePnl = (trade.roiPct || 0).toFixed(2);
    const btPnl = btTrade ? btTrade.netPnlPct.toFixed(2) : 'N/A';
    mismatches.push(`PnL: Live=${livePnl}%, Backtest=${btPnl}% (diff=${pnlDiff.toFixed(2)}%, tolerance=${dynamicPnlTolerance.toFixed(2)}%)`);
  }
  if (mismatchCategory === 'EXPECTED_VARIANCE') {
    mismatches.push(`ℹ️ Variance explained by entry slippage (${entryPriceDiffPct?.toFixed(2)}%)`);
  }

  const backtestDurationMs = Date.now() - startTime;

  const result: ParityResult = {
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.positionSide,

    liveEntryTs: trade.entryTs,
    liveExitTs: trade.exitTs,
    liveExitReason,
    livePnlPct: trade.roiPct || 0,
    liveEntryPrice,

    btEntryTs: btTrade ? new Date(btTrade.entryTime) : null,
    btExitTs: btTrade ? new Date(btTrade.exitTime) : null,
    btExitReason,
    btPnlPct: btTrade?.netPnlPct ?? null,
    btEntryPrice,

    entryPriceDiffPct,
    isSlippageExpected,

    entryMatch,
    exitMatch,
    pnlMatch,
    overallMatch,
    mismatchCategory,
    mismatchDetails: mismatches.length > 0 ? JSON.stringify(mismatches) : null,

    backtestDurationMs,
  };

  // 8. Save result to DB
  await prisma.tradeParityResult.upsert({
    where: { tradeId: trade.id },
    create: {
      tradeId: result.tradeId,
      symbol: result.symbol,
      side: result.side,
      liveEntryTs: result.liveEntryTs,
      liveExitTs: result.liveExitTs,
      liveExitReason: result.liveExitReason,
      livePnlPct: result.livePnlPct,
      btEntryTs: result.btEntryTs,
      btExitTs: result.btExitTs,
      btExitReason: result.btExitReason,
      btPnlPct: result.btPnlPct,
      entryMatch: result.entryMatch,
      exitMatch: result.exitMatch,
      pnlMatch: result.pnlMatch,
      overallMatch: result.overallMatch,
      mismatchDetails: result.mismatchDetails,
      backtestDurationMs: result.backtestDurationMs,
    },
    update: {
      symbol: result.symbol,
      side: result.side,
      liveEntryTs: result.liveEntryTs,
      liveExitTs: result.liveExitTs,
      liveExitReason: result.liveExitReason,
      livePnlPct: result.livePnlPct,
      btEntryTs: result.btEntryTs,
      btExitTs: result.btExitTs,
      btExitReason: result.btExitReason,
      btPnlPct: result.btPnlPct,
      entryMatch: result.entryMatch,
      exitMatch: result.exitMatch,
      pnlMatch: result.pnlMatch,
      overallMatch: result.overallMatch,
      mismatchDetails: result.mismatchDetails,
      backtestDurationMs: result.backtestDurationMs,
      verifiedAt: new Date(),
    },
  });

  const categoryLabel = mismatchCategory === 'EXPECTED_VARIANCE' ? '⚠️ EXPECTED VARIANCE' : 
                        mismatchCategory === 'REAL_MISMATCH' ? '❌ REAL MISMATCH' : '✅ MATCH';
  logger.info(`[PARITY] Trade ${trade.symbol} verified: ${categoryLabel} | slippage=${entryPriceDiffPct?.toFixed(2) ?? 'N/A'}% (${backtestDurationMs}ms)`);

  return result;
}

/**
 * Verify all trades within a time range
 */
export async function verifyAllTrades(opts: VerifyAllOptions = {}): Promise<{
  total: number;
  matched: number;
  mismatched: number;
  failed: number;
  results: ParityResult[];
}> {
  const days = opts.days || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  logger.info(`[PARITY] Starting bulk verification for last ${days} days...`);

  // Build query filters
  const where: any = {
    exitTs: { gte: since },
  };
  if (opts.sessionId) where.sessionId = opts.sessionId;
  if (opts.symbol) where.symbol = opts.symbol;

  // Fetch trades
  const trades = await prisma.trade.findMany({
    where,
    orderBy: { exitTs: 'desc' },
  });

  logger.info(`[PARITY] Found ${trades.length} trades to verify`);

  const results: ParityResult[] = [];
  let matched = 0;
  let mismatched = 0;
  let failed = 0;

  // Verify each trade sequentially (to avoid overwhelming the backtest service)
  for (const trade of trades) {
    try {
      const result = await verifyTrade(trade.id);
      results.push(result);

      if (result.overallMatch) {
        matched++;
      } else {
        mismatched++;
      }
    } catch (err) {
      logger.error(`[PARITY] Failed to verify trade ${trade.id}:`, err);
      failed++;
    }
  }

  const summary = {
    total: trades.length,
    matched,
    mismatched,
    failed,
    results,
  };

  logger.info(`[PARITY] Bulk verification complete: ${matched}/${trades.length} matched (${(matched/trades.length*100).toFixed(1)}%)`);

  return summary;
}

/**
 * Get parity results for display
 */
export async function getParityResults(opts: {
  limit?: number;
  offset?: number;
  onlyMismatches?: boolean;
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

  // Build where clause
  const where = opts.onlyMismatches ? { overallMatch: false } : {};

  // Fetch results
  const [results, totalCount, matchedCount] = await Promise.all([
    prisma.tradeParityResult.findMany({
      where,
      orderBy: { verifiedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.tradeParityResult.count(),
    prisma.tradeParityResult.count({ where: { overallMatch: true } }),
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

/**
 * Trigger verification for a trade (non-blocking, for use after trade exit)
 */
export function triggerVerification(tradeId: string): void {
  if (process.env.AUTO_VERIFY_PARITY !== 'true') {
    return;
  }

  setImmediate(async () => {
    try {
      await verifyTrade(tradeId);
    } catch (err) {
      logger.warn(`[PARITY] Background verification failed for ${tradeId}:`, err);
    }
  });
}
