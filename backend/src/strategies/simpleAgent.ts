/**
 * Simple Agent - Remplace 15,000 lignes de code complexe
 * 
 * Stratégie validée: Vol 5x + BTC MA50 + 6h momentum > 0.75%
 * Performance: 91% mois positifs (10/11)
 * 
 * Features:
 * - Capital Pool partagé entre agents
 * - Trailing Stop intelligent
 * - Support Long ET Short
 * - Market Conditions Status
 */

import { PrismaClient } from '@prisma/client';
import {
  MomentumConfig,
  checkMomentumSignal,
  shouldExitPosition,
  updatePositionWaterMarks,
  getMarketConditions,
  getCooldownBars,  // V5.41: Shared cooldown logic
  calculateExitNowMs,  // V5.45: Shared exit time calculation for parity
  calcROC,             // Shared indicator
  calcATR,             // Shared indicator
  calcBBPosition,      // Shared indicator
  calcTrendStrength,   // Shared indicator
  calcVolRatio,        // Shared indicator

  type Candle,
  type Position,
  type MarketConditions,
} from './momentumSimple.js';
import { createLogger, runWithUserId } from '../utils/logger.js';
import { globalSignalRanker } from './signalRanker.js';

import {
  getBinanceWebSocket,
  getKlinesWithMeta,  // V5.50: Added for accurate candle close detection using isFinal flag
  seedKlinesFromWebSocket,
  getBalanceFromWebSocket,
  getPositionFromWebSocket,
  getLastFilledOrderTradeUpdateFromWebSocket,
  isUserDataStreamActive,
  type BinanceKlineData,
} from '../services/binanceWebSocket.js';
import { globalRestCircuitBreaker } from '../services/globalRestCircuitBreaker.js';
import {
  notifyTradeExit,
  notifyOrderError,
  notifyTrailingActivated,
  notifyRegimeChange,
  notifyAgentStarted,
  notifyAgentStopped,
  notifyLongHold,
  notifyLiquidationWarning,
  notifySyncFailure,
  notifySignalDetected,
} from '../services/notificationService.js';
import { notifyPositionClosed } from '../utils/notifications.js';
import { trackRejectedSignal, recordTrade, updateAgentState } from '../services/telegramReporter.js';
import { orderQueue, type OrderRequest } from '../services/orderQueue.js';
import { calculateOrderPriority, type ExitReason } from '../services/orderPriority.js';
import { exchangeAPIDeduplicator, makeFetchMyTradesKey } from '../services/apiDeduplicator.js';
import { v4 as uuidv4 } from 'uuid';
import { CACHE_TTLS, SYNC_INTERVALS } from '../config/constants.js';
import { globalCacheManager } from './cacheManager.js';
import { PositionPersistence } from './positionPersistence.js';
import {
  EXIT_TRAIL, EXIT_TRAIL_NFS_HIGH_15M,
  EXIT_TRAIL_NFS_MED_15M, EXIT_TRAIL_NFS_LOW_15M, EXIT_TRAIL_PROACTIVE_15M,
  EXIT_SL_EXCHANGE, EXIT_TRAIL_EXCHANGE,
  EXIT_STAGNANT,
  EXIT_SIGNAL_REASON_MAP, toCanonical,
} from '../types/exitReasons.js';
import { ExchangeOrderManager } from './exchangeOrderManager.js';
import { PositionOpener } from './positionOpener.js';
import { RealtimeExitHandler } from './realtimeExitHandler.js';
import { ipWeightTracker } from '../services/ipWeightTracker.js';
import { isIpBanned, setGeoBlock } from '../exchange/ccxtClient.js';
import { symbolEngineManager } from './symbolEngineManager.js';
import type { SymbolSignalResult } from './symbolEngine.js';
import {
  type Candle as NfsCandle,
} from '../services/nfsRealtimeExit.js';
import {
  updateSymbolState,
  calculateProximityScore,
  type SignalFeatures,
} from '../services/signalRadarService.js';

const logger = createLogger('agent');

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Global caches (BTC candles, leverage) are managed by globalCacheManager

// Exchange type imported from centralized types
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

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface SimpleAgentConfig {
  // Exchange
  exchange: Exchange;
  
  // Database
  prisma: PrismaClient;
  
  // Session
  userId: string;
  sessionId: string;
  
  // Capital - Use shared pool
  capitalPool: CapitalPool;
  riskPerTradePct: number;  // Ex: 1 = 1%
  
  // Symbol for this agent
  symbol: string;  // Ex: 'BTC/USDT:USDT'
  
  // Mode
  mode: 'paper' | 'live';
  
  // Optionnel: callbacks
  onSignal?: (signal: SignalEvent) => void;
  onTrade?: (trade: TradeEvent) => void;
  onError?: (error: Error) => void;
  onMarketConditions?: (conditions: MarketConditions) => void;
  onTick?: (tick: TickEvent) => void;
}

export interface TickEvent {
  symbol: string;
  price: number;
  hasPosition: boolean;
  positionSide?: 'long' | 'short';
  support?: number;
  resistance?: number;
  tickCount: number;
  timestamp: Date;
}

export interface SignalEvent {
  symbol: string;
  side: 'long' | 'short';
  reason: string;
  timestamp: Date;
}

export interface TradeEvent {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  orderId: string;
  timestamp: Date;
}

// ============================================================================
// SIMPLE AGENT CLASS
// ============================================================================

export class SimpleAgent {
  private config: SimpleAgentConfig;
  private persistence: PositionPersistence;
  private orderManager: ExchangeOrderManager;
  private positionOpener: PositionOpener;
  private rtExitHandler: RealtimeExitHandler;
  private position: Position | null = null;

  // V5.30: Multi-position support - additional positions for large accounts
  private additionalPositions: Position[] = [];

  private running = false;
  private tickIntervalId: NodeJS.Timeout | null = null;
  private tickAlignTimeoutId: NodeJS.Timeout | null = null; // V5.39: For synchronized tick alignment
  private finalKlineUnsubscribe: (() => void) | null = null; // V5.50: Instant candle close detection

  private closingPosition = false;

  private lastMarketConditions: MarketConditions | null = null;
  private tickCount: number = 0;
  private lastTickAt: number = 0;
  private lastPrice: number = 0;
  private lastRejectReason: string = ''; // Track why no signal
  
  // Current trading state for frontend display
  private currentBias: 'long' | 'short' | null = null;
  private lastSignal: {
    entryZone?: [number, number];
    stopDistance?: number;
    targets?: number[];
    targetPcts?: number[];
  } | null = null;
  private lastExit: { ts: number; price: number; reason: string } | null = null;
  
  // V5.5: Track signal features for market quality assessment
  private lastSignalFeatures: {
    volRatio: number;
    roc: number;
    bbDistance: number;  // % distance from BB upper/lower
    reason: string;
  } | null = null;

  // V5.71: Cache last known BTC regime for real-time Signal Radar
  private lastKnownRegime: 'BULL' | 'BEAR' | 'NEUTRAL' | null = null; // null = not yet calculated
  
  // Track trailing stop activation (to notify only once)
  private trailingNotified: boolean = false;
  
  // V5.12: Track if trailing has been widened (for SMART trailing)
  private trailingWidened: boolean = false;
  private stagnantSlUpdated: boolean = false;  // V5.81: Track if exchange SL was tightened for stagnant
  
  // V5.11: Track last processed candle timestamp to sync with backtest
  // Only check entry signals when a NEW 15m candle closes (not on every tick)
  private lastProcessedCandleTs: number = 0;

  // Backtest parity: only evaluate exits on NEWLY CLOSED candles too.
  private lastProcessedExitCandleTs: number = 0;
  
  // V5.22/V5.23: Helper methods for signal scoring
  // Indicator helpers removed - using shared imports from momentumSimple.ts

  // Backtest parity: apply a post-exit cooldown to avoid immediate re-entries.
  // Backtest service uses 8 bars (2h) cooldown after any exit.
  private readonly ENTRY_COOLDOWN_BARS = 8;
  private entryCooldownBarsRemaining: number = 0;
  
  // Cache pour éviter trop d'appels API (per-symbol only, BTC is global)
  private candleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS = CACHE_TTLS.SYMBOL_CANDLE_MS;
  private wsSubscribed = false; // Track if WebSocket kline subscription is active
  
  // Guard against concurrent tick execution (prevents re-entrancy/recursion)
  private tickInProgress = false;
  
  // Position sync throttling (WebSocket is primary, REST is fallback)
  private lastPositionSync: number = 0;
  private readonly POSITION_SYNC_INTERVAL_MS = SYNC_INTERVALS.POSITION_MS;

  // V5.13: Missing trade reconciliation throttling
  private lastMissingTradesCheck: number = 0;
  private readonly MISSING_TRADES_CHECK_INTERVAL_MS = SYNC_INTERVALS.MISSING_TRADES_MS;
  
  constructor(config: SimpleAgentConfig) {
    this.config = config;
    this.persistence = new PositionPersistence({
      prisma: config.prisma,
      sessionId: config.sessionId,
      symbol: config.symbol,
      mode: config.mode,
    });
    this.orderManager = new ExchangeOrderManager(config.exchange, config.symbol, config.mode, config.userId);

    // Initialize RealtimeExitHandler (owns NFS system + proactive limit state)
    this.rtExitHandler = new RealtimeExitHandler({
      symbol: config.symbol,
      mode: config.mode,
      userId: config.userId,
      getPosition: () => this.position,
      isRunning: () => this.running,
      isClosingPosition: () => this.closingPosition,
      setClosingPosition: (val: boolean) => { this.closingPosition = val; },
      fetchCandles: () => this.fetchCandles(),
      fetchBtcCandles: () => this.fetchBtcCandles(),
      orderManager: this.orderManager,
      closePosition: (pos, price, reason) => this.closePosition(pos, price, reason),
      setLastPrice: (price: number) => { this.lastPrice = price; },
      setPosition: (pos: Position) => { this.position = pos; },
    });
    this.rtExitHandler.initializeNfsSystem();

    // Initialize PositionOpener
    this.positionOpener = new PositionOpener({
      symbol: config.symbol,
      sessionId: config.sessionId,
      userId: config.userId,
      mode: config.mode,
      exchange: config.exchange,
      capitalPool: config.capitalPool,
      riskPerTradePct: config.riskPerTradePct,
      savePositionToDb: (pos, action, fee) => this.savePositionToDb(pos, action, fee),
      setStopLossOnExchange: (pos, isUpdate) => this.setStopLossOnExchange(pos, isUpdate),
      setTrailingStopOnExchange: (pos, isWidening) => this.setTrailingStopOnExchange(pos, isWidening),
      formatQtyForExchange: (sym, qty) => this.formatQtyForExchange(sym, qty),
      startRealtimeExitMonitorIfNeeded: () => this.startRealtimeExitMonitorIfNeeded(),
      fetchBtcCandles: () => this.fetchBtcCandles(),
      fetchBtcCandles1h: () => this.fetchBtcCandles1h(),
      onTrade: config.onTrade ? (trade) => config.onTrade!(trade) : undefined,
    });
  }

