/**
 * positionCloser.ts — Position Close Logic
 *
 * V5.108 Phase 4: Extracted from orchestrator.ts.
 * Handles the full close-position lifecycle: PnL calculation, partial fill cleanup,
 * paper/live branching, DB save, notifications, capital release.
 *
 * Uses callback injection pattern (same as ExchangeSync, RealtimeExitHandler, PositionOpener).
 */

import {
  MomentumConfig,
  getCooldownBars,
  type Position,
} from '../momentumSimple.js';
import { createLogger } from '../../utils/logger.js';
import { orderQueue, type OrderRequest } from '../../services/orderQueue.js';
import { calculateOrderPriority, type ExitReason } from '../../services/orderPriority.js';
import { v4 as uuidv4 } from 'uuid';
import {
  getPositionFromWebSocket,
} from '../../services/binanceWebSocket.js';
import {
  notifyTradeExit,
  notifyOrderError,
} from '../../services/notificationService.js';
import { notifyPositionClosed } from '../../utils/notifications.js';
import { recordTrade } from '../../services/telegramReporter.js';
import type { CapitalPool } from '../capitalPool.js';
import type { TradeEvent } from './agentState.js';

const logger = createLogger('position-closer');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// DEPS INTERFACE
// ============================================================================

export interface PositionCloserDeps {
  // Config (immutable)
  symbol: string;
  mode: 'paper' | 'live';
  sessionId: string;
  userId: string;
  capitalPool: CapitalPool;
  entryCooldownBars: number;

  // State access
  getPosition: () => Position | null;
  setPosition: (pos: Position | null) => void;
  getAdditionalPositions: () => Position[];
  clearAdditionalPositions: () => void;
  isClosingPosition: () => boolean;
  setClosingPosition: (val: boolean) => void;
  setEntryCooldownBarsRemaining: (val: number) => void;
  setLastExit: (exit: { ts: number; price: number; reason: string } | null) => void;

  // Method callbacks
  stopRealtimeExitMonitor: () => void;
  resetTrailingAndSignalState: () => void;
  syncWithExchange: () => Promise<void>;
  cancelStopLossOnExchange: () => Promise<void>;
  formatQtyForExchange: (symbol: string, qty: number) => number;
  saveExitToDb: (
    position: Position, exitPrice: number, reason: string,
    pnlPct: number, pnlUsd: number, orderId?: string, fee?: number,
  ) => Promise<boolean>;
  startRealtimeExitMonitorIfNeeded: () => void;
  onTrade?: (trade: TradeEvent) => void;
}

// ============================================================================
// POSITION CLOSER CLASS
// ============================================================================

export class PositionCloser {
  // Internal state: only used within close logic
  private exitAttemptCount = 0;
  private lastExitAttemptTs = 0;

  constructor(private deps: PositionCloserDeps) {}

