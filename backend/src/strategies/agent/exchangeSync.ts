/**
 * exchangeSync.ts — Exchange Position Synchronization
 *
 * V5.108: Extracted from orchestrator.ts (formerly simpleAgent.ts).
 * Handles position sync with Binance exchange and missing trade reconciliation.
 *
 * Three sync cases:
 *   Case 1: Local has position, exchange doesn't → position closed on exchange (SL/trailing hit)
 *   Case 2: Exchange has position, local doesn't → unexpected position (restart recovery)
 *   Case 3: Both have position → verification log
 *
 * Uses callback injection pattern (same as RealtimeExitHandler, PositionOpener).
 */

import { PrismaClient } from '@prisma/client';
import {
  getPositionFromWebSocket,
  getLastFilledOrderTradeUpdateFromWebSocket,
  isUserDataStreamActive,
} from '../../services/binanceWebSocket.js';
import { ipWeightTracker } from '../../services/ipWeightTracker.js';
import { exchangeAPIDeduplicator, makeFetchMyTradesKey } from '../../services/apiDeduplicator.js';
import { orderQueue, type OrderRequest } from '../../services/orderQueue.js';
import {
  EXIT_SL_EXCHANGE, EXIT_TRAIL_EXCHANGE, EXIT_STAGNANT,
} from '../../types/exitReasons.js';
import { MomentumConfig, type Position } from '../momentumSimple.js';
import { notifyPositionClosed } from '../../utils/notifications.js';
import { notifyTradeExit } from '../../services/notificationService.js';
import { recordTrade } from '../../services/telegramReporter.js';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../utils/logger.js';
import type { CapitalPool } from '../capitalPool.js';
import type { PositionPersistence } from '../positionPersistence.js';
import type { Exchange } from '../../types/exchange.js';

const logger = createLogger('exchange-sync');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// DEPENDENCY INTERFACE
// ============================================================================

export interface ExchangeSyncDeps {
  symbol: string;
  mode: 'paper' | 'live';
  userId: string;
  sessionId: string;
  exchange: Exchange;
  prisma: PrismaClient;
  capitalPool: CapitalPool;
  persistence: PositionPersistence;

  // State accessors (read/write orchestrator state)
  getPosition: () => Position | null;
  setPosition: (pos: Position | null) => void;
  isClosingPosition: () => boolean;

  // Orchestrator callbacks
  savePositionToDb: (pos: Position, action: string, fee?: number) => Promise<void>;
  saveExitToDb: (pos: Position, price: number, reason: string, pnlPct: number, pnlUsd: number, orderId?: string, fee?: number) => Promise<boolean>;
  cancelStopLossOnExchange: () => Promise<void>;
  setStopLossOnExchange: (pos: Position, isUpdate: boolean) => Promise<void>;
  startRealtimeExitMonitorIfNeeded: () => void;
  formatQtyForExchange: (symbol: string, qty: number) => number;
  resetTrailingState: () => void;
}

// ============================================================================
// EXCHANGE SYNC CLASS
// ============================================================================

export class ExchangeSync {
  private lastPositionSync = 0;
  private lastMissingTradesCheck = 0;
  private readonly POSITION_SYNC_INTERVAL_MS: number;
  private readonly MISSING_TRADES_CHECK_INTERVAL_MS: number;

  constructor(
    private deps: ExchangeSyncDeps,
    positionSyncIntervalMs: number,
    missingTradesCheckIntervalMs: number,
  ) {
    this.POSITION_SYNC_INTERVAL_MS = positionSyncIntervalMs;
    this.MISSING_TRADES_CHECK_INTERVAL_MS = missingTradesCheckIntervalMs;
  }

  /**
   * Load existing position from DB on startup.
   * Commits margin to CapitalPool to prevent double-spending.
   */
  async loadExistingPosition(): Promise<void> {
    const position = await this.deps.persistence.loadExistingPosition();
    if (position) {
      this.deps.setPosition(position);
      // CRITICAL: Register margin in CapitalPool to prevent double-spending
      const marginUsd = position.marginUsd ?? (position.qty * position.entryPrice) / (position.leverage ?? 4.5);
      this.deps.capitalPool.commit(this.deps.sessionId, marginUsd);
    }
  }

