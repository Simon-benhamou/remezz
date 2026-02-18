/**
 * capitalPool.ts — Shared Capital Management
 *
 * V5.108: Extracted from simpleAgent.ts for separation of concerns.
 * Manages shared capital allocation across multiple trading agents.
 *
 * Features:
 * - Atomic reserve → commit → release lifecycle
 * - Live mode sync with Binance via WebSocket + REST fallback
 * - Skip-N-trades-then-resume rule after consecutive losers
 * - Per-user pools with paper/live separation
 */

import { SYNC_INTERVALS } from '../config/constants.js';
import { getBalanceFromWebSocket } from '../services/binanceWebSocket.js';
import { notifySyncFailure } from '../services/notificationService.js';
import { ipWeightTracker } from '../services/ipWeightTracker.js';
import { isIpBanned } from '../exchange/ccxtClient.js';
import { MomentumConfig } from './momentumSimple.js';
import type { Exchange } from '../types/exchange.js';

// ============================================================================
// CAPITAL POOL - Shared between all agents
// ============================================================================

export class CapitalPool {
  private totalCapitalUsd: number;
  private reservedByAgent: Map<string, number> = new Map();
  private inPositionByAgent: Map<string, number> = new Map();

  // Live mode: sync with real Binance balance
  private mode: 'paper' | 'live';
  private userId: string | null = null;
  private lastBalanceSync: number = 0;
  private readonly BALANCE_SYNC_INTERVAL_MS = SYNC_INTERVALS.BALANCE_MS;
  private hasEverSynced: boolean = false; // Track if we've ever successfully synced

  // 🔧 FIX: Store exchange reference for REST fallback when WebSocket cache is empty
  private exchange: Exchange | null = null;

  // V5.65: Atomic lock for reserve operations to prevent race conditions
  // When multiple agents try to reserve simultaneously, this ensures only one
  // can check+reserve at a time
  private reserveLock: Promise<void> = Promise.resolve();
  private reserveLockResolve: (() => void) | null = null;

  // V5.63: Skip-N-trades-then-resume rule after consecutive losers
  // Testing showed: Skip 1 trade after 2 consecutive losers = +70% PnL improvement
  // Skips more losers (727) than winners (382), improves win rate 58.5% → 66.7%
  private consecutiveLosers: number = 0;
  private tradesToSkip: number = 0;
  private readonly CONSECUTIVE_LOSER_THRESHOLD = 2;  // Trigger after this many consecutive losers
  private readonly TRADES_TO_SKIP = 1;               // Skip this many trades, then resume

  constructor(initialCapitalUsd: number, mode: 'paper' | 'live' = 'paper', userId?: string, exchange?: Exchange) {
    this.totalCapitalUsd = initialCapitalUsd;
    this.mode = mode;
    this.userId = userId || null;
    this.exchange = exchange || null;
    // Paper mode uses provided capital directly (no exchange sync needed)
    // Live mode requires syncing with exchange before trading
    this.hasEverSynced = (mode === 'paper');
    console.log(`[CapitalPool] Created ${mode} pool with $${initialCapitalUsd}${mode === 'live' ? ' (will sync with Binance)' : ''}`);
  }

  /**
   * Set the exchange reference (for REST fallback)
   */
  setExchange(exchange: Exchange): void {
    this.exchange = exchange;
  }

  /**
   * Get available capital for new positions
   *
   * IMPORTANT: In both modes, we calculate:
   *   available = totalCapital - reserved - inPosition
   *
   * - PAPER: totalCapital is our virtual balance (updated with PnL)
   * - LIVE: totalCapital is synced from Binance (already includes unrealized PnL in wallet balance)
   *
   * The reservedByAgent and inPositionByAgent track OUR local state of what we've committed,
   * which prevents double-spending when multiple agents try to open positions simultaneously.
   */
  getAvailableCapital(): number {
    let reserved = 0;
    let inPosition = 0;
    this.reservedByAgent.forEach(v => reserved += v);
    this.inPositionByAgent.forEach(v => inPosition += v);
    const available = Math.max(0, this.totalCapitalUsd - reserved - inPosition);
    return available;
  }

  /**
   * Get total capital (for display/logging)
   */
  getTotalCapital(): number {
    return this.totalCapitalUsd;
  }