  async closePosition(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string,
  ): Promise<void> {
    const { deps } = this;
    const symbol = deps.symbol;

    // Prevent duplicate close attempts and stop realtime monitor before placing orders.
    if (deps.isClosingPosition()) {
      logger.debug(`⚠️ [${symbol}] Close already in progress, skipping duplicate close (${reason})`);
      return;
    }

    // V5.105: Guard against exit loop — max 3 attempts per 30s, then force sync
    const now = Date.now();
    if (now - this.lastExitAttemptTs < 30_000) {
      this.exitAttemptCount++;
      if (this.exitAttemptCount > 3) {
        logger.warn(`🔄 [${symbol}] Exceeded 3 exit attempts in 30s — forcing syncWithExchange instead of retrying`);
        this.exitAttemptCount = 0;
        this.lastExitAttemptTs = now;
        await deps.syncWithExchange();
        return;
      }
    } else {
      this.exitAttemptCount = 1;
      this.lastExitAttemptTs = now;
    }

    deps.setClosingPosition(true);
    deps.stopRealtimeExitMonitor();

    try {

    // Calculate PnL based on side
    let pnlPct: number;
    let pnlUsd: number;

    if (position.side === 'long') {
      pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (currentPrice - position.entryPrice);
    } else {
      pnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (position.entryPrice - currentPrice);
    }

    const notionalUsd = position.qty * position.entryPrice;
    // V5.6: Use stored margin for capital release, fallback to notional/leverage or notional
    const marginToRelease = position.marginUsd ?? (position.leverage ? notionalUsd / position.leverage : notionalUsd);

    logger.info(`🚪 [${symbol}] CLOSING ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(4)} | exit=$${currentPrice.toFixed(4)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | reason=${reason}`);

    // Reset trailing flags and signal state for next position
    deps.resetTrailingAndSignalState();

    // V5.41: Use shared cooldown logic from momentumSimple.ts
    const cooldownBars = getCooldownBars(reason, deps.entryCooldownBars);
    deps.setEntryCooldownBarsRemaining(cooldownBars);
    logger.info(`⏱️ [${symbol}] Cooldown: ${cooldownBars} bars (${cooldownBars * 15}min) - exit reason: ${reason}`);

    // Store exit info for frontend display
    deps.setLastExit({
      ts: Date.now(),
      price: currentPrice,
      reason,
    });

    if (deps.mode === 'paper') {
      await this.closePaper(position, currentPrice, reason, pnlPct, pnlUsd, marginToRelease, notionalUsd);
    } else {
      await this.closeLive(position, currentPrice, reason, pnlPct, pnlUsd, marginToRelease, notionalUsd);
    }
    } finally {
      deps.setClosingPosition(false);
    }
  }

  // ==========================================================================
  // PAPER CLOSE
  // ==========================================================================

