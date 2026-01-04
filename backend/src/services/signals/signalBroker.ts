/**
 * Signal Broker - Event-Driven Signal Distribution
 *
 * CRITICAL COMPONENT for 1000+ agents CPU optimization
 *
 * Problem: 100 agents trading BTCUSDT = 100× same calculation every 15s
 * Solution: 1 generator calculates signal, broker distributes to all subscribers
 *
 * Architecture:
 * - SignalGenerator calculates signal → publishes to broker
 * - Broker stores latest signal per symbol (in-memory cache)
 * - Agents subscribe to symbols → receive signals via EventEmitter
 *
 * Performance:
 * - 100 agents subscribe to BTCUSDT = 1 calculation, 100 deliveries
 * - Signal propagation: <1ms (in-memory EventEmitter)
 * - CPU reduction: 100× (from 100 calculations to 1 + 100 notifications)
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../utils/logger.js';
import type { MarketConditions } from '../../strategies/momentumSimple.js';

const logger = createLogger('signal-broker');

// ============================================================================
// Types
// ============================================================================

export type TradingSignal = {
  // Identification
  symbol: string;
  timestamp: number;

  // Entry signal
  bias: 'long' | 'short' | null;
  entryPrice: number;
  entryZone?: [number, number];

  // Exit levels
  stopLoss: number;
  takeProfit: number;

  // Market conditions
  marketConditions: MarketConditions;

  // Signal metadata
  score: number;           // From signalRanker (0-100)
  confidence: number;      // Signal confidence (0-100)
  rejectReason?: string;   // If no signal, why was it rejected

  // Generation context (for debugging)
  generatedAt: number;
  generatorVersion: string;
};

// ============================================================================
// Signal Broker Class
// ============================================================================

class SignalBroker extends EventEmitter {
  // Latest signal per symbol (in-memory cache)
  private latestSignals = new Map<string, TradingSignal>();

  // Track active subscribers per symbol
  private subscriberCount = new Map<string, number>();

  // Stats
  private stats = {
    totalPublished: 0,
    totalSubscriptions: 0,
    totalUnsubscriptions: 0,
  };

  constructor() {
    super();
    this.setMaxListeners(10000); // Support 1000+ agents
  }

  /**
   * Publish a new signal for a symbol
   * Called by SignalGenerators
   */
  publishSignal(signal: TradingSignal): void {
    this.latestSignals.set(signal.symbol, signal);
    this.stats.totalPublished++;

    // Emit event for real-time subscribers
    this.emit(`signal:${signal.symbol}`, signal);

    const subscribers = this.subscriberCount.get(signal.symbol) || 0;

    logger.debug(
      `[${signal.symbol}] Signal published | ` +
      `bias=${signal.bias} | ` +
      `score=${signal.score} | ` +
      `subscribers=${subscribers}`
    );
  }

  /**
   * Subscribe to signals for a symbol
   * Returns unsubscribe function
   */
  subscribeToSignal(
    symbol: string,
    callback: (signal: TradingSignal) => void
  ): () => void {
    this.stats.totalSubscriptions++;

    // Track subscriber count
    const count = this.subscriberCount.get(symbol) || 0;
    this.subscriberCount.set(symbol, count + 1);

    // Send latest signal immediately if available
    const latest = this.latestSignals.get(symbol);
    if (latest) {
      setImmediate(() => callback(latest));
    }

    // Subscribe to future signals
    const handler = (signal: TradingSignal) => callback(signal);
    this.on(`signal:${symbol}`, handler);

    logger.debug(`[${symbol}] New subscription (total: ${count + 1})`);

    // Return unsubscribe function
    return () => {
      this.stats.totalUnsubscriptions++;
      this.off(`signal:${symbol}`, handler);

      const newCount = (this.subscriberCount.get(symbol) || 1) - 1;
      if (newCount <= 0) {
        this.subscriberCount.delete(symbol);
      } else {
        this.subscriberCount.set(symbol, newCount);
      }

      logger.debug(`[${symbol}] Unsubscribed (remaining: ${newCount})`);
    };
  }

  /**
   * Get latest signal for a symbol (synchronous)
   */
  getLatestSignal(symbol: string): TradingSignal | null {
    return this.latestSignals.get(symbol) || null;
  }

  /**
   * Get all active symbols with subscribers
   */
  getActiveSymbols(): string[] {
    return Array.from(this.subscriberCount.keys());
  }

  /**
   * Clear stale signals (older than maxAge)
   */
  clearStaleSignals(maxAgeMs: number = 300_000): number {
    const now = Date.now();
    let cleared = 0;

    for (const [symbol, signal] of this.latestSignals) {
      if (now - signal.timestamp > maxAgeMs) {
        this.latestSignals.delete(symbol);
        cleared++;
        logger.debug(`[${symbol}] Cleared stale signal (age: ${now - signal.timestamp}ms)`);
      }
    }

    return cleared;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      activeSymbols: this.subscriberCount.size,
      totalSubscribers: Array.from(this.subscriberCount.values()).reduce((a, b) => a + b, 0),
      cachedSignals: this.latestSignals.size,
      ...this.stats,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const signalBroker = new SignalBroker();

// Cleanup stale signals every 5 minutes
setInterval(() => {
  const cleared = signalBroker.clearStaleSignals(300_000); // 5 minutes
  if (cleared > 0) {
    logger.info(`[Cleanup] Cleared ${cleared} stale signals`);
  }
}, 300_000);