  /**
   * Get total margin in positions (for display/logging)
   */
  getInPositionsTotal(): number {
    let total = 0;
    this.inPositionByAgent.forEach(v => total += v);
    return total;
  }

  /**
   * Sync total capital with real Binance balance (live mode only)
   * @param force - If true, skip the throttle check and force sync
   * @returns true if sync was successful or not needed (paper mode), false otherwise
   */
  async syncWithExchange(force: boolean = false): Promise<boolean> {
    // Paper mode uses provided capital, no exchange sync needed - always considered "synced"
    if (this.mode !== 'live' || !this.userId) return true;

    const now = Date.now();
    if (!force && now - this.lastBalanceSync < this.BALANCE_SYNC_INTERVAL_MS) {
      return this.hasEverSynced; // Return whether we've ever synced successfully
    }

    try {
      // 1. Try WebSocket cache first (0 weight, instant)
      let balance = await getBalanceFromWebSocket(this.userId, 'USDT');

      // 2. 🔧 FIX: Only fall back to REST if:
      //    - WebSocket cache is completely empty (balance is null)
      //    - AND we have NEVER synced before (hasEverSynced = false)
      //    - AND force flag is set
      // This prevents excessive REST calls during temporary WS disconnections
      const shouldFallbackToRest = !balance && (!this.hasEverSynced || force) && this.exchange && this.exchange.fetchBalance && !isIpBanned();

      if (shouldFallbackToRest && this.exchange?.fetchBalance) {
        console.log(`[CapitalPool] WebSocket cache empty on ${force ? 'forced' : 'initial'} sync, falling back to REST fetchBalance...`);
        try {
          const restBalance = await this.exchange.fetchBalance({ type: 'future' });
          ipWeightTracker.record(5, `fetchBalance:pool:${this.userId}`);
          const totalUsdt = parseFloat(String(restBalance?.total?.USDT ?? restBalance?.USDT?.total ?? '0')) || 0;
          const freeUsdt = parseFloat(String(restBalance?.free?.USDT ?? restBalance?.USDT?.free ?? '0')) || 0;

          if (totalUsdt > 0) {
            balance = { asset: 'USDT', total: totalUsdt, free: freeUsdt, locked: totalUsdt - freeUsdt, timestamp: Date.now() };
            // Seed the cache for next time
            const { seedBalanceCache } = await import('../services/binanceWebSocket.js');
            seedBalanceCache(this.userId!, 'USDT', { total: totalUsdt, free: freeUsdt, locked: totalUsdt - freeUsdt });
            console.log(`[CapitalPool] REST fallback successful: $${totalUsdt.toFixed(2)}`);
          }
        } catch (restErr: any) {
          // 🔧 FIX: Log rate limit errors differently
          if (restErr.message?.includes('429') || restErr.message?.includes('banned') || restErr.message?.includes('Too Many')) {
            console.error(`[CapitalPool] ⚠️ REST API rate limited - user data stream may not be connected!`, restErr.message);
          } else {
            console.warn(`[CapitalPool] REST fallback failed:`, restErr.message || restErr);
          }
        }
      } else if (!balance && this.hasEverSynced) {
        // WebSocket cache miss but we've synced before - just use existing balance
        // This is normal during temporary WS disconnections
        console.log(`[CapitalPool] WebSocket cache miss, using existing balance: $${this.totalCapitalUsd.toFixed(2)} (hasEverSynced=true)`);
      }

      if (balance && balance.total > 0) {
        const oldTotal = this.totalCapitalUsd;
        // Use wallet balance (total = free + locked/margin used by exchange)
        // This is our "base" capital - the inPositionByAgent tracks what WE have committed
        this.totalCapitalUsd = balance.total;
        this.lastBalanceSync = now;
        this.hasEverSynced = true;

        if (Math.abs(oldTotal - this.totalCapitalUsd) > 0.01) {
          const inPos = this.getInPositionsTotal();
          console.log(`[CapitalPool] Live balance synced: $${oldTotal.toFixed(2)} → $${this.totalCapitalUsd.toFixed(2)} | inPosition=$${inPos.toFixed(2)} | available=$${this.getAvailableCapital().toFixed(2)}`);
        }
        return true;
      } else {
        // Only warn if we have no valid existing balance (real problem)
        // If we have an existing balance, this is just a temporary cache miss
        if (this.totalCapitalUsd <= 0) {
          console.warn(`[CapitalPool] Balance fetch returned empty or zero - no existing balance to use!`);

          // 📢 NOTIFICATION: Sync failure (only if we've never synced AND have no balance)
          if (!this.hasEverSynced) {
            notifySyncFailure({
              reason: 'Balance fetch returned empty or zero. Check API credentials and WebSocket connection.',
              mode: this.mode,
              userId: this.userId || undefined,
            });
          }
        }
        // If we have existing balance, just silently use it (common at startup)

        return this.hasEverSynced || this.totalCapitalUsd > 0;
      }
    } catch (err) {
      console.warn(`[CapitalPool] Failed to sync balance:`, err);

      // 📢 NOTIFICATION: Sync failure (only if we've never synced)
      if (!this.hasEverSynced) {
        notifySyncFailure({
          reason: `Failed to sync: ${(err as Error)?.message || 'Unknown error'}`,
          mode: this.mode,
          userId: this.userId || undefined,
        });
      }

      return this.hasEverSynced;
    }
  }

