/**
 * Global Order Queue System
 *
 * CRITICAL COMPONENT for 1000+ concurrent agents
 *
 * Problem: Without queue, 100 agents receiving simultaneous exit signal
 * = 100 API calls in <1 second = INSTANT IP BAN (418 error)
 *
 * Solution: Priority queue with rate limiting
 * - Orders queued and executed sequentially
 * - 350ms delay between orders (safe for Binance: 40 orders/sec limit)
 * - Priority-based execution (stop losses before entries)
 * - Max 3 concurrent orders (prevents bursts)
 * - Retry logic with exponential backoff
 * - Circuit breaker integration
 * - Comprehensive monitoring
 *
 * Performance: 100 simultaneous exits = 35 seconds total (vs instant ban)
 *
 * Production features:
 * - Idempotency (duplicate order detection)
 * - Order timeout (30s max wait in queue)
 * - Graceful degradation (queue overflow protection)
 * - Memory leak prevention (result cache cleanup)
 * - Observability (detailed stats and logging)
 */

import { v4 as uuidv4 } from 'uuid';
import { ORDER_QUEUE } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { globalRestCircuitBreaker } from './globalRestCircuitBreaker.js';
import { calculateOrderPriority, getPriorityTier } from './orderPriority.js';
import type { OrderPriorityContext } from './orderPriority.js';
import { notifyOrderFailed } from '../utils/notifications.js';
import { validateOrderComplete, adjustQtyToStepSize, getSymbolLimits, logValidationError } from './orderValidation.js';

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
// Order Queue Class
// ============================================================================

export class OrderQueue {
  // Priority queue (sorted by priority, then FIFO)
  private queue: QueuedOrder[] = [];

  // Currently executing orders
  private executing = new Map<string, { orderId: string; startedAt: number }>();

  // Order results cache (for idempotency and monitoring)
  private results = new Map<string, OrderResult>();

  // Configuration (tuned for Binance Futures limits)
  private readonly MAX_CONCURRENT_ORDERS: number;      // Max parallel orders
  private readonly ORDER_DELAY_MS: number;             // Min delay between orders
  private readonly MAX_RETRIES: number;                // Max retry attempts
  private readonly RESULT_CACHE_TTL_MS: number;        // Result cache lifetime
  private readonly MAX_QUEUE_SIZE: number;             // Max orders in queue
  private readonly DEFAULT_TIMEOUT_MS: number;         // Max wait time per order
  private readonly EXECUTION_TIMEOUT_MS = ORDER_QUEUE.EXECUTION_TIMEOUT_MS;

  // V5.65: Enhanced idempotency tracking to prevent double orders
  // Tracks order IDs for 24 hours to handle any edge cases
  private readonly IDEMPOTENCY_CACHE_TTL_MS: number;   // 24 hours
  private readonly orderIdHistory = new Set<string>(); // Long-term order ID tracking
  private orderIdHistoryCleanupAt = Date.now();        // Last cleanup timestamp

