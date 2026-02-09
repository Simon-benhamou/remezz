/**
 * Per-User Order Queue System
 *
 * CRITICAL COMPONENT for multi-user scaling
 *
 * Architecture:
 *   OrderQueueManager (singleton)
 *   ├── UserOrderQueue (userId: "abc") → 3 slots, 200ms delay
 *   ├── UserOrderQueue (userId: "def") → 3 slots, 200ms delay
 *   └── GlobalRateLimiter → 1100 weight/min across ALL users (Binance limit)
 *
 * Key insight: Each user has their own API credentials and their own
 * Binance rate limits. By separating queues per user, User A's orders
 * don't block User B's orders. The GlobalRateLimiter prevents aggregate
 * IP-level bans if all users share the same server IP.
 *
 * Production features:
 * - Per-user priority queues (stop losses before entries)
 * - Per-user concurrency (3 concurrent orders per user)
 * - Global rate limiting (1100 orders/min across all users)
 * - Idempotency (duplicate order detection)
 * - Order timeout (30s max wait in queue)
 * - Retry logic with exponential backoff
 * - Circuit breaker integration
 * - Inactive queue cleanup (30 min TTL)
 * - Comprehensive monitoring
 */

import { ORDER_QUEUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { globalRestCircuitBreaker } from './globalRestCircuitBreaker.js';
import { getPriorityTier } from './orderPriority.js';
import type { OrderPriorityContext } from './orderPriority.js';
import { notifyOrderFailed } from '../utils/notifications.js';
import { validateOrderComplete, logValidationError } from './orderValidation.js';
import type { Exchange } from '../types/exchange.js';

const logger = createLogger('order-queue');

// ============================================================================
// Types
// ============================================================================

export type OrderRequest = {
  // Identification
  id: string;                    // Unique order ID (UUID)
  agentId: string;               // Agent/session ID
  userId: string;                // User ID

  // Priority
  priority: number;              // 0-100 (calculated from context)
  priorityContext: OrderPriorityContext; // Context used for priority calculation

  // Order details
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  price?: number;
  params?: Record<string, unknown>;

  // Order classification
  isEntry: boolean;              // true = opening position, false = closing
  reason: string;                // 'signal_entry' | 'stop_loss' | 'take_profit' etc.

  // Metadata
  submittedAt: number;           // Timestamp when submitted
  retries: number;               // Retry count
  timeoutMs: number;             // Max time to wait in queue (default 30s)
};

export type OrderResult = {
  success: boolean;
  order?: import('../types/exchange.js').CcxtOrder;  // Typed CCXT order
  error?: string;
  errorCode?: string;            // Error classification
  executedAt: number;            // When order was executed
  waitTimeMs: number;            // Time spent in queue
  retriesUsed: number;           // Number of retries used
};

type QueuedOrder = {
  request: OrderRequest;
  resolve: (result: OrderResult) => void;
  reject: (error: Error) => void;
  queuedAt: number;              // When added to queue
};

// ============================================================================
// Global Rate Limiter
// ============================================================================

/**
 * Tracks total order execution across ALL users to respect
 * Binance's IP-level rate limits.
 *
 * Binance futures order weight is 1 per order.
 * Limit: ~2400 weight/min per IP. We use 1100 as safe threshold.
 */
class GlobalRateLimiter {
  private readonly MAX_WEIGHT_PER_MINUTE: number;
  private readonly timestamps: number[] = []; // Ring buffer of execution timestamps

  constructor(maxWeightPerMinute = 1100) {
    this.MAX_WEIGHT_PER_MINUTE = maxWeightPerMinute;
  }

  /**
   * Check if we can execute another order globally.
   * Each order = weight 1.
   */
  canExecute(): boolean {
    this.cleanup();
    return this.timestamps.length < this.MAX_WEIGHT_PER_MINUTE;
  }

  /**
   * Record an order execution (call AFTER executing).
   */
  recordExecution(): void {
    this.timestamps.push(Date.now());
  }

  /**
   * Get current weight usage in the sliding window.
   */
  getCurrentWeight(): number {
    this.cleanup();
    return this.timestamps.length;
  }

  /**
   * Remove timestamps older than 1 minute.
   */
  private cleanup(): void {
    const cutoff = Date.now() - 60_000;
    // Remove from front (oldest first)
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
}

// ============================================================================
// User Order Queue (per-user)
// ============================================================================

/**
 * Isolated queue for a single user's orders.
 * Each user gets their own concurrency slots, delay timers, and stats.
 */
class UserOrderQueue {
  readonly userId: string;

  // Priority queue (sorted by priority, then FIFO)
  private queue: QueuedOrder[] = [];

  // Currently executing orders
  private executing = new Map<string, { orderId: string; startedAt: number }>();

  // Order results cache (for idempotency and monitoring)
  private results = new Map<string, OrderResult>();

  // Configuration (tuned for Binance Futures limits per user)
  private readonly MAX_CONCURRENT_ORDERS: number;
  private readonly ORDER_DELAY_MS: number;
  private readonly MAX_RETRIES: number;
  private readonly RESULT_CACHE_TTL_MS: number;
  private readonly MAX_QUEUE_SIZE: number;
  private readonly DEFAULT_TIMEOUT_MS: number;
  private readonly EXECUTION_TIMEOUT_MS = ORDER_QUEUE.EXECUTION_TIMEOUT_MS;

  // V5.65: Enhanced idempotency tracking to prevent double orders
  private readonly IDEMPOTENCY_CACHE_TTL_MS: number;
  private readonly orderIdHistory = new Set<string>();
  private orderIdHistoryCleanupAt = Date.now();

  // Stats
  private stats = {
    totalSubmitted: 0,
    totalExecuted: 0,
    totalFailed: 0,
    totalRetried: 0,
    totalRejected: 0,
    totalTimedOut: 0,
    avgWaitTimeMs: 0,
    avgExecutionTimeMs: 0,
    maxQueueSize: 0,
  };

  // Processing
  private processingIntervalId: NodeJS.Timeout | null = null;
  private lastOrderExecutedAt = 0;
  private isProcessing = false;

  // Health monitoring
  private lastHealthCheckAt = 0;
  private readonly HEALTH_CHECK_INTERVAL_MS = ORDER_QUEUE.HEALTH_CHECK_INTERVAL_MS;

  // Activity tracking for cleanup by manager
  private _lastActivityAt = Date.now();

  // Reference to global rate limiter
  private globalRateLimiter: GlobalRateLimiter;

  constructor(
    userId: string,
    globalRateLimiter: GlobalRateLimiter,
    config?: {
      maxConcurrentOrders?: number;
      orderDelayMs?: number;
      maxRetries?: number;
      resultCacheTTL?: number;
      maxQueueSize?: number;
      defaultTimeoutMs?: number;
    }
  ) {
    this.userId = userId;
    this.globalRateLimiter = globalRateLimiter;

    // Per-user config: 3 concurrent, 200ms delay (users don't share rate limits)
    this.MAX_CONCURRENT_ORDERS = config?.maxConcurrentOrders ?? ORDER_QUEUE.MAX_CONCURRENT;
    this.ORDER_DELAY_MS = config?.orderDelayMs ?? ORDER_QUEUE.DELAY_MS;
    this.MAX_RETRIES = config?.maxRetries ?? ORDER_QUEUE.MAX_RETRIES;
    this.RESULT_CACHE_TTL_MS = config?.resultCacheTTL ?? ORDER_QUEUE.RESULT_CACHE_TTL_MS;
    this.MAX_QUEUE_SIZE = config?.maxQueueSize ?? ORDER_QUEUE.MAX_QUEUE_SIZE;
    this.DEFAULT_TIMEOUT_MS = config?.defaultTimeoutMs ?? ORDER_QUEUE.DEFAULT_TIMEOUT_MS;
    this.IDEMPOTENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

    logger.info(`[UserQueue:${userId}] Initialized | concurrent=${this.MAX_CONCURRENT_ORDERS} delay=${this.ORDER_DELAY_MS}ms`);
  }

  get lastActivityAt(): number {
    return this._lastActivityAt;
  }

  /**
   * Returns true if this user queue is idle (no pending or executing orders).
   */
  isIdle(): boolean {
    return this.queue.length === 0 && this.executing.size === 0;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  start(): void {
    if (this.processingIntervalId) return;

    this.processingIntervalId = setInterval(() => {
      void this.processQueue();
    }, 100);

    logger.debug(`[UserQueue:${this.userId}] Started processing`);
  }

  stop(): void {
    if (this.processingIntervalId) {
      clearInterval(this.processingIntervalId);
      this.processingIntervalId = null;
    }

    logger.debug(`[UserQueue:${this.userId}] Stopped processing`);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  async submitOrder(request: OrderRequest): Promise<OrderResult> {
    this._lastActivityAt = Date.now();
    this.stats.totalSubmitted++;

    // 1. Check for duplicate order (idempotency) - V5.65: Enhanced with long-term tracking
    const cachedResult = this.results.get(request.id);
    if (cachedResult) {
      logger.debug(`[${request.id}] Returning cached result (idempotent request)`);
      return cachedResult;
    }

    // V5.65: Also check long-term order ID history (24h)
    if (this.orderIdHistory.has(request.id)) {
      logger.warn(`[${request.id}] DUPLICATE ORDER BLOCKED - ID already processed (from history)`);
      return {
        success: false,
        error: 'Duplicate order ID detected - order already processed',
        errorCode: 'DUPLICATE_ORDER',
        executedAt: Date.now(),
        waitTimeMs: 0,
        retriesUsed: 0,
      };
    }

    // 2. Check queue size limit (prevent memory exhaustion)
    if (this.queue.length >= this.MAX_QUEUE_SIZE) {
      this.stats.totalRejected++;

      logger.error(`[${request.id}] Queue FULL for user ${this.userId} (${this.queue.length}/${this.MAX_QUEUE_SIZE}) - REJECTING order`);

      throw new Error(`Order queue full for user ${this.userId} (${this.queue.length}/${this.MAX_QUEUE_SIZE}). System overloaded.`);
    }

    // 3. Create promise wrapper
    return new Promise<OrderResult>((resolve, reject) => {
      const queuedOrder: QueuedOrder = {
        request,
        resolve,
        reject,
        queuedAt: Date.now(),
      };

      // 4. Insert into queue (sorted by priority)
      this.insertInQueue(queuedOrder);

      if (this.queue.length > this.stats.maxQueueSize) {
        this.stats.maxQueueSize = this.queue.length;
      }

      const priorityTier = getPriorityTier(request.priority);

      logger.info(
        `[${request.id}] QUEUED | ` +
        `user=${this.userId} | ` +
        `${request.symbol} ${request.side} ${request.quantity} | ` +
        `priority=${request.priority} (${priorityTier}) | ` +
        `reason=${request.reason} | ` +
        `queueSize=${this.queue.length}/${this.MAX_QUEUE_SIZE}`
      );
    });
  }

  getStats() {
    return {
      queue: {
        size: this.queue.length,
        maxSize: this.MAX_QUEUE_SIZE,
        executing: this.executing.size,
        maxConcurrent: this.MAX_CONCURRENT_ORDERS,
      },
      performance: {
        avgWaitTimeMs: Math.round(this.stats.avgWaitTimeMs),
        avgExecutionTimeMs: Math.round(this.stats.avgExecutionTimeMs),
        orderDelayMs: this.ORDER_DELAY_MS,
      },
      counters: {
        totalSubmitted: this.stats.totalSubmitted,
        totalExecuted: this.stats.totalExecuted,
        totalFailed: this.stats.totalFailed,
        totalRetried: this.stats.totalRetried,
        totalRejected: this.stats.totalRejected,
        totalTimedOut: this.stats.totalTimedOut,
      },
      rates: {
        successRate: this.stats.totalSubmitted > 0
          ? Math.round((this.stats.totalExecuted / this.stats.totalSubmitted) * 100)
          : 0,
        failureRate: this.stats.totalSubmitted > 0
          ? Math.round((this.stats.totalFailed / this.stats.totalSubmitted) * 100)
          : 0,
      },
    };
  }

  getAgentOrders(agentId: string): OrderRequest[] {
    return this.queue
      .map(q => q.request)
      .filter(r => r.agentId === agentId);
  }

  getPriorityDistribution(): Record<string, number> {
    const dist = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      NORMAL: 0,
      LOW: 0,
    };

    for (const { request } of this.queue) {
      const tier = getPriorityTier(request.priority);
      dist[tier as keyof typeof dist]++;
    }

    return dist;
  }

  // ==========================================================================
  // Private Methods - Queue Processing
  // ==========================================================================

  private insertInQueue(order: QueuedOrder): void {
    let insertIndex = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      if (order.request.priority > this.queue[i].request.priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, order);
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Health check
      await this.healthCheck();

      // 2. Circuit breaker
      const isCircuitOpen = !globalRestCircuitBreaker.canMakeRequest();

      if (isCircuitOpen && this.queue.length > 0) {
        const hasExitOrders = this.queue.some(q => !q.request.isEntry);

        if (hasExitOrders) {
          if (!globalRestCircuitBreaker.canMakeCriticalRequest()) {
            logger.warn(`[UserQueue:${this.userId}] Circuit breaker OPEN - ${this.queue.length} orders waiting (exit orders blocked)`);
            return;
          }
          logger.info(`[UserQueue:${this.userId}] Circuit breaker OPEN but processing CRITICAL exit order`);
        } else {
          logger.warn(`[UserQueue:${this.userId}] Circuit breaker OPEN - ${this.queue.length} entry orders waiting`);
          return;
        }
      } else if (isCircuitOpen) {
        return;
      }

      // 3. Skip if queue is empty
      if (this.queue.length === 0) return;

      // 4. Skip if max concurrent orders reached (per-user limit)
      if (this.executing.size >= this.MAX_CONCURRENT_ORDERS) {
        return;
      }

      // 5. Enforce delay between orders (per-user rate limiting)
      const now = Date.now();
      const timeSinceLastOrder = now - this.lastOrderExecutedAt;

      if (timeSinceLastOrder < this.ORDER_DELAY_MS && this.lastOrderExecutedAt > 0) {
        return;
      }

      // 6. Check global rate limiter (cross-user IP protection)
      if (!this.globalRateLimiter.canExecute()) {
        logger.warn(`[UserQueue:${this.userId}] Global rate limit reached (${this.globalRateLimiter.getCurrentWeight()}/min) - throttling`);
        return;
      }

      // 7. Dequeue next order
      let queuedOrder: QueuedOrder | undefined;

      if (isCircuitOpen) {
        const exitIndex = this.queue.findIndex(q => !q.request.isEntry);
        if (exitIndex >= 0) {
          queuedOrder = this.queue.splice(exitIndex, 1)[0];
        }
      } else {
        queuedOrder = this.queue.shift();
      }

      if (!queuedOrder) return;

      // 8. Check if order timed out while in queue
      const queueWaitTime = Date.now() - queuedOrder.queuedAt;
      const timeout = queuedOrder.request.timeoutMs || this.DEFAULT_TIMEOUT_MS;

      if (queueWaitTime > timeout) {
        this.stats.totalTimedOut++;

        logger.error(
          `[${queuedOrder.request.id}] TIMEOUT in queue | ` +
          `user=${this.userId} | ` +
          `waited ${queueWaitTime}ms > ${timeout}ms timeout | ` +
          `reason=${queuedOrder.request.reason}`
        );

        const result: OrderResult = {
          success: false,
          error: `Order timed out in queue after ${queueWaitTime}ms`,
          errorCode: 'QUEUE_TIMEOUT',
          executedAt: Date.now(),
          waitTimeMs: queueWaitTime,
          retriesUsed: queuedOrder.request.retries,
        };

        this.results.set(queuedOrder.request.id, result);
        queuedOrder.resolve(result);
        return;
      }

      // 9. Record in global rate limiter BEFORE executing
      this.globalRateLimiter.recordExecution();

      // 10. Execute order (async, non-blocking)
      void this.executeOrder(queuedOrder);

    } finally {
      this.isProcessing = false;
    }
  }

  private async executeOrder(queuedOrder: QueuedOrder): Promise<void> {
    const { request, resolve } = queuedOrder;
    const { id, symbol, side, quantity, userId } = request;

    this._lastActivityAt = Date.now();

    // Mark as executing
    this.executing.set(id, {
      orderId: id,
      startedAt: Date.now(),
    });

    this.lastOrderExecutedAt = Date.now();

    const waitTimeMs = this.lastOrderExecutedAt - request.submittedAt;
    this.stats.avgWaitTimeMs = (this.stats.avgWaitTimeMs + waitTimeMs) / 2;

    const priorityTier = getPriorityTier(request.priority);

    logger.info(
      `[${id}] EXECUTING | ` +
      `user=${userId} | ` +
      `${symbol} ${side} ${quantity} | ` +
      `priority=${request.priority} (${priorityTier}) | ` +
      `waitTime=${waitTimeMs}ms | ` +
      `reason=${request.reason}`
    );

    const executionStartAt = Date.now();

    try {
      // Get exchange instance for this user
      const exchange = await this.getExchangeForUser(userId);

      // V5.65: Validate order before submission to exchange
      const validation = validateOrderComplete(
        {
          symbol,
          side,
          type: request.type,
          quantity,
          price: request.price,
        },
        exchange.markets,
        undefined
      );

      if (!validation.valid) {
        logValidationError(symbol, validation, `order-queue:${id}`);

        const result: OrderResult = {
          success: false,
          error: validation.error,
          errorCode: validation.errorCode,
          executedAt: Date.now(),
          waitTimeMs,
          retriesUsed: request.retries,
        };

        this.stats.totalFailed++;
        this.results.set(id, result);
        this.orderIdHistory.add(id);
        this.executing.delete(id);

        void notifyOrderFailed({
          id,
          symbol,
          side,
          quantity,
          error: validation.error || 'Validation failed',
          isEntry: request.isEntry,
        });

        resolve(result);
        return;
      }

      // Use adjusted quantity if step size correction was needed
      const validatedQty = validation.adjustedQty ?? quantity;
      if (validation.adjustedQty && validation.adjustedQty !== quantity) {
        logger.info(`[${id}] Quantity adjusted for step size: ${quantity} → ${validatedQty}`);
      }

      // Execute order with timeout to prevent hanging
      let order: import('../types/exchange.js').CcxtOrder | undefined;

      const executeWithTimeout = async <T>(operation: Promise<T>): Promise<T> => {
        return new Promise<T>((resolveOp, rejectOp) => {
          const timeoutId = setTimeout(() => {
            rejectOp(new Error(`Exchange API timeout after ${this.EXECUTION_TIMEOUT_MS}ms`));
          }, this.EXECUTION_TIMEOUT_MS);

          operation
            .then((result) => {
              clearTimeout(timeoutId);
              resolveOp(result);
            })
            .catch((err) => {
              clearTimeout(timeoutId);
              rejectOp(err);
            });
        });
      };

      if (request.type === 'market') {
        if (side === 'buy') {
          order = await executeWithTimeout(exchange.createMarketBuyOrder(symbol, validatedQty, request.params));
        } else {
          order = await executeWithTimeout(exchange.createMarketSellOrder(symbol, validatedQty, request.params));
        }
      } else {
        order = await executeWithTimeout(exchange.createOrder(
          symbol,
          request.type,
          side,
          validatedQty,
          request.price,
          request.params
        ));
      }

      const executionTimeMs = Date.now() - executionStartAt;
      this.stats.avgExecutionTimeMs = (this.stats.avgExecutionTimeMs + executionTimeMs) / 2;

      const result: OrderResult = {
        success: true,
        order,
        executedAt: Date.now(),
        waitTimeMs,
        retriesUsed: request.retries,
      };

      this.stats.totalExecuted++;
      this.results.set(id, result);
      this.orderIdHistory.add(id);

      logger.info(
        `[${id}] SUCCESS | ` +
        `user=${userId} | ` +
        `orderId=${order!.id} | ` +
        `filled=${order!.filled} | ` +
        `price=${order!.average || order!.price} | ` +
        `executionTime=${executionTimeMs}ms`
      );

      resolve(result);

    } catch (error: unknown) {
      const executionTimeMs = Date.now() - executionStartAt;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        `[${id}] FAILED | ` +
        `user=${userId} | ` +
        `error=${errorMessage} | ` +
        `executionTime=${executionTimeMs}ms`
      );

      const errorCode = this.classifyError(error);

      if (request.retries < this.MAX_RETRIES && this.isRetryableError(error)) {
        this.stats.totalRetried++;

        request.retries++;
        request.priority = Math.min(100, request.priority + 10);

        logger.warn(
          `[${id}] RETRYING (${request.retries}/${this.MAX_RETRIES}) | ` +
          `user=${userId} | newPriority=${request.priority}`
        );

        const newQueuedOrder: QueuedOrder = {
          ...queuedOrder,
          queuedAt: Date.now(),
        };

        this.insertInQueue(newQueuedOrder);

      } else {
        this.stats.totalFailed++;

        globalRestCircuitBreaker.recordFailure(request.agentId, symbol, errorMessage);

        const result: OrderResult = {
          success: false,
          error: errorMessage,
          errorCode,
          executedAt: Date.now(),
          waitTimeMs,
          retriesUsed: request.retries,
        };

        void notifyOrderFailed({
          id,
          symbol,
          side,
          quantity,
          error: errorMessage,
          retriesUsed: request.retries,
        });

        this.results.set(id, result);
        this.orderIdHistory.add(id);

        resolve(result);
      }

    } finally {
      this.executing.delete(id);
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private classifyError(error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    if (message.includes('418') || message.includes('429')) return 'RATE_LIMIT';
    if (message.includes('insufficient') || message.includes('balance')) return 'INSUFFICIENT_BALANCE';
    if (message.includes('invalid') || message.includes('symbol')) return 'INVALID_SYMBOL';
    if (message.includes('timeout') || message.includes('network')) return 'NETWORK_ERROR';
    if (message.includes('margin') || message.includes('leverage')) return 'MARGIN_ERROR';
    return 'UNKNOWN_ERROR';
  }

  private isRetryableError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    if (message.includes('timeout') || message.includes('network') || message.includes('econnreset')) return true;
    if (message.includes('-1001') || message.includes('disconnected') || message.includes('temporary')) return true;
    if (message.includes('418') || message.includes('429')) return false;
    if (message.includes('insufficient') || message.includes('invalid') || message.includes('margin')) return false;
    return false;
  }

  private async getExchangeForUser(userId: string): Promise<Exchange> {
    const { getUserExchange } = await import('../exchange/ccxtClient.js');
    const { getUserCredentials } = await import('./userCredentials.js');

    const credentials = await getUserCredentials(userId);

    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      throw new Error(`No API credentials found for user ${userId}. Please configure your Binance API keys.`);
    }

    return getUserExchange(userId, credentials);
  }

  private async healthCheck(): Promise<void> {
    const now = Date.now();

    if (now - this.lastHealthCheckAt < this.HEALTH_CHECK_INTERVAL_MS) {
      return;
    }

    this.lastHealthCheckAt = now;

    // 1. Clean up stale results cache
    let cleanedResults = 0;
    for (const [id, result] of this.results) {
      if (now - result.executedAt > this.RESULT_CACHE_TTL_MS) {
        this.results.delete(id);
        cleanedResults++;
      }
    }

    if (cleanedResults > 0) {
      logger.debug(`[UserQueue:${this.userId}:HealthCheck] Cleaned ${cleanedResults} stale results`);
    }

    // 2. Detect stuck executing orders
    let stuckOrders = 0;
    for (const [id, exec] of this.executing) {
      const executingTime = now - exec.startedAt;
      if (executingTime > 120_000) {
        logger.error(`[UserQueue:${this.userId}:HealthCheck] STUCK ORDER: ${id} (${executingTime}ms)`);
        this.executing.delete(id);
        stuckOrders++;
      }
    }

    if (stuckOrders > 0) {
      logger.error(`[UserQueue:${this.userId}:HealthCheck] Removed ${stuckOrders} stuck orders`);
    }

    // 3. Clean up order ID history (24h)
    if (now - this.orderIdHistoryCleanupAt > this.IDEMPOTENCY_CACHE_TTL_MS) {
      const historySize = this.orderIdHistory.size;
      if (historySize > 0) {
        this.orderIdHistory.clear();
        this.orderIdHistoryCleanupAt = now;
        logger.info(`[UserQueue:${this.userId}:HealthCheck] Cleared ${historySize} order IDs (24h cleanup)`);
      }
    }

    // 4. Log queue health (only when there's activity)
    if (this.queue.length > 0 || this.executing.size > 0) {
      logger.info(
        `[UserQueue:${this.userId}:HealthCheck] Queue: ${this.queue.length}/${this.MAX_QUEUE_SIZE} | ` +
        `Executing: ${this.executing.size}/${this.MAX_CONCURRENT_ORDERS} | ` +
        `Results: ${this.results.size} | History: ${this.orderIdHistory.size}`
      );
    }
  }
}

// ============================================================================
// Order Queue Manager (facade that manages per-user queues)
// ============================================================================

/**
 * OrderQueueManager manages per-user order queues.
 *
 * It exposes the same public API as the old OrderQueue class so that
 * callers (simpleAgent, positionOpener, server) can use it as a drop-in
 * replacement via the `orderQueue` export.
 */
export class OrderQueueManager {
  private userQueues = new Map<string, UserOrderQueue>();
  private globalRateLimiter = new GlobalRateLimiter(1100);
  private cleanupIntervalId: NodeJS.Timeout | null = null;
  private started = false;

  // Inactive queue TTL: 30 minutes
  private readonly INACTIVE_QUEUE_TTL_MS = 30 * 60 * 1000;
  // Cleanup check interval: every 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  constructor() {
    logger.info('[OrderQueueManager] Initialized (per-user queue architecture)');
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the manager and all existing user queues.
   */
  start(): void {
    if (this.started) {
      logger.warn('[OrderQueueManager] Already started');
      return;
    }

    this.started = true;

    // Start all existing user queues
    for (const uq of this.userQueues.values()) {
      uq.start();
    }

    // Start inactive queue cleanup timer
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupInactiveQueues();
    }, this.CLEANUP_INTERVAL_MS);

    logger.info('[OrderQueueManager] Started (cleanup interval: 5min)');
  }

  /**
   * Stop the manager and all user queues.
   */
  stop(): void {
    this.started = false;

    // Stop all user queues
    for (const uq of this.userQueues.values()) {
      uq.stop();
    }

    // Stop cleanup timer
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    logger.info('[OrderQueueManager] Stopped all user queues');
  }

  // ==========================================================================
  // Public API (backward-compatible with old OrderQueue)
  // ==========================================================================

  /**
   * Submit an order to the appropriate user's queue.
   * This is the main entry point - same signature as the old OrderQueue.submitOrder().
   */
  async submitOrder(request: OrderRequest): Promise<OrderResult> {
    const userQueue = this.getOrCreateUserQueue(request.userId);
    return userQueue.submitOrder(request);
  }

  /**
   * Get aggregated stats across all user queues.
   * Matches the old OrderQueue.getStats() return shape.
   */
  getStats() {
    let totalQueueSize = 0;
    let totalExecuting = 0;
    let totalSubmitted = 0;
    let totalExecuted = 0;
    let totalFailed = 0;
    let totalRetried = 0;
    let totalRejected = 0;
    let totalTimedOut = 0;
    let avgWaitTimeMs = 0;
    let avgExecutionTimeMs = 0;
    let maxQueueSize = 0;
    let queueCount = 0;

    for (const uq of this.userQueues.values()) {
      const s = uq.getStats();
      totalQueueSize += s.queue.size;
      totalExecuting += s.queue.executing;
      totalSubmitted += s.counters.totalSubmitted;
      totalExecuted += s.counters.totalExecuted;
      totalFailed += s.counters.totalFailed;
      totalRetried += s.counters.totalRetried;
      totalRejected += s.counters.totalRejected;
      totalTimedOut += s.counters.totalTimedOut;
      avgWaitTimeMs += s.performance.avgWaitTimeMs;
      avgExecutionTimeMs += s.performance.avgExecutionTimeMs;
      if (s.queue.size > maxQueueSize) maxQueueSize = s.queue.size;
      queueCount++;
    }

    // Average the averages (approximate)
    if (queueCount > 0) {
      avgWaitTimeMs = Math.round(avgWaitTimeMs / queueCount);
      avgExecutionTimeMs = Math.round(avgExecutionTimeMs / queueCount);
    }

    return {
      queue: {
        size: totalQueueSize,
        maxSize: ORDER_QUEUE.MAX_QUEUE_SIZE,
        executing: totalExecuting,
        maxConcurrent: ORDER_QUEUE.MAX_CONCURRENT,
      },
      performance: {
        avgWaitTimeMs,
        avgExecutionTimeMs,
        orderDelayMs: ORDER_QUEUE.DELAY_MS,
      },
      counters: {
        totalSubmitted,
        totalExecuted,
        totalFailed,
        totalRetried,
        totalRejected,
        totalTimedOut,
      },
      rates: {
        successRate: totalSubmitted > 0
          ? Math.round((totalExecuted / totalSubmitted) * 100)
          : 0,
        failureRate: totalSubmitted > 0
          ? Math.round((totalFailed / totalSubmitted) * 100)
          : 0,
      },
      // NEW: multi-user specific stats
      users: {
        activeQueues: this.userQueues.size,
        globalRateLimit: {
          currentWeight: this.globalRateLimiter.getCurrentWeight(),
          maxWeightPerMinute: 1100,
        },
      },
    };
  }

  /**
   * Get pending orders for a specific agent (searches all user queues).
   */
  getAgentOrders(agentId: string): OrderRequest[] {
    const orders: OrderRequest[] = [];
    for (const uq of this.userQueues.values()) {
      orders.push(...uq.getAgentOrders(agentId));
    }
    return orders;
  }

  /**
   * Get priority distribution across all user queues.
   */
  getPriorityDistribution(): Record<string, number> {
    const dist = {
      CRITICAL: 0,
      HIGH: 0,
      MEDIUM: 0,
      NORMAL: 0,
      LOW: 0,
    };

    for (const uq of this.userQueues.values()) {
      const userDist = uq.getPriorityDistribution();
      for (const key of Object.keys(dist) as Array<keyof typeof dist>) {
        dist[key] += userDist[key] ?? 0;
      }
    }

    return dist;
  }

  /**
   * Get stats for a specific user's queue.
   */
  getUserStats(userId: string) {
    const uq = this.userQueues.get(userId);
    if (!uq) return null;
    return {
      userId,
      ...uq.getStats(),
    };
  }

  /**
   * Get per-user breakdown (for monitoring dashboard).
   */
  getPerUserStats() {
    const result: Array<{ userId: string; stats: ReturnType<UserOrderQueue['getStats']> }> = [];
    for (const [userId, uq] of this.userQueues) {
      result.push({ userId, stats: uq.getStats() });
    }
    return result;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get or create a UserOrderQueue for the given userId.
   * Lazily creates queues on first order submission.
   */
  private getOrCreateUserQueue(userId: string): UserOrderQueue {
    let uq = this.userQueues.get(userId);

    if (!uq) {
      uq = new UserOrderQueue(userId, this.globalRateLimiter, {
        maxConcurrentOrders: ORDER_QUEUE.MAX_CONCURRENT,
        orderDelayMs: ORDER_QUEUE.DELAY_MS,
        maxRetries: ORDER_QUEUE.MAX_RETRIES,
        resultCacheTTL: ORDER_QUEUE.RESULT_CACHE_TTL_MS,
        maxQueueSize: ORDER_QUEUE.MAX_QUEUE_SIZE,
        defaultTimeoutMs: ORDER_QUEUE.DEFAULT_TIMEOUT_MS,
      });

      this.userQueues.set(userId, uq);

      // Auto-start if manager is running
      if (this.started) {
        uq.start();
      }

      logger.info(`[OrderQueueManager] Created queue for user ${userId} | total queues: ${this.userQueues.size}`);
    }

    return uq;
  }

  /**
   * Clean up user queues that have been idle for > 30 minutes.
   * Prevents memory leak from users who logged out or stopped trading.
   */
  private cleanupInactiveQueues(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [userId, uq] of this.userQueues) {
      const idleTime = now - uq.lastActivityAt;

      if (idleTime > this.INACTIVE_QUEUE_TTL_MS && uq.isIdle()) {
        uq.stop();
        this.userQueues.delete(userId);
        cleaned++;
        logger.info(`[OrderQueueManager] Cleaned up inactive queue for user ${userId} (idle ${Math.round(idleTime / 60_000)}min)`);
      }
    }

    if (cleaned > 0) {
      logger.info(`[OrderQueueManager] Cleaned ${cleaned} inactive queues | remaining: ${this.userQueues.size}`);
    }
  }
}

// ============================================================================
// Backward-compatible OrderQueue class (delegates to OrderQueueManager)
// ============================================================================

/**
 * DEPRECATED: Use OrderQueueManager directly for new code.
 *
 * This class wraps OrderQueueManager to maintain backward compatibility.
 * The original OrderQueue class is no longer used directly, but callers
 * that import `orderQueue` (the singleton) continue to work seamlessly
 * because OrderQueueManager exposes the same public API.
 */
export class OrderQueue extends OrderQueueManager {}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global order queue manager instance.
 * Used by all agents to submit orders.
 *
 * Backward compatible: same API surface as the old single OrderQueue.
 * Internally routes orders to per-user queues for parallel processing.
 */
export const orderQueue = new OrderQueueManager();

// Auto-start on import
orderQueue.start();

logger.info('[OrderQueue] Global per-user order queue manager created and started');