  /**
   * Check if the pool has a valid balance to trade with
   * Returns true if we've synced OR if we have a valid existing balance
   */
  isSynced(): boolean {
    // Consider synced if we have a valid balance, even if WebSocket sync failed
    // The initial balance was fetched via REST at startup
    return this.hasEverSynced || this.totalCapitalUsd > 0;
  }

  /**
   * V5.65: Acquire lock for atomic reserve operations
   * This prevents race conditions when multiple agents try to reserve simultaneously
   */
  private async acquireReserveLock(): Promise<void> {
    // Wait for any pending reservation to complete
    await this.reserveLock;

    // Create new lock for this reservation
    this.reserveLock = new Promise<void>((resolve) => {
      this.reserveLockResolve = resolve;
    });
  }

  /**
   * V5.65: Release lock after reserve operation
   */
  private releaseReserveLock(): void {
    if (this.reserveLockResolve) {
      this.reserveLockResolve();
      this.reserveLockResolve = null;
    }
  }

  /**
   * Reserve capital for a potential trade (ATOMIC operation)
   * This is a temporary hold before the order is placed
   *
   * V5.65: Made async with lock to prevent race conditions
   */
  async reserve(agentId: string, amountUsd: number): Promise<boolean> {
    await this.acquireReserveLock();

    try {
      const available = this.getAvailableCapital();
      if (amountUsd > available) {
        console.log(`[CapitalPool] Cannot reserve $${amountUsd.toFixed(2)} for ${agentId}, only $${available.toFixed(2)} available (total=$${this.totalCapitalUsd.toFixed(2)}, inPos=$${this.getInPositionsTotal().toFixed(2)})`);
        return false;
      }

      const current = this.reservedByAgent.get(agentId) || 0;
      this.reservedByAgent.set(agentId, current + amountUsd);
      console.log(`[CapitalPool] Reserved $${amountUsd.toFixed(2)} for ${agentId} | available after: $${(available - amountUsd).toFixed(2)}`);
      return true;
    } finally {
      this.releaseReserveLock();
    }
  }

  /**
   * Commit reserved capital to an open position
   * Called after the order is successfully placed on the exchange
   */
  commit(agentId: string, amountUsd: number): void {
    // Move from reserved to in-position
    const reserved = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, Math.max(0, reserved - amountUsd));