  // Stats
  private stats = {
    totalSubmitted: 0,
    totalExecuted: 0,
    totalFailed: 0,
    totalRetried: 0,
    totalRejected: 0,            // Rejected due to queue full
    totalTimedOut: 0,            // Timed out waiting in queue
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

  constructor(config?: {
    maxConcurrentOrders?: number;
    orderDelayMs?: number;
    maxRetries?: number;
    resultCacheTTL?: number;
    maxQueueSize?: number;
    defaultTimeoutMs?: number;
  }) {
    // Configuration (with safe defaults for 1000+ agents)
    this.MAX_CONCURRENT_ORDERS = config?.maxConcurrentOrders ?? ORDER_QUEUE.MAX_CONCURRENT;
    this.ORDER_DELAY_MS = config?.orderDelayMs ?? ORDER_QUEUE.DELAY_MS;
    this.MAX_RETRIES = config?.maxRetries ?? ORDER_QUEUE.MAX_RETRIES;
    this.RESULT_CACHE_TTL_MS = config?.resultCacheTTL ?? ORDER_QUEUE.RESULT_CACHE_TTL_MS;
    this.MAX_QUEUE_SIZE = config?.maxQueueSize ?? ORDER_QUEUE.MAX_QUEUE_SIZE;
    this.DEFAULT_TIMEOUT_MS = config?.defaultTimeoutMs ?? ORDER_QUEUE.DEFAULT_TIMEOUT_MS;
    this.IDEMPOTENCY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;              // V5.65: 24 hours for order ID history

    logger.info('[OrderQueue] Initialized with config:', {
      maxConcurrent: this.MAX_CONCURRENT_ORDERS,
      orderDelayMs: this.ORDER_DELAY_MS,
      maxRetries: this.MAX_RETRIES,
      maxQueueSize: this.MAX_QUEUE_SIZE,
    });
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start processing the order queue
   */
  start(): void {
    if (this.processingIntervalId) {
      logger.warn('[OrderQueue] Already started');
      return;
    }

    // Process queue every 100ms (fast polling)
    this.processingIntervalId = setInterval(() => {
      void this.processQueue();
    }, 100);

    logger.info('[OrderQueue] Started processing (poll interval: 100ms)');
  }

  /**
   * Stop processing the order queue
   */
  stop(): void {
    if (this.processingIntervalId) {
      clearInterval(this.processingIntervalId);
      this.processingIntervalId = null;
    }

    logger.info('[OrderQueue] Stopped processing');
  }

  /**
   * Submit an order to the queue
   * Returns a promise that resolves when the order is executed
   *
   * @throws Error if queue is full
   */
  async submitOrder(request: OrderRequest): Promise<OrderResult> {
    this.stats.totalSubmitted++;

    // 1. Check for duplicate order (idempotency) - V5.65: Enhanced with long-term tracking
    const cachedResult = this.results.get(request.id);
    if (cachedResult) {
      logger.debug(`[${request.id}] Returning cached result (idempotent request)`);
      return cachedResult;
    }

    // V5.65: Also check long-term order ID history (24h)
    // This prevents double orders even if result cache was cleaned up
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

      logger.error(`[${request.id}] Queue FULL (${this.queue.length}/${this.MAX_QUEUE_SIZE}) - REJECTING order`);

      throw new Error(`Order queue full (${this.queue.length}/${this.MAX_QUEUE_SIZE}). System overloaded.`);
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

      // Track max queue size
      if (this.queue.length > this.stats.maxQueueSize) {
        this.stats.maxQueueSize = this.queue.length;
      }

      const priorityTier = getPriorityTier(request.priority);

      logger.info(
        `[${request.id}] QUEUED | ` +
        `${request.symbol} ${request.side} ${request.quantity} | ` +
        `priority=${request.priority} (${priorityTier}) | ` +
        `reason=${request.reason} | ` +
        `queueSize=${this.queue.length}/${this.MAX_QUEUE_SIZE}`
      );

      // V5.79: Order submitted notification removed from Telegram (noise reduction)
    });
  }

  /**
   * Get queue stats
   */
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

  /**
   * Get pending orders for a specific agent (for debugging)
   */
  getAgentOrders(agentId: string): OrderRequest[] {
    return this.queue
      .map(q => q.request)
      .filter(r => r.agentId === agentId);
  }

