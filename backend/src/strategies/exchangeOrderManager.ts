/**
 * ExchangeOrderManager - Extracted from SimpleAgent.
 * Handles all exchange order operations: stop loss, trailing stop,
 * proactive limits, quantity formatting, and order cancellation.
 */

import type { Exchange } from '../types/exchange.js';
import { MomentumConfig, type Position } from './momentumSimple.js';
import { createLogger } from '../utils/logger.js';
import { notifyOrderError } from '../services/notificationService.js';
import { getTickerFromWebSocket, getOrderTradeUpdateByIdFromWebSocket } from '../services/binanceWebSocket.js';
import { EXIT_EMERGENCY } from '../types/exitReasons.js';
import { ipWeightTracker } from '../services/ipWeightTracker.js';

const logger = createLogger('exchange-orders');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ExchangeOrderManager {
  // Proactive LIMIT order tracking
  proactiveLimitOrderId: string | null = null;
  proactiveLimitPrice: number | null = null;
  private proactiveLimitPlacedAt: number = 0;

  constructor(
    private exchange: Exchange,
    private symbol: string,
    private mode: 'paper' | 'live',
    private userId: string = '',
  ) {}

  // ── Quantity Formatting ────────────────────────────────────────────────

  formatQtyForExchange(symbol: string, qty: number): number {
    // Try CCXT's amountToPrecision first
    if (this.exchange.amountToPrecision) {
      try {
        const formatted = this.exchange.amountToPrecision(symbol, qty);
        const result = parseFloat(formatted);
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (via amountToPrecision)`);
        return result;
      } catch (e) {
        logger.warn(`⚠️ [${symbol}] amountToPrecision failed, using fallback:`, e);
      }
    }

    // Fallback: market precision
    const market = this.exchange.markets?.[symbol];
    if (market?.precision?.amount !== undefined) {
      const precision = market.precision.amount;
      if (Number.isInteger(precision) && precision > 0) {
        const factor = Math.pow(10, precision);
        const result = Math.floor(qty * factor) / factor;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (${precision} decimals)`);
        return result;
      } else {
        const stepSize = precision;
        const result = Math.floor(qty / stepSize) * stepSize;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (step=${stepSize})`);
        return result;
      }
    }

    // Known precision map (static fallback)
    const knownPrecision: Record<string, number> = {
      'SEI/USDT:USDT': 1, 'IMX/USDT:USDT': 0.1, 'SUI/USDT:USDT': 0.1,
      'DOGE/USDT:USDT': 1, 'XRP/USDT:USDT': 0.1, 'ADA/USDT:USDT': 0.1,
      'DOT/USDT:USDT': 0.1, 'LINK/USDT:USDT': 0.01, 'AVAX/USDT:USDT': 0.01,
      'SOL/USDT:USDT': 0.01, 'ETH/USDT:USDT': 0.001, 'BTC/USDT:USDT': 0.001,
    };

    const stepSize = knownPrecision[symbol];
    if (stepSize !== undefined) {
      logger.warn(`⚠️ [${symbol}] Using static precision fallback (step=${stepSize}).`);
      const result = Math.floor(qty / stepSize) * stepSize;
      return result;
    }

    // Ultimate fallback: 3 decimal places
    logger.warn(`⚠️ [${symbol}] No precision info available, using conservative 3 decimal fallback`);
    return Math.floor(qty * 1000) / 1000;
  }

  // ── Cancel Orders ──────────────────────────────────────────────────────

  async cancelAllOrdersOnExchange(position: Position | null): Promise<void> {
    if (this.mode === 'paper') return;

    if (this.exchange.cancelAllOrders) {
      try {
        await this.exchange.cancelAllOrders(this.symbol);
        ipWeightTracker.record(1, `cancelAllOrders:${this.symbol}`);
      } catch (err) {
        // Ignore "no orders" errors
      }
      try {
        await this.exchange.cancelAllOrders(this.symbol, { conditional: true });
        ipWeightTracker.record(1, `cancelAllOrders_cond:${this.symbol}`);
      } catch (err) {
        // Ignore
      }
      if (position) {
        position.stopLossOrderId = undefined;
        position.trailingOrderId = undefined;
      }
    }
  }

  async cancelStopLossOnExchange(position: Position | null): Promise<void> {
    if (this.mode === 'paper') return;
    try {
      await this.cancelAllOrdersOnExchange(position);
      logger.info(`🗑️ [${this.symbol}] Cancelled all open orders (regular + algo)`);
    } catch (error) {
      logger.warn(`⚠️ [${this.symbol}] Failed to cancel orders:`, error);
    }
  }

  // ── Stop Loss ──────────────────────────────────────────────────────────

  async setStopLossOnExchange(position: Position, isUpdate: boolean = false): Promise<void> {
    if (!position.stopLoss) return;
    if (this.mode === 'paper') return;

    const side = position.side === 'long' ? 'sell' : 'buy';

    try {
      if (isUpdate && position.stopLossOrderId) {
        try {
          await this.cancelAllOrdersOnExchange(position);
          logger.info(`🔄 [${this.symbol}] Cancelled all orders for SL update`);
          if (position.trailingOrderId) {
            await this.setTrailingStopOnExchange(position, null);
          }
        } catch (error: unknown) {
          logger.warn(`⚠️ [${this.symbol}] Failed to cancel orders for SL update:`, error);
        }
      }

      const formattedQty = this.formatQtyForExchange(this.symbol, position.qty);

      const slOrder = await this.exchange.createOrder(
        this.symbol, 'market', side, formattedQty, undefined,
        { stopLossPrice: position.stopLoss, reduceOnly: true, workingType: 'MARK_PRICE' },
      );
      ipWeightTracker.record(1, `SL:${this.symbol}`);

      position.stopLossOrderId = slOrder.id;

      const action = isUpdate ? 'UPDATED' : 'SET';
      logger.info(`🛡️ [${this.symbol}] Stop loss ${action} at $${position.stopLoss.toFixed(4)} (order: ${slOrder.id})`);
    } catch (error) {
      logger.warn(`⚠️ [${this.symbol}] Failed to set stop loss on exchange:`, error);
    }
  }

  // ── Trailing Stop ──────────────────────────────────────────────────────

  async setTrailingStopOnExchange(
    position: Position,
    closePositionFn: ((pos: Position, price: number, reason: string) => Promise<void>) | null,
    isWidening: boolean = false,
  ): Promise<boolean> {
    if (this.mode === 'paper') return false;
    if (!MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) return false;
    if (!position.entryPrice) return false;

    const side = position.side === 'long' ? 'sell' : 'buy';
    const trailingActivationPct = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;
    const trailingDistancePct = isWidening
      ? MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT
      : MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;

    const activationPrice = position.side === 'long'
      ? position.entryPrice * (1 + trailingActivationPct / 100)
      : position.entryPrice * (1 - trailingActivationPct / 100);

    try {
      const formattedQty = this.formatQtyForExchange(this.symbol, position.qty);

      const trailingOrder = await this.exchange.createOrder(
        this.symbol, 'market', side, formattedQty, undefined,
        { trailingPercent: trailingDistancePct, trailingTriggerPrice: activationPrice, reduceOnly: true, workingType: 'MARK_PRICE' },
      );
      ipWeightTracker.record(1, `trailing:${this.symbol}`);

      position.trailingOrderId = trailingOrder.id;

      const phase = isWidening ? 'WIDENED' : 'INITIAL';
      logger.info(`🎯 [${this.symbol}] TRAILING_STOP_MARKET [${phase}]: activation=$${activationPrice.toFixed(4)} (+${trailingActivationPct}%) | callback=${trailingDistancePct}% | order=${trailingOrder.id}`);
      return true;
    } catch (error: unknown) {
      const msg = errMsg(error);
      if (msg.includes('Invalid orderType') || msg.includes('not supported')) {
        logger.warn(`⚠️ [${this.symbol}] TRAILING_STOP_MARKET not supported, falling back to STOP_MARKET`);
      } else {
        logger.warn(`⚠️ [${this.symbol}] Failed to set trailing stop: ${msg}`);
      }

      // Fallback to STOP_MARKET
      logger.warn(`🛡️ [${this.symbol}] FALLBACK: Re-placing STOP_MARKET as protection`);
      try {
        if (position.stopLoss) {
          await this.setStopLossOnExchange(position, false);
          logger.info(`🛡️ [${this.symbol}] FALLBACK STOP_MARKET placed at $${position.stopLoss.toFixed(4)}`);
        } else {
          const emergencySL = position.side === 'long'
            ? position.entryPrice * (1 - 0.02)
            : position.entryPrice * (1 + 0.02);
          position.stopLoss = emergencySL;
          await this.setStopLossOnExchange(position, false);
          logger.warn(`🛡️ [${this.symbol}] EMERGENCY STOP_MARKET placed at $${emergencySL.toFixed(4)}`);
        }
      } catch (fallbackError: unknown) {
        logger.error(`🚨🚨🚨 [${this.symbol}] CRITICAL: Both trailing AND fallback SL failed! Position UNPROTECTED!`, errMsg(fallbackError));
        notifyOrderError({ symbol: this.symbol, side: position.side, orderType: 'stop_loss', error: `CRITICAL: Trailing+SL failed - EMERGENCY EXIT: ${errMsg(fallbackError)}`, mode: 'live' });

        if (closePositionFn) {
          logger.error(`🚨 [${this.symbol}] TRIGGERING EMERGENCY MARKET EXIT`);
          try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const ticker = await getTickerFromWebSocket(this.symbol);
            const currentPrice = ticker?.last || position.entryPrice;
            await closePositionFn(position, currentPrice, EXIT_EMERGENCY);
          } catch (emergencyError: unknown) {
            logger.error(`🚨🚨🚨🚨 [${this.symbol}] CATASTROPHIC: Emergency exit ALSO failed!`, errMsg(emergencyError));
            notifyOrderError({ symbol: this.symbol, side: position.side, orderType: 'exit', error: 'CATASTROPHIC: All protection mechanisms failed. Manual closure required!', mode: 'live' });
          }
        }
        return false;
      }
      return false;
    }
  }

  async updateTrailingStopOnExchange(position: Position, newStopPrice: number): Promise<void> {
    if (this.mode === 'paper') return;
    if (!MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) return;

    if (position.trailingOrderId) {
      logger.debug(`📊 [${this.symbol}] Native trailing active, Binance managing stop`);
      return;
    }

    const oldSL = position.stopLoss;
    if (position.side === 'long' && newStopPrice <= (oldSL || 0)) return;
    if (position.side === 'short' && newStopPrice >= (oldSL || Infinity)) return;

    position.stopLoss = newStopPrice;
    await this.setStopLossOnExchange(position, true);
    logger.info(`📈 [${this.symbol}] Trailing stop moved: $${oldSL?.toFixed(4)} → $${newStopPrice.toFixed(4)}`);
  }

  // ── Profit-Protection Stop ───────────────────────────────────────────

  /**
   * Profit-protection stop (exchange-side) with ~2% buffer.
   * Starts only after +2% PnL, then ratchets in 1% steps:
   * - +2% → stop @ breakeven
   * - +3% → stop @ +1%
   * - +4% → stop @ +2%
   */
  async updateEmergencyStopProfitProtectionIfNeeded(
    position: Position,
    currentPrice: number,
    pnlPct: number,
  ): Promise<void> {
    if (this.mode !== 'live') return;
    if (!position.entryPrice) return;
    if (!position.stopLoss) return;

    const startAt = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_START_PCT ?? 2.0;
    const distance = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_DISTANCE_PCT ?? 2.0;
    const step = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_STEP_PCT ?? 1.0;

    if (pnlPct < startAt) return;

    const rawLock = pnlPct - distance;
    const lockedProfitPct = Math.max(0, Math.floor(rawLock / step) * step);

    const entry = position.entryPrice;
    const desiredStop = position.side === 'long'
      ? entry * (1 + lockedProfitPct / 100)
      : entry * (1 - lockedProfitPct / 100);

    // Safety: avoid placing an immediately-triggering stop
    if (position.side === 'long' && desiredStop >= currentPrice) return;
    if (position.side === 'short' && desiredStop <= currentPrice) return;

    // Only ratchet in the favorable direction
    const currentStop = position.stopLoss;
    const isImprovement = position.side === 'long'
      ? desiredStop > currentStop
      : desiredStop < currentStop;
    if (!isImprovement) return;

    // Apply + update on exchange
    position.stopLoss = desiredStop;
    position.emergencyStopPrice = desiredStop;
    await this.setStopLossOnExchange(position, true);

    logger.info(
      `🧷 [${this.symbol}] Profit-protection stop ratcheted: pnl=${pnlPct.toFixed(2)}% | locked=+${lockedProfitPct.toFixed(0)}% | stop=$${desiredStop.toFixed(4)} (≈${distance}% buffer)`
    );
  }

  // ── Proactive Exhaustion Stop Orders ──────────────────────────────────
  //
  // V5.110: Changed from LIMIT to STOP_MARKET.
  // A SELL LIMIT below market fills immediately (bug).
  // A STOP_MARKET sits dormant until mark price reaches the trailing stop.
  // Only placed when MomentumExhaustionCalculator confirms momentum is dying.

  async placeProactiveLimit(
    symbol: string, orderSide: 'buy' | 'sell', qty: number, price: number,
  ): Promise<string | null> {
    if (this.mode === 'paper') {
      const orderId = `paper_proactive_${Date.now()}`;
      logger.debug(`[${symbol}] PAPER proactive STOP_MARKET: ${orderSide} ${qty} @ stop=$${price.toFixed(4)}`);
      return orderId;
    }
    try {
      const formattedQty = this.formatQtyForExchange(symbol, qty);
      const order = await this.exchange.createOrder(
        symbol, 'market', orderSide, formattedQty, undefined,
        { stopLossPrice: price, reduceOnly: true, workingType: 'MARK_PRICE' },
      );
      ipWeightTracker.record(1, `proactiveStop:${symbol}`);
      this.proactiveLimitPlacedAt = Date.now();
      return order.id || null;
    } catch (e: unknown) {
      logger.warn(`[${symbol}] Failed to place proactive STOP_MARKET: ${errMsg(e)}`);
      return null;
    }
  }

  async cancelProactiveLimit(
    symbol: string,
    nfsStateMachine: { onLimitOrderCancelled: () => void } | null,
  ): Promise<void> {
    const orderId = this.proactiveLimitOrderId;
    if (!orderId) return;

    this.proactiveLimitOrderId = null;
    this.proactiveLimitPrice = null;
    this.proactiveLimitPlacedAt = 0;

    if (nfsStateMachine) {
      nfsStateMachine.onLimitOrderCancelled();
    }

    if (this.mode === 'paper') {
      logger.debug(`[${symbol}] PAPER proactive LIMIT cancelled: ${orderId}`);
      return;
    }

    try {
      if (this.exchange.cancelOrder) {
        await this.exchange.cancelOrder(orderId, symbol);
        ipWeightTracker.record(1, `cancelProactive:${symbol}`);
      }
      logger.info(`[${symbol}] Proactive LIMIT cancelled on exchange: ${orderId}`);
    } catch (e: unknown) {
      logger.debug(`[${symbol}] Proactive LIMIT cancel failed (may have filled): ${errMsg(e)}`);
    }
  }

  async checkProactiveLimitFill(
    symbol: string,
    position: Position | null,
    lastPrice: number,
  ): Promise<{ filled: boolean; avgPrice: number } | null> {
    const orderId = this.proactiveLimitOrderId;
    if (!orderId) return null;

    if (this.mode === 'paper') {
      if (this.proactiveLimitPrice && position) {
        const limitPrice = this.proactiveLimitPrice;
        const filled = position.side === 'long'
          ? lastPrice <= limitPrice
          : lastPrice >= limitPrice;
        if (filled) return { filled: true, avgPrice: limitPrice };
      }
      return null;
    }

    // Live mode: Use WebSocket ORDER_TRADE_UPDATE cache (0 weight) instead of fetchOrder (2w)
    if (this.userId) {
      const wsUpdate = getOrderTradeUpdateByIdFromWebSocket(this.userId, orderId);
      if (wsUpdate) {
        const status = wsUpdate.orderStatus?.toUpperCase();
        if (status === 'FILLED' || status === 'CANCELED' || status === 'EXPIRED') {
          const avgPrice = wsUpdate.averagePrice || wsUpdate.lastFilledPrice || this.proactiveLimitPrice || 0;
          if (status === 'FILLED') {
            return { filled: true, avgPrice };
          }
          // Canceled/expired - clear tracking
          this.proactiveLimitOrderId = null;
          this.proactiveLimitPrice = null;
          return null;
        }
      }

      // REST fallback: If WS hasn't reported after 10s, verify via REST (2w)
      // Protects against missed WS events during reconnects
      const elapsed = Date.now() - this.proactiveLimitPlacedAt;
      if (elapsed > 10_000 && this.exchange.fetchOrder) {
        try {
          const order = await this.exchange.fetchOrder(orderId, symbol);
          ipWeightTracker.record(2, `fetchOrder_fallback:${symbol}`);
          const status = order.status?.toLowerCase();
          if (status === 'closed' || status === 'filled') {
            const avgPrice = order.average || order.price || this.proactiveLimitPrice || 0;
            return { filled: true, avgPrice };
          }
          if (status === 'canceled' || status === 'expired') {
            this.proactiveLimitOrderId = null;
            this.proactiveLimitPrice = null;
            return null;
          }
          // Still open - reset timer so we don't spam REST every 2s
          this.proactiveLimitPlacedAt = Date.now();
        } catch (e: unknown) {
          logger.debug(`[${symbol}] REST fallback fetchOrder failed: ${errMsg(e)}`);
        }
      }

      return null;
    }

    // Fallback: fetchOrder REST call (only if userId not available - legacy path)
    try {
      if (this.exchange.fetchOrder) {
        const order = await this.exchange.fetchOrder(orderId, symbol);
        ipWeightTracker.record(2, `fetchOrder:${symbol}`);
        const status = order.status?.toLowerCase();
        if (status === 'closed' || status === 'filled') {
          const avgPrice = order.average || order.price || this.proactiveLimitPrice || 0;
          return { filled: true, avgPrice };
        }
      }
    } catch (e: unknown) {
      logger.debug(`[${symbol}] Failed to check proactive LIMIT status: ${errMsg(e)}`);
    }
    return null;
  }
}