  private async closePaper(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string,
    pnlPct: number,
    pnlUsd: number,
    marginToRelease: number,
    notionalUsd: number,
  ): Promise<void> {
    const { deps } = this;
    const symbol = deps.symbol;

    // Paper close — position nulled AFTER DB save (see below) to prevent orphans on DB failure.
    // closingPosition flag prevents re-entry in the meantime.

    // V5.30: Close additional positions too
    let totalPnlUsd = pnlUsd;
    let totalMarginReleased = marginToRelease;

    for (const addPos of deps.getAdditionalPositions()) {
      let addPnlUsd: number;
      if (addPos.side === 'long') {
        addPnlUsd = addPos.qty * (currentPrice - addPos.entryPrice);
      } else {
        addPnlUsd = addPos.qty * (addPos.entryPrice - currentPrice);
      }
      const addMargin = addPos.marginUsd ?? (addPos.leverage ? (addPos.qty * addPos.entryPrice) / addPos.leverage : addPos.qty * addPos.entryPrice);
      const addPnlPct = addPos.side === 'long'
        ? ((currentPrice - addPos.entryPrice) / addPos.entryPrice) * 100
        : ((addPos.entryPrice - currentPrice) / addPos.entryPrice) * 100;

      deps.capitalPool.release(`${deps.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
      totalPnlUsd += addPnlUsd;
      totalMarginReleased += addMargin;

      // V5.30: Save additional position as separate trade in DB
      const addNotional = addPos.qty * currentPrice;
      const addFeeUsd = addNotional * 0.0004;
      await deps.saveExitToDb(addPos, currentPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, undefined, addFeeUsd);

      logger.info(`📝 [${symbol}] PAPER MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED | PnL=$${addPnlUsd.toFixed(2)}`);
    }
    deps.clearAdditionalPositions();

    // Release MARGIN (not notional) with PnL
    deps.capitalPool.release(deps.sessionId, marginToRelease, pnlUsd);

    // V5.41: Paper mode realistic costs (aligned with backtest for fair comparison)
    // Backtest uses: 0.04% × 2 (entry+exit) + 0.05% × 2 (slippage) + 0.01%/8h (funding)
    const exitNotionalUsd = position.qty * currentPrice;
    const entryNotionalUsd = position.qty * position.entryPrice;
    const tradingFeeEntry = entryNotionalUsd * 0.0004;  // 0.04% on entry
    const tradingFeeExit = exitNotionalUsd * 0.0004;    // 0.04% on exit
    const slippageEntry = entryNotionalUsd * 0.0005;    // 0.05% slippage on entry
    const slippageExit = exitNotionalUsd * 0.0005;      // 0.05% slippage on exit

    // Calculate funding: 0.01% per 8h period held
    const holdMinutes = (Date.now() - position.entryTime) / 60000;
    const holdBars = Math.floor(holdMinutes / 15);
    const fundingPeriods = Math.floor(holdBars / 32); // 32 bars = 8 hours
    const fundingFee = fundingPeriods * (entryNotionalUsd * 0.0001); // 0.01% per period

    const paperFeeUsd = tradingFeeEntry + tradingFeeExit + slippageEntry + slippageExit + fundingFee;

    // V5.78 FIX: Only send notifications if DB save succeeds
    // This prevents false notifications when position is still open due to DB failure
    const dbSaveSuccess = await deps.saveExitToDb(position, currentPrice, reason, pnlPct, totalPnlUsd, undefined, paperFeeUsd);

    if (!dbSaveSuccess) {
      logger.error(`❌ [${symbol}] PAPER close DB save FAILED - position may still exist in DB. Skipping notifications.`);
      // Don't send notification - position might still be open
      return;
    }

    // V5.91: Null position AFTER DB save succeeds — prevents orphan if DB fails
    deps.setPosition(null);

    logger.info(`📝 [${symbol}] PAPER CLOSED | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${totalPnlUsd.toFixed(2)}) | margin released=$${totalMarginReleased.toFixed(2)} | costs=$${paperFeeUsd.toFixed(2)}`);

    // Send Telegram notification for paper exit avec P&L et balance
    // V5.78: Only sent AFTER successful DB save
    const balanceAfterPaper = deps.capitalPool.getTotalCapital();
    void notifyPositionClosed({
      agentId: deps.sessionId,
      symbol,
      side: position.side,
      quantity: position.qty,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      pnl: totalPnlUsd,
      pnlPct: pnlPct,
      reason,
      mode: 'paper',
      balanceAfter: balanceAfterPaper,
      feesUsd: paperFeeUsd,
      userId: deps.userId,
    });

    // Old notification system (kept for compatibility)
    notifyTradeExit({
      symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: currentPrice,
      qty: position.qty,
      notionalUsd,
      pnlUsd,
      pnlPct,
      reason,
      mode: 'paper',
      userId: deps.userId || undefined,
    });

    // V5.63: Record trade result for consecutive loser tracking
    // Use GROSS PnL (before fees) — fees on flat trades (e.g. WIF +0.06%) should not count as loss
    const isWinner = totalPnlUsd > 0;
    deps.capitalPool.recordTradeResult(isWinner, symbol);

    // V5.79: Record trade for daily Telegram report
    recordTrade(totalPnlUsd - paperFeeUsd);
  }

  // ==========================================================================
  // LIVE CLOSE
  // ==========================================================================

  private async closeLive(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string,
    _pnlPct: number,
    _pnlUsd: number,
    marginToRelease: number,
    notionalUsd: number,
  ): Promise<void> {
    const { deps } = this;
    const symbol = deps.symbol;

    try {
      // V5.105: Removed circuit breaker check here (was double-gate bug).
      // The order queue already handles circuit breaker + CRITICAL exit priority.

      // FIRST: Cancel any open SL/TP orders to avoid orphaned orders
      await deps.cancelStopLossOnExchange();

      // Format quantity to exchange precision
      const formattedQty = deps.formatQtyForExchange(symbol, position.qty);

      // ========================================================================
      // ORDER QUEUE INTEGRATION - Submit exit order via global queue
      // ========================================================================

      // Calculate PnL for priority calculation
      const pnlPct = position.side === 'long'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

      const holdTimeMs = Date.now() - position.entryTime;

      const exitReason = reason as ExitReason;
      const orderRequest: OrderRequest = {
        id: uuidv4(),
        agentId: deps.sessionId,
        userId: deps.userId || 'unknown',
        priority: calculateOrderPriority({
          reason: exitReason,
          isEntry: false,
          positionPnlPct: pnlPct,
          positionHoldTimeMs: holdTimeMs,
          positionLeverage: position.leverage,
        }),
        symbol,
        side: position.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        quantity: formattedQty,
        params: { reduceOnly: true },
        isEntry: false,
        reason,
        priorityContext: {
          isEntry: false,
          reason: exitReason,
          positionPnlPct: pnlPct,
          positionHoldTimeMs: holdTimeMs,
        },
        submittedAt: Date.now(),
        retries: 0,
        timeoutMs: 30_000,
      };

      logger.info(
        `[${symbol}] Submitting ${position.side} exit order to queue | ` +
        `reason=${reason} | orderId=${orderRequest.id} | priority=${orderRequest.priority}`
      );

      const result = await orderQueue.submitOrder(orderRequest);

      if (!result.success) {
        // V5.105: Check if position is already closed on exchange (e.g. SL fired)
        const errorStr = (result.error || '').toLowerCase();
        const isAlreadyClosed = errorStr.includes('reduceonly') ||
                                errorStr.includes('reduce only') ||
                                errorStr.includes('position side does not match') ||
                                errorStr.includes('position does not exist');
        if (isAlreadyClosed) {
          logger.warn(`🔄 [${symbol}] Exit order rejected (position already closed on exchange) — triggering syncWithExchange`);
          deps.setClosingPosition(false);
          await deps.syncWithExchange();
          return;
        }

        // Also check WS position cache — if exchange shows no position, don't restart RT monitor
        const wsPos = getPositionFromWebSocket(deps.userId, symbol);
        if (!wsPos || Math.abs(wsPos.positionAmt) === 0) {
          logger.warn(`🔄 [${symbol}] Exit order failed but WS shows no position — triggering syncWithExchange`);
          deps.setClosingPosition(false);
          await deps.syncWithExchange();
          return;
        }

        logger.error(`[${symbol}] Exit order FAILED: ${result.error} (${result.errorCode})`);
        deps.setClosingPosition(false);
        // Restart RT monitor — close failed, position still needs real-time SL protection
        deps.startRealtimeExitMonitorIfNeeded();
        return;
      }

      const order = result.order!;
      const closeSide = position.side === 'long' ? 'sell' : 'buy';
      const exitPrice = order.average || order.price || currentPrice;

      // ═══════════════════════════════════════════════════════════════════════
      // V5.80: PARTIAL FILL DETECTION AND RETRY (BUG FIX)
      // ═══════════════════════════════════════════════════════════════════════
      await this.handlePartialFills(position, formattedQty, order, closeSide);

      // ═══════════════════════════════════════════════════════════════════════
      // V5.65: SLIPPAGE VALIDATION FOR EXIT ORDERS
      // ═══════════════════════════════════════════════════════════════════════
      this.validateExitSlippage(position, currentPrice, exitPrice);

      // Recalculate actual PnL
      let actualPnlPct: number;
      let actualPnlUsd: number;
      if (position.side === 'long') {
        actualPnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        actualPnlUsd = position.qty * (exitPrice - position.entryPrice);
      } else {
        actualPnlPct = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
        actualPnlUsd = position.qty * (position.entryPrice - exitPrice);
      }

      deps.setPosition(null);

      // V5.30: Close additional positions too (LIVE mode)
      let totalPnlUsd = actualPnlUsd;
      let totalMarginReleased = marginToRelease;

      await this.closeAdditionalPositionsLive(
        position, currentPrice, reason, exitReason, actualPnlPct,
        (addPnlUsd, addMargin) => { totalPnlUsd += addPnlUsd; totalMarginReleased += addMargin; },
      );
      deps.clearAdditionalPositions();

      // Release margin from our tracking (PnL is passed for logging but NOT added to totalCapitalUsd in live mode)
      deps.capitalPool.release(deps.sessionId, marginToRelease, actualPnlUsd);

      // CRITICAL: Sync with exchange to get the real balance after position close
      await deps.capitalPool.syncAfterPositionClose();

      // Log the updated capital state
      const newStatus = deps.capitalPool.getStatus();
      logger.info(`💰 [${symbol}] Capital after close: total=$${newStatus.totalUsd.toFixed(2)} | available=$${newStatus.availableUsd.toFixed(2)} | inPositions=$${newStatus.inPositionsUsd.toFixed(2)}`);

      // Extract fee from CCXT order response, fallback to 0.04% calculation
      const exitNotionalUsd = position.qty * exitPrice;
      const liveFeeUsd = order.fee?.cost ?? (exitNotionalUsd * 0.0004);

      // V5.78 FIX: Only send notifications if DB save succeeds
      const dbSaveSuccessLive = await deps.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd, order.id, liveFeeUsd);

      if (!dbSaveSuccessLive) {
        logger.error(`❌ [${symbol}] LIVE close DB save FAILED - position may still exist in DB. Skipping notifications.`);
        return;
      }

      logger.info(`🔴 [${symbol}] LIVE CLOSED @ $${exitPrice} | PnL=${actualPnlPct >= 0 ? '+' : ''}${actualPnlPct.toFixed(2)}% ($${actualPnlUsd.toFixed(2)}) | fee=$${liveFeeUsd.toFixed(2)} | margin released=$${marginToRelease.toFixed(2)} | orderId=${order.id}`)

      // Send Telegram notification for live exit avec tous les détails
      // V5.78: Only sent AFTER successful DB save
      const balanceAfterLive = deps.capitalPool.getTotalCapital();
      void notifyPositionClosed({
        agentId: deps.sessionId,
        symbol,
        side: position.side,
        quantity: position.qty,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl: actualPnlUsd,
        pnlPct: actualPnlPct,
        reason,
        mode: 'live',
        balanceAfter: balanceAfterLive,
        feesUsd: liveFeeUsd,
        userId: deps.userId,
      });

      // Old notification system (kept for compatibility)
      notifyTradeExit({
        symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        qty: position.qty,
        notionalUsd,
        pnlUsd: actualPnlUsd,
        pnlPct: actualPnlPct,
        reason,
        mode: 'live',
        userId: deps.userId || undefined,
      });

      // V5.63: Record trade result for consecutive loser tracking
      // Use GROSS PnL (before fees) — fees on flat trades should not count as loss
      const isWinnerLive = actualPnlUsd > 0;
      deps.capitalPool.recordTradeResult(isWinnerLive, symbol);

      // V5.79: Record trade for daily Telegram report
      recordTrade(actualPnlUsd - liveFeeUsd);

      deps.onTrade?.({
        symbol,
        side: closeSide,
        qty: position.qty,
        price: exitPrice,
        orderId: order.id,
        timestamp: new Date(),
      });

    } catch (error: unknown) {
      logger.error(`❌ [${symbol}] Failed to close live position:`, error);

      // NOTIFICATION: Exit order error (CRITICAL)
      notifyOrderError({
        symbol,
        side: position.side,
        orderType: 'exit',
        error: errMsg(error),
        mode: 'live',
        userId: deps.userId || undefined,
      });
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * V5.80: Handle partial fills and formatting residuals
   */
  private async handlePartialFills(
    position: Position,
    formattedQty: number,
    order: any,
    closeSide: 'buy' | 'sell',
  ): Promise<void> {
    const { deps } = this;
    const symbol = deps.symbol;
    const filledQty = order.filled ?? 0;

    // Check 1: Did exchange fill what we actually requested?
    const exchangeFillRatio = filledQty / formattedQty;

    // Check 2: Did formatting lose any quantity? (floor rounding residual)
    const formattingLoss = position.qty - formattedQty;
    const hasFormattingResidual = formattingLoss > 0.000001; // Epsilon for float comparison

    if (exchangeFillRatio < 0.99) {
      // Exchange partial fill - retry for unfilled portion of what we sent
      const remainingQty = formattedQty - filledQty;
      logger.warn(
        `⚠️ [${symbol}] EXCHANGE PARTIAL FILL! ` +
        `Sent=${formattedQty} Filled=${filledQty} (${(exchangeFillRatio * 100).toFixed(1)}%) ` +
        `Remaining=${remainingQty.toFixed(6)}`
      );

      // Retry close for remaining amount
      try {
        const retryFormattedQty = deps.formatQtyForExchange(symbol, remainingQty);

        // Only retry if remaining qty meets minimum order size
        if (retryFormattedQty > 0) {
          const retryOrderRequest: OrderRequest = {
            id: uuidv4(),
            agentId: deps.sessionId,
            userId: deps.userId || 'unknown',
            priority: 95, // CRITICAL priority for cleanup
            symbol,
            side: closeSide,
            type: 'market',
            quantity: retryFormattedQty,
            params: { reduceOnly: true },
            isEntry: false,
            reason: 'partial_fill_cleanup',
            priorityContext: { isEntry: false, reason: 'partial_fill_cleanup' },
            submittedAt: Date.now(),
            retries: 0,
            timeoutMs: 30_000,
          };

          logger.info(`🔄 [${symbol}] Submitting RETRY order for remaining ${retryFormattedQty} qty`);
          const retryResult = await orderQueue.submitOrder(retryOrderRequest);

          if (retryResult.success) {
            logger.info(`✅ [${symbol}] Partial fill cleanup SUCCESS | filled=${retryResult.order?.filled}`);
          } else {
            logger.error(`❌ [${symbol}] Partial fill cleanup FAILED: ${retryResult.error}`);
            // Position may still be partially open - will be caught by syncWithExchange
          }
        } else {
          logger.warn(`⚠️ [${symbol}] Remaining qty ${remainingQty} too small to close (below min order size)`);
        }
      } catch (retryError: any) {
        logger.error(`❌ [${symbol}] Partial fill retry error: ${retryError.message}`);
      }
    }

    // V5.81: Close formatting residual (floor rounding left dust on exchange)
    if (hasFormattingResidual && exchangeFillRatio >= 0.99) {
      logger.warn(
        `⚠️ [${symbol}] FORMATTING RESIDUAL: position.qty=${position.qty.toFixed(6)} but ` +
        `only sent formattedQty=${formattedQty.toFixed(6)} (residual=${formattingLoss.toFixed(6)}). ` +
        `Sending cleanup order...`
      );

      try {
        const residualQty = deps.formatQtyForExchange(symbol, formattingLoss);
        if (residualQty > 0) {
          const residualOrder: OrderRequest = {
            id: uuidv4(),
            agentId: deps.sessionId,
            userId: deps.userId || 'unknown',
            priority: 95, // CRITICAL priority for cleanup
            symbol,
            side: closeSide,
            type: 'market',
            quantity: residualQty,
            params: { reduceOnly: true },
            isEntry: false,
            reason: 'formatting_residual_cleanup',
            priorityContext: { isEntry: false, reason: 'formatting_residual_cleanup' },
            submittedAt: Date.now(),
            retries: 0,
            timeoutMs: 30_000,
          };

          logger.info(`🧹 [${symbol}] Submitting residual cleanup order for ${residualQty} qty`);
          const residualResult = await orderQueue.submitOrder(residualOrder);

          if (residualResult.success) {
            logger.info(`✅ [${symbol}] Residual cleanup SUCCESS | filled=${residualResult.order?.filled}`);
          } else {
            logger.error(`❌ [${symbol}] Residual cleanup FAILED: ${residualResult.error}`);
          }
        } else {
          logger.warn(`⚠️ [${symbol}] Residual ${formattingLoss.toFixed(6)} too small to close (below step size)`);
        }
      } catch (residualError: any) {
        logger.error(`❌ [${symbol}] Residual cleanup error: ${residualError.message}`);
      }
    }
  }

  /**
   * V5.65: Validate exit slippage (log-only alerts)
   */
  private validateExitSlippage(
    position: Position,
    expectedExitPrice: number,
    actualExitPrice: number,
  ): void {
    const symbol = this.deps.symbol;
    const exitSlippage = position.side === 'long'
      ? ((expectedExitPrice - actualExitPrice) / expectedExitPrice) * 100  // Positive = worse for long exit
      : ((actualExitPrice - expectedExitPrice) / expectedExitPrice) * 100; // Positive = worse for short exit

    const maxExitSlippage = MomentumConfig.EXIT.MAX_EXIT_SLIPPAGE_PCT ?? 2.0;

    if (exitSlippage > maxExitSlippage) {
      logger.warn(
        `⚠️ [${symbol}] HIGH EXIT SLIPPAGE | ` +
        `expected=$${expectedExitPrice.toFixed(4)} | filled=$${actualExitPrice.toFixed(4)} | ` +
        `slippage=${exitSlippage.toFixed(2)}% (max=${maxExitSlippage}%)`
      );
    } else if (exitSlippage > 0.1) {
      logger.info(`📊 [${symbol}] Exit slippage: ${exitSlippage.toFixed(3)}%`);
    }
  }

  /**
   * V5.30: Close additional positions in live mode
   */
  private async closeAdditionalPositionsLive(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string,
    exitReason: ExitReason,
    actualPnlPct: number,
    accumulate: (addPnlUsd: number, addMargin: number) => void,
  ): Promise<void> {
    const { deps } = this;
    const symbol = deps.symbol;

    for (const addPos of deps.getAdditionalPositions()) {
      try {
        // Submit close order for each additional position
        const addFormattedQty = deps.formatQtyForExchange(symbol, addPos.qty);

        const addOrderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: deps.sessionId,
          userId: deps.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: exitReason,
            isEntry: false,
            positionPnlPct: actualPnlPct,
            positionHoldTimeMs: Date.now() - addPos.entryTime,
          }),
          symbol,
          side: addPos.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          quantity: addFormattedQty,
          params: { reduceOnly: true },
          isEntry: false,
          reason: `multi_exit_${(addPos.entryIndex || 0) + 1}`,
          priorityContext: { isEntry: false, reason: exitReason },
          submittedAt: Date.now(),
          retries: 0,
          timeoutMs: 30_000,
        };

        const addResult = await orderQueue.submitOrder(addOrderRequest);

        if (addResult.success && addResult.order) {
          const addExitPrice = addResult.order.average || addResult.order.price || currentPrice;
          let addPnlUsd: number;
          if (addPos.side === 'long') {
            addPnlUsd = addPos.qty * (addExitPrice - addPos.entryPrice);
          } else {
            addPnlUsd = addPos.qty * (addPos.entryPrice - addExitPrice);
          }
          const addPnlPct = addPos.side === 'long'
            ? ((addExitPrice - addPos.entryPrice) / addPos.entryPrice) * 100
            : ((addPos.entryPrice - addExitPrice) / addPos.entryPrice) * 100;
          const addMargin = addPos.marginUsd ?? 0;

          deps.capitalPool.release(`${deps.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
          accumulate(addPnlUsd, addMargin);

          // V5.30: Save additional position as separate trade in DB
          const addNotional = addPos.qty * addExitPrice;
          const addFeeUsd = addResult.order.fee?.cost ?? (addNotional * 0.0004);
          await deps.saveExitToDb(addPos, addExitPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, addResult.order.id, addFeeUsd);

          logger.info(`🔴 [${symbol}] LIVE MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED @ $${addExitPrice.toFixed(4)} | PnL=$${addPnlUsd.toFixed(2)}`);
        } else {
          logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close FAILED: ${addResult.error}`);
        }
      } catch (addErr: any) {
        logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close error:`, addErr?.message);
      }
    }
  }
}
