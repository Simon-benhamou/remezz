/**
 * NFS Order Executor
 * ==================
 *
 * Unified order execution layer for NFS exits.
 * Same interface for paper and live - only execution differs.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('nfs-executor');
import type { NfsConfig, TrailingExitLog, NfsResult, NfsExitState } from './nfsRealtimeExit.js';
import { DEFAULT_NFS_CONFIG } from './nfsRealtimeExit.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ExecutionMode = 'paper' | 'live';

export interface OrderExecutorConfig {
  mode: ExecutionMode;
  nfsConfig: NfsConfig;
  symbol: string;
  // Callbacks for live mode
  onPlaceLimitOrder?: (symbol: string, side: 'buy' | 'sell', qty: number, price: number) => Promise<LimitOrderResult>;
  onPlaceMarketOrder?: (symbol: string, side: 'buy' | 'sell', qty: number) => Promise<MarketOrderResult>;
  onCancelOrder?: (orderId: string) => Promise<boolean>;
  onCheckOrderStatus?: (orderId: string) => Promise<OrderStatus>;
}

export interface LimitOrderResult {
  success: boolean;
  orderId?: string;
  filledQty?: number;
  avgPrice?: number;
  error?: string;
}

export interface MarketOrderResult {
  success: boolean;
  orderId?: string;
  filledQty: number;
  avgPrice: number;
  fee?: number;
  error?: string;
}

export interface OrderStatus {
  status: 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  filledQty: number;
  remainingQty: number;
  avgPrice: number;
}

export interface NfsExitResult {
  success: boolean;
  exitPrice: number;
  exitMethod: 'LIMIT_FILLED' | 'LIMIT_PARTIAL' | 'MARKET_FALLBACK' | 'MARKET_DIRECT' | '2CLOSE_FALLBACK';
  slippagePct: number;
  slippageUsd: number;
  filledQty: number;
  fee: number;
  timeTakenMs: number;
  orderAttempts: number;
  nfsScore?: number;
  log: TrailingExitLog;
}

// ═══════════════════════════════════════════════════════════════════════════
// NFS ORDER EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════

export class NfsOrderExecutor {
  private config: OrderExecutorConfig;
  private pendingLimitOrderId: string | null = null;
  private limitOrderPlacedAt: number | null = null;
  private monitorInterval: NodeJS.Timeout | null = null;

  constructor(config: OrderExecutorConfig) {
    this.config = {
      ...config,
      nfsConfig: { ...DEFAULT_NFS_CONFIG, ...config.nfsConfig },
    };
  }

  /**
   * Execute exit via LIMIT order with automatic fallback
   */
  async executeLimitWithFallback(
    side: 'long' | 'short',
    qty: number,
    trailingStopPrice: number,
    entryPrice: number,
    nfsResult: NfsResult,
    tradeId: string
  ): Promise<NfsExitResult> {
    const startTime = Date.now();
    const orderSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';
    let orderAttempts = 0;

    try {
      // Step 1: Place LIMIT order
      orderAttempts++;
      const limitResult = await this.placeLimitOrder(orderSide, qty, trailingStopPrice);

      if (!limitResult.success) {
        // LIMIT rejected - immediate market fallback
        logger.warn(`[NFS] LIMIT rejected: ${limitResult.error} - market fallback`);
        return await this.executeMarketFallback(
          side,
          orderSide,
          qty,
          trailingStopPrice,
          entryPrice,
          nfsResult,
          tradeId,
          startTime,
          orderAttempts + 1,
          'MARKET_FALLBACK'
        );
      }

      this.pendingLimitOrderId = limitResult.orderId!;
      this.limitOrderPlacedAt = Date.now();

      // Step 2: Monitor LIMIT order with timeout
      const fillResult = await this.monitorLimitOrder(
        limitResult.orderId!,
        qty,
        this.config.nfsConfig.LIMIT_ORDER_TIMEOUT_MS
      );

      if (fillResult.status === 'FILLED') {
        // Perfect - LIMIT filled completely
        return this.createExitResult(
          fillResult.avgPrice,
          trailingStopPrice,
          entryPrice,
          fillResult.filledQty,
          0, // fee handled by exchange
          startTime,
          orderAttempts,
          'LIMIT_FILLED',
          nfsResult,
          tradeId,
          side
        );
      }

      if (fillResult.status === 'PARTIALLY_FILLED') {
        // Partial fill - decide based on fill ratio
        const fillRatio = fillResult.filledQty / qty;

        if (fillRatio >= this.config.nfsConfig.PARTIAL_FILL_MIN_RATIO) {
          // Accept partial - cancel remaining
          await this.cancelOrder(limitResult.orderId!);
          return this.createExitResult(
            fillResult.avgPrice,
            trailingStopPrice,
            entryPrice,
            fillResult.filledQty,
            0,
            startTime,
            orderAttempts,
            'LIMIT_PARTIAL',
            nfsResult,
            tradeId,
            side
          );
        }

        // Partial too small - cancel and market for rest
        await this.cancelOrder(limitResult.orderId!);
        const remainingQty = qty - fillResult.filledQty;

        orderAttempts++;
        const marketResult = await this.placeMarketOrder(orderSide, remainingQty);

        // Calculate weighted average price
        const totalQty = fillResult.filledQty + marketResult.filledQty;
        const weightedAvgPrice = (
          fillResult.filledQty * fillResult.avgPrice +
          marketResult.filledQty * marketResult.avgPrice
        ) / totalQty;

        return this.createExitResult(
          weightedAvgPrice,
          trailingStopPrice,
          entryPrice,
          totalQty,
          marketResult.fee ?? 0,
          startTime,
          orderAttempts,
          'LIMIT_PARTIAL',
          nfsResult,
          tradeId,
          side
        );
      }

      // Timeout or cancelled - market fallback
      await this.cancelOrder(limitResult.orderId!);
      return await this.executeMarketFallback(
        side,
        orderSide,
        qty,
        trailingStopPrice,
        entryPrice,
        nfsResult,
        tradeId,
        startTime,
        orderAttempts + 1,
        'MARKET_FALLBACK'
      );

    } catch (error: any) {
      logger.error(`[NFS] Execution error: ${error.message}`);

      // Emergency market fallback
      try {
        return await this.executeMarketFallback(
          side,
          orderSide,
          qty,
          trailingStopPrice,
          entryPrice,
          nfsResult,
          tradeId,
          startTime,
          orderAttempts + 1,
          'MARKET_FALLBACK'
        );
      } catch (fallbackError: any) {
        logger.error(`[NFS] Market fallback also failed: ${fallbackError.message}`);
        throw fallbackError;
      }
    }
  }

  /**
   * Execute immediate market order (for HIGH NFS or 2-close fallback)
   */
  async executeMarketImmediate(
    side: 'long' | 'short',
    qty: number,
    trailingStopPrice: number,
    entryPrice: number,
    nfsResult: NfsResult | null,
    tradeId: string,
    exitMethod: '2CLOSE_FALLBACK' | 'MARKET_DIRECT'
  ): Promise<NfsExitResult> {
    const startTime = Date.now();
    const orderSide: 'buy' | 'sell' = side === 'long' ? 'sell' : 'buy';

    const marketResult = await this.placeMarketOrder(orderSide, qty);

    if (!marketResult.success) {
      throw new Error(`Market order failed: ${marketResult.error}`);
    }

    return this.createExitResult(
      marketResult.avgPrice,
      trailingStopPrice,
      entryPrice,
      marketResult.filledQty,
      marketResult.fee ?? 0,
      startTime,
      1,
      exitMethod,
      nfsResult,
      tradeId,
      side
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PRIVATE METHODS
  // ─────────────────────────────────────────────────────────────────────────

  private async executeMarketFallback(
    side: 'long' | 'short',
    orderSide: 'buy' | 'sell',
    qty: number,
    trailingStopPrice: number,
    entryPrice: number,
    nfsResult: NfsResult,
    tradeId: string,
    startTime: number,
    orderAttempts: number,
    exitMethod: 'MARKET_FALLBACK' | 'MARKET_DIRECT'
  ): Promise<NfsExitResult> {
    const marketResult = await this.placeMarketOrder(orderSide, qty);

    if (!marketResult.success) {
      throw new Error(`Market fallback failed: ${marketResult.error}`);
    }

    return this.createExitResult(
      marketResult.avgPrice,
      trailingStopPrice,
      entryPrice,
      marketResult.filledQty,
      marketResult.fee ?? 0,
      startTime,
      orderAttempts,
      exitMethod,
      nfsResult,
      tradeId,
      side
    );
  }

  private async placeLimitOrder(
    side: 'buy' | 'sell',
    qty: number,
    price: number
  ): Promise<LimitOrderResult> {
    if (this.config.mode === 'paper') {
      // Paper mode: simulate LIMIT order
      // In paper, we assume LIMIT always fills at the limit price
      // This is optimistic but matches backtest behavior
      return {
        success: true,
        orderId: `paper_limit_${Date.now()}`,
        filledQty: qty,
        avgPrice: price,
      };
    }

    // Live mode: use callback
    if (!this.config.onPlaceLimitOrder) {
      throw new Error('onPlaceLimitOrder callback not provided for live mode');
    }

    return await this.config.onPlaceLimitOrder(this.config.symbol, side, qty, price);
  }

  private async placeMarketOrder(
    side: 'buy' | 'sell',
    qty: number
  ): Promise<MarketOrderResult> {
    if (this.config.mode === 'paper') {
      // Paper mode: simulate market order with small slippage
      // We don't have real price here, so this will be set by caller
      return {
        success: true,
        orderId: `paper_market_${Date.now()}`,
        filledQty: qty,
        avgPrice: 0, // Will be set by caller using current price
        fee: 0,
      };
    }

    // Live mode: use callback
    if (!this.config.onPlaceMarketOrder) {
      throw new Error('onPlaceMarketOrder callback not provided for live mode');
    }

    return await this.config.onPlaceMarketOrder(this.config.symbol, side, qty);
  }

  private async cancelOrder(orderId: string): Promise<boolean> {
    this.pendingLimitOrderId = null;
    this.limitOrderPlacedAt = null;

    if (this.config.mode === 'paper') {
      return true;
    }

    if (!this.config.onCancelOrder) {
      logger.warn('[NFS] onCancelOrder callback not provided');
      return false;
    }

    return await this.config.onCancelOrder(orderId);
  }

  private async monitorLimitOrder(
    orderId: string,
    totalQty: number,
    timeoutMs: number
  ): Promise<OrderStatus> {
    if (this.config.mode === 'paper') {
      // Paper mode: instant fill at limit price
      return {
        status: 'FILLED',
        filledQty: totalQty,
        remainingQty: 0,
        avgPrice: 0, // Set by caller
      };
    }

    // Live mode: poll order status
    const startTime = Date.now();
    const pollIntervalMs = 1000;

    while (Date.now() - startTime < timeoutMs) {
      if (!this.config.onCheckOrderStatus) {
        throw new Error('onCheckOrderStatus callback not provided');
      }

      const status = await this.config.onCheckOrderStatus(orderId);

      if (status.status === 'FILLED') {
        return status;
      }

      if (status.status === 'CANCELLED' || status.status === 'REJECTED' || status.status === 'EXPIRED') {
        return status;
      }

      if (status.status === 'PARTIALLY_FILLED' && status.filledQty > 0) {
        // Check if we should wait more or accept partial
        const elapsedRatio = (Date.now() - startTime) / timeoutMs;
        if (elapsedRatio > 0.7) {
          // More than 70% of timeout elapsed - return partial
          return status;
        }
      }

      await this.sleep(pollIntervalMs);
    }

    // Timeout reached
    if (this.config.onCheckOrderStatus) {
      const finalStatus = await this.config.onCheckOrderStatus(orderId);
      return finalStatus;
    }

    return {
      status: 'PENDING',
      filledQty: 0,
      remainingQty: totalQty,
      avgPrice: 0,
    };
  }

  private createExitResult(
    exitPrice: number,
    trailingStopPrice: number,
    entryPrice: number,
    filledQty: number,
    fee: number,
    startTime: number,
    orderAttempts: number,
    exitMethod: NfsExitResult['exitMethod'],
    nfsResult: NfsResult | null,
    tradeId: string,
    side: 'long' | 'short'
  ): NfsExitResult {
    const slippagePct = trailingStopPrice > 0
      ? Math.abs((exitPrice - trailingStopPrice) / trailingStopPrice) * 100
      : 0;

    const pnlPct = side === 'long'
      ? ((exitPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - exitPrice) / entryPrice) * 100;

    const notionalUsd = filledQty * exitPrice;
    const slippageUsd = (slippagePct / 100) * notionalUsd;

    const log: TrailingExitLog = {
      tradeId,
      symbol: this.config.symbol,
      side,
      timestamp: Date.now(),
      trailingStopPrice,
      actualExitPrice: exitPrice,
      slippagePct,
      slippageUsd,
      nfsScore: nfsResult?.score ?? 0,
      nfsConfidence: nfsResult?.confidence ?? 'LOW',
      nfsComponents: nfsResult?.components ?? {
        breachATRRatio: 0,
        breachDepthPct: 0,
        volumeRatio: 0,
        candleBodyRatio: 0,
        momentumROC5: 0,
        rawScores: { breachATR: 0, breachDepth: 0, volume: 0, candleBody: 0, momentum: 0 },
      },
      exitMethod,
      orderAttempts,
      timeTakenMs: Date.now() - startTime,
      wasWsConnected: true, // Will be set by caller
      state: 'EXITED',
    };

    // Check max slippage alert
    if (slippagePct > this.config.nfsConfig.MAX_SLIPPAGE_PCT) {
      logger.warn(`[NFS] HIGH SLIPPAGE: ${slippagePct.toFixed(2)}% > ${this.config.nfsConfig.MAX_SLIPPAGE_PCT}%`);
    }

    return {
      success: true,
      exitPrice,
      exitMethod,
      slippagePct,
      slippageUsd,
      filledQty,
      fee,
      timeTakenMs: Date.now() - startTime,
      orderAttempts,
      nfsScore: nfsResult?.score,
      log,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CLEANUP
  // ─────────────────────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    if (this.pendingLimitOrderId) {
      try {
        await this.cancelOrder(this.pendingLimitOrderId);
      } catch (e) {
        logger.warn(`[NFS] Failed to cancel pending order on cleanup: ${e}`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════════════════

export function createNfsOrderExecutor(config: OrderExecutorConfig): NfsOrderExecutor {
  return new NfsOrderExecutor(config);
}
