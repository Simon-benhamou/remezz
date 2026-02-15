/**
 * V5.78: Binance REST API Queue
 *
 * Centralized rate-limited queue for ALL Binance REST API calls.
 * Prevents IP bans by enforcing weight limits proactively.
 *
 * Architecture:
 * - All REST calls go through this queue
 * - Weight tracking unified with ipWeightTracker (single source of truth for 2400w/min Binance limit)
 * - Priority-based execution (critical > high > normal > low)
 * - Automatic IP ban detection and handling
 *
 * Usage:
 *   const result = await binanceRestQueue.enqueue(
 *     () => exchange.fetchOHLCV(symbol, '15m'),
 *     { weight: 10, priority: 'normal', tag: 'klines_BTC' }
 *   );
 */

import { createLogger } from '../utils/logger.js';
import { isIpBanned, setIpBan, getIpBanExpiry } from '../exchange/ccxtClient.js';
import { ipWeightTracker } from './ipWeightTracker.js';

const logger = createLogger('RestQueue');

// Priority levels (lower number = higher priority)
export type QueuePriority = 'critical' | 'high' | 'normal' | 'low';

const PRIORITY_VALUES: Record<QueuePriority, number> = {
  critical: 0,  // Stop loss, position exits
  high: 1,      // User-initiated actions, balance fetches
  normal: 2,    // Klines preload, position sync
  low: 3,       // Background updates, non-urgent data
};

// Weight estimates for common Binance endpoints
export const BINANCE_WEIGHTS = {
  FETCH_TIME: 1,
  FETCH_TICKER: 1,
  FETCH_BALANCE: 5,
  FETCH_POSITIONS: 5,
  FETCH_OHLCV: 10,       // Depends on limit, but ~10 is typical
  FETCH_MY_TRADES: 10,
  CREATE_ORDER: 1,
  CANCEL_ORDER: 1,
  LOAD_MARKETS: 40,
  SET_LEVERAGE: 1,
  LISTEN_KEY: 1,
};

interface QueuedRequest<T = any> {
  id: string;
  fn: () => Promise<T>;
  weight: number;
  priority: QueuePriority;
  tag: string;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  enqueuedAt: number;
  retries: number;
}

interface QueueConfig {
  maxWeightPerMinute: number;
  minDelayBetweenCallsMs: number;
  maxRetries: number;
  banBackoffMs: number;
}

interface QueueStats {
  totalEnqueued: number;
  totalExecuted: number;
  totalFailed: number;
  totalRetried: number;
  currentQueueSize: number;
  weightUsedThisMinute: number;
  weightResetAt: number;
  avgWaitTimeMs: number;
  isProcessing: boolean;
  isPaused: boolean;
}

class BinanceRestQueue {
  private queue: QueuedRequest[] = [];
  private processing = false;
  private paused = false;
  private requestIdCounter = 0;
  private banExpiredCallbacks: Array<() => void> = [];
  private banExpiryTimer: NodeJS.Timeout | null = null;

  // Stats
  private stats = {
    totalEnqueued: 0,
    totalExecuted: 0,
    totalFailed: 0,
    totalRetried: 0,
    totalWaitTimeMs: 0,
  };

  // Configuration
  private config: QueueConfig = {
    maxWeightPerMinute: 2400,      // Binance hard limit — ipWeightTracker enforces this
    minDelayBetweenCallsMs: 100,   // Minimum delay between any two calls
    maxRetries: 2,                  // Retry failed requests (not bans)
    banBackoffMs: 5000,            // Wait after detecting rate limit warning
  };

  constructor(config?: Partial<QueueConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    logger.info('BinanceRestQueue initialized (unified with ipWeightTracker)', {
      minDelayMs: this.config.minDelayBetweenCallsMs,
    });
  }

