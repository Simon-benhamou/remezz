/**
 * SymbolEngineManager - Singleton managing SymbolEngine lifecycle
 *
 * Uses subscriber counting so engines are created when the first user
 * subscribes to a symbol and destroyed when the last user unsubscribes.
 */

import { createLogger } from '../utils/logger.js';
import { SymbolEngine } from './symbolEngine.js';

const logger = createLogger('symbol-engine-mgr');

class SymbolEngineManager {
  private engines: Map<string, SymbolEngine> = new Map();
  private subscriberCounts: Map<string, number> = new Map();

  /**
   * Subscribe to a symbol's engine. Creates and starts the engine if it doesn't exist.
   * Returns the engine instance.
   */
  subscribe(symbol: string): SymbolEngine {
    const count = this.subscriberCounts.get(symbol) || 0;

    if (count > 0) {
      // Engine already exists, just increment count
      this.subscriberCounts.set(symbol, count + 1);
      logger.info(`[SymbolEngineManager] +1 subscriber for ${symbol} (now ${count + 1})`);
      return this.engines.get(symbol)!;
    }

    // First subscriber: create and start engine
    const engine = new SymbolEngine(symbol);
    this.engines.set(symbol, engine);
    this.subscriberCounts.set(symbol, 1);
    engine.start();
    logger.info(`[SymbolEngineManager] Created engine for ${symbol} (1 subscriber)`);
    return engine;
  }

  /**
   * Unsubscribe from a symbol's engine. Stops and removes the engine
   * when the last subscriber leaves.
   */
  unsubscribe(symbol: string): void {
    const count = this.subscriberCounts.get(symbol) || 0;

    if (count <= 0) {
      logger.warn(`[SymbolEngineManager] Unsubscribe called for ${symbol} with no subscribers`);
      return;
    }

    const newCount = count - 1;
    this.subscriberCounts.set(symbol, newCount);

    if (newCount === 0) {
      // Last subscriber: stop and remove engine
      const engine = this.engines.get(symbol);
      if (engine) {
        engine.stop();
        this.engines.delete(symbol);
      }
      this.subscriberCounts.delete(symbol);
      logger.info(`[SymbolEngineManager] Removed engine for ${symbol} (0 subscribers)`);
    } else {
      logger.info(`[SymbolEngineManager] -1 subscriber for ${symbol} (now ${newCount})`);
    }
  }

  /**
   * Get engine for a symbol (if it exists).
   */
  getEngine(symbol: string): SymbolEngine | undefined {
    return this.engines.get(symbol);
  }

  /**
   * Get stats about running engines.
   */
  getStats(): { engines: number; symbols: string[]; subscribers: Record<string, number> } {
    const subscribers: Record<string, number> = {};
    for (const [symbol, count] of this.subscriberCounts) {
      subscribers[symbol] = count;
    }
    return {
      engines: this.engines.size,
      symbols: [...this.engines.keys()],
      subscribers,
    };
  }

  /**
   * Stop all engines. Used during graceful shutdown.
   */
  stopAll(): void {
    const count = this.engines.size;
    for (const [, engine] of this.engines) {
      engine.stop();
    }
    this.engines.clear();
    this.subscriberCounts.clear();
    if (count > 0) {
      logger.info(`[SymbolEngineManager] Stopped all ${count} engine(s)`);
    }
  }
}

export const symbolEngineManager = new SymbolEngineManager();