  // NFS system initialization delegated to rtExitHandler (see constructor)
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  async start(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    if (this.running) {
      logger.info(`⚠️ [${this.config.symbol}] Already running`);
      return;
    }

    this.running = true;

    // 🔄 LIVE MODE: Sync balance FIRST before logging (to show correct capital)
    if (this.config.mode === 'live') {
      logger.info(`🔄 [${this.config.symbol}] Syncing with exchange...`);
      await this.config.capitalPool.syncWithExchange(true);
    }
    
    // Now log with correct capital (showing pool total and available)
    const poolStatus = this.config.capitalPool.getStatus();
    logger.info(`✅ [${this.config.symbol}] STARTED | mode=${this.config.mode} | risk=${this.config.riskPerTradePct}% | pool=$${poolStatus.totalUsd.toFixed(2)} (avail=$${poolStatus.availableUsd.toFixed(2)})`);
    
    // 📢 NOTIFICATION: Agent started
    notifyAgentStarted({
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      capitalUsd: poolStatus.availableUsd,
      userId: this.config.userId || undefined,
    });
    
    // Charger les positions existantes depuis la DB
    await this.loadExistingPosition();
    
    // 🔄 LIVE MODE: Sync with exchange to catch any missed stop losses
    if (this.config.mode === 'live') {
      await this.syncWithExchange();
    }

    // Live mode: if we start with an existing position, enable realtime WS-based exits.
    this.startRealtimeExitMonitorIfNeeded();
    
    // V5.39: SYNCHRONIZED TICK - All agents tick at the same wall-clock times
    // This ensures all agents detect new candles simultaneously, so signals
    // arrive in the same batch window for the signal ranker.
    // 
    // Strategy: Align to 15-second boundaries (:00, :15, :30, :45 of each minute)
    // All agents will tick at exactly the same moments regardless of when they started.
    const TICK_INTERVAL_MS = 15_000;
    const now = Date.now();
    const nextBoundary = Math.ceil(now / TICK_INTERVAL_MS) * TICK_INTERVAL_MS;
    const delayToNextBoundary = nextBoundary - now;
    
    // V5.39: Add small jitter (0-500ms) to spread load across many agents
    // This prevents CPU/DB spikes when 1000+ agents tick at exact same moment
    // 500ms jitter is small enough that all agents still process the same candle
    // but large enough to spread the load smoothly
    const jitterMs = Math.floor(Math.random() * 500);
    
    // Premier tick immédiat pour initialiser l'état
    await this.tick();
    
    // Démarrer l'interval ALIGNÉ sur la prochaine borne de 15 secondes + jitter
    // Agents tickeront ensemble (±500ms): 12:00:00-12:00:00.5, 12:00:15-12:00:15.5, etc.
    this.tickAlignTimeoutId = setTimeout(() => {
      this.tickAlignTimeoutId = null;
      if (!this.running) return;
      void this.tick();
      this.tickIntervalId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }, delayToNextBoundary + jitterMs);
    
    logger.debug(`⏱️ [${this.config.symbol}] Tick synchronized to next ${TICK_INTERVAL_MS/1000}s boundary in ${delayToNextBoundary}ms (+${jitterMs}ms jitter)`);
    
    // V5.50: Subscribe to WebSocket final kline events for instant candle close detection
    // This reduces detection latency from ~8s (polling) to ~1s (WS event-driven)
    const binanceSymbol = this.config.symbol.split('/')[0] + 'USDT';
    try {
      const ws = getBinanceWebSocket();
      this.finalKlineUnsubscribe = ws.onFinalKline((kline: BinanceKlineData) => {
        // Only trigger for our symbol and 15m timeframe
        if (kline.symbol === binanceSymbol && kline.timeframe === '15m') {
          // Trigger immediate tick (but don't await - fire and forget)
          void this.tick();
        }
      });
      logger.debug(`⚡ [${this.config.symbol}] Subscribed to instant candle close events`);
    } catch (error) {
      logger.warn(`⚠️ [${this.config.symbol}] Failed to subscribe to instant candle events, using polling`);
    }
    }); // end runWithUserId
  }

  async stop(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    this.running = false;

    // V5.50: Unsubscribe from final kline events
    if (this.finalKlineUnsubscribe) {
      this.finalKlineUnsubscribe();
      this.finalKlineUnsubscribe = null;
    }

    // V5.39: Clear alignment timeout if still pending
    if (this.tickAlignTimeoutId) {
      clearTimeout(this.tickAlignTimeoutId);
      this.tickAlignTimeoutId = null;
    }

    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }

    this.stopRealtimeExitMonitor();

    // V5.22: Remove any pending signal for this agent from ranker
    globalSignalRanker.removeSignal(this.config.symbol, this.config.mode, this.config.userId);

    // 📢 NOTIFICATION: Agent stopped
    notifyAgentStopped({
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      reason: 'Manual stop',
      userId: this.config.userId || undefined,
    });

    logger.info(`⏹️ [${this.config.symbol}] STOPPED`);
    }); // end runWithUserId
  }

  // ==========================================================================
  // REALTIME (WS) EXIT MONITOR - Delegated to RealtimeExitHandler
  // ==========================================================================

  private startRealtimeExitMonitorIfNeeded(): void {
    this.rtExitHandler.startIfNeeded();
  }

  private stopRealtimeExitMonitor(): void {
    this.rtExitHandler.stop();
  }
  
  // ==========================================================================
  // PUBLIC SETTERS FOR CALLBACKS
  // ==========================================================================
  
  setOnTick(callback: (tick: TickEvent) => void): void {
    this.config.onTick = callback;
  }
  
  // ==========================================================================
  // PUBLIC GETTERS
  // ==========================================================================
  
  getSymbol(): string {
    return this.config.symbol;
  }
  
  getMode(): 'paper' | 'live' {
    return this.config.mode;
  }
  
  getPosition(): Position | null {
    return this.position;
  }
  
  getMarketConditions(): MarketConditions | null {
    return this.lastMarketConditions;
  }
  
  // ==========================================================================
  // MAIN TICK LOOP
  // ==========================================================================
  
  private async tick(): Promise<void> {
    return runWithUserId(this.config.userId, async () => {
    if (!this.running) return;

    // Prevent re-entrancy: skip if a tick is already in progress
    // This prevents stack overflow when tick() takes longer than the interval
    if (this.tickInProgress) {
      logger.warn(`⚠️ [${this.config.symbol}] Tick skipped - previous tick still in progress`);
      return;
    }

    this.tickInProgress = true;

    try {
      const now = new Date();
      const symbol = this.config.symbol;
      this.tickCount = (this.tickCount || 0) + 1;
      this.lastTickAt = Date.now();
      
      // 🔄 LIVE MODE: Sync with exchange first to detect stop loss executions
      if (this.config.mode === 'live') {
        await this.syncWithExchange();
      }
      
      // Update market conditions: prefer SymbolEngine cache, fallback to self-computation
      const engineForConditions = symbolEngineManager.getEngine(this.config.symbol);
      const engineConditions = engineForConditions?.getMarketConditions();
      const newConditions = engineConditions || getMarketConditions(
        (await this.fetchBtcCandles()),
        (await this.fetchBtcCandles1h()).filter(c => c.isFinal !== false)
      );
      this.lastMarketConditions = {
        ...newConditions,
        // Preserve marketQuality from checkEntry() if already set
        marketQuality: this.lastMarketConditions?.marketQuality || 'analyzing',
        qualityReason: this.lastMarketConditions?.qualityReason || 'Waiting for signal check...',
      };
      this.config.onMarketConditions?.(this.lastMarketConditions);
      
      // Fetch current candles for price and S/R
      const candles = await this.fetchCandles();
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : this.lastPrice;
      this.lastPrice = currentPrice;
      
      // Calculate basic S/R from recent highs/lows
      const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
      const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
      
      // � Broadcast tick to frontend via callback
      this.config.onTick?.({
        symbol,
        price: currentPrice,
        hasPosition: !!this.position,
        positionSide: this.position?.side,
        support: recentLow,
        resistance: recentHigh,
        tickCount: this.tickCount,
        timestamp: now,
      });

      // V5.79: Update agent state for Telegram heartbeat (every tick)
      const positionInfo = this.position ? {
        side: this.position.side,
        entryPrice: this.position.entryPrice,
        pnlPct: this.position.side === 'long'
          ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
          : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100,
      } : null;
      updateAgentState({
        symbol,
        mode: this.config.mode,
        balance: this.config.capitalPool.getTotalCapital(),
        position: positionInfo,
        lastUpdate: Date.now(),
      });

      // ═══════════════════════════════════════════════════════════════════════════
      // V5.71: Real-time Signal Radar - Calculate proximity on every tick
      // This detects when price approaches signal thresholds and logs only changes
      // ═══════════════════════════════════════════════════════════════════════════
      try {
        // Calculate BB from recent candles (need at least 20)
        if (candles.length >= 20) {
          const closePrices = candles.slice(-20).map(c => c.close);
          const sma = closePrices.reduce((a, b) => a + b, 0) / 20;
          const stdDev = Math.sqrt(closePrices.map(p => (p - sma) ** 2).reduce((a, b) => a + b, 0) / 20);
          const upperBB = sma + 2 * stdDev;
          const lowerBB = sma - 2 * stdDev;
          const bbWidth = upperBB - lowerBB;

          // BB distance: positive = above SMA, negative = below
          const bbDistance = bbWidth > 0 ? ((currentPrice - sma) / (bbWidth / 2)) * 100 : 0;

          // Volume ratio (current vs 20-period average)
          const volumes = candles.slice(-20).map(c => c.volume);
          const avgVolume = volumes.reduce((a, b) => a + b, 0) / 20;
          const currentVolume = candles[candles.length - 1].volume;
          const volRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

          // ROC (rate of change over 14 periods)
          const rocPeriod = Math.min(14, candles.length - 1);
          const rocPrice = candles[candles.length - 1 - rocPeriod]?.close || currentPrice;
          const roc = rocPrice > 0 ? ((currentPrice - rocPrice) / rocPrice) * 100 : 0;

          // Use last known regime from signal features (calculated in checkEntry from BTC data)
          // Skip radar update if regime hasn't been calculated yet to avoid flip-flopping
          // between NEUTRAL (default) and the real regime from another agent (paper/live)
          const currentRegime = this.lastKnownRegime || 'NEUTRAL';

          const radarFeatures: SignalFeatures = {
            roc,
            volRatio,
            bbDistance,
            atrPct: 0,  // Would need ATR calculation, skip for real-time
            trendStrength: 0,
          };

          const proximityScore = calculateProximityScore(radarFeatures, currentRegime, !!this.position);

          // Calculate PnL if in position
          let positionPnlPct: number | undefined;
          if (this.position) {
            positionPnlPct = this.position.side === 'long'
              ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
              : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
          }

          // V5.80: Only one agent per symbol updates the radar to prevent paper/live flip-flop
          // Priority: live > paper. Paper only updates if no live agent exists for this symbol.
          const isRadarOwner = this.config.mode === 'live' || !getCapitalPool(this.config.userId, undefined, 'live');
          if (isRadarOwner) {
            updateSymbolState({
              symbol,
              proximityScore,
              regime: currentRegime,
              features: radarFeatures,
              lastUpdate: Date.now(),
              inPosition: !!this.position,
              positionSide: this.position?.side,
              positionPnlPct,
              trailingActive: this.position?.trailingActive,
            });
          }
        }
      } catch (radarError) {
        // Don't let radar errors crash the tick
        logger.debug(`Signal Radar error for ${symbol}:`, radarError);
      }

      // 1. Si on a une position, checker l'exit avec trailing
      if (this.position) {
        // Avoid per-tick spam: checkExit already logs once per newly-closed 15m candle.
        // Keep detailed tick-level traces available via LOG_LEVEL=debug.
        const shortSymbol = symbol.replace('/USDT:USDT', '');
        logger.debug(`🔄 [${shortSymbol}] #${this.tickCount} IN_${this.position.side.toUpperCase()}@$${this.position.entryPrice.toFixed(2)} | $${currentPrice.toFixed(2)} | ${this.config.mode}`);
        await this.checkExit(this.position);
        // Note: If position was closed, the slot is freed via capitalPool.release()
        // Other agents will see the freed slot when they calculate availableSlots
        // in openPosition() AFTER waitForBatch(). No need to checkEntry() here
        // because this agent has a cooldown anyway.
        return;
      }
      
      // 2. Sinon, chercher une entrée (this sets lastRejectReason)
      await this.checkEntry();
      
      // 📋 LOG: One line per newly-closed candle (not per tick)
      // When waiting for the next candle, stay silent.
      if (this.lastRejectReason !== 'waiting_new_candle') {
        const shortSymbol = symbol.replace('/USDT:USDT', '');
        const f = this.lastSignalFeatures;
        // Show key metrics: vol ratio, ROC%, BB distance
        const featuresSummary = f
          ? `vol=${f.volRatio.toFixed(1)}x roc=${f.roc.toFixed(1)}% bb=${f.bbDistance > 0 ? '+' : ''}${f.bbDistance.toFixed(1)}%`
          : 'no_data';
        // Simplified reject reason (just the key part)
        const rejectKey = this.lastRejectReason?.split(':')[1]?.split('(')[0] || this.lastRejectReason?.split(':')[0] || '';
        logger.info(`🕵️ [${shortSymbol}] 15m CHECK | $${currentPrice.toFixed(2)} | ${featuresSummary} | ${rejectKey} | ${this.config.mode}`);
      }
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Tick error:`, error);
      this.config.onError?.(error as Error);
    } finally {
      // Always release the lock, even if an error occurred
      this.tickInProgress = false;
    }
    }); // end runWithUserId
  }

  // ==========================================================================
  // ENTRY LOGIC
  // ==========================================================================
  
  private async checkEntry(): Promise<void> {
    const symbol = this.config.symbol;
    const shortSymbol = symbol.replace('/USDT:USDT', '');

    try {
      // ═══════════════════════════════════════════════════════════════════════════
      // SymbolEngine Phase 2: Get signal from shared engine instead of computing
      // independently. Falls back to self-computation if engine has no result.
      // ═══════════════════════════════════════════════════════════════════════════

      const engine = symbolEngineManager.getEngine(symbol);
      const engineResult = engine?.getLastSignal() ?? null;

      // Resolve signal data: engine-first, fallback to self-computation
      let signal: ReturnType<typeof checkMomentumSignal>;
      let candles: Candle[];
      let btcCandles: Candle[];
      let currentPrice: number;
      let lastClosedCandleTs: number;
      const now = Date.now();
      const CANDLE_INTERVAL_MS = 15 * 60 * 1000;

      // Always fetch fresh candles for price + stale-signal validation
      const allCandles = await this.fetchCandles();

      // Validate engine result freshness: candleCloseTs must match actual latest closed candle
      let useEngine = false;
      if (engineResult && engineResult.closedCandles.length >= 61 && allCandles.length > 0) {
        let latestClosedTs = allCandles[allCandles.length - 1].timestamp;
        if (allCandles[allCandles.length - 1].isFinal === false && allCandles.length >= 2) {
          latestClosedTs = allCandles[allCandles.length - 2].timestamp;
        }
        useEngine = engineResult.candleCloseTs === latestClosedTs;
      }

      if (useEngine && engineResult) {
        // ── Engine path: reuse shared signal computation ──
        signal = engineResult.signal;
        candles = engineResult.closedCandles;
        btcCandles = engineResult.btcCandles;
        // Use fresh price from latest candle (engine price can be up to 15s stale)
        currentPrice = allCandles[allCandles.length - 1].close;
        lastClosedCandleTs = engineResult.candleCloseTs;
        this.lastPrice = currentPrice;
      } else {
        // ── Fallback path: compute signal ourselves (startup / no engine) ──
        // allCandles already fetched above for validation
        if (allCandles.length < 61) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Not enough candles (${allCandles.length}/61)`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        currentPrice = allCandles[allCandles.length - 1].close;
        this.lastPrice = currentPrice;

        let lastClosedIdx = allCandles.length - 1;
        if (allCandles[lastClosedIdx].isFinal === false) {
          lastClosedIdx = allCandles.length - 2;
        }
        if (lastClosedIdx < 0) {
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        candles = allCandles.slice(0, lastClosedIdx + 1);
        lastClosedCandleTs = candles[candles.length - 1].timestamp;

        // Check same-candle early (before expensive BTC fetch)
        if (lastClosedCandleTs === this.lastProcessedCandleTs) {
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        // Fetch BTC data (only needed in fallback path)
        const allBtcCandles = await this.fetchBtcCandles();
        const MIN_BTC_CANDLES = 201;
        if (allBtcCandles.length < MIN_BTC_CANDLES) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Waiting for BTC data (${allBtcCandles.length}/${MIN_BTC_CANDLES})`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        let btcLastClosedIdx = allBtcCandles.length - 1;
        if (allBtcCandles.length > 0 && allBtcCandles[btcLastClosedIdx].isFinal === false) {
          btcLastClosedIdx = allBtcCandles.length - 2;
        }
        btcCandles = btcLastClosedIdx >= 0 ? allBtcCandles.slice(0, btcLastClosedIdx + 1) : allBtcCandles;

        const allBtcCandles1h = await this.fetchBtcCandles1h();
        const btcCandles1h = allBtcCandles1h.filter(c => c.isFinal !== false);
        const MIN_BTC_1H_CANDLES = 201; // Need 200 for SMA200 regime + 1 (match backtest)
        if (btcCandles1h.length < MIN_BTC_1H_CANDLES) {
          if (this.tickCount % 10 === 1) {
            logger.info(`⚠️ [${shortSymbol}] Waiting for BTC 1h data (${btcCandles1h.length}/${MIN_BTC_1H_CANDLES})`);
          }
          this.lastRejectReason = 'waiting_new_candle';
          return;
        }

        signal = checkMomentumSignal(symbol, candles, btcCandles, {
          nowMs: now,
          btcCandles1h,
        });
      }

      // ── Common path: new candle detection + per-user logic ──

      // Check if this is the same closed candle we already processed
      if (lastClosedCandleTs === this.lastProcessedCandleTs) {
        this.lastRejectReason = 'waiting_new_candle';
        return;
      }

      // New closed candle! Mark it as processed
      const isFirstCheck = this.lastProcessedCandleTs === 0;
      const candleStartTime = new Date(lastClosedCandleTs).toISOString().slice(11, 19);
      const candleEndTime = new Date(lastClosedCandleTs + CANDLE_INTERVAL_MS).toISOString().slice(11, 19);
      const detectionDelayMs = now - (lastClosedCandleTs + CANDLE_INTERVAL_MS);
      const detectionDelaySec = Math.round(detectionDelayMs / 1000);

      // V5.80: Skip stale candles on restart
      const STALE_CANDLE_THRESHOLD_SEC = 120;
      if (isFirstCheck && detectionDelaySec > STALE_CANDLE_THRESHOLD_SEC) {
        logger.info(`⏭️ [${shortSymbol}] Skipping stale candle on startup [${candleStartTime}-${candleEndTime} UTC] | Detected +${detectionDelaySec}s (>${STALE_CANDLE_THRESHOLD_SEC}s threshold)`);
        this.lastProcessedCandleTs = lastClosedCandleTs;
        return;
      }

      if (!isFirstCheck) {
        const closedCandle = candles[candles.length - 1];
        const candleColor = closedCandle.close > closedCandle.open ? '🟢' : '🔴';
        const candleChange = ((closedCandle.close - closedCandle.open) / closedCandle.open * 100).toFixed(2);
        const changeNum = parseFloat(candleChange);
        logger.info(`🕯️ [${shortSymbol}] New 15m candle CLOSED [${candleStartTime}-${candleEndTime} UTC] ${candleColor} | $${closedCandle.close.toFixed(2)} (${changeNum > 0 ? '+' : ''}${candleChange}%) | Detected +${detectionDelaySec}s`);
      }

      this.lastProcessedCandleTs = lastClosedCandleTs;

      // Backtest parity: decrement cooldown once per CLOSED candle.
      if (this.entryCooldownBarsRemaining > 0) {
        this.entryCooldownBarsRemaining--;
      }
      if (this.entryCooldownBarsRemaining > 0) {
        this.lastRejectReason = `cooldown_${this.entryCooldownBarsRemaining}bars`;
        return;
      }

      // Process signal features (regime, radar, market quality)
      const f = signal.features;
      if (f) {
        // 📢 NOTIFICATION: Regime change (detect BTC crossing SMA200)
        if (shortSymbol === 'BTC' || shortSymbol === 'ADA') {
          const btcPrice = btcCandles[btcCandles.length - 1]?.close || 0;
          const estimatedSma200 = f.btcInBullRegime ? btcPrice * 0.99 : btcPrice * 1.01;
          notifyRegimeChange({
            newRegime: f.btcInBullRegime ? 'bull' : 'bear',
            btcPrice,
            sma200: estimatedSma200,
            userId: this.config.userId || undefined,
          });
        }

        // V5.5: Store features for market quality assessment
        const bbDistance = f.btcInBullRegime
          ? ((currentPrice - (f.bbUpper || currentPrice)) / currentPrice) * 100
          : (((f.bbLower || currentPrice) - currentPrice) / currentPrice) * 100;

        this.lastSignalFeatures = {
          volRatio: f.volRatio,
          roc: f.roc || 0,
          bbDistance,
          reason: signal.reason || '',
        };

        // Update market quality in conditions
        if (this.lastMarketConditions) {
          const isLowVolume = f.volRatio < 1.5;
          const isNearBB = Math.abs(bbDistance) < 0.5;
          const isConsolidating = isLowVolume && isNearBB;

          this.lastMarketConditions = {
            ...this.lastMarketConditions,
            marketQuality: isConsolidating ? 'consolidation' : 'momentum',
            qualityReason: isConsolidating
              ? `Low vol (${f.volRatio.toFixed(1)}x) + price near BB (${bbDistance.toFixed(2)}%)`
              : `Vol ${f.volRatio.toFixed(1)}x, BB dist ${bbDistance.toFixed(2)}%`,
          };
          this.config.onMarketConditions?.(this.lastMarketConditions);
        }

        // V5.71: Update Signal Radar with current state
        const radarFeatures: SignalFeatures = {
          roc: f.roc || 0,
          volRatio: f.volRatio,
          bbDistance,
          atrPct: 0,
          trendStrength: 0,
        };
        const currentRegime = f.btcInBullRegime ? 'BULL' : (f.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
        this.lastKnownRegime = currentRegime;
        const proximityScore = calculateProximityScore(radarFeatures, currentRegime, !!this.position);

        let positionPnlPct: number | undefined;
        if (this.position) {
          positionPnlPct = this.position.side === 'long'
            ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
            : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
        }

        const isRadarOwnerEntry = this.config.mode === 'live' || !getCapitalPool(this.config.userId, undefined, 'live');
        if (isRadarOwnerEntry) {
          updateSymbolState({
            symbol,
            proximityScore,
            regime: currentRegime,
            features: radarFeatures,
            lastUpdate: Date.now(),
            inPosition: !!this.position,
            positionSide: this.position?.side,
            positionPnlPct,
            trailingActive: this.position?.trailingActive,
          });
        }
      }

      if (signal.valid && signal.side) {
        const btcPrice = btcCandles[btcCandles.length - 1]?.close || 0;
        const btcRegime = signal.features?.btcInBullRegime ? 'BULL' : (signal.features?.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
        logger.info(`✅ [${shortSymbol}] SIGNAL ${signal.side.toUpperCase()} | $${currentPrice.toFixed(2)} | ${signal.reason} | BTC=${btcPrice.toFixed(0)} regime=${btcRegime} btcCandles=${btcCandles.length}`);

        // Use engine-computed score if available, otherwise calculate
        let qualityScore: number;
        let roc5: number;
        let volumeRatio: number;

        if (engineResult && engineResult.score > 0) {
          qualityScore = engineResult.score;
          roc5 = signal.features?.roc5 ?? 0;
          volumeRatio = signal.features?.volRatio ?? 1;
        } else {
          const closes = candles.map(c => c.close);
          const volumes = candles.map(c => c.volume);
          roc5 = calcROC(closes, 5);
          volumeRatio = calcVolRatio(volumes);
          const bbPosition = calcBBPosition(candles, 20, 2);
          const atrRaw = calcATR(candles, 14) ?? 0;
          const atrPct = atrRaw ? (atrRaw / currentPrice) * 100 : 0;
          const trendStrength = calcTrendStrength(closes, 50);

          qualityScore = globalSignalRanker.calculateScore({
            roc5,
            volumeRatio,
            bbPosition,
            atrPct,
            trendStrength,
            side: signal.side,
          });
        }

        logger.info(`📊 [${shortSymbol}] Signal Quality Score: ${qualityScore.toFixed(2)} | ${engineResult ? 'via SymbolEngine' : 'self-computed'}`);

        // V5.22: Add signal to global ranker for prioritization
        globalSignalRanker.addSignal({
          symbol,
          side: signal.side,
          score: qualityScore,
          price: currentPrice,
          timestamp: Date.now(),
          roc5,
          volumeRatio,
          reason: signal.reason || 'momentum_signal',
          mode: this.config.mode,
          userId: this.config.userId,
        });

        notifySignalDetected({
          symbol,
          side: signal.side,
          price: currentPrice,
          reason: signal.reason || 'momentum_signal',
          mode: this.config.mode,
          userId: this.config.userId || undefined,
        });

        this.currentBias = signal.side;
        this.lastSignal = {
          entryZone: [
            currentPrice * (signal.side === 'long' ? 0.998 : 1.002),
            currentPrice * (signal.side === 'long' ? 1.002 : 0.998),
          ],
          stopDistance: currentPrice * MomentumConfig.EXIT.STOP_LOSS_PCT / 100,
          targets: [
            currentPrice * (signal.side === 'long' ? 1.01 : 0.99),
            currentPrice * (signal.side === 'long' ? 1.02 : 0.98),
            currentPrice * (signal.side === 'long' ? 1.03 : 0.97),
          ],
          targetPcts: [1, 2, 3],
        };

        this.config.onSignal?.({
          symbol,
          side: signal.side,
          reason: signal.reason || 'momentum_signal',
          timestamp: new Date(),
        });

        logger.info(`⏳ [${shortSymbol}] Waiting for signal ranking batch...`);
        await globalSignalRanker.waitForBatch(this.config.mode, this.config.userId);

        this.lastRejectReason = '';
        await this.openPosition(signal.side, candles);
      } else {
        this.lastRejectReason = signal.reason || 'no_signal';

        const rejectReason = signal.reason || 'no_signal';
        if (f && !rejectReason.startsWith('waiting_') && !rejectReason.startsWith('cooldown')) {
          const regime = f.btcInBullRegime ? 'BULL' : (f.btcInBearRegime ? 'BEAR' : 'NEUTRAL');
          const bbDistance = f.btcInBullRegime
            ? ((currentPrice - (f.bbUpper || currentPrice)) / currentPrice) * 100
            : (((f.bbLower || currentPrice) - currentPrice) / currentPrice) * 100;
          const radarFeatures: SignalFeatures = {
            roc: f.roc || 0,
            volRatio: f.volRatio,
            bbDistance,
            atrPct: 0,
            trendStrength: 0,
          };
          const score = calculateProximityScore(radarFeatures, regime, !!this.position);
          const estimatedSide: 'long' | 'short' = regime === 'BULL' ? 'long' : 'short';
          trackRejectedSignal({
            timestamp: Date.now(),
            symbol,
            side: estimatedSide,
            score: Math.round(score),
            reason: rejectReason,
            price: currentPrice,
          });
        }
      }

    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking entry:`, error);
    }
  }
  
  private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const result = await this.positionOpener.open(side, candles);
    if (result.position) {
      this.position = result.position;
      this.additionalPositions = result.additionalPositions;
      this.closingPosition = false;
      if (result.lastProcessedExitCandleTs !== null) {
        this.lastProcessedExitCandleTs = result.lastProcessedExitCandleTs;
      }
    }
  }

  
  // ==========================================================================
  // EXIT LOGIC WITH TRAILING STOP
  // ==========================================================================
  
  private async checkExit(position: Position): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      const allCandles = await this.fetchCandles();
      if (allCandles.length === 0) return;

      // Fetch BTC candles for regime detection (V5.13)
      const allBtcCandles = await this.fetchBtcCandles();

      // V5.50 FIX: Use isFinal flag from WebSocket instead of time-based heuristic
      // This ensures live trading detects candle close at the EXACT same moment as backtest
      // Previously: used (now - timestamp < 15min) which caused 15-min delay
      // Now: use isFinal flag directly from Binance WebSocket
      let lastClosedIdx = allCandles.length - 1;
      const lastCandle = allCandles[lastClosedIdx];
      
      // If the last candle is not final (still in progress), use the previous one
      if (lastCandle.isFinal === false) {
        lastClosedIdx = allCandles.length - 2;
      }
      
      if (lastClosedIdx < 0) {
        return;
      }
      
      const candles = allCandles.slice(0, lastClosedIdx + 1);
      const latestClosedCandle = candles[candles.length - 1];
      
      // V5.50 FIX: Use isFinal for BTC candles too (aligned with backtest)
      // This ensures regime detection uses the same closed candle data as backtest
      let lastClosedBtcIdx = allBtcCandles.length - 1;
      if (allBtcCandles.length > 0) {
        const lastBtcCandle = allBtcCandles[lastClosedBtcIdx];
        if (lastBtcCandle.isFinal === false) {
          lastClosedBtcIdx = allBtcCandles.length - 2;
        }
      }
      const btcCandles = lastClosedBtcIdx >= 0 ? allBtcCandles.slice(0, lastClosedBtcIdx + 1) : [];

      // V5.82: Fetch BTC 1h candles for regime SMA200
      const allBtcCandles1h = await this.fetchBtcCandles1h();
      const btcCandles1h = allBtcCandles1h.filter(c => c.isFinal !== false);

      // Only process exit once per newly-closed candle.
      if (latestClosedCandle.timestamp === this.lastProcessedExitCandleTs) {
        return;
      }

      // V5.80: Detect stale candle on restart - use close price instead of wick for SL check
      // After redeployment, the first candle may be old (detected +600s). The wick of that candle
      // could trigger a false SL exit even though price has since recovered. Use close price only.
      const CANDLE_INTERVAL_MS_EXIT = 15 * 60 * 1000;
      const exitDetectionDelayMs = Date.now() - (latestClosedCandle.timestamp + CANDLE_INTERVAL_MS_EXIT);
      const exitDetectionDelaySec = Math.round(exitDetectionDelayMs / 1000);
      const isStaleExitCandle = this.lastProcessedExitCandleTs === 0 && exitDetectionDelaySec > 120;
      if (isStaleExitCandle) {
        logger.info(`⏭️ [${symbol}] Stale candle on startup for exit check (Detected +${exitDetectionDelaySec}s) - using close price instead of wick for SL`);
      }

      // V5.48 FIX: Update HWM for ALL skipped candles, not just the latest!
      // If agent tick was slow and multiple candles closed, we must update HWM
      // with the HIGH of each skipped candle to ensure we don't miss a peak.
      // 
      // This fixes the 9% vs 1.9% trailing capture bug where a candle with
      // a high peak was skipped and its HIGH was never used for the HWM.
      const missedCandlesForHwm: { timestamp: number; high: number; low: number }[] = [];
      if (this.lastProcessedExitCandleTs && this.lastProcessedExitCandleTs > 0) {
        // Find all candles between lastProcessedExitCandleTs and current
        for (const c of candles) {
          if (c.timestamp > this.lastProcessedExitCandleTs && c.timestamp <= latestClosedCandle.timestamp) {
            missedCandlesForHwm.push({ timestamp: c.timestamp, high: c.high, low: c.low });
          }
        }
        
        // Update HWM for each missed candle
        if (missedCandlesForHwm.length > 1) {
          logger.warn(`⚠️ [${symbol}] CATCH-UP: ${missedCandlesForHwm.length} candles since last check - updating HWM for all`);
          for (const missed of missedCandlesForHwm) {
            // Update position HWM with each missed candle's high/low
            if (position.side === 'long') {
              if (!this.position!.highWaterMark || missed.high > this.position!.highWaterMark) {
                this.position!.highWaterMark = missed.high;
                logger.info(`📈 [${symbol}] HWM updated from missed candle: $${missed.high.toFixed(4)} (ts=${new Date(missed.timestamp).toISOString().slice(11, 16)})`);
              }
            } else {
              if (!this.position!.lowWaterMark || missed.low < this.position!.lowWaterMark) {
                this.position!.lowWaterMark = missed.low;
                logger.info(`📉 [${symbol}] LWM updated from missed candle: $${missed.low.toFixed(4)} (ts=${new Date(missed.timestamp).toISOString().slice(11, 16)})`);
              }
            }
          }
        }
      }
      
      this.lastProcessedExitCandleTs = latestClosedCandle.timestamp;

      const currentPrice = latestClosedCandle.close;
      this.lastPrice = currentPrice;
      
      // 🔧 SAFETY CHECK - Ensure position has protection
      // In live mode we require an emergency SL order; exchange trailing is optional.
      if (this.config.mode === 'live' && !position.stopLossOrderId && !position.trailingOrderId) {
        logger.warn(`🚨 [${symbol}] SAFETY: Position has NO PROTECTION! Attempting to re-place orders...`);
        
        // Re-place emergency SL (and trailing only if enabled)
        try {
          await this.setStopLossOnExchange(position, false);
          if (MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) {
            await this.setTrailingStopOnExchange(position, false);
          }
          logger.info(`🛡️ [${symbol}] SAFETY: Re-placed protection orders`);
        } catch (safetyError: any) {
          logger.error(`🚨🚨🚨 [${symbol}] SAFETY: Failed to re-place protection! ${safetyError.message}`);
        }
      }
      
      // Update water marks for trailing stop (this handles the current candle)
      this.position = updatePositionWaterMarks(position, currentPrice, latestClosedCandle.high, latestClosedCandle.low);
      
      // Log position status every tick when in position
      const pnlPct = position.side === 'long'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      const appTrail = this.position?.appTrailingStop;
      const emergency = this.position?.emergencyStopPrice ?? this.position?.stopLoss;
      logger.info(
        `📊 [${symbol}] POSITION ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(2)} | now=$${currentPrice.toFixed(2)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | trail=$${appTrail ? appTrail.toFixed(2) : 'N/A'} | emergencySL=$${emergency ? emergency.toFixed(2) : 'N/A'}`
      );
      
      // 📢 NOTIFICATION: Liquidation warning (check if price is close to liquidation)
      // Liquidation price calculation: 
      // For LONG: liqPrice = entryPrice * (1 - 1/leverage + maintenance_margin_rate)
      // For SHORT: liqPrice = entryPrice * (1 + 1/leverage - maintenance_margin_rate)
      // Simplified: we use ~0.4% maintenance margin for Binance Futures
      const leverage = position.leverage || 4;
      const maintenanceRate = 0.004; // 0.4% maintenance margin
      const liqPrice = position.side === 'long'
        ? position.entryPrice * (1 - 1/leverage + maintenanceRate)
        : position.entryPrice * (1 + 1/leverage - maintenanceRate);
      
      const distanceToLiqPct = position.side === 'long'
        ? ((currentPrice - liqPrice) / currentPrice) * 100
        : ((liqPrice - currentPrice) / currentPrice) * 100;
      
      // Warn if within 5% of liquidation (only in live mode)
      if (this.config.mode === 'live' && distanceToLiqPct <= 5 && distanceToLiqPct > 0) {
        notifyLiquidationWarning({
          symbol,
          side: position.side,
          currentPrice,
          liquidationPrice: liqPrice,
          distancePct: distanceToLiqPct,
          leverage,
          mode: 'live',
          userId: this.config.userId || undefined,
        });
      }
      
      // V5.13: Pass BTC candles for regime detection and symbol candles for momentum reversal
      // V5.46 PARITY FIX: Entry/Exit time alignment with backtest
      // - entryTime = candle.timestamp (same as backtest)
      // - nowMs = calculateExitNowMs(candleTimestamp) = candleTimestamp + 15min
      // - holdMinutes = (nowMs - entryTime) / 60000 = holdBars * 15 (EXACT parity)
      // This ensures trailing stops, stagnant detection, and all time-based exits
      // behave identically between live and backtest.
      // V5.80: On stale candle restart, use close price for high/low to avoid wick-triggered false SL
      const exitHigh = isStaleExitCandle ? currentPrice : latestClosedCandle.high;
      const exitLow = isStaleExitCandle ? currentPrice : latestClosedCandle.low;
      const exitSignal = shouldExitPosition(this.position!, currentPrice, candles, {
        nowMs: calculateExitNowMs(latestClosedCandle.timestamp),
        priceHigh: exitHigh,
        priceLow: exitLow,
        btcCandles: btcCandles,
        btcCandles1h: btcCandles1h,  // V5.82: 1h candles for regime SMA200
      });

      // 🔍 DEBUG: Log regime change detection for debugging timing issues
      if (exitSignal.shouldExit && exitSignal.reason === 'regime_change') {
        logger.warn(`🚨 [${symbol}] REGIME CHANGE DETECTED on 15m close | candle_ts=${new Date(latestClosedCandle.timestamp).toISOString()} | price=$${currentPrice.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
      }

      // ════════════════════════════════════════════════════════════════════════
      // V5.81: When stagnant is confirmed, immediately update exchange SL to tightened level
      // This ensures the exchange protects at 0.8% SL instead of the wide 3% emergency.
      // Parity data shows live loses -5% to -11% on stagnant exits vs backtest -4%
      // because the exchange SL was still at the wide emergency level.
      // ════════════════════════════════════════════════════════════════════════
      if (this.position!.stagnantState?.confirmed && !this.position!.stagnantState?.cancelled) {
        if (!this.stagnantSlUpdated) {
          this.stagnantSlUpdated = true;
          const stagnantSlRatio = MomentumConfig.EXIT.STAGNANT_TRADE_TIGHTEN_SL_RATIO ?? 0.5;
          const baseSl = this.position!.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
          const stagnantSlPct = baseSl * stagnantSlRatio;
          const stagnantSlPrice = this.position!.side === 'long'
            ? this.position!.entryPrice * (1 - stagnantSlPct / 100)
            : this.position!.entryPrice * (1 + stagnantSlPct / 100);

          logger.info(`🔧 [${symbol}] V5.84: Stagnant confirmed — updating exchange SL to ${stagnantSlPct.toFixed(2)}% (${stagnantSlRatio}× base ${baseSl}%) ($${stagnantSlPrice.toFixed(4)})`);

          if (this.position) {
            this.position.stopLoss = stagnantSlPrice;
            this.position.stopLossPct = stagnantSlPct;
          }
          try {
            await this.setStopLossOnExchange(this.position!, true);
          } catch (err: any) {
            logger.warn(`⚠️ [${symbol}] V5.81: Failed to tighten exchange SL for stagnant: ${err.message}`);
          }
        }
      }

      // V5.26: Persist trailing activation - once active, stays active
      if (exitSignal.trailingActivated) {
        // V5.72: Track when trailing first activated
        if (!this.position!.trailingActive) {
          this.rtExitHandler.trailingActivatedAt = Date.now();
        }
        this.position!.trailingActive = true;
      }

      // ════════════════════════════════════════════════════════════════════════
      // V5.62: TRAILING STOP with NFS_ADAPTIVE (aligned with backtest)
      // Uses NFS score to determine exit strategy:
      // - HIGH: Exit at trailing stop price (immediate)
      // - MEDIUM: Exit at candle close with 1-candle confirmation
      // - LOW: Exit at candle close with 2-candle confirmation
      // ════════════════════════════════════════════════════════════════════════
      if (exitSignal.trailingBreached === true) {
        // Initialize breach counter if needed
        if (!this.position!.trailingBreachCandles) {
          this.position!.trailingBreachCandles = 0;
        }

        this.position!.trailingBreachCandles += 1;
        const breachCount = this.position!.trailingBreachCandles;
        const trailingStopPrice = exitSignal.newStopLoss ?? this.position!.appTrailingStop ?? currentPrice;

        // V5.62: NFS_ADAPTIVE on 15m close (backup to 1m realtime monitor)
        const nfsEnabled = MomentumConfig.EXIT.NFS_ENABLED ?? false;
        const nfsAdaptive = MomentumConfig.EXIT.NFS_ADAPTIVE_ENABLED ?? true;

        // V5.86: Check if proactive limit was filled FIRST before doing 15m exit
        // This prevents double-exit when 15m check runs before 1m fill detection
        if (this.rtExitHandler.proactiveLimitOrderId && this.position) {
          logger.info(`[${symbol}] 15m check: proactive LIMIT pending (${this.rtExitHandler.proactiveLimitOrderId}), checking fill status first...`);
          const fillResult = await this.checkProactiveLimitFill(symbol);
          if (fillResult?.filled) {
            const execPx = fillResult.avgPrice;
            this.stopRealtimeExitMonitor();
            logger.info(
              `🎯🎯🎯 [${symbol}] PROACTIVE LIMIT FILLED (detected at 15m check) @ $${execPx.toFixed(4)} | ` +
              `trailing=$${this.rtExitHandler.proactiveLimitPrice?.toFixed(4)} | ` +
              `slippage=0% (exact backtest match!)`
            );
            this.rtExitHandler.proactiveLimitOrderId = null;
            this.rtExitHandler.proactiveLimitPrice = null;
            await this.closePosition(this.position!, execPx, EXIT_TRAIL_PROACTIVE_15M);
            return;
          }
          // If not filled yet, cancel it and proceed with 15m exit logic
          // (price may have gapped through the limit price)
          logger.info(`[${symbol}] Proactive LIMIT not filled yet, cancelling and proceeding with 15m exit...`);
          try {
            await this.cancelProactiveLimit(symbol);
          } catch (e) {
            logger.warn(`[${symbol}] Failed to cancel proactive LIMIT: ${e}`);
          }
        }

        if (nfsEnabled && nfsAdaptive && this.rtExitHandler.getNfsCalculator()) {
          // Calculate NFS score for this breach
          const symbolCandles = await this.fetchCandles();
          const nfsCandles = symbolCandles.slice(-25).map(c => ({
            timestamp: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume || 0,
            isFinal: true,
          })) as NfsCandle[];

          const currentNfsCandle: NfsCandle = {
            timestamp: latestClosedCandle.timestamp,
            open: latestClosedCandle.open,
            high: latestClosedCandle.high,
            low: latestClosedCandle.low,
            close: latestClosedCandle.close,
            volume: latestClosedCandle.volume || 0,
            isFinal: true,
          };

          const nfsResult = this.rtExitHandler.getNfsCalculator()!.calculate(
            currentNfsCandle,
            nfsCandles.slice(0, -1),
            this.position!.side,
            trailingStopPrice
          );

          // V5.80: Enhanced logging for paper/live parity debugging
          // Log all inputs that could cause NFS score divergence between paper and live
          const hwm = this.position!.side === 'long' ? this.position!.highWaterMark : this.position!.lowWaterMark;
          logger.info(
            `🔴 [${symbol}] 15m TRAILING BREACH | NFS=${nfsResult.score.toFixed(0)} (${nfsResult.confidence}) | ` +
            `breaches=${breachCount} | close=${currentPrice.toFixed(4)} | stop=${trailingStopPrice.toFixed(4)} | ` +
            `hwm=${hwm?.toFixed(4) ?? 'N/A'} | entry=${this.position!.entryPrice.toFixed(4)} | mode=${this.config.mode}`
          );
          // Log NFS components for detailed comparison
          logger.debug(
            `[${symbol}] NFS components: breachATR=${nfsResult.components.breachATRRatio.toFixed(4)} ` +
            `breachDepth=${nfsResult.components.breachDepthPct.toFixed(4)}% ` +
            `vol=${nfsResult.components.volumeRatio.toFixed(2)}x ` +
            `body=${nfsResult.components.candleBodyRatio.toFixed(2)} ` +
            `roc5=${nfsResult.components.momentumROC5.toFixed(4)}%`
          );

          if (nfsResult.shouldExitImmediately) {
            // HIGH confidence: Exit at trailing stop price (backtest) or candle close (paper realistic)
            // V5.87: Paper now uses candle close to simulate market order execution (more realistic)
            // Live will place market order anyway, so this just affects paper realism
            // Proactive limit (when it works) will give both paper and live exact trailing price
            const highExitPrice = this.config.mode === 'paper' ? currentPrice : trailingStopPrice;
            logger.info(`⚡⚡⚡ [${symbol}] 15m NFS HIGH EXIT | exec=${highExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)}, mode=${this.config.mode})`);
            await this.closePosition(this.position!, highExitPrice, EXIT_TRAIL_NFS_HIGH_15M);
            return;
          } else if (nfsResult.confidence === 'MEDIUM' && breachCount >= 1) {
            // V5.81 PARITY FIX: Use best of trailing stop price or current price
            // Parity data shows MED exits lose 3-5% vs backtest because candle close
            // is worse than trailing stop price. Use trailing price when it's better.
            const medExitPrice = this.position!.side === 'long'
              ? Math.max(trailingStopPrice, currentPrice)
              : Math.min(trailingStopPrice, currentPrice);
            logger.info(`⚡⚡ [${symbol}] 15m NFS MEDIUM EXIT | exec=${medExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)})`);
            await this.closePosition(this.position!, medExitPrice, EXIT_TRAIL_NFS_MED_15M);
            return;
          } else if (breachCount >= 2) {
            // V5.81: Same fix for LOW - use best of trailing stop or close
            const lowExitPrice = this.position!.side === 'long'
              ? Math.max(trailingStopPrice, currentPrice)
              : Math.min(trailingStopPrice, currentPrice);
            logger.info(`⚡ [${symbol}] 15m NFS LOW EXIT (2-close) | exec=${lowExitPrice.toFixed(4)} (trail=${trailingStopPrice.toFixed(4)}, close=${currentPrice.toFixed(4)})`);
            await this.closePosition(this.position!, lowExitPrice, EXIT_TRAIL_NFS_LOW_15M);
            return;
          } else {
            // LOW, first breach - wait for confirmation
            logger.warn(`⏳ [${symbol}] 15m NFS LOW (score=${nfsResult.score.toFixed(0)}) - waiting for 2nd close (${breachCount}/2)`);
          }
        } else {
          // Fallback: Standard 2-close confirmation (NFS disabled)
          const REQUIRED_CONFIRMATIONS = 2;
          if (breachCount >= REQUIRED_CONFIRMATIONS) {
            logger.info(`🔴 [${symbol}] TRAILING CONFIRMED (${breachCount}/${REQUIRED_CONFIRMATIONS} closes) | price=$${currentPrice.toFixed(4)} | trailStop=$${trailingStopPrice.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
            await this.closePosition(this.position!, currentPrice, EXIT_TRAIL);
            return;
          } else {
            logger.warn(`⚠️ [${symbol}] TRAILING BREACH ${breachCount}/${REQUIRED_CONFIRMATIONS} | price=$${currentPrice.toFixed(4)} | trail=$${exitSignal.newStopLoss?.toFixed(4)} | Waiting for confirmation...`);
          }
        }
      } else if (exitSignal.trailingBreached === false) {
        // V5.39 FIX: Explicit reset when trailingBreached is false (wick hit but close recovered)
        // This matches backtest behavior - breach counter resets when close recovers above stop
        if (this.position!.trailingBreachCandles && this.position!.trailingBreachCandles > 0) {
          logger.info(`✅ [${symbol}] Trailing breach CLEARED - wick hit but close recovered above stop`);
        }
        this.position!.trailingBreachCandles = 0;
      } else if (exitSignal.trailingActivated) {
        // trailingBreached is undefined - no wick breach at all, just trailing active
        // Also reset counter to be safe
        if (this.position!.trailingBreachCandles && this.position!.trailingBreachCandles > 0) {
          logger.info(`✅ [${symbol}] Trailing breach CLEARED - price recovered above stop`);
        }
        this.position!.trailingBreachCandles = 0;
      }

      // Emergency profit-protection (exchange-side): ratchet stop only after +2% PnL.
      // This is NOT the primary exit; trailing/app logic remains the priority.
      await this.updateEmergencyStopProfitProtectionIfNeeded(currentPrice, pnlPct);
      
      if (exitSignal.shouldExit) {
        // ════════════════════════════════════════════════════════════════════════
        // V5.81 PARITY FIX: Use SL price for SL/stagnant exits (matching backtest)
        // ════════════════════════════════════════════════════════════════════════
        // Backtest exits at the exact SL price (entry × (1 ± slPct/100)).
        // Live was exiting at candle close price, which can be significantly worse
        // when the SL is breached mid-candle (parity data shows -3% to -7% gap).
        // Fix: For SL-type exits, compute the theoretical SL price and use it.
        let exitPrice = currentPrice;
        if (exitSignal.reason === 'stoploss' || exitSignal.reason === 'stagnant_trade') {
          const effectiveSlPct = exitSignal.effectiveSlPct ?? this.position!.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT;
          const slExitPrice = this.position!.side === 'long'
            ? this.position!.entryPrice * (1 - effectiveSlPct / 100)
            : this.position!.entryPrice * (1 + effectiveSlPct / 100);
          // Use SL price if it's better (closer to entry) than current price,
          // otherwise use current price (market may have recovered slightly)
          if (this.position!.side === 'long') {
            exitPrice = Math.max(slExitPrice, currentPrice); // Best of SL or current
          } else {
            exitPrice = Math.min(slExitPrice, currentPrice); // Best of SL or current
          }
          logger.info(`🎯 [${symbol}] V5.81: Using SL exit price $${exitPrice.toFixed(4)} (SL=$${slExitPrice.toFixed(4)}, close=$${currentPrice.toFixed(4)}, slPct=${effectiveSlPct.toFixed(1)}%)`);
        }
        logger.info(`🔴 [${symbol}] EXIT SIGNAL: reason=${exitSignal.reason} | PnL=${exitSignal.pnlPct?.toFixed(2)}% | holdMin=${exitSignal.holdMinutes?.toFixed(0)}`);
        await this.closePosition(this.position!, exitPrice, EXIT_SIGNAL_REASON_MAP[exitSignal.reason ?? ''] ?? toCanonical(exitSignal.reason ?? 'unknown'));
      } else if (exitSignal.newStopLoss && exitSignal.newStopLoss !== this.position?.appTrailingStop) {
        // Update app trailing stop price
        this.position!.appTrailingStop = exitSignal.newStopLoss;
        
        // 📢 NOTIFICATION: Trailing stop activated (only notify once)
        if (!this.trailingNotified && exitSignal.pnlPct && exitSignal.pnlPct >= 1) {
          this.trailingNotified = true;
          notifyTrailingActivated({
            symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            currentPrice,
            trailPrice: exitSignal.newStopLoss,
            pnlPct: exitSignal.pnlPct,
            mode: this.config.mode,
            userId: this.config.userId || undefined,
          });
        }
        
        // V5.12: SMART TRAILING - Widen callback when profit reaches 2%
        // This lets winners run while protecting early gains
        const widenThreshold = MomentumConfig.EXIT.TRAILING_WIDEN_AT_PCT; // 2%
        if (!this.trailingWidened && exitSignal.pnlPct && exitSignal.pnlPct >= widenThreshold) {
          this.trailingWidened = true;
          logger.info(`📈 [${symbol}] Profit +${exitSignal.pnlPct.toFixed(1)}% >= ${widenThreshold}% - WIDENING trailing callback`);
          
          if (this.config.mode === 'live' && this.position) {
            try {
              // Cancel existing trailing and re-place with wider callback
              await this.cancelAllOrdersOnExchange();
              await this.setTrailingStopOnExchange(this.position, true); // true = isWidening
              // Note: setTrailingStopOnExchange now has built-in fallback to STOP_MARKET if trailing fails
              logger.info(`🎯 [${symbol}] Trailing WIDENED: callback now ${MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT}%`);
            } catch (error: unknown) {
              // Error already handled by setTrailingStopOnExchange fallback
              logger.warn(`⚠️ [${symbol}] Failed to widen trailing: ${errMsg(error)}`);
            }
          }
        }
        
        // Update trailing stop on exchange (live mode) or just log (paper mode)
        await this.updateTrailingStopOnExchange(exitSignal.newStopLoss);
      }
      
      // Check for long hold warning (> 24h)
      const holdHours = exitSignal.holdMinutes ? exitSignal.holdMinutes / 60 : 0;
      if (holdHours >= 24) {
        notifyLongHold({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          currentPrice,
          holdDurationHours: holdHours,
          pnlPct: pnlPct,
          sessionId: this.config.sessionId,
          mode: this.config.mode,
          userId: this.config.userId || undefined,
        });
      }
      
      // V5.39: Periodically save position state to DB (every check)
      // This ensures HWM, maxPnl, trailing state survive restarts
      await this.updatePositionStateInDb();
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking exit:`, error);
    }
  }
  
  private async closePosition(
    position: Position,
    currentPrice: number,
    reason: ExitReason | string
  ): Promise<void> {
    const symbol = this.config.symbol;

    // Prevent duplicate close attempts and stop realtime monitor before placing orders.
    if (this.closingPosition) {
      logger.debug(`⚠️ [${symbol}] Close already in progress, skipping duplicate close (${reason})`);
      return;
    }
    this.closingPosition = true;
    this.stopRealtimeExitMonitor();

    try {
    
    // Calculate PnL based on side
    let pnlPct: number;
    let pnlUsd: number;
    
    if (position.side === 'long') {
      pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (currentPrice - position.entryPrice);
    } else {
      pnlPct = ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      pnlUsd = position.qty * (position.entryPrice - currentPrice);
    }
    
    const notionalUsd = position.qty * position.entryPrice;
    // V5.6: Use stored margin for capital release, fallback to notional/leverage or notional
    const marginToRelease = position.marginUsd ?? (position.leverage ? notionalUsd / position.leverage : notionalUsd);
    
    logger.info(`🚪 [${symbol}] CLOSING ${position.side.toUpperCase()} | entry=$${position.entryPrice.toFixed(4)} | exit=$${currentPrice.toFixed(4)} | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)}) | reason=${reason}`);
    
    // Reset trailing flags for next position
    this.trailingNotified = false;
    this.trailingWidened = false;
    this.stagnantSlUpdated = false;

    // Reset NFS + proactive limit + trailing tracking state (owned by rtExitHandler)
    this.rtExitHandler.resetState();

    // V5.41: Use shared cooldown logic from momentumSimple.ts
    const cooldownBars = getCooldownBars(reason, this.ENTRY_COOLDOWN_BARS);
    this.entryCooldownBarsRemaining = cooldownBars;
    logger.info(`⏱️ [${symbol}] Cooldown: ${cooldownBars} bars (${cooldownBars * 15}min) - exit reason: ${reason}`);

    // Store exit info for frontend display
    this.lastExit = {
      ts: Date.now(),
      price: currentPrice,
      reason,
    };
    this.currentBias = null;
    this.lastSignal = null;

    if (this.config.mode === 'paper') {
      // Paper close — position nulled AFTER DB save (see below) to prevent orphans on DB failure.
      // closingPosition flag prevents re-entry in the meantime.

      // V5.30: Close additional positions too
      let totalPnlUsd = pnlUsd;
      let totalMarginReleased = marginToRelease;
      
      for (const addPos of this.additionalPositions) {
        let addPnlUsd: number;
        if (addPos.side === 'long') {
          addPnlUsd = addPos.qty * (currentPrice - addPos.entryPrice);
        } else {
          addPnlUsd = addPos.qty * (addPos.entryPrice - currentPrice);
        }
        const addMargin = addPos.marginUsd ?? (addPos.leverage ? (addPos.qty * addPos.entryPrice) / addPos.leverage : addPos.qty * addPos.entryPrice);
        const addPnlPct = addPos.side === 'long'
          ? ((currentPrice - addPos.entryPrice) / addPos.entryPrice) * 100
          : ((addPos.entryPrice - currentPrice) / addPos.entryPrice) * 100;
        
        this.config.capitalPool.release(`${this.config.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
        totalPnlUsd += addPnlUsd;
        totalMarginReleased += addMargin;
        
        // V5.30: Save additional position as separate trade in DB
        const addNotional = addPos.qty * currentPrice;
        const addFeeUsd = addNotional * 0.0004;
        await this.saveExitToDb(addPos, currentPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, undefined, addFeeUsd);
        
        logger.info(`📝 [${symbol}] PAPER MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED | PnL=$${addPnlUsd.toFixed(2)}`);
      }
      this.additionalPositions = [];
      
      // Release MARGIN (not notional) with PnL
      this.config.capitalPool.release(this.config.sessionId, marginToRelease, pnlUsd);
      
      // V5.41: Paper mode realistic costs (aligned with backtest for fair comparison)
      // Backtest uses: 0.04% × 2 (entry+exit) + 0.05% × 2 (slippage) + 0.01%/8h (funding)
      const exitNotionalUsd = position.qty * currentPrice;
      const entryNotionalUsd = position.qty * position.entryPrice;
      const tradingFeeEntry = entryNotionalUsd * 0.0004;  // 0.04% on entry
      const tradingFeeExit = exitNotionalUsd * 0.0004;    // 0.04% on exit
      const slippageEntry = entryNotionalUsd * 0.0005;    // 0.05% slippage on entry
      const slippageExit = exitNotionalUsd * 0.0005;      // 0.05% slippage on exit
      
      // Calculate funding: 0.01% per 8h period held
      const holdMinutes = (Date.now() - position.entryTime) / 60000;
      const holdBars = Math.floor(holdMinutes / 15);
      const fundingPeriods = Math.floor(holdBars / 32); // 32 bars = 8 hours
      const fundingFee = fundingPeriods * (entryNotionalUsd * 0.0001); // 0.01% per period
      
      const paperFeeUsd = tradingFeeEntry + tradingFeeExit + slippageEntry + slippageExit + fundingFee;

      // V5.78 FIX: Only send notifications if DB save succeeds
      // This prevents false notifications when position is still open due to DB failure
      const dbSaveSuccess = await this.saveExitToDb(position, currentPrice, reason, pnlPct, totalPnlUsd, undefined, paperFeeUsd);

      if (!dbSaveSuccess) {
        logger.error(`❌ [${symbol}] PAPER close DB save FAILED - position may still exist in DB. Skipping notifications.`);
        // Don't send notification - position might still be open
        return;
      }

      // V5.91: Null position AFTER DB save succeeds — prevents orphan if DB fails
      this.position = null;

      logger.info(`📝 [${symbol}] PAPER CLOSED | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${totalPnlUsd.toFixed(2)}) | margin released=$${totalMarginReleased.toFixed(2)} | costs=$${paperFeeUsd.toFixed(2)}`);

      // 📢 Send Telegram notification for paper exit avec P&L et balance
      // V5.78: Only sent AFTER successful DB save
      const balanceAfterPaper = this.config.capitalPool.getTotalCapital();
      void notifyPositionClosed({
        agentId: this.config.sessionId,
        symbol,
        side: position.side,
        quantity: position.qty,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        pnl: totalPnlUsd,
        pnlPct: pnlPct,
        reason,
        mode: 'paper',
        balanceAfter: balanceAfterPaper,
        feesUsd: paperFeeUsd,
        userId: this.config.userId,
      });

      // Old notification system (kept for compatibility)
      notifyTradeExit({
        symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: currentPrice,
        qty: position.qty,
        notionalUsd,
        pnlUsd,
        pnlPct,
        reason,
        mode: 'paper',
        userId: this.config.userId || undefined,
      });

      // V5.63: Record trade result for consecutive loser tracking
      // Winner = positive net PnL after fees (use totalPnlUsd which includes multi-positions)
      const isWinner = (totalPnlUsd - paperFeeUsd) > 0;
      this.config.capitalPool.recordTradeResult(isWinner, symbol);

      // V5.79: Record trade for daily Telegram report
      recordTrade(totalPnlUsd - paperFeeUsd);

    } else {
      // Live close
      try {
        // 🚫 V5.71: Check circuit breaker with CRITICAL exit allowance
        // Position exits are critical - we allow them even when circuit is open (rate-limited to 1 per 5s)
        // This prevents positions from being stuck open during IP bans or rate limits
        if (!globalRestCircuitBreaker.canMakeCriticalRequest()) {
          const state = globalRestCircuitBreaker.getState();
          const remainingMs = state.closesAt ? state.closesAt - Date.now() : 0;
          const remainingSec = Math.round(remainingMs / 1000);
          logger.error(`🚫 [${symbol}] REST circuit breaker is OPEN and critical rate limit exceeded - cannot close position (${remainingSec}s remaining) ⚠️ POSITION REMAINS OPEN! Will retry on next cycle.`);
          // Don't clear position or release capital - the position is still open on exchange!
          // Reset closingPosition flag so we can retry on next exit check cycle
          this.closingPosition = false;
          // Restart RT monitor — close failed, position still needs real-time SL protection
          this.startRealtimeExitMonitorIfNeeded();
          return;
        }
        
        // FIRST: Cancel any open SL/TP orders to avoid orphaned orders
        await this.cancelStopLossOnExchange();

        // Format quantity to exchange precision
        const formattedQty = this.formatQtyForExchange(symbol, position.qty);

        // ========================================================================
        // ORDER QUEUE INTEGRATION - Submit exit order via global queue
        // ========================================================================

        // Calculate PnL for priority calculation
        const pnlPct = position.side === 'long'
          ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

        const holdTimeMs = Date.now() - position.entryTime;

        const exitReason = reason as ExitReason;
        const orderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: this.config.sessionId,
          userId: this.config.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: exitReason,
            isEntry: false,
            positionPnlPct: pnlPct,
            positionHoldTimeMs: holdTimeMs,
            positionLeverage: position.leverage,
          }),
          symbol,
          side: position.side === 'long' ? 'sell' : 'buy',
          type: 'market',
          quantity: formattedQty,
          params: { reduceOnly: true },
          isEntry: false,
          reason,
          priorityContext: {
            isEntry: false,
            reason: exitReason,
            positionPnlPct: pnlPct,
            positionHoldTimeMs: holdTimeMs,
          },
          submittedAt: Date.now(),
          retries: 0,
          timeoutMs: 30_000,
        };

        logger.info(
          `[${symbol}] Submitting ${position.side} exit order to queue | ` +
          `reason=${reason} | orderId=${orderRequest.id} | priority=${orderRequest.priority}`
        );

        const result = await orderQueue.submitOrder(orderRequest);

        if (!result.success) {
          logger.error(`[${symbol}] Exit order FAILED: ${result.error} (${result.errorCode})`);
          this.closingPosition = false;
          // Restart RT monitor — close failed, position still needs real-time SL protection
          this.startRealtimeExitMonitorIfNeeded();
          return;
        }

        const order = result.order!;
        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const exitPrice = order.average || order.price || currentPrice;

        // ═══════════════════════════════════════════════════════════════════════════
        // V5.80: PARTIAL FILL DETECTION AND RETRY (BUG FIX)
        //
        // Previous bug: Compared order.filled against position.qty, but we sent formattedQty.
        // If formattedQty < position.qty (due to floor rounding), the check would pass even
        // when a residual remains. Example:
        //   - position.qty = 10.0025
        //   - formattedQty = 10.002 (after floor)
        //   - order.filled = 10.002 (100% of what we sent)
        //   - Old ratio = 10.002 / 10.0025 = 99.97% > 99% → no retry triggered!
        //   - But 0.0005 residual remains on exchange
        //
        // Fix: Compare against formattedQty AND check for formatting loss separately.
        // ═══════════════════════════════════════════════════════════════════════════
        const filledQty = order.filled ?? 0;

        // Check 1: Did exchange fill what we actually requested?
        const exchangeFillRatio = filledQty / formattedQty;

        // Check 2: Did formatting lose any quantity? (floor rounding residual)
        const formattingLoss = position.qty - formattedQty;
        const hasFormattingResidual = formattingLoss > 0.000001; // Epsilon for float comparison

        if (exchangeFillRatio < 0.99) {
          // Exchange partial fill - retry for unfilled portion of what we sent
          const remainingQty = formattedQty - filledQty;
          logger.warn(
            `⚠️ [${symbol}] EXCHANGE PARTIAL FILL! ` +
            `Sent=${formattedQty} Filled=${filledQty} (${(exchangeFillRatio * 100).toFixed(1)}%) ` +
            `Remaining=${remainingQty.toFixed(6)}`
          );

          // Retry close for remaining amount
          try {
            const retryFormattedQty = this.formatQtyForExchange(symbol, remainingQty);

            // Only retry if remaining qty meets minimum order size
            if (retryFormattedQty > 0) {
              const retryOrderRequest: OrderRequest = {
                id: uuidv4(),
                agentId: this.config.sessionId,
                userId: this.config.userId || 'unknown',
                priority: 95, // CRITICAL priority for cleanup
                symbol,
                side: closeSide,
                type: 'market',
                quantity: retryFormattedQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'partial_fill_cleanup',
                priorityContext: { isEntry: false, reason: 'partial_fill_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };

              logger.info(`🔄 [${symbol}] Submitting RETRY order for remaining ${retryFormattedQty} qty`);
              const retryResult = await orderQueue.submitOrder(retryOrderRequest);

              if (retryResult.success) {
                logger.info(`✅ [${symbol}] Partial fill cleanup SUCCESS | filled=${retryResult.order?.filled}`);
              } else {
                logger.error(`❌ [${symbol}] Partial fill cleanup FAILED: ${retryResult.error}`);
                // Position may still be partially open - will be caught by syncWithExchange
              }
            } else {
              logger.warn(`⚠️ [${symbol}] Remaining qty ${remainingQty} too small to close (below min order size)`);
            }
          } catch (retryError: any) {
            logger.error(`❌ [${symbol}] Partial fill retry error: ${retryError.message}`);
          }
        }

        // V5.81: Close formatting residual (floor rounding left dust on exchange)
        // Previously this only warned; now we send a second reduceOnly order to fully close.
        if (hasFormattingResidual && exchangeFillRatio >= 0.99) {
          logger.warn(
            `⚠️ [${symbol}] FORMATTING RESIDUAL: position.qty=${position.qty.toFixed(6)} but ` +
            `only sent formattedQty=${formattedQty.toFixed(6)} (residual=${formattingLoss.toFixed(6)}). ` +
            `Sending cleanup order...`
          );

          try {
            const residualQty = this.formatQtyForExchange(symbol, formattingLoss);
            if (residualQty > 0) {
              const residualOrder: OrderRequest = {
                id: uuidv4(),
                agentId: this.config.sessionId,
                userId: this.config.userId || 'unknown',
                priority: 95, // CRITICAL priority for cleanup
                symbol,
                side: closeSide,
                type: 'market',
                quantity: residualQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'formatting_residual_cleanup',
                priorityContext: { isEntry: false, reason: 'formatting_residual_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };

              logger.info(`🧹 [${symbol}] Submitting residual cleanup order for ${residualQty} qty`);
              const residualResult = await orderQueue.submitOrder(residualOrder);

              if (residualResult.success) {
                logger.info(`✅ [${symbol}] Residual cleanup SUCCESS | filled=${residualResult.order?.filled}`);
              } else {
                logger.error(`❌ [${symbol}] Residual cleanup FAILED: ${residualResult.error}`);
              }
            } else {
              logger.warn(`⚠️ [${symbol}] Residual ${formattingLoss.toFixed(6)} too small to close (below step size)`);
            }
          } catch (residualError: any) {
            logger.error(`❌ [${symbol}] Residual cleanup error: ${residualError.message}`);
          }
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // V5.65: SLIPPAGE VALIDATION FOR EXIT ORDERS
        // ═══════════════════════════════════════════════════════════════════════════
        const expectedExitPrice = currentPrice;
        const exitSlippage = position.side === 'long'
          ? ((expectedExitPrice - exitPrice) / expectedExitPrice) * 100  // Positive = worse for long exit (sold lower)
          : ((exitPrice - expectedExitPrice) / expectedExitPrice) * 100; // Positive = worse for short exit (bought higher)

        const maxExitSlippage = MomentumConfig.EXIT.MAX_EXIT_SLIPPAGE_PCT ?? 2.0;
        const slippageAlertEnabled = MomentumConfig.EXIT.SLIPPAGE_ALERT_ENABLED ?? true;

        if (exitSlippage > maxExitSlippage) {
          logger.warn(
            `⚠️ [${symbol}] HIGH EXIT SLIPPAGE | ` +
            `expected=$${expectedExitPrice.toFixed(4)} | filled=$${exitPrice.toFixed(4)} | ` +
            `slippage=${exitSlippage.toFixed(2)}% (max=${maxExitSlippage}%)`
          );
          // Slippage alert removed from Telegram (V5.79) - log only
        } else if (exitSlippage > 0.1) {
          logger.info(`📊 [${symbol}] Exit slippage: ${exitSlippage.toFixed(3)}%`);
        }

        // Recalculate actual PnL
        let actualPnlPct: number;
        let actualPnlUsd: number;
        if (position.side === 'long') {
          actualPnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
          actualPnlUsd = position.qty * (exitPrice - position.entryPrice);
        } else {
          actualPnlPct = ((position.entryPrice - exitPrice) / position.entryPrice) * 100;
          actualPnlUsd = position.qty * (position.entryPrice - exitPrice);
        }
        
        this.position = null;
        
        // V5.30: Close additional positions too (LIVE mode)
        let totalPnlUsd = actualPnlUsd;
        let totalMarginReleased = marginToRelease;
        
        for (const addPos of this.additionalPositions) {
          try {
            // Submit close order for each additional position
            const addFormattedQty = this.formatQtyForExchange(symbol, addPos.qty);
            
            const addOrderRequest: OrderRequest = {
              id: uuidv4(),
              agentId: this.config.sessionId,
              userId: this.config.userId || 'unknown',
              priority: calculateOrderPriority({
                reason: exitReason,
                isEntry: false,
                positionPnlPct: actualPnlPct,
                positionHoldTimeMs: Date.now() - addPos.entryTime,
              }),
              symbol,
              side: addPos.side === 'long' ? 'sell' : 'buy',
              type: 'market',
              quantity: addFormattedQty,
              params: { reduceOnly: true },
              isEntry: false,
              reason: `multi_exit_${(addPos.entryIndex || 0) + 1}`,
              priorityContext: { isEntry: false, reason: exitReason },
              submittedAt: Date.now(),
              retries: 0,
              timeoutMs: 30_000,
            };
            
            const addResult = await orderQueue.submitOrder(addOrderRequest);
            
            if (addResult.success && addResult.order) {
              const addExitPrice = addResult.order.average || addResult.order.price || currentPrice;
              let addPnlUsd: number;
              if (addPos.side === 'long') {
                addPnlUsd = addPos.qty * (addExitPrice - addPos.entryPrice);
              } else {
                addPnlUsd = addPos.qty * (addPos.entryPrice - addExitPrice);
              }
              const addPnlPct = addPos.side === 'long'
                ? ((addExitPrice - addPos.entryPrice) / addPos.entryPrice) * 100
                : ((addPos.entryPrice - addExitPrice) / addPos.entryPrice) * 100;
              const addMargin = addPos.marginUsd ?? 0;
              
              this.config.capitalPool.release(`${this.config.sessionId}_multi_${addPos.entryIndex}`, addMargin, addPnlUsd);
              totalPnlUsd += addPnlUsd;
              totalMarginReleased += addMargin;
              
              // V5.30: Save additional position as separate trade in DB
              const addNotional = addPos.qty * addExitPrice;
              const addFeeUsd = addResult.order.fee?.cost ?? (addNotional * 0.0004);
              await this.saveExitToDb(addPos, addExitPrice, `${reason}_MULTI${(addPos.entryIndex || 0) + 1}`, addPnlPct, addPnlUsd, addResult.order.id, addFeeUsd);
              
              logger.info(`🔴 [${symbol}] LIVE MULTI-POS ${(addPos.entryIndex || 0) + 1} CLOSED @ $${addExitPrice.toFixed(4)} | PnL=$${addPnlUsd.toFixed(2)}`);
            } else {
              logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close FAILED: ${addResult.error}`);
            }
          } catch (addErr: any) {
            logger.error(`❌ [${symbol}] Multi-pos ${(addPos.entryIndex || 0) + 1} close error:`, addErr?.message);
          }
        }
        this.additionalPositions = [];
        
        // Release margin from our tracking (PnL is passed for logging but NOT added to totalCapitalUsd in live mode)
        this.config.capitalPool.release(this.config.sessionId, marginToRelease, actualPnlUsd);
        
        // 🔧 CRITICAL: Sync with exchange to get the real balance after position close
        // This ensures totalCapitalUsd reflects the actual Binance balance (which includes realized PnL)
        await this.config.capitalPool.syncAfterPositionClose();
        
        // Log the updated capital state
        const newStatus = this.config.capitalPool.getStatus();
        logger.info(`💰 [${symbol}] Capital after close: total=$${newStatus.totalUsd.toFixed(2)} | available=$${newStatus.availableUsd.toFixed(2)} | inPositions=$${newStatus.inPositionsUsd.toFixed(2)}`);
        
        // Extract fee from CCXT order response, fallback to 0.04% calculation
        const exitNotionalUsd = position.qty * exitPrice;
        const liveFeeUsd = order.fee?.cost ?? (exitNotionalUsd * 0.0004);

        // V5.78 FIX: Only send notifications if DB save succeeds
        // Pass the real exchange orderId and fee for proper tracking
        const dbSaveSuccessLive = await this.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd, order.id, liveFeeUsd);

        if (!dbSaveSuccessLive) {
          logger.error(`❌ [${symbol}] LIVE close DB save FAILED - position may still exist in DB. Skipping notifications.`);
          // Don't send notification but position IS closed on exchange
          return;
        }

        logger.info(`🔴 [${symbol}] LIVE CLOSED @ $${exitPrice} | PnL=${actualPnlPct >= 0 ? '+' : ''}${actualPnlPct.toFixed(2)}% ($${actualPnlUsd.toFixed(2)}) | fee=$${liveFeeUsd.toFixed(2)} | margin released=$${marginToRelease.toFixed(2)} | orderId=${order.id}`)

        // 📢 Send Telegram notification for live exit avec tous les détails
        // V5.78: Only sent AFTER successful DB save
        const balanceAfterLive = this.config.capitalPool.getTotalCapital();
        void notifyPositionClosed({
          agentId: this.config.sessionId,
          symbol,
          side: position.side,
          quantity: position.qty,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl: actualPnlUsd,
          pnlPct: actualPnlPct,
          reason,
          mode: 'live',
          balanceAfter: balanceAfterLive,
          feesUsd: liveFeeUsd,
          userId: this.config.userId,
        });

        // Old notification system (kept for compatibility)
        notifyTradeExit({
          symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          exitPrice,
          qty: position.qty,
          notionalUsd,
          pnlUsd: actualPnlUsd,
          pnlPct: actualPnlPct,
          reason,
          mode: 'live',
          userId: this.config.userId || undefined,
        });

        // V5.63: Record trade result for consecutive loser tracking
        // Winner = positive net PnL after fees
        const isWinnerLive = (actualPnlUsd - liveFeeUsd) > 0;
        this.config.capitalPool.recordTradeResult(isWinnerLive, symbol);

        // V5.79: Record trade for daily Telegram report
        recordTrade(actualPnlUsd - liveFeeUsd);

        this.config.onTrade?.({
          symbol,
          side: closeSide,
          qty: position.qty,
          price: exitPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error: unknown) {
        logger.error(`❌ [${symbol}] Failed to close live position:`, error);
        
        // 📢 NOTIFICATION: Exit order error (CRITICAL)
        notifyOrderError({
          symbol,
          side: position.side,
          orderType: 'exit',
          error: errMsg(error),
          mode: 'live',
          userId: this.config.userId || undefined,
        });
      }
    }
    } finally {
      this.closingPosition = false;
    }
  }
  
  // ==========================================================================
  // EXCHANGE HELPERS
  // ==========================================================================
  
  private formatQtyForExchange(symbol: string, qty: number): number {
    return this.orderManager.formatQtyForExchange(symbol, qty);
  }
  
  private async fetchCandles(): Promise<Candle[]> {
    const symbol = this.config.symbol;
    // Convert CCXT symbol to Binance format: "ETH/USDT:USDT" -> "ETHUSDT"
    const binanceSymbol = symbol.split('/')[0] + 'USDT';
    
    // 1. Subscribe to WebSocket stream (re-subscribe each time to keep TTL alive)
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(binanceSymbol, '15m');
      if (!this.wsSubscribed) {
        this.wsSubscribed = true;
        logger.info(`📡 [${symbol}] Subscribed to WebSocket kline stream (0 API weight)`);
      }
    } catch (error) {
      if (!this.wsSubscribed) {
        logger.warn(`⚠️ [${symbol}] Failed to subscribe to WebSocket, will use REST`);
      }
    }
    
    // 2. Try WebSocket cache first (0 API weight!)
    // V5.50: Use getKlinesWithMeta to preserve isFinal flag for accurate candle close detection
    try {
      const wsKlines = getKlinesWithMeta(binanceSymbol, '15m');
      if (wsKlines && wsKlines.length >= 50) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume,
          isFinal: c.isFinal,
        }));
        
        // Update local cache with WS data
        this.candleCache = { candles, fetchedAt: Date.now() };
        return candles;
      }
    } catch (error) {
      // WebSocket not ready, fall through to cache/wait
    }
    
    // 3. Check local cache (from previous WS data)
    if (this.candleCache && Date.now() - this.candleCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.candleCache.candles;
    }
    
    // 4. NO REST FALLBACK - WebSocket only to avoid IP bans
    // If WebSocket doesn't have enough data yet, use whatever we have
    // V5.29: Removed REST fallback - caused IP bans from Binance
    // V5.50: Use getKlinesWithMeta to preserve isFinal flag
    const wsKlinesPartial = getKlinesWithMeta(binanceSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        isFinal: c.isFinal,
      }));
      this.candleCache = { candles, fetchedAt: Date.now() };
      return candles;
    }
    
    // No data - return cached or empty (agent will skip tick)
    return this.candleCache?.candles || [];
  }
  
  private async fetchBtcCandles(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT';

    // 1. Subscribe to BTC WebSocket stream
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(btcSymbol, '15m');
      if (!globalCacheManager.getBtc15mWsSubscribed()) {
        globalCacheManager.setBtc15mWsSubscribed(true);
        logger.info('📡 [BTC] Subscribed to WebSocket kline stream (0 API weight)');
      }
    } catch (error) {
      if (!globalCacheManager.getBtc15mWsSubscribed()) {
        logger.warn('⚠️ [BTC] Failed to subscribe to WebSocket, will use REST');
      }
    }

    // 2. Try WebSocket cache first (0 API weight!)
    try {
      const wsKlines = getKlinesWithMeta(btcSymbol, '15m');
      if (wsKlines && wsKlines.length >= 200) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c.timestamp, open: c.open, high: c.high,
          low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
        }));
        globalCacheManager.setBtc15mCache(candles);
        return candles;
      }
    } catch (error) {
      // WebSocket cache miss
    }

    // 3. Check global cache
    if (globalCacheManager.isBtc15mCacheValid()) {
      return globalCacheManager.getBtc15mCache()!.candles;
    }

    // 4. WebSocket partial data
    const wsKlinesPartial = getKlinesWithMeta(btcSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c.timestamp, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
      }));
      globalCacheManager.setBtc15mCache(candles);
      return candles;
    }

    return globalCacheManager.getBtc15mCache()?.candles || [];
  }

  // V5.36: Fetch BTC 1h candles for Multi-Timeframe Confluence filter
  private async fetchBtcCandles1h(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT';
    const MIN_FINAL_CANDLES = 11;

    // 0. Check global cache first
    if (globalCacheManager.isBtc1hCacheValid(MIN_FINAL_CANDLES)) {
      return globalCacheManager.getBtc1hCache()!.candles;
    }

    // Prevent multiple concurrent fetches
    const existing = globalCacheManager.getBtc1hFetchingPromise();
    if (existing) return existing;

    const fetchPromise = (async () => {
      try {
        // 1. Subscribe to BTC 1h WebSocket stream
        try {
          const ws = getBinanceWebSocket();
          ws.subscribeToKline(btcSymbol, '1h');
        } catch (error) {
          // Silently fail
        }

        // 2. Try WebSocket cache first (0 API weight!)
        try {
          const wsKlines = getKlinesWithMeta(btcSymbol, '1h');
          if (wsKlines && wsKlines.length >= 20) {
            const candles: Candle[] = wsKlines.map(c => ({
              timestamp: c.timestamp, open: c.open, high: c.high,
              low: c.low, close: c.close, volume: c.volume, isFinal: c.isFinal,
            }));
            globalCacheManager.setBtc1hCache(candles);
            return candles;
          }
        } catch (error) {
          // WebSocket cache miss
        }

        // 3. REST API fallback (V5.86: 250 candles for SMA200 regime)
        try {
          if (this.config.exchange.fetchOHLCV && !isIpBanned() && ipWeightTracker.canMakeCall(10)) {
            const ohlcv = await this.config.exchange.fetchOHLCV('BTC/USDT:USDT', '1h', undefined, 250);
            ipWeightTracker.record(10, 'fetchOHLCV:BTC_1h:fallback');
            if (ohlcv && ohlcv.length >= 11) {
              const candles: Candle[] = ohlcv.map((c, idx) => ({
                timestamp: c[0] as number, open: c[1] as number,
                high: c[2] as number, low: c[3] as number,
                close: c[4] as number, volume: c[5] as number,
                isFinal: idx < ohlcv.length - 1,
              }));
              globalCacheManager.setBtc1hCache(candles);
              seedKlinesFromWebSocket(btcSymbol, '1h', ohlcv);
              logger.info(`[fetchBtcCandles1h] REST seeded ${ohlcv.length} candles to WebSocket cache`);
              return candles;
            }
          }
        } catch (error: unknown) {
          const msg = errMsg(error);
          if (msg.includes('451') || msg.includes('restricted location')) {
            setGeoBlock('fetchBtcCandles1h');
          }
          logger.warn(`[fetchBtcCandles1h] REST fallback failed: ${msg}`);
        }

        logger.warn('[fetchBtcCandles1h] No BTC 1h data available - MTF filter will be bypassed');
        return [];
      } finally {
        globalCacheManager.setBtc1hFetchingPromise(null);
      }
    })();

    globalCacheManager.setBtc1hFetchingPromise(fetchPromise);
    return fetchPromise;
  }

  /**
   * Cancel ALL orders on exchange (both regular AND algo orders)
   * This is a helper that calls cancelAllOrders twice - once for regular, once for algo
   */
  // ═══════════════════════════════════════════════════════════════════════
  // V5.82: PROACTIVE LIMIT ORDER HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private async placeProactiveLimit(
    symbol: string, orderSide: 'buy' | 'sell', qty: number, price: number,
  ): Promise<string | null> {
    return this.orderManager.placeProactiveLimit(symbol, orderSide, qty, price);
  }

  private async cancelProactiveLimit(symbol: string): Promise<void> {
    await this.orderManager.cancelProactiveLimit(symbol, this.rtExitHandler.getNfsStateMachine());
    this.rtExitHandler.proactiveLimitOrderId = null;
    this.rtExitHandler.proactiveLimitPrice = null;
  }

  private async checkProactiveLimitFill(symbol: string): Promise<{ filled: boolean; avgPrice: number } | null> {
    // Sync proactive limit state to orderManager before checking
    this.orderManager.proactiveLimitOrderId = this.rtExitHandler.proactiveLimitOrderId;
    this.orderManager.proactiveLimitPrice = this.rtExitHandler.proactiveLimitPrice;
    return this.orderManager.checkProactiveLimitFill(symbol, this.position, this.lastPrice);
  }

  private async cancelAllOrdersOnExchange(): Promise<void> {
    await this.orderManager.cancelAllOrdersOnExchange(this.position);
  }

  private async cancelStopLossOnExchange(): Promise<void> {
    await this.orderManager.cancelStopLossOnExchange(this.position);
  }
  
  private async setStopLossOnExchange(position: Position, isUpdate: boolean = false): Promise<void> {
    await this.orderManager.setStopLossOnExchange(position, isUpdate);
  }
  
  /**
   * 🚀 V5.12: SMART Trailing Stop - Starts tight, widens at higher profit
   * 
   * Phase 1 (0.8% → 2%): callback 0.5% (tight protection)
   * Phase 2 (>2%): callback 0.8% (let winner run)
   * 
   * NOTE: Binance doesn't support dynamic callback, so we:
   * 1. Place initial trailing with tight callback (0.5%)
   * 2. When profit reaches 2%, cancel and re-place with wide callback (0.8%)
   * 
   * @returns true if trailing stop was placed successfully, false if fallback to STOP_MARKET was used
   */
  private async setTrailingStopOnExchange(position: Position, isWidening: boolean = false): Promise<boolean> {
    return this.orderManager.setTrailingStopOnExchange(
      position,
      (pos, price, reason) => this.closePosition(pos, price, reason),
      isWidening,
    );
  }
  
  private async updateTrailingStopOnExchange(newStopPrice: number): Promise<void> {
    if (!this.position) return;
    await this.orderManager.updateTrailingStopOnExchange(this.position, newStopPrice);
  }

  private async updateEmergencyStopProfitProtectionIfNeeded(currentPrice: number, pnlPct: number): Promise<void> {
    if (!this.position) return;
    await this.orderManager.updateEmergencyStopProfitProtectionIfNeeded(this.position, currentPrice, pnlPct);
  }

  // ==========================================================================
  // DATABASE HELPERS
  // ==========================================================================
  
  private async loadExistingPosition(): Promise<void> {
    const position = await this.persistence.loadExistingPosition();
    if (position) {
      this.position = position;
      // CRITICAL: Register margin in CapitalPool to prevent double-spending
      const marginUsd = position.marginUsd ?? (position.qty * position.entryPrice) / (position.leverage ?? 4.5);
      this.config.capitalPool.commit(this.config.sessionId, marginUsd);
    }
  }
  
  /**
   * 🔄 SYNC WITH EXCHANGE (Live Mode Only)
   * Uses WebSocket for real-time position updates (0 weight!) instead of REST API
   * Detects if stop losses were executed on Binance
   */
  private async syncWithExchange(): Promise<void> {
    const symbol = this.config.symbol;
    
    // Throttle sync to avoid excessive processing
    const now = Date.now();
    if (now - this.lastPositionSync < this.POSITION_SYNC_INTERVAL_MS) {
      return;
    }
    this.lastPositionSync = now;
    
    try {
      // 🚀 Use WebSocket position cache (0 weight!) instead of fetchPositions (5 weight)
      const wsPosition = getPositionFromWebSocket(this.config.userId, symbol);
      
      let exchangeQty = 0;
      let exchangeSide: 'long' | 'short' = 'long';
      let entryPrice = 0;
      let unrealizedPnl = 0;
      
      if (wsPosition) {
        // Got position from WebSocket cache (0 API weight!)
        exchangeQty = Math.abs(wsPosition.positionAmt);
        exchangeSide = wsPosition.side === 'short' ? 'short' : 'long';
        entryPrice = wsPosition.entryPrice;
        unrealizedPnl = wsPosition.unrealizedPnl;
      } else {
        // NO REST FALLBACK - WebSocket only to prevent IP bans
        // V5.29: Removed REST fallback completely - caused catastrophic IP bans
        // Position sync via REST was being called by 20+ agents every 30s = instant ban
        // 
        // If WebSocket userData stream is not connected, positions will not sync.
        // This is acceptable because:
        // 1. server.ts calls fetchPositions() once at startup to seed cache
        // 2. WebSocket userData stream should be active (listenKey refresh)
        // 3. If WS disconnects, better to have stale data than IP ban
        //
        // If local position exists but WS says no position:
        if (this.position !== null) {
          logger.info(`🔄 [${symbol}] WS has no position but local has one - position may be closed`);
          // Continue to handle the mismatch below (exchangeQty stays 0)
        } else {
          // No position in WS, no position locally - nothing to do
          return;
        }
      }
      
      // Case 1: We think we have a position but exchange says NO
      if (this.position && exchangeQty === 0) {
        // V5.91: Guard against race with closePosition() — if close is already in progress,
        // skip to prevent double capital release + double DB save
        if (this.closingPosition) {
          logger.info(`🔄 [${symbol}] SYNC: closePosition() in progress — skipping to prevent double processing`);
          return;
        }
        logger.info(`🔴 [${symbol}] SYNC MISMATCH: Position closed on exchange (likely stop loss hit)`);
        
        // Try to get the last trade to find exit price and orderId
        let exitPrice = this.position.entryPrice;
        let exchangeOrderId: string | undefined;
        let orderType: string | undefined;
        
        // 🔍 Determine exit reason based on order data from Binance
        let reason = EXIT_SL_EXCHANGE;
        
        try {
          // Prefer WebSocket user-data fills (0 weight) when available
          if (isUserDataStreamActive(this.config.userId)) {
            const exitSide = this.position.side === 'long' ? 'SELL' : 'BUY';
            const wsFill = getLastFilledOrderTradeUpdateFromWebSocket(this.config.userId, symbol, {
              reduceOnly: true,
              side: exitSide,
            });

            if (wsFill) {
              const wsPrice = Number(wsFill.averagePrice ?? wsFill.lastFilledPrice);
              if (Number.isFinite(wsPrice) && wsPrice > 0) {
                exitPrice = wsPrice;
              }
              exchangeOrderId = wsFill.orderId;
              orderType = wsFill.orderType;
              logger.info(`📈 [${symbol}] Found exit fill via WS: $${exitPrice} orderId=${exchangeOrderId} type=${orderType}`);
            } else {
              logger.warn(`⚠️ [${symbol}] No WS exit fill found yet; using entryPrice fallback for sync.`);
            }
          }

          // REST fallback (only if WS is not active or had no data)
          // V5.66: Use deduplicator to prevent concurrent identical calls
          if (!exchangeOrderId && this.config.exchange.fetchMyTrades && ipWeightTracker.canMakeCall(10)) {
            const since = Date.now() - 3600000;
            const key = makeFetchMyTradesKey(this.config.userId, symbol, since);
            const trades = await exchangeAPIDeduplicator.execute(
              key,
              async () => {
                const result = await this.config.exchange.fetchMyTrades!(symbol, since, 10);
                ipWeightTracker.record(10, `fetchMyTrades:exitSync:${symbol}`);
                return result;
              },
              5_000, // 5s cache TTL for exit sync
              `${this.config.sessionId}:exitSync`
            );
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = lastTrade.price || exitPrice;
              exchangeOrderId = lastTrade.order || (lastTrade.info?.orderId as string | undefined);
              orderType = (lastTrade.info?.type as string | undefined) || lastTrade.type;
              logger.info(`📈 [${symbol}] Found exit trade via REST: $${exitPrice} orderId=${exchangeOrderId} type=${orderType}`);
            }
          }
        } catch (tradeError) {
          logger.warn(`⚠️ [${symbol}] Could not determine exit trade:`, tradeError);
        }
        
        // Calculate PnL
        let pnlPct: number;
        let pnlUsd: number;
        if (this.position.side === 'long') {
          pnlPct = ((exitPrice - this.position.entryPrice) / this.position.entryPrice) * 100;
          pnlUsd = this.position.qty * (exitPrice - this.position.entryPrice);
        } else {
          pnlPct = ((this.position.entryPrice - exitPrice) / this.position.entryPrice) * 100;
          pnlUsd = this.position.qty * (this.position.entryPrice - exitPrice);
        }
        
        // 🔍 V5.13: IMPROVED exit reason detection using order type
        // Priority 1: Check if orderType explicitly says TRAILING_STOP_MARKET
        if (orderType && orderType.includes('TRAILING')) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderType=${orderType} (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 2: Check if orderId matches our tracked trailingOrderId
        else if (exchangeOrderId && this.position.trailingOrderId && exchangeOrderId === this.position.trailingOrderId) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderId match (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 3: If PnL > -1% and we had a trailing order active, assume trailing
        // (Trailing activates at +0.8%, so any exit with PnL > -1% is likely trailing)
        else if (pnlPct > -1 && this.position.trailingOrderId) {
          reason = EXIT_TRAIL_EXCHANGE;
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via PnL heuristic (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 4: V5.85 - Check if stagnant was confirmed (exchange SL was tightened)
        else if (this.position.stagnantState?.confirmed && !this.position.stagnantState?.cancelled) {
          reason = EXIT_STAGNANT;
          logger.info(`🐌 [${symbol}] Detected STAGNANT TRADE exit (PnL: ${pnlPct.toFixed(2)}%, stagnant SL hit on exchange)`);
        }
        // Priority 5: Fixed stop loss (significant loss or orderType is STOP_MARKET)
        else {
          reason = EXIT_SL_EXCHANGE;
          logger.info(`🛑 [${symbol}] Detected FIXED SL exit (PnL: ${pnlPct.toFixed(2)}%, type=${orderType})`);
        }
        
        const notionalUsd = this.position.qty * this.position.entryPrice;
        // V5.6: Use stored margin, fallback to notional/leverage or notional
        const marginToRelease = this.position.marginUsd ?? (this.position.leverage ? notionalUsd / this.position.leverage : notionalUsd);
        
        // Release MARGIN (not notional)
        this.config.capitalPool.release(this.config.sessionId, marginToRelease, pnlUsd);
        
        // Calculate fee for synced exit (no order response available, use 0.04%)
        const syncExitNotionalUsd = this.position.qty * exitPrice;
        const syncFeeUsd = syncExitNotionalUsd * 0.0004;
        
        // Save exit to DB with exchange orderId and calculated fee
        const syncDbSuccess = await this.saveExitToDb(this.position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId, syncFeeUsd);

        logger.info(`✅ [${symbol}] Position synced: Exit @ $${exitPrice.toFixed(4)}, PnL: ${pnlPct.toFixed(2)}%, fee: $${syncFeeUsd.toFixed(2)}, margin released: $${marginToRelease.toFixed(2)}`);

        // V5.89: Send Telegram notification for exchange-triggered exits (was missing!)
        // Previously only closePosition() sent notifications, but exchange-side SL/trailing
        // exits go through syncWithExchange and silently saved without notifying.
        if (syncDbSuccess) {
          const balanceAfterSync = this.config.capitalPool.getTotalCapital();
          void notifyPositionClosed({
            agentId: this.config.sessionId,
            symbol,
            side: this.position.side,
            quantity: this.position.qty,
            entryPrice: this.position.entryPrice,
            exitPrice,
            pnl: pnlUsd,
            pnlPct,
            reason,
            mode: 'live',
            balanceAfter: balanceAfterSync,
            feesUsd: syncFeeUsd,
            userId: this.config.userId,
          });

          notifyTradeExit({
            symbol,
            side: this.position.side,
            entryPrice: this.position.entryPrice,
            exitPrice,
            qty: this.position.qty,
            notionalUsd,
            pnlUsd,
            pnlPct,
            reason,
            mode: 'live',
            userId: this.config.userId || undefined,
          });

          // Record trade for consecutive loser tracking + daily report
          const isWinnerSync = (pnlUsd - syncFeeUsd) > 0;
          this.config.capitalPool.recordTradeResult(isWinnerSync, symbol);
          recordTrade(pnlUsd - syncFeeUsd);
        }
        
        // V5.12: Cancel any remaining orders (trailing stop, backup SL) to avoid orphans
        // This is CRITICAL - when Binance trailing triggers, the STOP_MARKET remains!
        logger.info(`🧹 [${symbol}] Cleaning up orphan orders after position close...`);
        await this.cancelStopLossOnExchange();
        
        // Reset trailing flags
        this.trailingNotified = false;
        this.trailingWidened = false;
        this.stagnantSlUpdated = false;
        // V5.72: Reset trailing tracking (owned by rtExitHandler)
        this.rtExitHandler.resetState();

        this.position = null;
      }
      
      // Case 2: Exchange has position but we don't know about it
      else if (!this.position && exchangeQty > 0) {
        // V5.82: Close dust positions on exchange (residual from floor rounding on exit)
        // If notional value < $5, this is dust — close it on exchange to prevent re-adoption
        const dustNotional = exchangeQty * entryPrice;
        if (dustNotional < 5) {
          logger.info(`🧹 [${symbol}] SYNC: Dust position detected (${exchangeSide} ${exchangeQty}, notional=$${dustNotional.toFixed(2)}) — closing on exchange`);
          try {
            const closeSide = exchangeSide === 'long' ? 'sell' : 'buy';
            const dustFormattedQty = this.formatQtyForExchange(symbol, exchangeQty);
            if (dustFormattedQty > 0) {
              const dustOrder: OrderRequest = {
                id: uuidv4(),
                agentId: this.config.sessionId,
                userId: this.config.userId || 'unknown',
                priority: 95,
                symbol,
                side: closeSide,
                type: 'market',
                quantity: dustFormattedQty,
                params: { reduceOnly: true },
                isEntry: false,
                reason: 'dust_position_cleanup',
                priorityContext: { isEntry: false, reason: 'dust_position_cleanup' },
                submittedAt: Date.now(),
                retries: 0,
                timeoutMs: 30_000,
              };
              const dustResult = await orderQueue.submitOrder(dustOrder);
              if (dustResult.success) {
                logger.info(`✅ [${symbol}] Dust cleanup SUCCESS | filled=${dustResult.order?.filled}`);
              } else {
                logger.warn(`⚠️ [${symbol}] Dust cleanup FAILED: ${dustResult.error}`);
              }
            } else {
              logger.info(`🧹 [${symbol}] Dust qty ${exchangeQty} below step size — cannot close via order`);
            }
          } catch (dustErr: any) {
            logger.warn(`⚠️ [${symbol}] Dust cleanup error: ${dustErr?.message}`);
          }
          return;
        }

        logger.info(`⚠️ [${symbol}] SYNC: Found unexpected position on exchange (${exchangeSide} ${exchangeQty})`);
        
        if (entryPrice > 0) {
          // 🔧 V5.29: Check if position exists in DB to preserve entryTime and maxPnlPct
          // This is critical for stagnant trade detection after restart
          let dbEntryTime: number | undefined;
          let dbMaxPnlPct: number | undefined;
          
          try {
            // V5.44 FIX: Position model doesn't have exitPrice field
            // We find the most recent position for this session/symbol
            // An "open" position is one that exists and hasn't been deleted
            const dbPosition = await this.config.prisma.position.findFirst({
              where: {
                sessionId: this.config.sessionId,
                symbol: this.config.symbol,
              },
              orderBy: { openedAt: 'desc' },
            });
            
            if (dbPosition && dbPosition.openedAt) {
              dbEntryTime = dbPosition.openedAt.getTime();
              dbMaxPnlPct = dbPosition.maxPnlPct || undefined;
              const ageMinutes = dbEntryTime ? Math.round((Date.now() - dbEntryTime) / 60000) : 0;
              logger.info(`📊 [${symbol}] Restored position history from DB: age=${ageMinutes}min, maxPnl=${dbMaxPnlPct?.toFixed(2)}%`);
            }
          } catch (dbErr) {
            logger.warn(`⚠️ [${symbol}] Failed to load DB position:`, dbErr);
          }
          
          // V5.6: Estimate margin - use asset-specific leverage or default to 5x
          const notionalUsd = exchangeQty * entryPrice;
          const estimatedLeverage = MomentumConfig.LEVERAGE[symbol] || 5;
          const estimatedMargin = notionalUsd / estimatedLeverage;
          
          this.position = {
            symbol,
            side: exchangeSide,
            entryPrice,
            qty: exchangeQty,
            entryTime: dbEntryTime || Date.now(), // Use DB time if available
            realEntryTime: dbEntryTime || Date.now(),  // V5.86: Use DB time for stagnant detection
            leverage: estimatedLeverage,
            marginUsd: estimatedMargin,
            highWaterMark: exchangeSide === 'long' ? entryPrice : undefined,
            lowWaterMark: exchangeSide === 'short' ? entryPrice : undefined,
            maxPnlPct: dbMaxPnlPct, // Preserve max PnL for stagnant detection
          };
          
          // Commit MARGIN (not notional) for this position
          this.config.capitalPool.commit(this.config.sessionId, estimatedMargin);
          
          // Calculate entry fee for synced position (no order available, use 0.04%)
          const syncEntryFee = notionalUsd * 0.0004;
          
          // Save to DB with calculated fee (only if not already saved)
          if (!dbEntryTime) {
            await this.savePositionToDb(this.position, 'synced_from_exchange', syncEntryFee);
          }
          
          logger.info(`✅ [${symbol}] Position synced from exchange: ${exchangeSide} @ $${entryPrice} (age: ${Math.round((Date.now() - (dbEntryTime || Date.now())) / 60000)}min)`);

          // ═══════════════════════════════════════════════════════════════════════════
          // V5.79: CRITICAL - Set up stop loss protection for synced positions
          // Without this, positions detected by sync would have NO PROTECTION
          // ═══════════════════════════════════════════════════════════════════════════
          if (this.config.mode === 'live') {
            try {
              // Calculate emergency stop (same logic as live entry)
              const baseSlPct = 2.0; // Default base SL
              const emergencyTargetPct = baseSlPct * (MomentumConfig.EXIT.EMERGENCY_STOP_MULTIPLIER || 2.5);
              const emergencyMaxPct = MomentumConfig.EXIT.EMERGENCY_STOP_MAX_PCT ?? 3.0;
              const emergencySlPct = Math.min(emergencyTargetPct, emergencyMaxPct);
              const emergencyStop = exchangeSide === 'long'
                ? entryPrice * (1 - emergencySlPct / 100)
                : entryPrice * (1 + emergencySlPct / 100);

              this.position.stopLoss = emergencyStop;
              this.position.emergencyStopPrice = emergencyStop;

              await this.setStopLossOnExchange(this.position, false);
              logger.info(`🛡️ [${symbol}] SYNC: Emergency SL set @ $${emergencyStop.toFixed(4)} (${emergencySlPct.toFixed(2)}%) for synced position`);

              // Start realtime exit monitor for the synced position
              this.startRealtimeExitMonitorIfNeeded();
            } catch (slError: any) {
              logger.error(`❌ [${symbol}] SYNC: Failed to set stop loss for synced position: ${slError.message}`);
              // Position exists but has no protection - will be caught by safety check on next 15m candle
            }
          }
        }
      }

      // Case 3: Both have position - verify they match (use variables we already have)
      else if (this.position && exchangeQty > 0) {
        // Just log for now, could add reconciliation logic
        logger.info(`✅ [${symbol}] Position verified on exchange: qty=${exchangeQty} entry=$${entryPrice} uPnL=$${unrealizedPnl.toFixed(2)}`);
      }
      
      // 🔍 V5.13: Check for missing trades (trades that happened between ticks)
      // This runs on every sync to catch trades that completed quickly
      await this.checkMissingTrades();
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Failed to sync with exchange:`, error);
    }
  }
  
  /**
   * 🔍 V5.13: Check for missing trades
   * Compares Binance trade history with DB to find and log missing trades
   * This catches trades that completed between ticks (entry->exit->entry within 1 minute)
   */
  private async checkMissingTrades(): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      if (this.config.mode !== 'live') {
        return;
      }

      const now = Date.now();
      if (now - this.lastMissingTradesCheck < this.MISSING_TRADES_CHECK_INTERVAL_MS) {
        return;
      }
      this.lastMissingTradesCheck = now;

      // If user-data stream is active, rely on WS-based sync (avoid REST bursts)
      if (isUserDataStreamActive(this.config.userId)) {
        return;
      }

      // Get all trades from Binance for the last 2 hours (to catch recent misses)
      // V5.66: Use deduplicator to prevent concurrent identical calls
      if (!this.config.exchange.fetchMyTrades || !ipWeightTracker.canMakeCall(10)) {
        return;
      }

      const since = Date.now() - 2 * 3600 * 1000; // Last 2 hours
      const key = makeFetchMyTradesKey(this.config.userId, symbol, since);
      const binanceTrades = await exchangeAPIDeduplicator.execute(
        key,
        async () => {
          const result = await this.config.exchange.fetchMyTrades!(symbol, since, 50);
          ipWeightTracker.record(10, `fetchMyTrades:missingTrades:${symbol}`);
          return result;
        },
        10_000, // 10s cache TTL for missing trades check
        `${this.config.sessionId}:missingTradesCheck`
      );
      
      if (!binanceTrades || binanceTrades.length === 0) {
        logger.info(`✅ [${symbol}] No Binance trades found in last 24h`);
        return;
      }
      
      logger.info(`📊 [${symbol}] Found ${binanceTrades.length} Binance trades in last 24h`);
      
      // Group trades into entry/exit pairs
      // Binance returns all trades chronologically, we need to match entries with exits
      const tradePairs: Array<{
        entryTrade: any;
        exitTrade: any;
      }> = [];
      
      let pendingEntry: any = null;
      
      for (const trade of binanceTrades) {
        const side = trade.side; // 'buy' or 'sell'
        const isBuy = side === 'buy';
        
        // For LONG positions: buy=entry, sell=exit
        // For SHORT positions: sell=entry, buy=exit
        // We'll assume LONG for simplicity (can be improved with order type detection)
        
        if (isBuy && !pendingEntry) {
          // Entry for LONG
          pendingEntry = trade;
        } else if (!isBuy && pendingEntry) {
          // Exit for LONG
          tradePairs.push({
            entryTrade: pendingEntry,
            exitTrade: trade,
          });
          pendingEntry = null;
        }
      }
      
      logger.info(`📊 [${symbol}] Identified ${tradePairs.length} complete trade pairs from Binance`);
      
      // Now check which pairs are missing in our DB
      let reconciledCount = 0;
      
      for (const pair of tradePairs) {
        const entryOrderId = pair.entryTrade.order || pair.entryTrade.info?.orderId;
        const exitOrderId = pair.exitTrade.order || pair.exitTrade.info?.orderId;
        
        // Check if exit order exists in DB
        const existingOrder = await this.config.prisma.order.findFirst({
          where: { clientOrderId: exitOrderId }
        });
        
        if (existingOrder) {
          // Trade already in DB, skip
          continue;
        }
        
        // Trade is missing! Reconstruct and save it
        logger.warn(`⚠️ [${symbol}] Found missing trade: entry=${entryOrderId} exit=${exitOrderId}`);
        
        const entryPrice = pair.entryTrade.price;
        const exitPrice = pair.exitTrade.price;
        const qty = pair.exitTrade.amount;
        
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        const pnlUsd = qty * (exitPrice - entryPrice);
        
        // Determine exit reason based on order type
        const orderType = pair.exitTrade.info?.type || pair.exitTrade.type;
        let reason = EXIT_SL_EXCHANGE;
        
        if (orderType && orderType.includes('TRAILING')) {
          reason = EXIT_TRAIL_EXCHANGE;
        } else if (pnlPct > -1) {
          reason = EXIT_TRAIL_EXCHANGE;
        }
        
        // Reconstruct position object
        const reconstructedPosition: Position = {
          symbol,
          side: 'long',
          entryPrice,
          qty,
          entryTime: pair.entryTrade.timestamp || Date.now(),
          leverage: 5, // Estimate
          marginUsd: (qty * entryPrice) / 5, // Estimate
          orderId: entryOrderId,
        };
        
        // Check if this entry already exists (avoid duplicate entries)
        const existingEntry = await this.config.prisma.order.findFirst({
          where: { clientOrderId: entryOrderId }
        });
        
        if (!existingEntry) {
          // Save entry first
          await this.savePositionToDb(reconstructedPosition, 'reconciled_entry', qty * entryPrice * 0.0004);
        } else {
          logger.info(`✓ [${symbol}] Entry ${entryOrderId} already exists, skipping entry save`);
        }
        
        // Save exit (use undefined for exchangeOrderId to force unique ID generation)
        // This avoids the "already exists" check in saveExitToDb
        const exitFee = qty * exitPrice * 0.0004;
        await this.saveExitToDb(reconstructedPosition, exitPrice, reason, pnlPct, pnlUsd, undefined, exitFee);
        
        reconciledCount++;
        logger.info(`✅ [${symbol}] Reconciled missing trade: PnL=${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
      }
      
      logger.info(`✅ [${symbol}] Reconciliation complete: ${reconciledCount} missing trades recovered`);
      
    } catch (error: unknown) {
      logger.error(`❌ [${symbol}] Failed to reconcile trades:`, errMsg(error));
    }
  }
  
  private async savePositionToDb(position: Position, _action: string, entryFeeUsd?: number): Promise<void> {
    await this.persistence.savePositionToDb(position, entryFeeUsd);
  }
  
  private async updatePositionStateInDb(): Promise<void> {
    if (!this.position) return;
    await this.persistence.updatePositionStateInDb(this.position);
  }
  
  private async saveExitToDb(
    position: Position,
    exitPrice: number,
    reason: string,
    pnlPct: number,
    pnlUsd: number,
    exchangeOrderId?: string,
    feeUsd?: number,
  ): Promise<boolean> {
    const result = await this.persistence.saveExitToDb(
      position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId, feeUsd,
    );
    if (result.success) {
      // Update SessionKpi (non-critical, outside transaction)
      // Pass null for currentPosition — position was just closed, unrealized should be 0
      await this.persistence.updateSessionKpi(pnlUsd, pnlPct, null, this.lastPrice);
    }
    return result.success;
  }
  
  // ==========================================================================
  // PUBLIC API
  // ==========================================================================
  
  getStatus(): { 
    running: boolean; 
    hasPosition: boolean; 
    symbol: string;
    sessionId: string;
    mode: 'paper' | 'live';
    marketConditions: MarketConditions | null;
    capitalPoolStatus: ReturnType<CapitalPool['getStatus']>;
    lastTickAt: number;
    tickCount: number;
  } {
    return {
      running: this.running,
      hasPosition: this.position !== null,
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      marketConditions: this.lastMarketConditions,
      capitalPoolStatus: this.config.capitalPool.getStatus(),
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
    };
  }
  
  /**
   * Get detailed agent state for frontend display
   */
  getAgentState(): {
    pos: (Position & {
      currentPrice?: number;
      pnlPct?: number;
      pnlUsd?: number;
      notionalUsd?: number;
      duration?: number;
      trailDistance?: number;
      // Frontend aliases
      entry?: number;
      leverage?: number;
      openedAt?: number;
      stopPrice?: number;
      stop?: number;
      targets?: number[];
      // V5.72: Trailing state for frontend
      trailingState?: {
        active: boolean;
        activatedAt: number | null;
        updateCount: number;
        currentStopPrice: number | undefined;
        peakPrice: number;
        distanceFromPeak: number;
      };
      // V5.72: Health status for frontend
      healthStatus?: 'progressing' | 'watching' | 'stagnant' | 'at_risk';
      healthReason?: string;
      peakPrice?: number;
      distanceFromPeak?: number;
      stopDistancePct?: number;
    }) | null;
    plan: { 
      bias?: 'long' | 'short' | null; 
      zone?: { from: number; to: number; mid: number } | null;
      stopDistance?: number;
      rPrices?: Array<{ r: number; price: number; pct: number }>;
    } | null;
    exit: { ts: number; price: number; reason: string } | null;
    profile: {
      riskPerTradePct: number;
      dailyLossLimitPct: number;
      maxLeverage: number;
      aggressiveness: string;
      availableUsd: number;
    };
    balance: {
      freeUsd: number;
      totalUsd: number;
    };
    lastTickAt: number;
    tickCount: number;
  } {
    // Calculate live position metrics
    let posWithMetrics: any = null;
    
    if (this.position) {
      const currentPrice = this.lastPrice || this.position.entryPrice;
      const pnlPct = this.position.side === 'long'
        ? ((currentPrice - this.position.entryPrice) / this.position.entryPrice) * 100
        : ((this.position.entryPrice - currentPrice) / this.position.entryPrice) * 100;
      const pnlUsd = this.position.side === 'long'
        ? this.position.qty * (currentPrice - this.position.entryPrice)
        : this.position.qty * (this.position.entryPrice - currentPrice);
      const notionalUsd = this.position.qty * this.position.entryPrice;
      const duration = Date.now() - this.position.entryTime;
      
      // Trail distance from current price to stop
      const trailDistance = this.position.stopLoss
        ? this.position.side === 'long'
          ? ((currentPrice - this.position.stopLoss) / currentPrice) * 100
          : ((this.position.stopLoss - currentPrice) / currentPrice) * 100
        : 0;
      
      // V5.72: Calculate peak price and distance from peak
      const peakPrice = this.position.side === 'long'
        ? this.position.highWaterMark || this.position.entryPrice
        : this.position.lowWaterMark || this.position.entryPrice;
      const distanceFromPeak = this.position.side === 'long'
        ? peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0
        : peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;

      // V5.72: Calculate health status based on backend state
      const holdMinutes = duration / 60000;
      const minHoldForJudgment = 15; // 15 minutes minimum before judging
      const stopDistancePct = trailDistance;
      const isStagnant = this.position.stagnantState?.confirmed && !this.position.stagnantState?.cancelled;
      const isAtRisk = stopDistancePct < 0.5; // Less than 0.5% from stop

      let healthStatus: 'progressing' | 'watching' | 'stagnant' | 'at_risk' = 'progressing';
      let healthReason = 'Price moving favorably';

      if (holdMinutes < minHoldForJudgment) {
        healthStatus = 'watching';
        healthReason = `Monitoring (${Math.round(holdMinutes)}m / ${minHoldForJudgment}m min)`;
      } else if (isAtRisk) {
        healthStatus = 'at_risk';
        healthReason = `Near stop loss (${stopDistancePct.toFixed(2)}% away)`;
      } else if (isStagnant) {
        healthStatus = 'stagnant';
        healthReason = 'Trade stagnant - not progressing';
      } else if (pnlPct > 0) {
        healthStatus = 'progressing';
        healthReason = `In profit (+${pnlPct.toFixed(2)}%)`;
      }

      // V5.72: Build trailing state object
      const trailingState = {
        active: this.position.trailingActive || false,
        activatedAt: this.rtExitHandler.trailingActivatedAt,
        updateCount: this.rtExitHandler.trailingUpdateCount,
        currentStopPrice: this.position.appTrailingStop || this.position.stopLoss,
        peakPrice,
        distanceFromPeak,
      };

      posWithMetrics = {
        ...this.position,
        // Add entry as alias for frontend compatibility (PositionInfoCard expects 'entry')
        entry: this.position.entryPrice,
        // Add leverage for frontend display
        leverage: MomentumConfig.LEVERAGE[this.position.symbol] || 5,
        // Add openedAt for frontend time-held calculation
        openedAt: this.position.entryTime,
        // Add stopPrice as alias for frontend compatibility
        stopPrice: this.position.appTrailingStop || this.position.stopLoss,
        stop: this.position.appTrailingStop || this.position.stopLoss,
        // Add targets from lastSignal
        targets: this.lastSignal?.targets || [],
        currentPrice,
        pnlPct,
        pnlUsd,
        notionalUsd,
        duration,
        trailDistance,
        // V5.72: Add trailing state for frontend
        trailingState,
        // V5.72: Add health status for frontend
        healthStatus,
        healthReason,
        // V5.72: Add additional context
        peakPrice,
        distanceFromPeak,
        stopDistancePct,
      };
    }
    
    return {
      pos: posWithMetrics,
      plan: this.currentBias ? {
        bias: this.currentBias,
        zone: this.lastSignal?.entryZone ? {
          from: this.lastSignal.entryZone[0],
          to: this.lastSignal.entryZone[1],
          mid: (this.lastSignal.entryZone[0] + this.lastSignal.entryZone[1]) / 2,
        } : null,
        stopDistance: this.lastSignal?.stopDistance,
        rPrices: this.lastSignal?.targets?.map((t, i) => ({
          r: i + 1,
          price: t,
          pct: this.lastSignal?.targetPcts?.[i] || (i + 1) * 0.5,
        })),
      } : null,
      exit: this.lastExit,
      profile: {
        riskPerTradePct: this.config.riskPerTradePct,
        dailyLossLimitPct: 3, // Default
        maxLeverage: MomentumConfig.LEVERAGE[this.config.symbol] || 4,
        aggressiveness: 'reactive', // Default
        availableUsd: this.config.capitalPool.getAvailableCapital(),
      },
      balance: {
        freeUsd: this.config.capitalPool.getAvailableCapital(),
        totalUsd: this.config.capitalPool.getStatus().totalUsd,
      },
      lastTickAt: this.lastTickAt,
      tickCount: this.tickCount,
    };
  }
  
  async forceCheck(): Promise<void> {
    await this.tick();
  }
}

// ============================================================================
// FACTORY FUNCTION - Creates 4 agents sharing the same capital pool
// ============================================================================

export async function createSimpleAgent(params: {
  exchange: Exchange;
  prisma: any;
  userId: string;
  sessionId: string;
  symbol: string;
  capitalPool?: CapitalPool;
  mode?: 'paper' | 'live';
}): Promise<SimpleAgent> {
  // Use provided pool or get/create pool for this user
  const pool = params.capitalPool || getCapitalPool(params.userId, 10000);
  if (!pool) {
    throw new Error('Capital pool not available');
  }
  
  const agent = new SimpleAgent({
    exchange: params.exchange,
    prisma: params.prisma,
    userId: params.userId,
    sessionId: params.sessionId,
    capitalPool: pool,
    riskPerTradePct: 1,  // 1% risk per trade
    symbol: params.symbol,
    mode: params.mode || 'paper',
  });
  
  return agent;
}

/**
 * Create all 4 agents sharing the same capital pool
 */
export async function createAllAgents(params: {
  exchange: Exchange;
  prisma: any;
  userId: string;
  sessionIds: { btc: string; eth: string; sol: string; xrp: string };
  totalCapitalUsd: number;
  mode?: 'paper' | 'live';
}): Promise<{
  agents: SimpleAgent[];
  capitalPool: CapitalPool;
}> {
  // Create shared capital pool for this user
  const capitalPool = resetCapitalPool(params.userId, params.totalCapitalUsd, params.mode);
  
  // 🔧 FIX: Set exchange reference on pool for REST fallback in syncWithExchange (live mode)
  if (params.mode === 'live' && params.exchange) {
    capitalPool.setExchange(params.exchange);
  }
  
  const symbols = MomentumConfig.SYMBOLS;
  const sessionIdMap: Record<string, string> = {
    'BTC/USDT:USDT': params.sessionIds.btc,
    'ETH/USDT:USDT': params.sessionIds.eth,
    'SOL/USDT:USDT': params.sessionIds.sol,
    'XRP/USDT:USDT': params.sessionIds.xrp,
  };
  
  const agents: SimpleAgent[] = [];
  
  for (const symbol of symbols) {
    const agent = await createSimpleAgent({
      exchange: params.exchange,
      prisma: params.prisma,
      userId: params.userId,
      sessionId: sessionIdMap[symbol],
      symbol,
      capitalPool,
      mode: params.mode,
    });
    agents.push(agent);
  }
  
  console.log(`[AgentFactory] Created ${agents.length} agents for user ${params.userId} with shared capital pool of $${params.totalCapitalUsd}`);
  
  return { agents, capitalPool };
}
