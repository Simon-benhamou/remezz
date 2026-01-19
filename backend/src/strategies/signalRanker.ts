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
  mode?: 'live' | 'paper';  // NEW: Track which mode the signal is from
}

/**
 * V5.22: Calculate signal quality score (LEGACY - Simple version)
 * 
 * Formula: ROC momentum (60%) + Volume confirmation (40%)
 */
export function calculateSignalScoreV22(roc5: number, volumeRatio: number): number {
  const rocScore = Math.abs(roc5) * 0.6;
  const volScore = Math.min(volumeRatio, 3) * 10 * 0.4;
  return rocScore + volScore;
}

/**
 * V5.23: Enhanced signal quality score with multi-factor analysis
 * 
 * CRITICAL: This scoring function is used by BOTH backtest and production.
 * Any changes here must maintain consistency between the two.
 * 
 * Formula breakdown:
 * - BB Position (30%): Buy low / Sell high in band
 * - ROC Momentum (25%): Rate of change strength
 * - Volume (20%): Confirmation with volume
 * - ATR Filter (15%): Penalty for excessive volatility
 * - Trend Strength (10%): Alignment with SMA50
 * 
 * @param params.roc5 - Rate of change over 5 periods (e.g., 0.02 = 2%)
 * @param params.volumeRatio - Current volume / 19-period average
 * @param params.bbPosition - Position in BB (0=lower, 0.5=middle, 1=upper)
 * @param params.atrPct - ATR as % of price (e.g., 3.5 = 3.5% volatility)
 * @param params.trendStrength - Price distance from SMA50 (positive=uptrend, negative=downtrend)
 * @param params.side - 'long' or 'short' for directional scoring
 * @returns Quality score (higher = better opportunity)
 */
export function calculateSignalScore(params: {
  roc5: number;
  volumeRatio: number;
  bbPosition: number;
  atrPct: number;
  trendStrength: number;
  side: 'long' | 'short';
}): number {
  const { roc5, volumeRatio, bbPosition, atrPct, trendStrength, side } = params;
  
  // 1. BB Position (30%) - Buy low, sell high
  let bbScore = 0;
  if (side === 'long') {
    // LONG: Prefer buying near lower band (0 = perfect, 1 = worst)
    bbScore = (1 - bbPosition) * 10 * 0.3;
  } else {
    // SHORT: Prefer selling near upper band (1 = perfect, 0 = worst)
    bbScore = bbPosition * 10 * 0.3;
  }
  
  // 2. ROC Momentum (25%) - Strong movement in our direction
  const rocScore = Math.abs(roc5) * 10 * 0.25;
  
  // 3. Volume (20%) - High volume = conviction (cap at 3x)
  const volScore = Math.min(volumeRatio, 3) * 10 * 0.2;
  
  // 4. ATR Filter (15%) - Penalty for high volatility
  // Low ATR (<2%) = full points, High ATR (>5%) = zero points
  const atrScore = Math.max(0, 1 - (atrPct - 2) / 3) * 10 * 0.15;
  
  // 5. Trend Strength (10%) - Alignment with SMA50
  let trendScore = 0;
  if (side === 'long' && trendStrength > 0) {
    // LONG + uptrend = bonus
    trendScore = Math.min(Math.abs(trendStrength) / 0.05, 1) * 10 * 0.1;
  } else if (side === 'short' && trendStrength < 0) {
    // SHORT + downtrend = bonus
    trendScore = Math.min(Math.abs(trendStrength) / 0.05, 1) * 10 * 0.1;
  }
  // Counter-trend = 0 points (no penalty, just no bonus)
  
  return bbScore + rocScore + volScore + atrScore + trendScore;
}

// Backward compatibility: Use V5.22 scoring if only 2 params provided
export function calculateSignalScoreCompat(roc5: number, volumeRatio: number): number {
  return calculateSignalScoreV22(roc5, volumeRatio);
}

class SignalRanker {
  // Pending signals waiting to be evaluated - SEPARATED BY MODE
  // This is critical for parity: paper and live agents receive candles at different times
  // so they must have independent batch windows
  private pendingSignals: Map<string, Map<string, RankedSignal>> = new Map([
    ['paper', new Map()],
    ['live', new Map()],
  ]);
  
  // V5.58: Track slots consumed in current batch to prevent race conditions
  // When an agent's signal is approved, we increment this counter BEFORE
  // they actually reserve capital. This ensures other agents see fewer slots.
  private slotsConsumedInBatch: Map<string, number> = new Map([
    ['paper', 0],
    ['live', 0],
  ]);
  
