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
  // V5.54: Use forcedEntry to ensure we test EXACTLY the same trade as live
  // This solves the problem where live skipped signals due to max positions
  const dataStartDate = new Date(trade.entryTs.getTime() - 3 * 24 * 60 * 60 * 1000);  // 3 days before for warmup
  
  // Calculate the candle timestamp that matches the live entry
  // 
  // IMPORTANT: Understanding backtest vs live timing:
  // - Binance candle timestamp = OPEN time of the candle
  // - Candle 09:45 means the candle that opens at 09:45 and closes at 10:00
  // - The CLOSE price of candle 09:45 is the price at 10:00
  // 
  // Live trading flow:
  // - At 09:45:XX, live sees the signal (from candle 09:30-09:45 that just closed)
  // - Live places order and gets filled at ~$624.35
  // - This price matches the CLOSE of candle 09:45 (which closes at 10:00)
  // 
  // Backtest flow:
  // - When backtest processes candle 09:45, it uses the CLOSE price of that candle
  // - So entryTimestamp should be the candle that's currently OPEN when live enters
  // 
  // Example: Live entry at 09:45:30
  // - Candle 09:30-09:45 just closed (signal generated)
  // - Candle 09:45-10:00 is currently open
  // - Live enters at the current price ~= what will be candle 09:45's CLOSE
  // - Backtest should use candle timestamp 09:45
  //
  const liveEntryMs = trade.entryTs.getTime();
  // Round DOWN to nearest 15-minute boundary = the candle that's currently OPEN
  const entryTimestamp = Math.floor(liveEntryMs / CANDLE_15M_MS) * CANDLE_15M_MS;
  
  // Start simulation a bit before entry to warm up state machines (stagnant, etc.)
  const btStartDate = new Date(entryTimestamp - 30 * 60 * 1000);  // 30 min before
  // End a few hours after exit to capture all exit conditions
  const btEndDate = new Date(trade.exitTs.getTime() + 4 * 60 * 60 * 1000);

  logger.info(`[PARITY] Live entry: ${trade.entryTs.toISOString()}, Calculated candle: ${new Date(entryTimestamp).toISOString()}`);

  let btResult: BacktestResult;
  try {
    // V5.54: Use forcedEntry to enter at EXACT same time as live
    btResult = await runBacktest({
      startDate: btStartDate,
      endDate: btEndDate,
      dataStartDate,
      symbols: [trade.symbol],
      initialCapital: 1000,
      leverage: trade.leverage || 5,
      forcedEntry: {
        symbol: trade.symbol,
        side: trade.positionSide.toLowerCase() as 'long' | 'short',
        entryTimestamp,
        entryPrice: trade.entryPrice || 0,
      },
    });
  } catch (err) {
    logger.error(`[PARITY] Backtest failed for trade ${tradeId}:`, err);
    throw err;
  }

  // 3. Find matching backtest trade
  // V5.54: With forcedEntry, there should be exactly one trade at the forced entry time
  let btTrade = findMatchingBacktestTrade(trade, btResult.trades);
  
  // V5.54: If no matching trade found, the backtest didn't enter at the forced time
  // This could mean the candle data is missing or timestamp calculation was wrong
  if (!btTrade && btResult.trades.length > 0) {
    // Try to find closest trade
    logger.warn(`[PARITY] No exact match found. BT trades:`);
    for (const t of btResult.trades) {
      logger.warn(`[PARITY]   - ${t.symbol} ${t.side} @ ${new Date(t.entryTime).toISOString()}`);
    }
    // Take the first trade as best match
    btTrade = btResult.trades[0];
  }
  
  // V5.54: Simplified - no more signal matching or re-run logic needed
  // The forcedEntry ensures we enter at the exact same time as live

  // 4. Calculate entry price slippage
  // V5.54: With forcedEntry, we use the backtest trade entry price directly
  const liveEntryPrice = trade.entryPrice || 0;
  const btEntryPrice = btTrade?.entryPrice ?? null;
  let entryPriceDiffPct: number | null = null;
  
  if (btEntryPrice && liveEntryPrice > 0) {
    entryPriceDiffPct = Math.abs((liveEntryPrice - btEntryPrice) / btEntryPrice) * 100;
  }

  // 5. Compare results with slippage-aware tolerance
  const liveExitReason = normalizeExitReason(trade.exitReason);
  const btExitReason = btTrade ? normalizeExitReason(btTrade.exitReason) : null;

  // V5.54: Entry matches if we have a backtest trade with forcedEntry
  const entryMatch = btTrade !== null;
  
  // V5.54: With forcedEntry, we always have a matching trade or no trade at all
  // signalOnlyMatch is no longer applicable since we force the entry
  const signalOnlyMatch = false;
  
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
  // V5.54: With forcedEntry, we no longer need signal-only matching
  if (!btTrade) {
    mismatches.push(`⚠️ Backtest did not enter at forced time ${new Date(entryTimestamp).toISOString()} - check candle data`);
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

    // V5.54: With forcedEntry, btEntryTs comes directly from the trade
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
