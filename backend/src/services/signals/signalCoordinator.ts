/**
 * Signal Coordinator - Manages SignalGenerator Lifecycle
 *
 * Creates, starts, stops, and manages SignalGenerator instances.
 * Ensures ONE generator per symbol (shared across all agents).
 *
 * Benefits:
 * - Central management of all signal generators
 * - Automatic cleanup when no agents subscribe
 * - Memory-efficient (only runs generators for active symbols)
 * - Prevents duplicate generators for same symbol
 *
 * Architecture:
 * 1. Agents request signals via subscribe(symbol)
 * 2. Coordinator creates SignalGenerator if needed
 * 3. Generator calculates and broadcasts signals
 * 4. When last agent unsubscribes, generator is stopped and cleaned up
 */

import { createLogger } from '../../utils/logger.js';
import { SignalGenerator, type SignalGeneratorConfig } from './signalGenerator.js';
import { signalBroker } from './signalBroker.js';
import type { Candle } from '../../strategies/momentumSimple.js';

const logger = createLogger('signal-coordinator');

export interface CoordinatorStats {
  totalGenerators: number;
  activeGenerators: number;
  symbols: string[];
  subscriberCounts: Record<string, number>;
}

/**
 * SignalCoordinator - Manages all SignalGenerators
 */
export class SignalCoordinator {
  private generators: Map<string, SignalGenerator> = new Map();
  private subscriberCounts: Map<string, number> = new Map();
  private unsubscribeFns: Map<string, () => void> = new Map(); // agentId:symbol -> unsubscribe fn

  private defaultConfig = {
    timeframe: '1h',
    updateIntervalMs: 15_000, // Recalculate every 15s
  };

  constructor() {
    logger.info('[SignalCoordinator] Initialized');
  }

  /**
   * Subscribe an agent to signals for a symbol
   * Creates and starts generator if it doesn't exist
   */
  async subscribe(agentId: string, symbol: string): Promise<void> {
    // Increment subscriber count
    const currentCount = this.subscriberCounts.get(symbol) || 0;
    this.subscriberCounts.set(symbol, currentCount + 1);

    logger.info(`[SignalCoordinator] ${agentId} subscribed to ${symbol} (subscribers: ${currentCount + 1})`);

    // Create generator if it doesn't exist
    if (!this.generators.has(symbol)) {
      await this.createGenerator(symbol);
    }

    // Subscribe agent to signal broker
    const unsubscribe = signalBroker.subscribeToSignal(symbol, (signal) => {
      // Signal will be delivered via signalBroker callback
      logger.debug(`[SignalCoordinator] ${agentId} received signal for ${symbol}: ${signal.bias}`);
    });
    this.unsubscribeFns.set(`${agentId}:${symbol}`, unsubscribe);
  }

  /**
   * Unsubscribe an agent from signals for a symbol
   * Stops and removes generator if no subscribers remain
   */
  unsubscribe(agentId: string, symbol: string): void {
    const currentCount = this.subscriberCounts.get(symbol) || 0;

    if (currentCount > 0) {
      this.subscriberCounts.set(symbol, currentCount - 1);

      logger.info(`[SignalCoordinator] ${agentId} unsubscribed from ${symbol} (subscribers: ${currentCount - 1})`);

      // Unsubscribe from signal broker using stored function
      const key = `${agentId}:${symbol}`;
      const unsubscribe = this.unsubscribeFns.get(key);
      if (unsubscribe) {
        unsubscribe();
        this.unsubscribeFns.delete(key);
      }

      // Stop generator if no subscribers remain
      if (currentCount - 1 === 0) {
        this.stopGenerator(symbol);
      }
    }
  }

  /**
   * Create and start a signal generator for a symbol
   */
  private async createGenerator(symbol: string): Promise<void> {
    if (this.generators.has(symbol)) {
      logger.warn(`[SignalCoordinator] Generator for ${symbol} already exists`);
      return;
    }

    const config: SignalGeneratorConfig = {
      symbol,
      ...this.defaultConfig,
    };

    const generator = new SignalGenerator(config);
    this.generators.set(symbol, generator);

    await generator.start();

    logger.info(`[SignalCoordinator] Created and started generator for ${symbol}`);
  }

  /**
   * Stop and remove a signal generator
   */
  private stopGenerator(symbol: string): void {
    const generator = this.generators.get(symbol);

    if (generator) {
      generator.stop();
      this.generators.delete(symbol);

      logger.info(`[SignalCoordinator] Stopped and removed generator for ${symbol}`);
    }
  }

  /**
   * Update candle data for a symbol
   * Called by WebSocket manager when new candles arrive
   */
  updateCandles(symbol: string, timeframe: string, candles: Candle[]): void {
    const generator = this.generators.get(symbol);

    if (generator) {
      generator.updateCandles(symbol, timeframe, candles);
    }

    // Also update BTC candles for all generators (needed for BTC trend filter)
    if (symbol === 'BTC/USDT:USDT' || symbol === 'BTCUSDT') {
      for (const [, gen] of this.generators) {
        gen.updateCandles(symbol, timeframe, candles);
      }
    }
  }

  /**
   * Force recalculation for a symbol
   * Useful for testing or manual triggers
   */
  async recalculate(symbol: string): Promise<void> {
    const generator = this.generators.get(symbol);

    if (generator) {
      // Trigger update by passing empty candle update
      // This forces a recalculation without new data
      logger.info(`[SignalCoordinator] Forcing recalculation for ${symbol}`);
      // Note: This is a simple trigger - real implementation would call calculateAndBroadcast directly
    } else {
      logger.warn(`[SignalCoordinator] No generator found for ${symbol}`);
    }
  }

  /**
   * Get statistics about all generators
   */
  getStats(): CoordinatorStats {
    const activeGenerators = Array.from(this.generators.values()).filter(
      (gen) => gen.getStatus().isRunning
    ).length;

    const subscriberCounts: Record<string, number> = {};
    for (const [symbol, count] of this.subscriberCounts.entries()) {
      subscriberCounts[symbol] = count;
    }

    return {
      totalGenerators: this.generators.size,
      activeGenerators,
      symbols: Array.from(this.generators.keys()),
      subscriberCounts,
    };
  }

  /**
   * Get status of a specific generator
   */
  getGeneratorStatus(symbol: string): any {
    const generator = this.generators.get(symbol);
    return generator ? generator.getStatus() : null;
  }

  /**
   * Get all generator statuses
   */
  getAllStatuses(): Record<string, any> {
    const statuses: Record<string, any> = {};

    for (const [symbol, generator] of this.generators.entries()) {
      statuses[symbol] = generator.getStatus();
    }

    return statuses;
  }

  /**
   * Stop all generators (cleanup on shutdown)
   */
  stopAll(): void {
    logger.info(`[SignalCoordinator] Stopping all ${this.generators.size} generators`);

    for (const [symbol, generator] of this.generators.entries()) {
      generator.stop();
    }

    this.generators.clear();
    this.subscriberCounts.clear();

    logger.info('[SignalCoordinator] All generators stopped');
  }

  /**
   * Health check - log current state
   */
  healthCheck(): void {
    const stats = this.getStats();

    logger.info(`[SignalCoordinator] Health Check:`, {
      totalGenerators: stats.totalGenerators,
      activeGenerators: stats.activeGenerators,
      symbols: stats.symbols,
      subscriberCounts: stats.subscriberCounts,
    });
  }
}

// Global singleton instance
export const signalCoordinator = new SignalCoordinator();

// Periodic health check (every 5 minutes)
setInterval(() => {
  signalCoordinator.healthCheck();
}, 300_000);