    const inPos = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, inPos + amountUsd);
    console.log(`[CapitalPool] Committed $${amountUsd.toFixed(2)} for ${agentId} | total inPosition: $${this.getInPositionsTotal().toFixed(2)}`);
  }

  /**
   * Release capital when position is closed
   *
   * IMPORTANT DIFFERENCE between modes:
   * - PAPER: We must add PnL to totalCapitalUsd manually (no real exchange)
   * - LIVE: We should NOT add PnL because the Binance balance already includes it.
   *         We just clear our local tracking, then sync with exchange to get real balance.
   */
  release(agentId: string, amountUsd: number, pnlUsd: number = 0): void {
    const inPosBefore = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, Math.max(0, inPosBefore - amountUsd));

    // Only add PnL in PAPER mode - in LIVE mode, the exchange balance already includes it
    if (this.mode === 'paper') {
      this.totalCapitalUsd += pnlUsd;
      console.log(`[CapitalPool] PAPER Released $${amountUsd.toFixed(2)} for ${agentId} | PnL: $${pnlUsd.toFixed(2)} | New Total: $${this.totalCapitalUsd.toFixed(2)}`);
    } else {
      // In LIVE mode, just release the tracking - the sync will update totalCapitalUsd from Binance
      console.log(`[CapitalPool] LIVE Released $${amountUsd.toFixed(2)} for ${agentId} | PnL: $${pnlUsd.toFixed(2)} (will sync from exchange)`);
    }
  }

  /**
   * Force sync after position close in live mode
   * This ensures totalCapitalUsd reflects the real balance including realized PnL
   */
  async syncAfterPositionClose(): Promise<void> {
    if (this.mode === 'live') {
      console.log(`[CapitalPool] Forcing sync after position close...`);
      await this.syncWithExchange(true);
    }
  }

  /**
   * Cancel a reservation (when order fails or is cancelled)
   */
  cancelReservation(agentId: string): void {
    const reserved = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.delete(agentId);
    if (reserved > 0) {
      console.log(`[CapitalPool] Cancelled reservation of $${reserved.toFixed(2)} for ${agentId}`);
    }
  }

  /**
   * Get pool status for monitoring/display
   */
  getStatus(): {
    totalUsd: number;
    availableUsd: number;
    reservedUsd: number;
    inPositionsUsd: number;
    mode: 'paper' | 'live';
    lastSync: number;
    consecutiveLosers: number;  // V5.63: Current consecutive loser count
    tradesToSkip: number;       // V5.63: Trades remaining to skip
    entryBlocked: boolean;      // V5.63: True if currently in skip mode
    byAgent: Record<string, { reserved: number; inPosition: number }>;
  } {
    let reservedTotal = 0;
    let inPositionTotal = 0;
    const byAgent: Record<string, { reserved: number; inPosition: number }> = {};

    this.reservedByAgent.forEach((v, k) => {
      reservedTotal += v;
      if (!byAgent[k]) byAgent[k] = { reserved: 0, inPosition: 0 };
      byAgent[k].reserved = v;
    });

    this.inPositionByAgent.forEach((v, k) => {
      inPositionTotal += v;
      if (!byAgent[k]) byAgent[k] = { reserved: 0, inPosition: 0 };
      byAgent[k].inPosition = v;
    });

    return {
      totalUsd: this.totalCapitalUsd,
      availableUsd: this.getAvailableCapital(),
      reservedUsd: reservedTotal,
      inPositionsUsd: inPositionTotal,
      mode: this.mode,
      lastSync: this.lastBalanceSync,
      consecutiveLosers: this.consecutiveLosers,
      tradesToSkip: this.tradesToSkip,
      entryBlocked: this.isInSkipMode(),  // Use read-only method
      byAgent,
    };
  }

  /**
   * V5.18: Get number of currently open positions
   * Used for adaptive max positions based on capital
   *
   * V5.44 FIX: Now includes RESERVED positions (pending entry orders)
   * to prevent race conditions where multiple signals pass the max check
   * before any of them commit.
   */
  getOpenPositionCount(): number {
    let count = 0;
    // Count committed positions (already in position)
    this.inPositionByAgent.forEach((v) => {
      if (v > 0) count++;
    });
    // V5.44: Also count reserved positions (entry order pending)
    // This prevents race conditions where multiple agents pass the check simultaneously
    this.reservedByAgent.forEach((v) => {
      if (v > 0) count++;
    });
    return count;
  }

  /**
   * V5.18: Calculate dynamic max positions based on account capital
   * Larger accounts can have more concurrent positions for better capital utilization
   */
  getMaxPositions(): number {
    const maxPositions = Math.min(
      MomentumConfig.RISK.MAX_POSITIONS_BASE + Math.floor(this.totalCapitalUsd / 1500) * MomentumConfig.RISK.POSITIONS_PER_1500,
      MomentumConfig.RISK.MAX_POSITIONS_CAP
    );
    return maxPositions;
  }

  /**
   * Set total capital (used when user updates paper balance)
   */
  setTotalCapital(newTotalUsd: number): void {
    this.totalCapitalUsd = newTotalUsd;
    console.log(`[CapitalPool] Total capital set to $${newTotalUsd}`);
  }

  /**
   * Get current mode
   */
  getMode(): 'paper' | 'live' {
    return this.mode;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V5.63: SKIP-N-TRADES-THEN-RESUME RULE
  // After 2 consecutive losers, skip the next N trades, then resume
  // Testing showed: Skip 1 = +70% PnL, skips 2x more losers than winners
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a trade result (winner or loser)
   * Call this after every position close to track consecutive losers
   * @param isWinner - true if trade was profitable (pnlPct > 0)
   * @param symbol - symbol for logging
   */
  recordTradeResult(isWinner: boolean, symbol?: string): void {
    if (isWinner) {
      if (this.consecutiveLosers > 0) {
        console.log(`[CapitalPool] 🔄 ${symbol || ''} WIN resets consecutive losers: ${this.consecutiveLosers} → 0`);
      }
      this.consecutiveLosers = 0;
    } else {
      this.consecutiveLosers++;
      console.log(`[CapitalPool] 📉 ${symbol || ''} LOSS - consecutive losers now: ${this.consecutiveLosers}`);

      // Trigger skip-N rule when threshold reached
      if (this.consecutiveLosers >= this.CONSECUTIVE_LOSER_THRESHOLD) {
        this.tradesToSkip = this.TRADES_TO_SKIP;
        this.consecutiveLosers = 0; // Reset counter after triggering
        console.log(`[CapitalPool] 🛑 Skip rule triggered! Will skip next ${this.TRADES_TO_SKIP} trade(s)`);
      }
    }
  }

  /**
   * Check if entry should be skipped and decrement skip counter
   * Returns true if we should skip this entry
   * IMPORTANT: This decrements the counter, so only call once per entry attempt
   */
  shouldSkipEntry(): boolean {
    if (this.tradesToSkip > 0) {
      this.tradesToSkip--;
      console.log(`[CapitalPool] 🛑 Skipping entry (${this.tradesToSkip} more to skip after this)`);
      return true;
    }
    return false;
  }

  /**
   * Check if currently in skip mode (without decrementing)
   * Use this for display/logging purposes
   */
  isInSkipMode(): boolean {
    return this.tradesToSkip > 0;
  }

  /**
   * Get current skip state (for display/logging)
   */
  getSkipState(): { consecutiveLosers: number; tradesToSkip: number } {
    return {
      consecutiveLosers: this.consecutiveLosers,
      tradesToSkip: this.tradesToSkip,
    };
  }

  /**
   * Reset skip state (e.g., at start of new session)
   */
  resetSkipState(): void {
    this.consecutiveLosers = 0;
    this.tradesToSkip = 0;
    console.log(`[CapitalPool] Skip state reset`);
  }

  /**
   * Debug: Log full state
   */
  debugLog(context: string): void {
    const status = this.getStatus();
    console.log(`[CapitalPool DEBUG - ${context}]`, {
      mode: status.mode,
      total: `$${status.totalUsd.toFixed(2)}`,
      available: `$${status.availableUsd.toFixed(2)}`,
      reserved: `$${status.reservedUsd.toFixed(2)}`,
      inPositions: `$${status.inPositionsUsd.toFixed(2)}`,
      byAgent: status.byAgent,
    });
  }
}

// Per-user capital pools - separate pools for paper and live
const userCapitalPools = new Map<string, CapitalPool>();

/**
 * Get pool key - includes mode to allow paper + live simultaneously
 */
function getPoolKey(userId: string, mode?: 'paper' | 'live'): string {
  return mode ? `${userId}_${mode}` : userId;
}

export function getCapitalPool(userId: string, initialCapital?: number, mode?: 'paper' | 'live'): CapitalPool | null {
  if (!userId) return null;

  const key = getPoolKey(userId, mode);
  let pool = userCapitalPools.get(key);
  if (!pool && initialCapital !== undefined) {
    pool = new CapitalPool(initialCapital, mode || 'paper', userId);
    userCapitalPools.set(key, pool);
  }
  return pool || null;
}

export function resetCapitalPool(userId: string, initialCapital: number, mode: 'paper' | 'live' = 'paper'): CapitalPool {
  const key = getPoolKey(userId, mode);
  const pool = new CapitalPool(initialCapital, mode, userId);
  userCapitalPools.set(key, pool);
  console.log(`[CapitalPool] Reset ${mode} pool for user ${userId} with $${initialCapital}`);
  return pool;
}