  /**
   * Enqueue a REST API call for rate-limited execution
   */
  async enqueue<T>(
    fn: () => Promise<T>,
    options: {
      weight?: number;
      priority?: QueuePriority;
      tag?: string;
    } = {}
  ): Promise<T> {
    const {
      weight = 10,
      priority = 'normal',
      tag = 'unknown',
    } = options;

    // Check if IP is banned - reject immediately for non-critical requests
    if (isIpBanned() && priority !== 'critical') {
      const banExpiry = getIpBanExpiry();
      const waitMs = Math.max(0, banExpiry - Date.now());
      // Ensure ban-expired callbacks are scheduled even if ban was set externally
      if (!this.banExpiryTimer && this.banExpiredCallbacks.length > 0) {
        this.scheduleBanExpiryCallbacks(banExpiry);
      }
      throw new Error(`IP banned - ${Math.ceil(waitMs / 60000)} minutes remaining. Request rejected: ${tag}`);
    }

    this.stats.totalEnqueued++;
    const id = `req_${++this.requestIdCounter}`;

    return new Promise<T>((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id,
        fn,
        weight,
        priority,
        tag,
        resolve,
        reject,
        enqueuedAt: Date.now(),
        retries: 0,
      };

      // Insert in priority order
      this.insertByPriority(request);

      logger.debug(`[${id}] Enqueued: ${tag} (weight: ${weight}, priority: ${priority}, queue size: ${this.queue.length})`);

      // Start processing if not already
      this.processQueue();
    });
  }

  /**
   * Insert request maintaining priority order
   */
  private insertByPriority(request: QueuedRequest): void {
    const priorityValue = PRIORITY_VALUES[request.priority];

    // Find insertion point (first request with lower priority)
    let insertIndex = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (PRIORITY_VALUES[this.queue[i].priority] > priorityValue) {
        insertIndex = i;
        break;
      }
    }

    this.queue.splice(insertIndex, 0, request);
  }

  /**
   * Main processing loop
   */
  private async processQueue(): Promise<void> {
    if (this.processing || this.paused) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Check for IP ban
      if (isIpBanned()) {
        const banExpiry = getIpBanExpiry();
        const waitMs = Math.max(0, banExpiry - Date.now());

        if (waitMs > 0) {
          logger.warn(`IP banned - pausing queue for ${Math.ceil(waitMs / 60000)} minutes`);

          // Reject all non-critical requests
          this.rejectNonCritical('IP banned');

          // Wait for ban to expire (check every 30s)
          while (isIpBanned() && !this.paused) {
            await this.sleep(30_000);
          }

          if (this.paused) break;
          logger.info('IP ban expired - resuming queue');

          // Cancel the timer — fire callbacks immediately since we detected ban expiry in-loop
          if (this.banExpiryTimer) {
            clearTimeout(this.banExpiryTimer);
            this.banExpiryTimer = null;
          }
          logger.info(`Firing ${this.banExpiredCallbacks.length} ban-expired callbacks`);
          for (const cb of this.banExpiredCallbacks) {
            try { cb(); } catch (e: any) {
              logger.warn('Ban-expired callback error:', e?.message);
            }
          }
        }

        // rejectNonCritical may have emptied the queue
        if (this.queue.length === 0) break;
      }

      const request = this.queue[0];
      if (!request) break;

      // Check if we have weight budget (unified via ipWeightTracker)
      if (!ipWeightTracker.canMakeCall(request.weight)) {
        const currentWeight = ipWeightTracker.getCurrentWeight();
        logger.info(`Weight limit reached (${currentWeight}/2400) - waiting for budget to free up (next: ${request.tag}, weight: ${request.weight})`);
        await this.sleep(2_000); // Wait 2s and re-check
        continue;
      }

      // Remove from queue and execute
      this.queue.shift();
      await this.executeRequest(request);

      // Minimum delay between calls
      if (this.queue.length > 0) {
        await this.sleep(this.config.minDelayBetweenCallsMs);
      }
    }

    this.processing = false;
  }

  /**
   * Execute a single request with error handling
   */
  private async executeRequest<T>(request: QueuedRequest<T>): Promise<void> {
    const waitTime = Date.now() - request.enqueuedAt;
    this.stats.totalWaitTimeMs += waitTime;

    try {
      logger.debug(`[${request.id}] Executing: ${request.tag} (waited ${waitTime}ms)`);

      const result = await request.fn();

      // Success - record weight in unified tracker (single source of truth)
      ipWeightTracker.record(request.weight, `queue:${request.tag}`);
      this.stats.totalExecuted++;

      logger.debug(`[${request.id}] Success: ${request.tag}`);
      request.resolve(result);

    } catch (error: any) {
      const errorMsg = error?.message || String(error);

      // Check for IP ban
      if (this.isIpBanError(errorMsg)) {
        this.handleIpBan(errorMsg);
        request.reject(new Error(`IP banned during request: ${request.tag}`));
        return;
      }

      // Check for rate limit warning (not ban yet)
      if (this.isRateLimitWarning(errorMsg)) {
        logger.warn(`Rate limit warning on ${request.tag} - backing off ${this.config.banBackoffMs}ms`);
        await this.sleep(this.config.banBackoffMs);

        // Retry this request
        if (request.retries < this.config.maxRetries) {
          request.retries++;
          this.stats.totalRetried++;
          this.insertByPriority(request);
          return;
        }
      }

      // Other error - retry if allowed
      if (request.retries < this.config.maxRetries && this.isRetryableError(errorMsg)) {
        request.retries++;
        this.stats.totalRetried++;
        logger.warn(`[${request.id}] Retrying ${request.tag} (attempt ${request.retries + 1})`);
        this.insertByPriority(request);
        return;
      }

      // Final failure
      this.stats.totalFailed++;
      logger.error(`[${request.id}] Failed: ${request.tag} - ${errorMsg}`);
      request.reject(error);
    }
  }

  /**
   * Check if error indicates IP ban
   */
  private isIpBanError(msg: string): boolean {
    return msg.includes('418') ||
           msg.includes('-1003') ||
           msg.includes('banned') ||
           msg.includes('IP banned');
  }

  /**
   * Check if error is a rate limit warning (429)
   */
  private isRateLimitWarning(msg: string): boolean {
    return msg.includes('429') ||
           msg.includes('Too many') ||
           msg.includes('-1015') ||
           msg.includes('rate limit');
  }

  /**
   * Check if error is retryable (network issues, etc.)
   */
  private isRetryableError(msg: string): boolean {
    return msg.includes('ETIMEDOUT') ||
           msg.includes('ECONNRESET') ||
           msg.includes('ENOTFOUND') ||
           msg.includes('network') ||
           msg.includes('timeout');
  }

  /**
   * Handle IP ban detection
   */
  private handleIpBan(errorMsg: string): void {
    // Binance error may contain "banned until <timestamp_ms>"
    const banMatch = errorMsg.match(/banned until (\d+)/);
    let banUntilAbsolute: number;

    if (banMatch) {
      // Binance gave us the exact unban timestamp
      const parsed = parseInt(banMatch[1]);
      // Sanity: if parsed is in the past or >24h away, use 5 min default
      if (parsed > Date.now() && parsed < Date.now() + 24 * 60 * 60 * 1000) {
        banUntilAbsolute = parsed;
      } else {
        banUntilAbsolute = Date.now() + 5 * 60 * 1000;
      }
    } else {
      // No timestamp in error — assume short ban (5 minutes, not 60!)
      banUntilAbsolute = Date.now() + 5 * 60 * 1000;
    }

    const durationMin = Math.ceil((banUntilAbsolute - Date.now()) / 60000);
    logger.error(`IP BAN DETECTED - setting ban for ${durationMin} minutes (until ${new Date(banUntilAbsolute).toISOString()})`);
    setIpBan(banUntilAbsolute, `restQueue:${errorMsg.substring(0, 80)}`);

    // Schedule ban-expired callbacks (re-seed candles, etc.)
    this.scheduleBanExpiryCallbacks(banUntilAbsolute);
  }

  /**
   * Schedule a timer to fire ban-expired callbacks when the ban lifts.
   * This ensures callbacks fire even if processQueue isn't running during the ban.
   */
  private scheduleBanExpiryCallbacks(banUntil: number): void {
    // Clear any existing timer (ban may have been extended)
    if (this.banExpiryTimer) {
      clearTimeout(this.banExpiryTimer);
      this.banExpiryTimer = null;
    }

    const delayMs = Math.max(0, banUntil - Date.now()) + 5_000; // 5s buffer after ban expiry
    logger.info(`Scheduled ban-expired callbacks in ${Math.ceil(delayMs / 1000)}s`);

    this.banExpiryTimer = setTimeout(() => {
      this.banExpiryTimer = null;
      if (isIpBanned()) {
        // Ban was extended, don't fire yet
        logger.info('Ban still active at scheduled callback time, skipping');
        return;
      }
      logger.info(`Firing ${this.banExpiredCallbacks.length} ban-expired callbacks`);
      for (const cb of this.banExpiredCallbacks) {
        try { cb(); } catch (e: any) {
          logger.warn('Ban-expired callback error:', e?.message);
        }
      }
    }, delayMs);
  }

  /**
   * Reject all non-critical requests (during IP ban)
   */
  private rejectNonCritical(reason: string): void {
    const nonCritical = this.queue.filter(r => r.priority !== 'critical');
    this.queue = this.queue.filter(r => r.priority === 'critical');

    for (const request of nonCritical) {
      request.reject(new Error(`${reason}: ${request.tag}`));
    }

    if (nonCritical.length > 0) {
      logger.warn(`Rejected ${nonCritical.length} non-critical requests due to: ${reason}`);
    }
  }

  /**
   * Pause the queue (for graceful shutdown)
   */
  pause(): void {
    this.paused = true;
    logger.info('Queue paused');
  }

  /**
   * Resume the queue
   */
  resume(): void {
    this.paused = false;
    logger.info('Queue resumed');
    this.processQueue();
  }

  /**
   * Register a callback to run when an IP ban expires.
   * Used to trigger candle cache re-seeding so agents recover quickly.
   */
  onBanExpired(callback: () => void): void {
    this.banExpiredCallbacks.push(callback);
  }

  /**
   * Clear the queue (reject all pending)
   */
  clear(reason: string = 'Queue cleared'): void {
    const count = this.queue.length;
    for (const request of this.queue) {
      request.reject(new Error(reason));
    }
    this.queue = [];
    logger.info(`Queue cleared: ${count} requests rejected`);
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    return {
      totalEnqueued: this.stats.totalEnqueued,
      totalExecuted: this.stats.totalExecuted,
      totalFailed: this.stats.totalFailed,
      totalRetried: this.stats.totalRetried,
      currentQueueSize: this.queue.length,
      weightUsedThisMinute: ipWeightTracker.getCurrentWeight(), // Unified tracker
      weightResetAt: 0, // No longer relevant — ipWeightTracker uses rolling 60s window
      avgWaitTimeMs: this.stats.totalExecuted > 0
        ? Math.round(this.stats.totalWaitTimeMs / this.stats.totalExecuted)
        : 0,
      isProcessing: this.processing,
      isPaused: this.paused,
    };
  }

  /**
   * Get current queue contents (for debugging)
   */
  getQueueContents(): Array<{ id: string; tag: string; priority: QueuePriority; weight: number; waitingMs: number }> {
    const now = Date.now();
    return this.queue.map(r => ({
      id: r.id,
      tag: r.tag,
      priority: r.priority,
      weight: r.weight,
      waitingMs: now - r.enqueuedAt,
    }));
  }

  /**
   * Get remaining weight budget for this minute (via unified tracker)
   */
  getRemainingWeight(): number {
    return Math.max(0, 2400 - ipWeightTracker.getCurrentWeight());
  }

  /**
   * Check if a request with given weight can be executed immediately
   */
  canExecuteImmediately(weight: number): boolean {
    if (isIpBanned()) return false;
    return ipWeightTracker.canMakeCall(weight) && this.queue.length === 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const binanceRestQueue = new BinanceRestQueue();

// Export class for testing
export { BinanceRestQueue };