  // Timeout to batch signals (ms) - wait for all agents to report
  // CRITICAL: This must allow enough time for all agents to submit their signals
  // before any agent checks shouldExecuteSignal()
  private readonly BATCH_WINDOW_MS = 2000; // 2 seconds base window
  private readonly BATCH_EXTENSION_MS = 500; // Extension for late arrivals
  private readonly BATCH_MAX_WINDOW_MS = 4000; // Hard cap on total batch window
  private batchTimeouts: Map<string, NodeJS.Timeout | null> = new Map([
    ['paper', null],
    ['live', null],
  ]);

  // V5.66: Track batch start time to prevent infinite extensions
  private batchStartTimes: Map<string, number> = new Map([
    ['paper', 0],
    ['live', 0],
  ]);

  // Track the candle timestamp that signals are for (prevents mixing signals from different candles)
  private currentBatchCandleTs: number = 0;

  // Promise that resolves when batch window closes (allows agents to wait) - PER MODE
  private batchCompletePromises: Map<string, Promise<void> | null> = new Map([
    ['paper', null],
    ['live', null],
  ]);
  private batchCompleteResolvers: Map<string, (() => void) | null> = new Map([
    ['paper', null],
    ['live', null],
  ]);
  
  /**
   * Add a signal candidate for ranking consideration
   *
   * V5.66: Fixed race condition - batch window now uses fixed start time
   * with limited extension for late arrivals, preventing infinite resets.
   */
  addSignal(signal: RankedSignal): void {
    const mode = signal.mode || 'paper';  // Default to paper for backward compatibility
    const modeSignals = this.pendingSignals.get(mode)!;
    const now = Date.now();

    // Store signal (overwrites if symbol already has pending signal)
    modeSignals.set(signal.symbol, signal);

    // Check if this is a new batch or continuing an existing one
    const batchStartTime = this.batchStartTimes.get(mode) || 0;
    const isNewBatch = !this.batchCompletePromises.get(mode);

    if (isNewBatch) {
      // V5.58: Reset slots consumed counter at start of new batch
      this.slotsConsumedInBatch.set(mode, 0);
      // V5.66: Record batch start time
      this.batchStartTimes.set(mode, now);

      this.batchCompletePromises.set(mode, new Promise<void>((resolve) => {
        this.batchCompleteResolvers.set(mode, resolve);
      }));

      // Set initial batch timer
      this.batchTimeouts.set(mode, setTimeout(() => {
        this.closeBatch(mode);
      }, this.BATCH_WINDOW_MS));

      logger.debug(`📊 [${mode}] New batch started - waiting ${this.BATCH_WINDOW_MS}ms for signals`);
    } else {
      // V5.66: Existing batch - only extend if within allowed window
      const elapsed = now - batchStartTime;
      const remainingToMax = this.BATCH_MAX_WINDOW_MS - elapsed;

      if (remainingToMax > this.BATCH_EXTENSION_MS) {
        // Extend the window slightly for late arrivals
        const existingTimeout = this.batchTimeouts.get(mode);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
        }

        const extensionMs = Math.min(this.BATCH_EXTENSION_MS, remainingToMax);
        this.batchTimeouts.set(mode, setTimeout(() => {
          this.closeBatch(mode);
        }, extensionMs));

        logger.debug(`📊 [${mode}] Batch extended by ${extensionMs}ms for late signal (${signal.symbol})`);
      } else {
        logger.debug(`📊 [${mode}] Batch at max window - no extension for ${signal.symbol}`);
      }
    }
  }

  /**
   * V5.66: Close batch and resolve waiting promises
   */
  private closeBatch(mode: 'live' | 'paper'): void {
    this.flushExpiredSignals(mode);
    this.batchStartTimes.set(mode, 0); // Reset for next batch

    // Resolve the batch promise so waiting agents can proceed
    const resolver = this.batchCompleteResolvers.get(mode);
    if (resolver) {
      const modeSignals = this.pendingSignals.get(mode)!;
      logger.debug(`📊 [${mode}] Batch closed with ${modeSignals.size} signals`);
      resolver();
      this.batchCompletePromises.set(mode, null);
      this.batchCompleteResolvers.set(mode, null);
    }
  }
  
  /**
   * Wait for the current batch window to close
   * This ensures all agents have submitted their signals before ranking
   * 
   * CRITICAL for backtest parity: In backtest, all signals are collected
   * synchronously before ranking. In live, agents run async, so we must
   * wait for the batch window to ensure fair ranking.
   */
  async waitForBatch(mode: 'live' | 'paper' = 'paper'): Promise<void> {
    const promise = this.batchCompletePromises.get(mode);
    if (promise) {
      await promise;
    }
  }
  
  /**
   * Calculate signal quality score
   * V5.23: Enhanced multi-factor scoring
   * 
   * Delegates to shared function to ensure consistency with backtest
   */
  calculateScore(params: {
    roc5: number;
    volumeRatio: number;
    bbPosition: number;
    atrPct: number;
    trendStrength: number;
    side: 'long' | 'short';
  }): number {
    return calculateSignalScore(params);
  }
  
  /**
   * Get top N signals by score for a specific mode
   */
  getTopSignals(maxCount: number, mode: 'live' | 'paper' = 'paper'): RankedSignal[] {
    const modeSignals = this.pendingSignals.get(mode)!;
    const signals = Array.from(modeSignals.values());
    
    // Sort by score descending
    signals.sort((a, b) => b.score - a.score);
    
    // Take top N
    return signals.slice(0, maxCount);
  }
  
  /**
   * V5.58: Get number of slots already consumed in current batch
   * This prevents race conditions where multiple agents think they have slots
   */
  getSlotsConsumedInBatch(mode: 'live' | 'paper' = 'paper'): number {
    return this.slotsConsumedInBatch.get(mode) || 0;
  }
  
  /**
   * Check if a signal should be executed
   * Returns true if this signal is in the top N best opportunities
   * 
   * V5.58: Now accounts for slots already consumed by other signals in this batch
   * to prevent race conditions where multiple agents all pass the ranking check
   */
  shouldExecuteSignal(symbol: string, availableSlots: number, mode: 'live' | 'paper' = 'paper'): boolean {
    // V5.58: Subtract slots already consumed in this batch
    const consumed = this.slotsConsumedInBatch.get(mode) || 0;
    const effectiveSlots = Math.max(0, availableSlots - consumed);
    
    if (effectiveSlots === 0) {
      logger.info(`⏸️ [${symbol.replace('/USDT:USDT', '')}] Signal DEFERRED - all ${availableSlots} slots consumed by higher-ranked signals in this batch`);
      return false;
    }
    
    const topSignals = this.getTopSignals(effectiveSlots, mode);
    const isTopSignal = topSignals.some(s => s.symbol === symbol);
    
    const modeSignals = this.pendingSignals.get(mode)!;
    if (!isTopSignal && modeSignals.size > 0) {
      const currentSignal = modeSignals.get(symbol);
      if (currentSignal) {
        logger.info(`⏸️ [${symbol.replace('/USDT:USDT', '')}] Signal DEFERRED (score=${currentSignal.score.toFixed(2)}) - not in top ${effectiveSlots} opportunities (${consumed} slots already consumed)`);
      }
    }
    
    // V5.58: If approved, consume a slot to prevent other agents from using it
    if (isTopSignal) {
      this.slotsConsumedInBatch.set(mode, consumed + 1);
      logger.info(`🎯 [${symbol.replace('/USDT:USDT', '')}] Signal APPROVED - consuming slot ${consumed + 1}/${availableSlots} for ${mode}`);
    }
    
    return isTopSignal;
  }
  
  /**
   * Remove a signal from pending (called after execution or when invalidated)
   */
  removeSignal(symbol: string, mode: 'live' | 'paper' = 'paper'): void {
    const modeSignals = this.pendingSignals.get(mode)!;
    modeSignals.delete(symbol);
  }
  
  /**
   * Clear signals older than 5 minutes (stale) for a specific mode
   */
  private flushExpiredSignals(mode: 'live' | 'paper' = 'paper'): void {
    const now = Date.now();
    const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
    
    const modeSignals = this.pendingSignals.get(mode)!;
    for (const [symbol, signal] of modeSignals.entries()) {
      if (now - signal.timestamp > EXPIRY_MS) {
        logger.info(`🧹 [${symbol.replace('/USDT:USDT', '')}] Signal expired after 5min - removing`);
        modeSignals.delete(symbol);
      }
    }
  }
  
  /**
   * Get current pending signals (for debugging)
   */
  getPendingSignals(mode: 'live' | 'paper' = 'paper'): RankedSignal[] {
    const modeSignals = this.pendingSignals.get(mode)!;
    return Array.from(modeSignals.values());
  }
  
  /**
   * Clear all pending signals (e.g., on agent restart)
   */
  clear(mode?: 'live' | 'paper'): void {
    if (mode) {
      this.pendingSignals.get(mode)!.clear();
      const timeout = this.batchTimeouts.get(mode);
      if (timeout) {
        clearTimeout(timeout);
        this.batchTimeouts.set(mode, null);
      }
    } else {
      // Clear all modes
      this.pendingSignals.get('paper')!.clear();
      this.pendingSignals.get('live')!.clear();
      for (const [m, timeout] of this.batchTimeouts.entries()) {
        if (timeout) {
          clearTimeout(timeout);
          this.batchTimeouts.set(m, null);
        }
      }
    }
  }
}

// Global singleton instance shared across all agents
export const globalSignalRanker = new SignalRanker();