  /**
   * Sync local position state with exchange (live mode only).
   * Uses WebSocket for real-time position updates (0 weight!) instead of REST API.
   * Detects if stop losses were executed on Binance.
   */
  async syncWithExchange(): Promise<void> {
    const { symbol, userId, sessionId, mode, capitalPool } = this.deps;

    // Throttle sync to avoid excessive processing
    const now = Date.now();
    if (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL_MS) {
      return;
    }
    this.lastPositionSync = now;

    try {
      // Use WebSocket position cache (0 weight!) instead of fetchPositions (5 weight)
      const wsPosition = getPositionFromWebSocket(userId, symbol);

      let exchangeQty = 0;
      let exchangeSide: 'long' | 'short' = 'long';
      let entryPrice = 0;
      let unrealizedPnl = 0;

      if (wsPosition) {
        exchangeQty = Math.abs(wsPosition.positionAmt);
        exchangeSide = wsPosition.side === 'short' ? 'short' : 'long';
        entryPrice = wsPosition.entryPrice;
        unrealizedPnl = wsPosition.unrealizedPnl;
      } else {
        // NO REST FALLBACK - WebSocket only to prevent IP bans
        const position = this.deps.getPosition();
        if (position !== null) {
          logger.info(`🔄 [${symbol}] WS has no position but local has one - position may be closed`);
        } else {
          return;
        }
      }

      const position = this.deps.getPosition();

      // Case 1: We think we have a position but exchange says NO
      if (position && exchangeQty === 0) {
        // V5.91: Guard against race with closePosition()
        if (this.deps.isClosingPosition()) {
          logger.info(`🔄 [${symbol}] SYNC: closePosition() in progress — skipping to prevent double processing`);
          return;
        }
        logger.info(`🔴 [${symbol}] SYNC MISMATCH: Position closed on exchange (likely stop loss hit)`);

        // Try to get the last trade to find exit price and orderId
        let exitPrice = position.entryPrice;
        let exchangeOrderId: string | undefined;
        let orderType: string | undefined;
        let reason = EXIT_SL_EXCHANGE;

        try {
          // Prefer WebSocket user-data fills (0 weight)
          if (isUserDataStreamActive(userId)) {
            const exitSide = position.side === 'long' ? 'SELL' : 'BUY';
            const wsFill = getLastFilledOrderTradeUpdateFromWebSocket(userId, symbol, {
              reduceOnly: true,
              side: exitSide,
            });

            if (wsFill) {
              const wsPrice = Number(wsFill.averagePrice ?? wsFill.lastFilledPrice);
              if (Number.isFinite(wsPrice) && wsPrice > 0) {
                exitPrice = wsPrice;
              }
              exchangeOrderId = wsFill.orderId;
              orderType = wsFill.orderType;
              logger.info(`📈 [${symbol}] Found exit fill via WS: $${exitPrice} orderId=${exchangeOrderId} type=${orderType}`);
            } else {
              logger.warn(`⚠️ [${symbol}] No WS exit fill found yet; using entryPrice fallback for sync.`);
            }
          }

          // REST fallback (only if WS is not active or had no data)
          if (!exchangeOrderId && this.deps.exchange.fetchMyTrades && ipWeightTracker.canMakeCall(10)) {
            const since = Date.now() - 3600000;
            const key = makeFetchMyTradesKey(userId, symbol, since);
            const trades = await exchangeAPIDeduplicator.execute(
              key,
              async () => {
                const result = await this.deps.exchange.fetchMyTrades!(symbol, since, 10);
                ipWeightTracker.record(10, `fetchMyTrades:exitSync:${symbol}`);
                return result;
              },
              5_000,
              `${sessionId}:exitSync`
            );
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = lastTrade.price || exitPrice;
              exchangeOrderId = lastTrade.order || (lastTrade.info?.orderId as string | undefined);
              orderType = (lastTrade.info?.type as string | undefined) || lastTrade.type;
              logger.info(`📈 [${symbol}] Found exit trade via REST: $${exitPrice} orderId=${exchangeOrderId} type=${orderType}`);
            }
          }
        } catch (tradeError) {
          logger.warn(`⚠️ [${symbol}] Could not determine exit trade:`, tradeError);
        }

        // Calculate PnL
        let pnlPct: number;
        let pnlUsd: number;
        if (position.side === 'long') {
          pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          pnlUsd = position.qty * (exitPrice - position.entryPrice);
        } else {
          pnlPct = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          pnlUsd = position.qty * (position.entryPrice - exitPrice);
        }

        // Determine exit reason from order type
        if (orderType && orderType.includes('TRAILING')) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderType=${orderType} (PnL: ${pnlPct.toFixed(2)}%)`);
        } else if (exchangeOrderId && position.trailingOrderId && exchangeOrderId === position.trailingOrderId) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderId match (PnL: ${pnlPct.toFixed(2)}%)`);
        } else if (pnlPct > -1 && position.trailingOrderId) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via PnL heuristic (PnL: ${pnlPct.toFixed(2)}%)`);
        } else if (position.stagnantState?.confirmed && !position.stagnantState?.cancelled) {
          reason = EXIT_STAGNANT;
          logger.info(`🐌 [${symbol}] Detected STAGNANT TRADE exit (PnL: ${pnlPct.toFixed(2)}%, stagnant SL hit on exchange)`);
        } else {
          reason = EXIT_SL_EXCHANGE;
          logger.info(`🛑 [${symbol}] Detected FIXED SL exit (PnL: ${pnlPct.toFixed(2)}%, type=${orderType})`);
        }

        const notionalUsd = position.qty * position.entryPrice;
        const marginToRelease = position.marginUsd ?? (position.leverage ? notionalUsd / position.leverage : notionalUsd);

        // Release MARGIN (not notional)
        capitalPool.release(sessionId, marginToRelease, pnlUsd);

        // Calculate fee for synced exit
        const syncExitNotionalUsd = position.qty * exitPrice;
        const syncFeeUsd = syncExitNotionalUsd * 0.0004;

        // Save exit to DB
        const syncDbSuccess = await this.deps.saveExitToDb(position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId, syncFeeUsd);

        logger.info(`✅ [${symbol}] Position synced: Exit @ $${exitPrice.toFixed(4)}, PnL: ${pnlPct.toFixed(2)}%, fee: $${syncFeeUsd.toFixed(2)}, margin released: $${marginToRelease.toFixed(2)}`);

        // V5.89: Send notifications for exchange-triggered exits
        if (syncDbSuccess) {
          const balanceAfterSync = capitalPool.getTotalCapital();
          void notifyPositionClosed({
            agentId: sessionId,
            symbol,
            side: position.side,
            quantity: position.qty,
            entryPrice: position.entryPrice,
            exitPrice,
            pnl: pnlUsd,
            pnlPct,
            reason,
            mode: 'live',
            balanceAfter: balanceAfterSync,
            feesUsd: syncFeeUsd,
            userId,
          });

          notifyTradeExit({
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice,
            qty: position.qty,
            notionalUsd,
            pnlUsd,
            pnlPct,
            reason,
            mode: 'live',
            userId: userId || undefined,
          });

          // Record trade for consecutive loser tracking + daily report
          const isWinnerSync = (pnlUsd - syncFeeUsd) > 0;
          capitalPool.recordTradeResult(isWinnerSync, symbol);
          recordTrade(pnlUsd - syncFeeUsd);
        }

        // Cancel remaining orders to avoid orphans
        logger.info(`🧹 [${symbol}] Cleaning up orphan orders after position close...`);
        await this.deps.cancelStopLossOnExchange();

        // Reset trailing flags
        this.deps.resetTrailingState();

        this.deps.setPosition(null);
      }

      // Case 2: Exchange has position but we don't know about it
      else if (!position && exchangeQty > 0) {
        // V5.82: Close dust positions (notional < $5)
        const dustNotional = exchangeQty * entryPrice;
        if (dustNotional < 5) {
          logger.info(`🧹 [${symbol}] SYNC: Dust position detected (${exchangeSide} ${exchangeQty}, notional=$${dustNotional.toFixed(2)}) — closing on exchange`);
          try {
            const closeSide = exchangeSide === 'long' ? 'sell' : 'buy';
            const dustFormattedQty = this.deps.formatQtyForExchange(symbol, exchangeQty);
            if (dustFormattedQty > 0) {
              const dustOrder: OrderRequest = {
                id: uuidv4(),
                agentId: sessionId,
                userId: userId || 'unknown',
                priority: 95,
                symbol,
                side: closeSide,
                type: 'market',
                quantity: dustFormattedQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'dust_position_cleanup',
                priorityContext: { isEntry: false, reason: 'dust_position_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };
              const dustResult = await orderQueue.submitOrder(dustOrder);
              if (dustResult.success) {
                logger.info(`✅ [${symbol}] Dust cleanup SUCCESS | filled=${dustResult.order?.filled}`);
              } else {
                logger.warn(`⚠️ [${symbol}] Dust cleanup FAILED: ${dustResult.error}`);
              }
            } else {
              logger.info(`🧹 [${symbol}] Dust qty ${exchangeQty} below step size — cannot close via order`);
            }
          } catch (dustErr: any) {
            logger.warn(`⚠️ [${symbol}] Dust cleanup error: ${dustErr?.message}`);
          }
          return;
        }

        logger.info(`⚠️ [${symbol}] SYNC: Found unexpected position on exchange (${exchangeSide} ${exchangeQty})`);

        if (entryPrice > 0) {
          // Check if position exists in DB to preserve entryTime and maxPnlPct
          let dbEntryTime: number | undefined;
          let dbMaxPnlPct: number | undefined;

          try {
            const dbPosition = await this.deps.prisma.position.findFirst({
              where: {
                sessionId: sessionId,
                symbol: symbol,
              },
              orderBy: { openedAt: 'desc' },
            });

            if (dbPosition && dbPosition.openedAt) {
              dbEntryTime = dbPosition.openedAt.getTime();
              dbMaxPnlPct = dbPosition.maxPnlPct || undefined;
              const ageMinutes = dbEntryTime ? Math.round((Date.now() - dbEntryTime) / 60000) : 0;
              logger.info(`📊 [${symbol}] Restored position history from DB: age=${ageMinutes}min, maxPnl=${dbMaxPnlPct?.toFixed(2)}%`);
            }
          } catch (dbErr) {
            logger.warn(`⚠️ [${symbol}] Failed to load DB position:`, dbErr);
          }

          // Estimate margin
          const notionalUsd = exchangeQty * entryPrice;
          const estimatedLeverage = MomentumConfig.LEVERAGE[symbol] || 5;
          const estimatedMargin = notionalUsd / estimatedLeverage;

          const newPosition: Position = {
            symbol,
            side: exchangeSide,
            entryPrice,
            qty: exchangeQty,
            entryTime: dbEntryTime || Date.now(),
            realEntryTime: dbEntryTime || Date.now(),
            leverage: estimatedLeverage,
            marginUsd: estimatedMargin,
            highWaterMark: exchangeSide === 'long' ? entryPrice : undefined,
            lowWaterMark: exchangeSide === 'short' ? entryPrice : undefined,
            maxPnlPct: dbMaxPnlPct,
          };

          this.deps.setPosition(newPosition);

          // Commit MARGIN for this position
          capitalPool.commit(sessionId, estimatedMargin);

          // Calculate entry fee
          const syncEntryFee = notionalUsd * 0.0004;

          // Save to DB (only if not already saved)
          if (!dbEntryTime) {
            await this.deps.savePositionToDb(newPosition, 'synced_from_exchange', syncEntryFee);
          }

          logger.info(`✅ [${symbol}] Position synced from exchange: ${exchangeSide} @ $${entryPrice} (age: ${Math.round((Date.now() - (dbEntryTime || Date.now())) / 60000)}min)`);

          // Set up stop loss protection for synced positions
          if (mode === 'live') {
            try {
              const baseSlPct = 2.0;
              const emergencyTargetPct = baseSlPct * (MomentumConfig.EXIT.EMERGENCY_STOP_MULTIPLIER || 2.5);
              const emergencyMaxPct = MomentumConfig.EXIT.EMERGENCY_STOP_MAX_PCT ?? 3.0;
              const emergencySlPct = Math.min(emergencyTargetPct, emergencyMaxPct);
              const emergencyStop = exchangeSide === 'long'
                ? entryPrice * (1 - emergencySlPct / 100)
                : entryPrice * (1 + emergencySlPct / 100);

              newPosition.stopLoss = emergencyStop;
              newPosition.emergencyStopPrice = emergencyStop;

              await this.deps.setStopLossOnExchange(newPosition, false);
              logger.info(`🛡️ [${symbol}] SYNC: Emergency SL set @ $${emergencyStop.toFixed(4)} (${emergencySlPct.toFixed(2)}%) for synced position`);

              this.deps.startRealtimeExitMonitorIfNeeded();
            } catch (slError: any) {
              logger.error(`❌ [${symbol}] SYNC: Failed to set stop loss for synced position: ${slError.message}`);
            }
          }
        }
      }

      // Case 3: Both have position - verify they match
      else if (position && exchangeQty > 0) {
        logger.info(`✅ [${symbol}] Position verified on exchange: qty=${exchangeQty} entry=$${entryPrice} uPnL=$${unrealizedPnl.toFixed(2)}`);
      }

      // Check for missing trades
      await this.checkMissingTrades();

    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to sync with exchange:`, error);
    }
  }

  /**
   * Check for missing trades — compares Binance trade history with DB.
   * Catches trades that completed between ticks (entry→exit→entry within 1 minute).
   */
  private async checkMissingTrades(): Promise<void> {
    const { symbol, mode, userId, sessionId } = this.deps;

    try {
      if (mode !== 'live') {
        return;
      }

      const now = Date.now();
      if (now - this.lastMissingTradesCheck < this.MISSING_TRADES_CHECK_INTERVAL_MS) {
        return;
      }
      this.lastMissingTradesCheck = now;

      // If user-data stream is active, rely on WS-based sync
      if (isUserDataStreamActive(userId)) {
        return;
      }

      if (!this.deps.exchange.fetchMyTrades || !ipWeightTracker.canMakeCall(10)) {
        return;
      }

      const since = Date.now() - 2 * 3600 * 1000;
      const key = makeFetchMyTradesKey(userId, symbol, since);
      const binanceTrades = await exchangeAPIDeduplicator.execute(
        key,
        async () => {
          const result = await this.deps.exchange.fetchMyTrades!(symbol, since, 50);
          ipWeightTracker.record(10, `fetchMyTrades:missingTrades:${symbol}`);
          return result;
        },
        10_000,
        `${sessionId}:missingTradesCheck`
      );

      if (!binanceTrades || binanceTrades.length === 0) {
        logger.info(`✅ [${symbol}] No Binance trades found in last 24h`);
        return;
      }

      logger.info(`📊 [${symbol}] Found ${binanceTrades.length} Binance trades in last 24h`);

      // Group trades into entry/exit pairs
      const tradePairs: Array<{ entryTrade: any; exitTrade: any }> = [];
      let pendingEntry: any = null;

      for (const trade of binanceTrades) {
        const isBuy = trade.side === 'buy';
        if (isBuy && !pendingEntry) {
          pendingEntry = trade;
        } else if (!isBuy && pendingEntry) {
          tradePairs.push({ entryTrade: pendingEntry, exitTrade: trade });
          pendingEntry = null;
        }
      }

      logger.info(`📊 [${symbol}] Identified ${tradePairs.length} complete trade pairs from Binance`);

      let reconciledCount = 0;

      for (const pair of tradePairs) {
        const entryOrderId = pair.entryTrade.order || pair.entryTrade.info?.orderId;
        const exitOrderId = pair.exitTrade.order || pair.exitTrade.info?.orderId;

        const existingOrder = await this.deps.prisma.order.findFirst({
          where: { clientOrderId: exitOrderId }
        });

        if (existingOrder) continue;

        logger.warn(`⚠️ [${symbol}] Found missing trade: entry=${entryOrderId} exit=${exitOrderId}`);

        const entryPriceVal = pair.entryTrade.price;
        const exitPrice = pair.exitTrade.price;
        const qty = pair.exitTrade.amount;

        const pnlPct = ((exitPrice - entryPriceVal) / entryPriceVal) * 100;
        const pnlUsd = qty * (exitPrice - entryPriceVal);

        const orderType = pair.exitTrade.info?.type || pair.exitTrade.type;
        let reason = EXIT_SL_EXCHANGE;
        if (orderType && orderType.includes('TRAILING')) {
          reason = EXIT_TRAIL_EXCHANGE;
        } else if (pnlPct > -1) {
          reason = EXIT_TRAIL_EXCHANGE;
        }

        const reconstructedPosition: Position = {
          symbol,
          side: 'long',
          entryPrice: entryPriceVal,
          qty,
          entryTime: pair.entryTrade.timestamp || Date.now(),
          leverage: 5,
          marginUsd: (qty * entryPriceVal) / 5,
          orderId: entryOrderId,
        };

        const existingEntry = await this.deps.prisma.order.findFirst({
          where: { clientOrderId: entryOrderId }
        });

        if (!existingEntry) {
          await this.deps.savePositionToDb(reconstructedPosition, 'reconciled_entry', qty * entryPriceVal * 0.0004);
        } else {
          logger.info(`✓ [${symbol}] Entry ${entryOrderId} already exists, skipping entry save`);
        }

        const exitFee = qty * exitPrice * 0.0004;
        await this.deps.saveExitToDb(reconstructedPosition, exitPrice, reason, pnlPct, pnlUsd, undefined, exitFee);

        reconciledCount++;
        logger.info(`✅ [${symbol}] Reconciled missing trade: PnL=${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
      }

      logger.info(`✅ [${symbol}] Reconciliation complete: ${reconciledCount} missing trades recovered`);

    } catch (error: unknown) {
      logger.error(`❌ [${symbol}] Failed to reconcile trades:`, errMsg(error));
    }
  }
}
