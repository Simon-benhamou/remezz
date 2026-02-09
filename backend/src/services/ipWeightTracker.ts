/**
 * IP Weight Tracker - Global singleton for Binance API weight monitoring.
 *
 * Tracks ALL REST API weight consumed per minute across the entire server.
 * Unlike binanceRestQueue (which only tracks queued calls), this also captures
 * direct exchange calls: SL placement, trailing stops, cancelOrder, setLeverage, etc.
 *
 * Provides:
 * - record(): Log weight after any REST call
 * - canMakeCall(): Check if budget allows a call
 * - waitForBudget(): Async throttle until budget available
 * - getStats(): Expose to /api/health
 */

import { IP_WEIGHT } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ip-weight');

interface WeightEntry {
  timestamp: number;
  weight: number;
  caller: string;
}

class IpWeightTracker {
  private readonly MAX_WEIGHT = IP_WEIGHT.MAX_PER_MINUTE;
  private readonly SOFT_LIMIT = IP_WEIGHT.SOFT_LIMIT;
  private entries: WeightEntry[] = [];
  private cleanupTimer: NodeJS.Timeout | null = null;
  private totalRecorded = 0;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), IP_WEIGHT.CLEANUP_INTERVAL_MS);
    // Allow GC if process is shutting down
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Record weight consumed by a REST call */
  record(weight: number, caller: string): void {
    this.entries.push({ timestamp: Date.now(), weight, caller });
    this.totalRecorded += weight;

    const current = this.getCurrentWeight();
    if (current > this.SOFT_LIMIT) {
      logger.warn(`⚠️ API weight at ${current}/${this.MAX_WEIGHT} (${Math.round(current / this.MAX_WEIGHT * 100)}%) - caller: ${caller}`);
    }
  }

  /** Check if a call of given weight can proceed without exceeding hard limit */
  canMakeCall(weight: number): boolean {
    return this.getCurrentWeight() + weight <= this.MAX_WEIGHT;
  }

  /** Get total weight consumed in the last 60 seconds */
  getCurrentWeight(): number {
    const cutoff = Date.now() - 60_000;
    let total = 0;
    for (const entry of this.entries) {
      if (entry.timestamp >= cutoff) total += entry.weight;
    }
    return total;
  }

  /**
   * Wait until there's enough budget for the call.
   * Returns true if budget became available, false on timeout.
   */
  async waitForBudget(weight: number, caller: string, timeoutMs: number = 30_000): Promise<boolean> {
    const start = Date.now();
    while (!this.canMakeCall(weight)) {
      if (Date.now() - start > timeoutMs) {
        logger.warn(`⏰ waitForBudget timeout after ${timeoutMs}ms for ${caller} (weight=${weight}, current=${this.getCurrentWeight()})`);
        return false;
      }
      // Wait 500ms and check again
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return true;
  }

  /** Stats for /api/health */
  getStats(): {
    currentWeight: number;
    maxWeight: number;
    softLimit: number;
    pctUsed: number;
    callsLastMinute: number;
    totalRecorded: number;
  } {
    const currentWeight = this.getCurrentWeight();
    const cutoff = Date.now() - 60_000;
    let callsLastMinute = 0;
    for (const entry of this.entries) {
      if (entry.timestamp >= cutoff) callsLastMinute++;
    }
    return {
      currentWeight,
      maxWeight: this.MAX_WEIGHT,
      softLimit: this.SOFT_LIMIT,
      pctUsed: Math.round(currentWeight / this.MAX_WEIGHT * 100),
      callsLastMinute,
      totalRecorded: this.totalRecorded,
    };
  }

  /** Top callers in the last minute (for debugging) */
  getTopCallers(limit: number = 5): { caller: string; weight: number; count: number }[] {
    const cutoff = Date.now() - 60_000;
    const callerMap = new Map<string, { weight: number; count: number }>();
    for (const entry of this.entries) {
      if (entry.timestamp < cutoff) continue;
      const existing = callerMap.get(entry.caller);
      if (existing) {
        existing.weight += entry.weight;
        existing.count++;
      } else {
        callerMap.set(entry.caller, { weight: entry.weight, count: 1 });
      }
    }
    return [...callerMap.entries()]
      .map(([caller, data]) => ({ caller, ...data }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit);
  }

  /** Remove entries older than 60 seconds */
  private cleanup(): void {
    const cutoff = Date.now() - 60_000;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => e.timestamp >= cutoff);
    if (before > this.entries.length + 50) {
      logger.debug(`Cleaned ${before - this.entries.length} stale weight entries`);
    }
  }

  /** Stop cleanup timer (for tests) */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

export const ipWeightTracker = new IpWeightTracker();
