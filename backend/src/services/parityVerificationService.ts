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
  // V5.51: Added SIGNAL_ONLY for when we match signal but BT had earlier position
  mismatchCategory: 'NONE' | 'SIGNAL_ONLY' | 'EXPECTED_VARIANCE' | 'REAL_MISMATCH';
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
 * Check if two timestamps are within 1 candle of each other (±15 minutes)
 * 
 * This is needed because:
 * - Backtest: enters at the CLOSE of a candle when signal is detected
 * - Live: detects signal at CLOSE, but order executes on the NEXT candle
 * 
 * So a 1-candle offset is expected and normal.
 */
function isWithinOneCandle(ts1: Date | number, ts2: Date | number | null | undefined): boolean {
  if (!ts2) return false;

  const t1 = typeof ts1 === 'number' ? ts1 : ts1.getTime();
  const t2 = typeof ts2 === 'number' ? ts2 : ts2.getTime();

  // Round down to nearest 15-minute boundary
  const candle1 = Math.floor(t1 / CANDLE_15M_MS);
  const candle2 = Math.floor(t2 / CANDLE_15M_MS);

  // Allow ±1 candle difference
  return Math.abs(candle1 - candle2) <= 1;
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
 * Match by: same symbol, same side, entry within ±1 candle
 * 
 * Note: We allow ±1 candle tolerance because:
 * - Backtest enters at candle CLOSE when signal detected
 * - Live enters on the NEXT candle after signal confirmation
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

    // Check entry time is within 1 candle (±15 minutes)
    // This handles the expected offset between backtest (enters at close)
    // and live (enters on next candle)
    const btEntryTime = new Date(btTrade.entryTime);
    if (isWithinOneCandle(liveTrade.entryTs, btEntryTime)) {
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

  // Note: Historical JSON data ends around 2025-12-27, but the backtest service
  // automatically fetches missing data from Binance REST API, so we don't need
  // to block verification for recent trades.

  // 2. Run backtest for the trade's time period
  // V5.47: Use dataStartDate for indicator warmup (3 days for 200-SMA), but start simulation very close to live entry
  // Starting 5 min before ensures we catch the signal candle without capturing earlier signals
  const dataStartDate = new Date(trade.entryTs.getTime() - 3 * 24 * 60 * 60 * 1000);  // 3 days before for warmup
  const btStartDate = new Date(trade.entryTs.getTime() - 5 * 60 * 1000);  // Start 5 min before live entry
  // V5.52 FIX: Extended from 2h to 4h to ensure backtest captures all exit conditions
  // This prevents "END" exit reason when BT entry timing differs slightly from live
  const btEndDate = new Date(trade.exitTs.getTime() + 4 * 60 * 60 * 1000);      // 4 hours after

  let btResult: BacktestResult;
  try {
    // V5.51: Use parityMode to ignore position limits and test pure signal logic
    // This ensures we find the EXACT signal that matched the live trade,
    // even if backtest would have entered earlier due to having no open positions
    btResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      dataStartDate,  // V5.47: Load data earlier for warmup
      symbols: [trade.symbol],
      initialCapital: 1000,  // Doesn't matter for comparison in parity mode
      leverage: trade.leverage || 5,
      parityMode: true,  // V5.51: Ignore position limits, test pure signal logic
    });
  } catch (err) {
    logger.error(`[PARITY] Backtest failed for trade ${tradeId}:`, err);
    throw err;
  }

  // 3. Find matching backtest trade
  let btTrade = findMatchingBacktestTrade(trade, btResult.trades);
  
  // V5.51: Also check validSignals array to find the EXACT signal that matched live entry
  // This handles the case where backtest entered earlier due to no position limits
  let matchingSignal: NonNullable<BacktestResult['validSignals']>[number] | null = null;
  if (btResult.validSignals && btResult.validSignals.length > 0) {
    const liveSymbol = trade.symbol.toUpperCase();
    const liveSide = trade.positionSide.toLowerCase();
    
    for (const sig of btResult.validSignals) {
      const sigSymbol = sig.symbol.toUpperCase();
      const sigSide = sig.side.toLowerCase();
      
      if (sigSymbol !== liveSymbol) continue;
      if (sigSide !== liveSide) continue;
      
      // Check if signal timestamp is within ±15 minutes of live entry
      const sigTime = new Date(sig.timestamp);
      if (isWithinOneCandle(trade.entryTs, sigTime)) {
        matchingSignal = sig;
        break;
      }
    }
  }

  // V5.51: If we found a signal but no trade, re-run backtest starting just before the signal
  // This ensures the backtest enters at the SAME time as live (not earlier)
  if (matchingSignal && !btTrade) {
    logger.info(`[PARITY] Signal found at ${new Date(matchingSignal.timestamp).toISOString()} but no trade - re-running backtest from signal time`);
    
    // Start 5 min before the signal to catch it without earlier signals
    const signalTime = matchingSignal.timestamp;
    const rerunStartDate = new Date(signalTime - 5 * 60 * 1000);  // 5 min before signal
    
    try {
      const rerunResult = await runBacktest({
        startDate: rerunStartDate,
        endDate: btEndDate,
        dataStartDate,  // V5.47: Use same dataStartDate for consistent warmup without earlier signals
        symbols: [trade.symbol],
        initialCapital: 1000,
        leverage: trade.leverage || 5,
        parityMode: false,  // Normal mode - we want actual trades now
      });
      
      // Log rerun trades for debugging
      logger.info(`[PARITY] Re-run produced ${rerunResult.trades.length} trades:`);
      for (const t of rerunResult.trades) {
        logger.info(`[PARITY]   - ${t.symbol} ${t.side} @ ${new Date(t.entryTime).toISOString()}`);
      }
      
      // Now find the trade that should match
      btTrade = findMatchingBacktestTrade(trade, rerunResult.trades);
      
      if (btTrade) {
        logger.info(`[PARITY] Re-run successful: found trade at ${new Date(btTrade.entryTime).toISOString()}`);
      } else {
        logger.warn(`[PARITY] Re-run produced trades but none matched live entry ${trade.entryTs.toISOString()}`);
      }
    } catch (err) {
      logger.warn(`[PARITY] Re-run backtest failed:`, err);
    }
  }

  // 4. Calculate entry price slippage
  // V5.51: Prefer signal price if we found a matching signal (more accurate)
  const liveEntryPrice = trade.entryPrice || 0;
  const btEntryPrice = matchingSignal?.price ?? btTrade?.entryPrice ?? null;
  let entryPriceDiffPct: number | null = null;
  
  if (btEntryPrice && liveEntryPrice > 0) {
    entryPriceDiffPct = Math.abs((liveEntryPrice - btEntryPrice) / btEntryPrice) * 100;
  }

  // 5. Compare results with slippage-aware tolerance
  const liveExitReason = normalizeExitReason(trade.exitReason);
  const btExitReason = btTrade ? normalizeExitReason(btTrade.exitReason) : null;

  // V5.51: Entry matches if we found either a matching signal OR a matching trade
  const entryMatch = matchingSignal !== null || btTrade !== null;
  
  // V5.51: If we only have a signal (no matching trade), we can't compare exit/PnL
  // This happens when live entered later due to position limits
  // This is NOT a full match - we need a special category for this
  const signalOnlyMatch = matchingSignal !== null && btTrade === null;
  
  // Exit and PnL can only be compared if we have a backtest trade
  const exitMatch = btTrade !== null 
    ? (btExitReason !== null && liveExitReason === btExitReason)
    : false;  // Can't match exit without a trade
  
  // Calculate live PnL as ROE (leveraged) to match backtest's netPnlPct calculation
  // trade.roiPct is the price movement %, we need to multiply by leverage for ROE
  const liveLeverage = trade.leverage || 5;
  const liveRoePct = (trade.roiPct || 0) * liveLeverage;
  
  // Calculate dynamic PnL tolerance based on entry slippage
  // If we have 1.5% slippage, we expect up to ~2.25% PnL difference (on ROE)
  const dynamicPnlTolerance = entryPriceDiffPct 
    ? Math.max(PNL_TOLERANCE_PCT * liveLeverage, entryPriceDiffPct * SLIPPAGE_PNL_MULTIPLIER * liveLeverage)
    : PNL_TOLERANCE_PCT * liveLeverage;
  
  const pnlDiff = btTrade !== null 
    ? Math.abs(liveRoePct - (btTrade.netPnlPct || 0))
    : Infinity;  // Can't compare PnL without trade
  const pnlMatch = btTrade !== null 
    ? pnlDiff < dynamicPnlTolerance
    : false;  // Can't match PnL without a trade
  
  // Check if slippage explains the variance
  const isSlippageExpected = entryPriceDiffPct !== null && 
    entryPriceDiffPct <= EXPECTED_SLIPPAGE_PCT && 
    pnlDiff <= (entryPriceDiffPct * SLIPPAGE_PNL_MULTIPLIER * liveLeverage + PNL_TOLERANCE_PCT * liveLeverage);

  // V5.51: Overall match only if we have a full trade comparison
  // Signal-only is a partial match (entry validated, but can't verify exit/PnL)
  const overallMatch = entryMatch && exitMatch && pnlMatch && !signalOnlyMatch;

  // 6. Categorize the mismatch
  // V5.51: Add SIGNAL_ONLY category for when we match the signal but not a trade
  let mismatchCategory: 'NONE' | 'SIGNAL_ONLY' | 'EXPECTED_VARIANCE' | 'REAL_MISMATCH' = 'NONE';
  
  if (signalOnlyMatch) {
    // We found the signal but BT had position from earlier - entry is validated
    mismatchCategory = 'SIGNAL_ONLY';
  } else if (overallMatch) {
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
    mismatches.push(`Entry: No matching backtest signal/trade found for ${trade.entryTs.toISOString()}`);
  }
  // V5.51: Log when we matched a signal but no trade (indicates position limit difference)
  if (matchingSignal && !btTrade) {
    mismatches.push(`ℹ️ Signal matched at ${new Date(matchingSignal.timestamp).toISOString()} (no trade - BT had position open from earlier signal)`);
  }
  if (entryMatch && entryPriceDiffPct !== null && entryPriceDiffPct > 0.1) {
    mismatches.push(`Entry Price Slippage: ${entryPriceDiffPct.toFixed(2)}% (Live=$${liveEntryPrice.toFixed(4)}, BT=$${btEntryPrice?.toFixed(4)})`);
  }
  if (entryMatch && !exitMatch) {
    mismatches.push(`Exit reason: Live=${liveExitReason}, Backtest=${btExitReason ?? 'N/A (signal only)'}`);
  }
  if (entryMatch && !pnlMatch) {
    const livePnl = liveRoePct.toFixed(2);
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
    livePnlPct: liveRoePct,  // Use leveraged ROE to match backtest
    liveEntryPrice,

    // V5.51: Use signal data if we matched a signal but no trade
    btEntryTs: btTrade ? new Date(btTrade.entryTime) : (matchingSignal ? new Date(matchingSignal.timestamp) : null),
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

  const categoryLabel = mismatchCategory === 'SIGNAL_ONLY' ? '🔶 SIGNAL ONLY' :
                        mismatchCategory === 'EXPECTED_VARIANCE' ? '⚠️ EXPECTED VARIANCE' : 
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