  /**
   * Get priority distribution (for monitoring)
   */
  getPriorityDistribution(): Record<string, number> {
    const dist = {
      CRITICAL: 0,  // 90-100
      HIGH: 0,      // 70-89
      MEDIUM: 0,    // 50-69
      NORMAL: 0,    // 20-49
      LOW: 0,       // 0-19
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

  /**
   * Insert order into queue (sorted by priority DESC, then FIFO)
   */
  private insertInQueue(order: QueuedOrder): void {
    // Find insertion point (higher priority first)
    let insertIndex = this.queue.length;

    for (let i = 0; i < this.queue.length; i++) {
      if (order.request.priority > this.queue[i].request.priority) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, order);
  }

  /**
   * Process the queue (called every 100ms)
   */
  private async processQueue(): Promise<void> {
    // Prevent concurrent processing
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // 1. Health check (cleanup timeouts, stale results)
      await this.healthCheck();

      // 2. Check circuit breaker status
      // V5.65: Allow critical orders (exits) even when circuit is open
      const isCircuitOpen = !globalRestCircuitBreaker.canMakeRequest();

      if (isCircuitOpen && this.queue.length > 0) {
        // Check if we have any exit orders (critical)
        const hasExitOrders = this.queue.some(q => !q.request.isEntry);

        if (hasExitOrders) {
          // Check if we can make a critical request
          if (!globalRestCircuitBreaker.canMakeCriticalRequest()) {
            logger.warn(`[OrderQueue] Circuit breaker OPEN - ${this.queue.length} orders waiting (exit orders blocked by rate limit)`);
            return;
          }
          // Critical request allowed - continue processing but only process exits
          logger.info(`[OrderQueue] Circuit breaker OPEN but processing CRITICAL exit order`);
        } else {
          // No exit orders - skip entirely
          logger.warn(`[OrderQueue] Circuit breaker OPEN - ${this.queue.length} entry orders waiting`);
          return;
        }
      } else if (isCircuitOpen) {
        return; // Empty queue + circuit open = nothing to do
      }

      // 3. Skip if queue is empty
      if (this.queue.length === 0) return;

      // 4. Skip if max concurrent orders reached
      if (this.executing.size >= this.MAX_CONCURRENT_ORDERS) {
        return;
      }

      // 5. Enforce delay between orders (rate limiting)
      const now = Date.now();
      const timeSinceLastOrder = now - this.lastOrderExecutedAt;

      if (timeSinceLastOrder < this.ORDER_DELAY_MS && this.lastOrderExecutedAt > 0) {
        return; // Too soon, wait longer
      }

      // 6. Dequeue next order
      // V5.65: When circuit is open, only dequeue exit orders
      let queuedOrder: QueuedOrder | undefined;

      if (isCircuitOpen) {
        // Find the first exit order (critical)
        const exitIndex = this.queue.findIndex(q => !q.request.isEntry);
        if (exitIndex >= 0) {
          queuedOrder = this.queue.splice(exitIndex, 1)[0];
        }
      } else {
        // Normal operation - dequeue by priority (first item)
        queuedOrder = this.queue.shift();
      }

      if (!queuedOrder) return;

      // 7. Check if order timed out while in queue
      const queueWaitTime = Date.now() - queuedOrder.queuedAt;
      const timeout = queuedOrder.request.timeoutMs || this.DEFAULT_TIMEOUT_MS;

      if (queueWaitTime > timeout) {
        this.stats.totalTimedOut++;

        logger.error(
          `[${queuedOrder.request.id}] TIMEOUT in queue | ` +
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

      // 8. Execute order (async, non-blocking)
      void this.executeOrder(queuedOrder);

    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Execute an order
   */
  private async executeOrder(queuedOrder: QueuedOrder): Promise<void> {
    const { request, resolve } = queuedOrder;
    const { id, symbol, side, quantity, userId } = request;

    // Mark as executing
    this.executing.set(id, {
      orderId: id,
      startedAt: Date.now(),
    });

    this.lastOrderExecutedAt = Date.now();

    const waitTimeMs = this.lastOrderExecutedAt - request.submittedAt;
    this.stats.avgWaitTimeMs = (this.stats.avgWaitTimeMs + waitTimeMs) / 2; // Moving average

    const priorityTier = getPriorityTier(request.priority);

    logger.info(
      `[${id}] EXECUTING | ` +
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
      // This prevents LOT_SIZE, MIN_NOTIONAL, and INVALID_SYMBOL errors
      const validation = validateOrderComplete(
        {
          symbol,
          side,
          type: request.type,
          quantity,
          price: request.price,
        },
        exchange.markets,
        undefined // currentPrice not available here, price validated at higher level
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

        // Notify about the validation failure
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

      // V5.38: Execute order with timeout to prevent hanging
      // If Binance doesn't respond within EXECUTION_TIMEOUT_MS, we fail gracefully
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
        // Limit order
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

      // Success
      const result: OrderResult = {
        success: true,
        order,
        executedAt: Date.now(),
        waitTimeMs,
        retriesUsed: request.retries,
      };

      this.stats.totalExecuted++;
      this.results.set(id, result);

      // V5.65: Add to long-term order ID history
      this.orderIdHistory.add(id);

      logger.info(
        `[${id}] ✅ SUCCESS | ` +
        `orderId=${order.id} | ` +
        `filled=${order.filled} | ` +
        `price=${order.average || order.price} | ` +
        `executionTime=${executionTimeMs}ms`
      );

      // V5.79: Order filled notification removed from Telegram (redundant with position notifications)

      resolve(result);

    } catch (error: unknown) {
      const executionTimeMs = Date.now() - executionStartAt;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        `[${id}] ❌ FAILED | ` +
        `error=${errorMessage} | ` +
        `executionTime=${executionTimeMs}ms`
      );

      // Classify error
      const errorCode = this.classifyError(error);

      // Check if we should retry
      if (request.retries < this.MAX_RETRIES && this.isRetryableError(error)) {
        this.stats.totalRetried++;

        // Increment retry count and re-queue with boosted priority
        request.retries++;
        request.priority = Math.min(100, request.priority + 10); // Boost priority on retry

        logger.warn(
          `[${id}] RETRYING (${request.retries}/${this.MAX_RETRIES}) | ` +
          `newPriority=${request.priority}`
        );

        // Re-insert with boosted priority
        const newQueuedOrder: QueuedOrder = {
          ...queuedOrder,
          queuedAt: Date.now(), // Reset queue time
        };

        this.insertInQueue(newQueuedOrder);

      } else {
        // Max retries exceeded or non-retryable error
        this.stats.totalFailed++;

        // Record failure in circuit breaker
        globalRestCircuitBreaker.recordFailure(request.agentId, symbol, errorMessage);

        const result: OrderResult = {
          success: false,
          error: errorMessage,
          errorCode,
          executedAt: Date.now(),
          waitTimeMs,
          retriesUsed: request.retries,
        };

        // Notify Telegram about failure
        void notifyOrderFailed({
          id,
          symbol,
          side,
          quantity,
          error: errorMessage,
          retriesUsed: request.retries,
        });

        this.results.set(id, result);

        // V5.65: Add to long-term order ID history even on failure
        // This prevents resubmitting the same order ID
        this.orderIdHistory.add(id);

        resolve(result); // Don't reject, return error result
      }

    } finally {
      this.executing.delete(id);
    }
  }

  /**
   * Classify error for better handling
   */
  private classifyError(error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    if (message.includes('418') || message.includes('429')) {
      return 'RATE_LIMIT';
    }

    if (message.includes('insufficient') || message.includes('balance')) {
      return 'INSUFFICIENT_BALANCE';
    }

    if (message.includes('invalid') || message.includes('symbol')) {
      return 'INVALID_SYMBOL';
    }

    if (message.includes('timeout') || message.includes('network')) {
      return 'NETWORK_ERROR';
    }

    if (message.includes('margin') || message.includes('leverage')) {
      return 'MARGIN_ERROR';
    }

    return 'UNKNOWN_ERROR';
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

    // Retryable: Network errors, timeouts
    if (message.includes('timeout') || message.includes('network') || message.includes('econnreset')) {
      return true;
    }

    // Retryable: Temporary Binance errors
    if (message.includes('-1001') || message.includes('disconnected') || message.includes('temporary')) {
      return true;
    }

    // NOT retryable: Rate limit (let circuit breaker handle it)
    if (message.includes('418') || message.includes('429')) {
      return false;
    }

    // NOT retryable: Insufficient balance, invalid symbol, margin errors
    if (message.includes('insufficient') || message.includes('invalid') || message.includes('margin')) {
      return false;
    }

    // Default: don't retry unknown errors
    return false;
  }

  /**
   * Get exchange instance for a user (with their API credentials)
   */
  private async getExchangeForUser(userId: string): Promise<unknown> {
    // Import dynamically to avoid circular dependencies
    const { getUserExchange } = await import('../exchange/ccxtClient.js');
    const { getUserCredentials } = await import('./userCredentials.js');
    
    // Get user's API credentials
    const credentials = await getUserCredentials(userId);
    
    if (!credentials || !credentials.apiKey || !credentials.apiSecret) {
      throw new Error(`No API credentials found for user ${userId}. Please configure your Binance API keys.`);
    }
    
    // Return authenticated exchange instance for this user
    return getUserExchange(userId, credentials);
  }

  /**
   * Health check - cleanup timeouts and stale results
   */
  private async healthCheck(): Promise<void> {
    const now = Date.now();

    // Run health check max once per minute
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
      logger.debug(`[HealthCheck] Cleaned ${cleanedResults} stale results from cache`);
    }

    // 2. Detect stuck executing orders (should never happen, but safety check)
    let stuckOrders = 0;
    for (const [id, exec] of this.executing) {
      const executingTime = now - exec.startedAt;

      // If order has been executing for >2 minutes, something is wrong
      if (executingTime > 120_000) {
        logger.error(`[HealthCheck] STUCK ORDER detected: ${id} (executing for ${executingTime}ms)`);
        this.executing.delete(id);
        stuckOrders++;
      }
    }

    if (stuckOrders > 0) {
      logger.error(`[HealthCheck] Removed ${stuckOrders} stuck orders from executing map`);
    }

    // 3. V5.65: Clean up order ID history (once per 24 hours)
    // The history grows over time, but we only need to prevent duplicates for 24h
    if (now - this.orderIdHistoryCleanupAt > this.IDEMPOTENCY_CACHE_TTL_MS) {
      const historySize = this.orderIdHistory.size;
      if (historySize > 0) {
        this.orderIdHistory.clear();
        this.orderIdHistoryCleanupAt = now;
        logger.info(`[HealthCheck] Cleared ${historySize} order IDs from history (24h cleanup)`);
      }
    }

    // 4. Log queue health
    if (this.queue.length > 0 || this.executing.size > 0) {
      logger.info(
        `[HealthCheck] Queue: ${this.queue.length}/${this.MAX_QUEUE_SIZE} | ` +
        `Executing: ${this.executing.size}/${this.MAX_CONCURRENT_ORDERS} | ` +
        `Results cache: ${this.results.size} | ` +
        `OrderIdHistory: ${this.orderIdHistory.size}`
      );
    }
  }
}

// ============================================================================
// Global Singleton Instance
// ============================================================================

/**
 * Global order queue instance
 * Used by all agents to submit orders
 */
export const orderQueue = new OrderQueue({
  maxConcurrentOrders: ORDER_QUEUE.MAX_CONCURRENT,
  orderDelayMs: ORDER_QUEUE.DELAY_MS,
  maxRetries: ORDER_QUEUE.MAX_RETRIES,
  resultCacheTTL: ORDER_QUEUE.RESULT_CACHE_TTL_MS,
  maxQueueSize: ORDER_QUEUE.MAX_QUEUE_SIZE,
  defaultTimeoutMs: ORDER_QUEUE.DEFAULT_TIMEOUT_MS,
});

// Auto-start on import
orderQueue.start();

logger.info('[OrderQueue] Global instance created and started');
