/**
 * V5.22: Signal Ranking System
 * 
 * Collects signals from all agents and ranks them by quality score.
 * Ensures that when capital is limited (maxPositions constraint),
 * only the highest-quality opportunities are selected.
 * 
 * This dramatically improves performance vs first-come-first-served approach.
 * 
 * SHARED by both backtest and production to ensure identical scoring logic.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('signal-ranker');

export interface RankedSignal {
  symbol: string;
  side: 'long' | 'short';
  score: number;
  price: number;
  timestamp: number;
  roc5: number;
  volumeRatio: number;
  reason: string;
}

/**
 * V5.22: Calculate signal quality score
 * 
 * CRITICAL: This scoring function is used by BOTH backtest and production.
 * Any changes here must maintain consistency between the two.
 * 
 * Formula: ROC momentum (60%) + Volume confirmation (40%)
 * 
 * @param roc5 - Rate of change over 5 periods (e.g., 0.02 = 2%)
 * @param volumeRatio - Current volume / 19-period average (e.g., 2.5 = 2.5x average)
 * @returns Quality score (higher = better opportunity)
 */
export function calculateSignalScore(roc5: number, volumeRatio: number): number {
  // ROC: Strong momentum = higher score
  const rocScore = Math.abs(roc5) * 0.6;
  
  // Volume: High volume = higher score (cap at 3x to avoid extreme outliers)
  const volScore = Math.min(volumeRatio, 3) * 10 * 0.4;
  
  return rocScore + volScore;
}

class SignalRanker {
  // Pending signals waiting to be evaluated
  private pendingSignals: Map<string, RankedSignal> = new Map();
  
  // Timeout to batch signals (ms) - wait for all agents to report
  private readonly BATCH_WINDOW_MS = 1000; // 1 second
  private batchTimeout: NodeJS.Timeout | null = null;
  
  /**
   * Add a signal candidate for ranking consideration
   */
  addSignal(signal: RankedSignal): void {
    // Store signal (overwrites if symbol already has pending signal)
    this.pendingSignals.set(signal.symbol, signal);
    
    // Reset batch timer - wait for more signals to arrive
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
    }
    
    // Auto-flush after batch window
    this.batchTimeout = setTimeout(() => {
      this.flushExpiredSignals();
    }, this.BATCH_WINDOW_MS);
  }
  
  /**
   * Calculate signal quality score
   * V5.22: ROC momentum (60%) + Volume confirmation (40%)
   * 
   * Delegates to shared function to ensure consistency with backtest
   */
  calculateScore(roc5: number, volumeRatio: number): number {
    return calculateSignalScore(roc5, volumeRatio);
  }
  
  /**
   * Get top N signals by score
   */
  getTopSignals(maxCount: number): RankedSignal[] {
    const signals = Array.from(this.pendingSignals.values());
    
    // Sort by score descending
    signals.sort((a, b) => b.score - a.score);
    
    // Take top N
    return signals.slice(0, maxCount);
  }
  
  /**
   * Check if a signal should be executed
   * Returns true if this signal is in the top N best opportunities
   */
  shouldExecuteSignal(symbol: string, availableSlots: number): boolean {
    const topSignals = this.getTopSignals(availableSlots);
    const isTopSignal = topSignals.some(s => s.symbol === symbol);
    
    if (!isTopSignal && this.pendingSignals.size > 0) {
      const currentSignal = this.pendingSignals.get(symbol);
      if (currentSignal) {
        logger.info(`⏸️ [${symbol.replace('/USDT:USDT', '')}] Signal DEFERRED (score=${currentSignal.score.toFixed(2)}) - not in top ${availableSlots} opportunities`);
      }
    }
    
    return isTopSignal;
  }
  
  /**
   * Remove a signal from pending (called after execution or when invalidated)
   */
  removeSignal(symbol: string): void {
    this.pendingSignals.delete(symbol);
  }
  
  /**
   * Clear signals older than 5 minutes (stale)
   */
  private flushExpiredSignals(): void {
    const now = Date.now();
    const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
    
    for (const [symbol, signal] of this.pendingSignals.entries()) {
      if (now - signal.timestamp > EXPIRY_MS) {
        logger.info(`🧹 [${symbol.replace('/USDT:USDT', '')}] Signal expired after 5min - removing`);
        this.pendingSignals.delete(symbol);
      }
    }
  }
  
  /**
   * Get current pending signals (for debugging)
   */
  getPendingSignals(): RankedSignal[] {
    return Array.from(this.pendingSignals.values());
  }
  
  /**
   * Clear all pending signals (e.g., on agent restart)
   */
  clear(): void {
    this.pendingSignals.clear();
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
  }
}

// Global singleton instance shared across all agents
export const globalSignalRanker = new SignalRanker();
