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
  calculatePositionSize,
  updatePositionWaterMarks,
  getMarketConditions,
  getLiquidityTier,
  calcSafeLeverage,
  calcDynamicStopLoss,  // V5.7: Dynamic SL based on ATR
  determineVolatilityRegime,  // V5.14: Volatility-based trailing
  LIQUIDATION_CONFIG,
  type Candle,
  type Position,
  type MarketConditions,
} from './momentumSimple.js';
import { createLogger } from '../utils/logger.js';
import { globalSignalRanker } from './signalRanker.js';
import {
  getBinanceWebSocket,
  getKlinesOhlcvFromWebSocket,
  seedKlinesFromWebSocket,
  getBalanceFromWebSocket,
  getTickerFromWebSocket,
  getPositionFromWebSocket,
  getLastFilledOrderTradeUpdateFromWebSocket,
  isUserDataStreamActive,
  seedPositionCache,
  toBinanceSymbolId,
  isPositionCacheSeeded,
} from '../services/binanceWebSocket.js';
import { globalRestCircuitBreaker } from '../services/globalRestCircuitBreaker.js';
import { isIpBanned } from '../exchange/ccxtClient.js';
import {
  notifyTradeEntry,
  notifyTradeExit,
  notifyOrderError,
  notifyDailyLossLimit,
  notifyTrailingActivated,
  notifyRegimeChange,
  notifyHighVolatility,
  notifyAgentStarted,
  notifyAgentStopped,
  notifyLongHold,
  notifyLiquidationWarning,
  notifySyncFailure,
  notifySignalDetected,
} from '../services/notificationService.js';
import { notifyPositionOpened, notifyPositionClosed } from '../utils/notifications.js';
import { orderQueue, type OrderRequest } from '../services/orderQueue.js';
import { calculateOrderPriority } from '../services/orderPriority.js';
import { v4 as uuidv4 } from 'uuid';

const logger = createLogger('agent');

// ============================================================================
// GLOBAL BTC CACHE - Shared between all agents to reduce API calls
// ============================================================================
// Uses WebSocket first (0 API weight), falls back to REST with cache

const GLOBAL_BTC_CACHE_TTL_MS = 300_000; // 5 minutes (longer TTL since WS is primary)
let globalBtcCandleCache: { candles: Candle[]; fetchedAt: number } | null = null;
let globalBtcCacheFetchingPromise: Promise<Candle[]> | null = null;
let btcWsSubscribed = false;

// V5.36: Global cache for BTC 1h candles (shared across all agents)
const GLOBAL_BTC_1H_CACHE_TTL_MS = 900_000; // 15 minutes (1h candles change less frequently)
let globalBtc1hCandleCache: { candles: Candle[]; fetchedAt: number } | null = null;
let globalBtc1hCacheFetchingPromise: Promise<Candle[]> | null = null;

// Type for exchange (we avoid importing ccxt directly to reduce bundle size)
type Exchange = {
  fetchOHLCV: (symbol: string, timeframe: string, since?: number, limit?: number) => Promise<number[][]>;
  setLeverage: (leverage: number, symbol: string) => Promise<void>;
  createMarketBuyOrder: (symbol: string, qty: number, params?: Record<string, any>) => Promise<any>;
  createMarketSellOrder: (symbol: string, qty: number, params?: Record<string, any>) => Promise<any>;
  createOrder: (symbol: string, type: string, side: string, qty: number, price?: number, params?: Record<string, any>) => Promise<any>;
  // For live sync
  fetchPositions?: (symbols?: string[]) => Promise<any[]>;
  fetchMyTrades?: (symbol: string, since?: number, limit?: number) => Promise<any[]>;
  cancelOrder?: (orderId: string, symbol: string) => Promise<any>;
  cancelAllOrders?: (symbol: string, params?: Record<string, any>) => Promise<any>;
  // For quantity precision (CCXT method)
  amountToPrecision?: (symbol: string, amount: number) => string;
  markets?: Record<string, any>;
  // For balance fetching (REST fallback)
  fetchBalance?: (params?: Record<string, any>) => Promise<any>;
};

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
  private readonly BALANCE_SYNC_INTERVAL_MS = 30_000; // Sync every 30s max
  private hasEverSynced: boolean = false; // Track if we've ever successfully synced
  
  // 🔧 FIX: Store exchange reference for REST fallback when WebSocket cache is empty
  private exchange: Exchange | null = null;
  
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
      const shouldFallbackToRest = !balance && (!this.hasEverSynced || force) && this.exchange && this.exchange.fetchBalance;
      
      if (shouldFallbackToRest && this.exchange?.fetchBalance) {
        console.log(`[CapitalPool] WebSocket cache empty on ${force ? 'forced' : 'initial'} sync, falling back to REST fetchBalance...`);
        try {
          const restBalance = await this.exchange.fetchBalance({ type: 'future' });
          const totalUsdt = parseFloat(restBalance?.total?.USDT || restBalance?.USDT?.total || '0') || 0;
          const freeUsdt = parseFloat(restBalance?.free?.USDT || restBalance?.USDT?.free || '0') || 0;
          
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
   * Reserve capital for a potential trade
   * This is a temporary hold before the order is placed
   */
  reserve(agentId: string, amountUsd: number): boolean {
    const available = this.getAvailableCapital();
    if (amountUsd > available) {
      console.log(`[CapitalPool] Cannot reserve $${amountUsd.toFixed(2)} for ${agentId}, only $${available.toFixed(2)} available (total=$${this.totalCapitalUsd.toFixed(2)}, inPos=$${this.getInPositionsTotal().toFixed(2)})`);
      return false;
    }
    
    const current = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, current + amountUsd);
    console.log(`[CapitalPool] Reserved $${amountUsd.toFixed(2)} for ${agentId} | available after: $${(available - amountUsd).toFixed(2)}`);
    return true;
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
      byAgent,
    };
  }
  
  /**
   * V5.18: Get number of currently open positions
   * Used for adaptive max positions based on capital
   */
  getOpenPositionCount(): number {
    let count = 0;
    this.inPositionByAgent.forEach((v) => {
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
  
  // Database - use any to avoid type conflicts between different prisma versions
  prisma: any;
  
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
  private position: Position | null = null;
  
  // V5.30: Multi-position support - additional positions for large accounts
  private additionalPositions: Position[] = [];
  
  private running = false;
  private tickIntervalId: NodeJS.Timeout | null = null;

  // Realtime app-side exits (WS-based) to react faster than 15m candle-close.
  private realtimeExitIntervalId: NodeJS.Timeout | null = null;
  private realtimeExitInProgress = false;
  private closingPosition = false;
  private rtBreachSinceMs: number | null = null;
  private rtBreachTicks = 0;
  private lastAppTrailingStop: number | null = null;
  private lastRtTrailingKlineTs: number | null = null;
  private rtTrailingBreachCandles = 0;
  
  // Throttle WebSocket unhealthy warnings (max once per 30s per agent)
  private lastWsUnhealthyWarnTs = 0;
  private static readonly WS_UNHEALTHY_WARN_THROTTLE_MS = 30_000;

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
  
  // Track trailing stop activation (to notify only once)
  private trailingNotified: boolean = false;
  
  // V5.12: Track if trailing has been widened (for SMART trailing)
  private trailingWidened: boolean = false;
  
  // V5.11: Track last processed candle timestamp to sync with backtest
  // Only check entry signals when a NEW 15m candle closes (not on every tick)
  private lastProcessedCandleTs: number = 0;

  // Backtest parity: only evaluate exits on NEWLY CLOSED candles too.
  private lastProcessedExitCandleTs: number = 0;
  
  // V5.22/V5.23: Helper methods for signal scoring
  private calcROC(closes: number[], period: number = 5): number {
    if (closes.length < period + 1) return 0;
    const current = closes[closes.length - 1];
    const past = closes[closes.length - period - 1];
    return past > 0 ? (current - past) / past : 0;
  }
  
  private calcSMA(values: number[], period: number): number {
    if (values.length < period) return 0;
    const slice = values.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
  }
  
  private calcBB(closes: number[], period = 20, mult = 2) {
    if (closes.length < period) return { middle: 0, upper: 0, lower: 0 };
    const sma = this.calcSMA(closes, period);
    const slice = closes.slice(-period);
    const variance = slice.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
      middle: sma,
      upper: sma + stdDev * mult,
      lower: sma - stdDev * mult,
    };
  }
  
  private calcATR(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 0;
    const recentCandles = candles.slice(-period - 1);
    const trValues: number[] = [];
    
    for (let i = 1; i < recentCandles.length; i++) {
      const high = recentCandles[i].high;
      const low = recentCandles[i].low;
      const prevClose = recentCandles[i - 1].close;
      
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trValues.push(tr);
    }
    
    const atr = trValues.reduce((sum, tr) => sum + tr, 0) / period;
    const currentPrice = candles[candles.length - 1].close;
    return currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
  }
  
  private calcBBPosition(candles: Candle[], period = 20, mult = 2): number {
    const closes = candles.map(c => c.close);
    const bb = this.calcBB(closes, period, mult);
    const currentPrice = candles[candles.length - 1].close;
    
    if (bb.upper <= bb.lower) return 0.5;
    const position = (currentPrice - bb.lower) / (bb.upper - bb.lower);
    return Math.max(0, Math.min(1, position));
  }
  
  private calcTrendStrength(closes: number[], period = 50): number {
    if (closes.length < period) return 0;
    const sma = this.calcSMA(closes, period);
    const currentPrice = closes[closes.length - 1];
    return sma > 0 ? (currentPrice - sma) / sma : 0;
  }

  // Backtest parity: apply a post-exit cooldown to avoid immediate re-entries.
  // Backtest service uses 8 bars (2h) cooldown after any exit.
  private readonly ENTRY_COOLDOWN_BARS = 8;
  private entryCooldownBarsRemaining: number = 0;
  
  // Cache pour éviter trop d'appels API (per-symbol only, BTC is global)
  private candleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS = 120_000; // 2 minutes (increased to reduce API calls)
  private wsSubscribed = false; // Track if WebSocket kline subscription is active
  
  // Guard against concurrent tick execution (prevents re-entrancy/recursion)
  private tickInProgress = false;
  
  // Position sync throttling (WebSocket is primary, REST is fallback)
  private lastPositionSync: number = 0;
  private readonly POSITION_SYNC_INTERVAL_MS = 600_000; // 10 minutes - CRITICAL: Avoid REST spam causing IP bans

  // V5.13: Missing trade reconciliation throttling
  private lastMissingTradesCheck: number = 0;
  private readonly MISSING_TRADES_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
  
  constructor(config: SimpleAgentConfig) {
    this.config = config;
  }
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  async start(): Promise<void> {
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
    });
    
    // Charger les positions existantes depuis la DB
    await this.loadExistingPosition();
    
    // 🔄 LIVE MODE: Sync with exchange to catch any missed stop losses
    if (this.config.mode === 'live') {
      await this.syncWithExchange();
    }

    // Live mode: if we start with an existing position, enable realtime WS-based exits.
    this.startRealtimeExitMonitorIfNeeded();
    
    // V5.13: Reduced tick interval from 60s to 15s for faster signal detection
    // This ensures we check for new closed 15m candles within ~15-30s instead of up to 60s
    this.tickIntervalId = setInterval(() => this.tick(), 15_000); // 15 seconds
    
    // Premier tick immédiat
    await this.tick();
  }
  
  async stop(): Promise<void> {
    this.running = false;
    
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }

    this.stopRealtimeExitMonitor();
    
    // V5.22: Remove any pending signal for this agent from ranker
    globalSignalRanker.removeSignal(this.config.symbol);
    
    // 📢 NOTIFICATION: Agent stopped
    notifyAgentStopped({
      symbol: this.config.symbol,
      sessionId: this.config.sessionId,
      mode: this.config.mode,
      reason: 'Manual stop',
    });
    
    logger.info(`⏹️ [${this.config.symbol}] STOPPED`);
  }

  // ==========================================================================
  // REALTIME (WS) EXIT MONITOR
  // ==========================================================================

  private startRealtimeExitMonitorIfNeeded(): void {
    // V5.37: Enable RT exit monitor for BOTH paper and live modes
    // This ensures identical behavior between paper and live trading
    // Previously only live had RT protection, causing divergent exit timing
    if (!this.running) return;
    if (!this.position) return;
    if (!MomentumConfig.EXIT.REALTIME_APP_EXIT_ENABLED) return;
    if (this.realtimeExitIntervalId) return;

    const pollMs = Math.max(250, Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_POLL_MS ?? 1000));

    this.rtBreachSinceMs = null;
    this.rtBreachTicks = 0;
    this.lastAppTrailingStop = null;
    this.lastRtTrailingKlineTs = null;
    this.rtTrailingBreachCandles = 0;
    this.closingPosition = false;

    // If realtime trailing is enabled and we use kline-close mode, subscribe to 1m klines.
    try {
      const trailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
      const trailingMode = (MomentumConfig.EXIT as any).REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;
      const klineInterval = (MomentumConfig.EXIT as any).REALTIME_APP_EXIT_KLINE_INTERVAL as string | undefined;
      if (trailingEnabled && trailingMode === 'kline_1m_close') {
        const ws = getBinanceWebSocket();
        ws.subscribeToKline(this.config.symbol, klineInterval || '1m');
      }
    } catch {
      // Non-fatal: realtime exit monitor should still run even if subscription fails.
    }

    this.realtimeExitIntervalId = setInterval(() => {
      void this.checkRealtimeExit().catch(err => {
        logger.debug(`⚠️ [${this.config.symbol}] Realtime exit check error: ${String((err as any)?.message || err)}`);
      });
    }, pollMs);

    const trailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
    const slEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_STOPLOSS_ENABLED ?? true);
    const trailingMode = (MomentumConfig.EXIT as any).REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;
    const mode = trailingEnabled
      ? (slEnabled ? `trail(${trailingMode || 'ticker'})+sl` : `trail(${trailingMode || 'ticker'})`)
      : (slEnabled ? 'sl_only' : 'disabled');
    logger.info(`📡 [${this.config.symbol}] Realtime WS exits enabled (poll ${pollMs}ms, mode=${mode})`);
  }

  private stopRealtimeExitMonitor(): void {
    if (this.realtimeExitIntervalId) {
      clearInterval(this.realtimeExitIntervalId);
      this.realtimeExitIntervalId = null;
    }
    this.rtBreachSinceMs = null;
    this.rtBreachTicks = 0;
    this.lastAppTrailingStop = null;
    this.lastRtTrailingKlineTs = null;
    this.rtTrailingBreachCandles = 0;
    this.realtimeExitInProgress = false;
  }

  private async checkRealtimeExit(): Promise<void> {
    if (!this.running) return;
    if (this.config.mode !== 'live') return;
    if (!MomentumConfig.EXIT.REALTIME_APP_EXIT_ENABLED) return;
    if (this.realtimeExitInProgress) return;
    if (this.closingPosition) return;
    if (!this.position) return;

    this.realtimeExitInProgress = true;
    try {
      const symbol = this.config.symbol;

      // WebSocket ticker is 0 weight; if WS is not receiving data we do nothing here.
      // We use isConnectedAndReceiving() which is more lenient than isHealthy() -
      // it allows realtime exit monitoring even during temporary timestamp drift.
      const ws = getBinanceWebSocket();
      const wsConnected = ws.isConnectedAndReceiving();
      const wsHealthy = ws.isHealthy();
      
      if (!wsConnected) {
        // Throttled warning: max once per 30s per agent to avoid log spam
        const now = Date.now();
        if (now - this.lastWsUnhealthyWarnTs >= SimpleAgent.WS_UNHEALTHY_WARN_THROTTLE_MS) {
          this.lastWsUnhealthyWarnTs = now;
          const status = ws.getHealthStatus();
          logger.warn(`⚠️ [${symbol}] WebSocket NOT CONNECTED - realtime exit monitoring paused | connected=${status.isConnected}, tickers=${status.tickerCount}, lastUpdate=${status.lastUpdateAge}ms ago`);
        }
        return;
      }
      
      // If connected but not strictly "healthy", just log debug (no warning spam)
      if (!wsHealthy) {
        logger.debug(`[${symbol}] WebSocket connected but stale - continuing with cached data`);
      }
      
      // Clear throttle timestamp when connected
      this.lastWsUnhealthyWarnTs = 0;
      
      const ticker = ws.getTicker(symbol);
      if (!ticker) {
        logger.debug(`⚠️ [${symbol}] No ticker data from WebSocket`);
        return;
      }
      const tickerTs = Number.isFinite(Number(ticker.timestamp)) ? Number(ticker.timestamp) : Date.now();
      if (Date.now() - tickerTs > 10_000) return;

      const useMid = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_USE_MID_PRICE ?? true);
      const mid = ticker.bid > 0 && ticker.ask > 0 ? (ticker.bid + ticker.ask) / 2 : 0;
      const currentPrice = useMid && mid > 0 ? mid : ticker.last;
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

      this.lastPrice = currentPrice;

      const rtTrailingEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_TRAILING_ENABLED ?? false);
      const rtStoplossEnabled = Boolean(MomentumConfig.EXIT.REALTIME_APP_EXIT_STOPLOSS_ENABLED ?? true);
      const trailingMode = (MomentumConfig.EXIT as any).REALTIME_APP_EXIT_TRAILING_MODE as string | undefined;

      // ----------------------------------------------------------------------
      // 🚨 CRITICAL: Check REGIME_CHANGE and MOMENTUM_REVERSAL FIRST
      // These are protective exits that should trigger BEFORE stop loss
      // to save 5-10% of loss when regime flips
      // ----------------------------------------------------------------------
      try {
        const symbolCandles = await this.fetchCandles();
        const btcCandles = await this.fetchBtcCandles();
        const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;
        
        // ⚠️  STRATEGIC EXITS ONLY ON 15M CLOSE
        // Regime change and momentum reversal are checked in checkExit() on 15m candle close
        // for 100% backtest parity. Ticker monitor focuses only on protective stops.
      } catch (err) {
        logger.debug(`[${symbol}] Failed to monitor in RT: ${String((err as any)?.message || err)}`);
        // Continue to stop loss check if monitoring fails
      }

      // ----------------------------------------------------------------------
      // 1) STOPLOSS realtime (ticker-based, protective)
      // V5.36: Stagnant detection REMOVED from realtime - now only on 15m candle close
      // to match paper/backtest behavior. This prevents premature stagnant exits.
      // Stagnant detection is handled by shouldExitPosition() in checkExit().
      // ----------------------------------------------------------------------
      if (rtStoplossEnabled) {
        const bufferPct = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_BUFFER_PCT ?? 0.05);
        const confirmMs = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_MS ?? 1800);
        const confirmTicks = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_TICKS ?? 2);
        const now = Date.now();

        // V5.28 FIX: If trailing is active, use trailing stop instead of fixed SL
        // This prevents the bug where trailing activates but SL still uses the fixed price
        const trailingActive = this.position!.trailingActive && this.position!.appTrailingStop;
        
        // V5.36: Use stagnant state from position (set by shouldExitPosition on 15m close)
        // Only check if stagnant is CONFIRMED - the detection itself happens on 15m close
        const isStagnantConfirmed = this.position!.stagnantState?.confirmed && !this.position!.stagnantState?.cancelled;
        const stagnantTightenSlPct = (MomentumConfig.EXIT as any).STAGNANT_TRADE_TIGHTEN_SL_PCT ?? 0.8;
        
        // Use tightened SL if stagnant confirmed (by 15m close logic), otherwise use normal SL
        const effectiveSlPct = isStagnantConfirmed 
          ? stagnantTightenSlPct 
          : (this.position!.stopLossPct ?? MomentumConfig.EXIT.STOP_LOSS_PCT);
        
        const fixedSlPrice = this.position!.side === 'long'
          ? this.position!.entryPrice * (1 - effectiveSlPct / 100)
          : this.position!.entryPrice * (1 + effectiveSlPct / 100);
        
        // When trailing is active, use the trailing stop as our protective stop
        // For LONG: trailing stop is below current price (sell if price drops to it)
        // For SHORT: trailing stop is above current price (buy if price rises to it)
        const slPrice = trailingActive ? this.position!.appTrailingStop! : fixedSlPrice;
        
        const slBreach = this.position!.side === 'long'
          ? currentPrice <= slPrice * (1 - bufferPct / 100)
          : currentPrice >= slPrice * (1 + bufferPct / 100);

        if (!slBreach) {
          this.rtBreachSinceMs = null;
          this.rtBreachTicks = 0;
        } else {
          if (this.rtBreachSinceMs == null) {
            this.rtBreachSinceMs = now;
            this.rtBreachTicks = 1;
          } else {
            this.rtBreachTicks += 1;
          }

          const elapsed = now - (this.rtBreachSinceMs ?? now);
          const confirmed = elapsed >= confirmMs || this.rtBreachTicks >= confirmTicks;
          if (confirmed) {
            this.stopRealtimeExitMonitor();
            // V5.28: Distinguish between trailing stop hit, stagnant trade, or fixed SL hit
            let exitReason: string;
            let stopType: string;
            if (trailingActive) {
              exitReason = 'trailing_rt';
              stopType = 'trailing';
            } else if (isStagnantConfirmed) {
              exitReason = 'stagnant_trade';
              stopType = 'stagnant';
            } else {
              exitReason = 'stoploss_rt';
              stopType = 'fixed';
            }
            const holdMinutes = (now - this.position!.entryTime) / 60000;
            const maxPnlRaw = this.position!.maxPnlPct ?? 0;
            logger.info(
              `⚡ [${symbol}] REALTIME EXIT confirmed (${exitReason}) price=$${currentPrice.toFixed(4)} ${stopType}_sl=$${slPrice.toFixed(4)} sl_pct=${effectiveSlPct.toFixed(1)}% | confirm=${Math.round(elapsed)}ms/${this.rtBreachTicks}ticks${isStagnantConfirmed ? ` | STAGNANT: held ${Math.round(holdMinutes)}m, maxPnl=${maxPnlRaw.toFixed(2)}%` : ''}`,
            );
            await this.closePosition(this.position, currentPrice, exitReason);
            return;
          }
        }
      }

      // ----------------------------------------------------------------------
      // 2) TRAILING realtime (noise-filtered)
      //    Option A: ticker-based (fast but noisy)
      //    Option B: 1m kline CLOSE-based (filters wicks)
      // ----------------------------------------------------------------------
      if (!rtTrailingEnabled) return;

      if (trailingMode === 'kline_1m_close') {
        const interval = ((MomentumConfig.EXIT as any).REALTIME_APP_EXIT_KLINE_INTERVAL as string | undefined) || '1m';
        const confirmCandles = Math.max(1, Number((MomentumConfig.EXIT as any).REALTIME_APP_EXIT_KLINE_CONFIRM_CANDLES ?? 2));

        // Ensure we are subscribed.
        ws.subscribeToKline(symbol, interval);

        const klines = ws.getKlines(symbol, interval);
        const last = klines && klines.length ? klines[klines.length - 1] : null;
        
        if (!last) {
          logger.debug(`⚠️ [${symbol}] No 1m klines received from WebSocket yet`);
          return;
        }
        
        if (!last.isFinal) {
          const now = Date.now();
          const candleAge = now - last.timestamp;
          logger.debug(`⏳ [${symbol}] Waiting for 1m candle to close (age: ${Math.round(candleAge/1000)}s, close: ${last.close.toFixed(4)})`);
          return;
        }

        // Process once per newly-closed 1m candle.
        if (this.lastRtTrailingKlineTs === last.timestamp) return;
        
        const detectionDelay = Date.now() - (last.closeTime || last.timestamp);
        logger.info(`📍 [${symbol}] NEW 1m candle closed | close=${last.close.toFixed(4)} | detection_delay=${detectionDelay}ms`);
        this.lastRtTrailingKlineTs = last.timestamp;

        // Update trailing state using the candle close for breach detection.
        // V5.25 FIX: Use proper high/low for breach detection:
        // - LONG: breach when price drops below trailing stop -> use last.low
        // - SHORT: breach when price rises above trailing stop -> use last.high
        // This ensures we detect when the trailing stop was hit during the candle.
        const closePx = last.close;
        if (!Number.isFinite(closePx) || closePx <= 0) return;

        // For watermark updates (to move the trailing stop favorably):
        // - LONG: use last.high to track highest price (move stop up)
        // - SHORT: use last.low to track lowest price (move stop down)
        // For breach detection (to check if stop was hit):
        // - LONG: use last.low (did price drop to stop?)
        // - SHORT: use last.high (did price rise to stop?)
        const priceHigh = last.high;
        const priceLow = last.low;

        // V5.25 FIX: Update watermarks with 1m candle data so trailing stop follows profit!
        // This was missing - the watermark wasn't being updated on 1m candles,
        // so the trailing stop never moved up/down with the price.
        this.position = updatePositionWaterMarks(this.position!, closePx, priceHigh, priceLow);

        // V5.13: Fetch BTC candles for regime detection in realtime
        const btcCandles = await this.fetchBtcCandles();
        const symbolCandles = await this.fetchCandles();
        const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;
        
        // IMPORTANT: For realtime 1m-based trailing, we ONLY check trailing stop.
        // Regime change and momentum reversal should be evaluated on 15m candle close
        // in checkExit() to match backtest behavior exactly.
        const exitSignal = shouldExitPosition(this.position!, closePx, candles, {
          nowMs: Date.now(),
          priceHigh,
          priceLow,
          // NOTE: Pass null for btcCandles to DISABLE regime_change detection in realtime
          // Regime detection should only happen on 15m candle close (checkExit)
          btcCandles: undefined,
        });

        const candidateStop = exitSignal.newStopLoss;
        if (Number.isFinite(Number(candidateStop))) {
          this.lastAppTrailingStop = candidateStop as number;
          this.position!.appTrailingStop = candidateStop as number;
        }
        
        // V5.26: Persist trailing activation - once active, stays active
        if (exitSignal.trailingActivated) {
          this.position!.trailingActive = true;
        }

        // ONLY react to trailing exits in realtime - regime_change and momentum_reversal
        // are handled in checkExit() on 15m candle close for backtest parity
        if (!(exitSignal.shouldExit && exitSignal.reason === 'trailing')) {
          if (this.rtTrailingBreachCandles > 0) {
            logger.info(`✅ [${symbol}] Trailing breach CLEARED (was ${this.rtTrailingBreachCandles}/${confirmCandles}) | close=${closePx.toFixed(4)} | stop=${(candidateStop as number | undefined)?.toFixed(4) || 'n/a'}`);
          }
          this.rtTrailingBreachCandles = 0;
          return;
        }

        // Confirm by consecutive 1m candle closes beyond the trailing stop.
        this.rtTrailingBreachCandles += 1;
        const stopPrice = (candidateStop as number | undefined)?.toFixed(4) || 'n/a';
        logger.warn(
          `🚨 [${symbol}] TRAILING BREACH detected! (${this.rtTrailingBreachCandles}/${confirmCandles}) | close=${closePx.toFixed(4)} | stop=${stopPrice} | side=${this.position!.side}`,
        );
        
        if (this.rtTrailingBreachCandles < confirmCandles) {
          logger.info(`⏳ [${symbol}] Waiting for confirmation... (need ${confirmCandles - this.rtTrailingBreachCandles} more candle${confirmCandles - this.rtTrailingBreachCandles > 1 ? 's' : ''})`);
          return;
        }

        this.stopRealtimeExitMonitor();
        const execPx = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : closePx;
        logger.info(
          `⚡⚡⚡ [${symbol}] REALTIME EXIT CONFIRMED (trailing_rt, 1m close) | exec=${execPx.toFixed(4)} | close=${closePx.toFixed(4)} | stop=${stopPrice} | confirmCandles=${confirmCandles}`,
        );
        await this.closePosition(this.position!, execPx, 'trailing_rt');
        return;
      }

      // Fallback: ticker-based trailing (legacy). Keep the existing anti-noise confirmation.
      // Update watermarks in realtime so trailing can capture peaks/troughs.
      this.position = updatePositionWaterMarks(this.position!, currentPrice, currentPrice, currentPrice);

      // Fetch symbol candles for trailing stop calculation
      // NOTE: Do NOT pass btcCandles - regime detection should only happen on 15m close
      // This ensures regime_change exits match backtest timing exactly
      const symbolCandles = await this.fetchCandles();
      const candles = symbolCandles.length > 1 ? symbolCandles.slice(0, -1) : symbolCandles;
      
      const exitSignal = shouldExitPosition(this.position!, currentPrice, candles, {
        nowMs: Date.now(),
        priceHigh: currentPrice,
        priceLow: currentPrice,
        // btcCandles: undefined - regime detection disabled in realtime for backtest parity
      });

      const candidateStop = exitSignal.newStopLoss;
      if (Number.isFinite(Number(candidateStop))) {
        this.lastAppTrailingStop = candidateStop as number;
        this.position!.appTrailingStop = candidateStop as number;
      }
      
      // V5.26: Persist trailing activation - once active, stays active
      if (exitSignal.trailingActivated) {
        this.position!.trailingActive = true;
      }

      if (!(exitSignal.shouldExit && exitSignal.reason === 'trailing')) {
        this.rtBreachSinceMs = null;
        this.rtBreachTicks = 0;
        return;
      }

      const bufferPct = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_BUFFER_PCT ?? 0.05);
      const confirmMs = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_MS ?? 1800);
      const confirmTicks = Number(MomentumConfig.EXIT.REALTIME_APP_EXIT_CONFIRM_TICKS ?? 2);
      const now = Date.now();
      const stopPrice = candidateStop as number | undefined;
      if (!stopPrice) return;

      const breach = this.position!.side === 'long'
        ? currentPrice <= stopPrice * (1 - bufferPct / 100)
        : currentPrice >= stopPrice * (1 + bufferPct / 100);

      if (!breach) {
        this.rtBreachSinceMs = null;
        this.rtBreachTicks = 0;
        return;
      }

      if (this.rtBreachSinceMs == null) {
        this.rtBreachSinceMs = now;
        this.rtBreachTicks = 1;
        logger.debug(`🔎 [${symbol}] Realtime trailing breach started (ticker) price=$${currentPrice.toFixed(4)} stop=$${stopPrice.toFixed(4)}`);
        return;
      }

      this.rtBreachTicks += 1;
      const elapsed = now - this.rtBreachSinceMs;
      const confirmed = elapsed >= confirmMs || this.rtBreachTicks >= confirmTicks;
      if (!confirmed) return;

      this.stopRealtimeExitMonitor();
      logger.info(`⚡ [${symbol}] REALTIME EXIT confirmed (trailing_rt) price=$${currentPrice.toFixed(4)} stop=$${stopPrice.toFixed(4)} | confirm=${Math.round(elapsed)}ms/${this.rtBreachTicks}ticks`);
      await this.closePosition(this.position!, currentPrice, 'trailing_rt');
    } finally {
      this.realtimeExitInProgress = false;
    }
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
      
      // Fetch BTC candles for market conditions
      const btcCandles = await this.fetchBtcCandles();
      
      // Update and broadcast market conditions (preserve marketQuality from previous update)
      const newConditions = getMarketConditions(btcCandles);
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
      
      // 1. Si on a une position, checker l'exit avec trailing
      if (this.position) {
        // Avoid per-tick spam: checkExit already logs once per newly-closed 15m candle.
        // Keep detailed tick-level traces available via LOG_LEVEL=debug.
        const shortSymbol = symbol.replace('/USDT:USDT', '');
        logger.debug(`🔄 [${shortSymbol}] #${this.tickCount} IN_${this.position.side.toUpperCase()}@$${this.position.entryPrice.toFixed(2)} | $${currentPrice.toFixed(2)} | ${this.config.mode}`);
        await this.checkExit(this.position);
        return; // Don't look for new entries while in position
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
  }
  
  // ==========================================================================
  // ENTRY LOGIC
  // ==========================================================================
  
  private async checkEntry(): Promise<void> {
    const symbol = this.config.symbol;
    const shortSymbol = symbol.replace('/USDT:USDT', '');
    
    try {
      // Fetch candles pour le symbol
      const allCandles = await this.fetchCandles();
      if (allCandles.length < 61) {
        // Only log this warning once every 10 ticks to reduce spam
        if (this.tickCount % 10 === 1) {
          logger.info(`⚠️ [${shortSymbol}] Not enough candles (${allCandles.length}/61)`);
        }
        return;
      }
      
      // ═══════════════════════════════════════════════════════════════════════════
      // V5.13: FIX - Wait for candle to be CLOSED before checking signal
      // The issue was that slice(0, -1) would exclude the in-progress candle,
      // but if the WebSocket hasn't received the new candle yet, we'd check
      // the same old candle again. Now we check the timestamp to ensure we're
      // looking at a NEW closed candle (timestamp must be >= lastProcessedCandleTs + 15min)
      // ═══════════════════════════════════════════════════════════════════════════
      
      // Store last price for frontend (use latest candle for display)
      const currentPrice = allCandles[allCandles.length - 1].close;
      this.lastPrice = currentPrice;
      
      // Find the last CLOSED candle (15min old or more)
      const now = Date.now();
      const CANDLE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
      
      // The last candle is closed if its timestamp is at least 15min old
      let lastClosedIdx = allCandles.length - 1;
      const lastCandleAge = now - allCandles[lastClosedIdx].timestamp;
      
      if (lastCandleAge < CANDLE_INTERVAL_MS) {
        // Last candle is still in progress, use the previous one
        lastClosedIdx = allCandles.length - 2;
      }
      
      if (lastClosedIdx < 0) {
        logger.warn(`⚠️ [${shortSymbol}] No closed candles available yet`);
        return;
      }
      
      const candles = allCandles.slice(0, lastClosedIdx + 1);
      const lastClosedCandleTs = candles[candles.length - 1].timestamp;
      
      // Check if this is the same closed candle we already processed
      if (lastClosedCandleTs === this.lastProcessedCandleTs) {
        // Same candle, skip signal check (but still update features for display)
        this.lastRejectReason = 'waiting_new_candle';
        return;
      }
      
      // New closed candle! Mark it as processed
      const isFirstCheck = this.lastProcessedCandleTs === 0;
      const candleStartTime = new Date(lastClosedCandleTs).toISOString().slice(11, 19);
      const candleEndTime = new Date(lastClosedCandleTs + CANDLE_INTERVAL_MS).toISOString().slice(11, 19);
      // Detection delay = time since candle closed (candleEnd = candleStart + 15min)
      const detectionDelayMs = now - (lastClosedCandleTs + CANDLE_INTERVAL_MS);
      const detectionDelaySec = Math.round(detectionDelayMs / 1000);
      
      if (!isFirstCheck) {
        const closedCandle = candles[candles.length - 1];
        const candleColor = closedCandle.close > closedCandle.open ? '🟢' : '🔴';
        const candleChange = ((closedCandle.close - closedCandle.open) / closedCandle.open * 100).toFixed(2);
        const changeNum = parseFloat(candleChange);
        // Show candle period (start-end UTC) and detection delay for clarity
        logger.info(`🕯️ [${shortSymbol}] New 15m candle CLOSED [${candleStartTime}-${candleEndTime} UTC] ${candleColor} | $${closedCandle.close.toFixed(2)} (${changeNum > 0 ? '+' : ''}${candleChange}%) | Detected +${detectionDelaySec}s`);
      }
      
      this.lastProcessedCandleTs = lastClosedCandleTs;

      // Backtest parity: decrement cooldown once per CLOSED candle.
      if (this.entryCooldownBarsRemaining > 0) {
        this.entryCooldownBarsRemaining--;
      }

      // If we're still cooling down after an exit, skip entry checks.
      if (this.entryCooldownBarsRemaining > 0) {
        this.lastRejectReason = `cooldown_${this.entryCooldownBarsRemaining}bars`;
        return;
      }
      
      // Fetch BTC candles pour corrélation (also use only closed candles)
      const allBtcCandles = await this.fetchBtcCandles();

      // V5.13: Same logic for BTC candles - use timestamp age
      let btcLastClosedIdx = allBtcCandles.length - 1;
      const btcLastCandleAge = now - allBtcCandles[btcLastClosedIdx].timestamp;

      if (btcLastCandleAge < CANDLE_INTERVAL_MS) {
        btcLastClosedIdx = allBtcCandles.length - 2;
      }

      const btcCandles = btcLastClosedIdx >= 0 ? allBtcCandles.slice(0, btcLastClosedIdx + 1) : allBtcCandles;

      // V5.36: Fetch BTC 1h candles for Multi-Timeframe Confluence filter
      const btcCandles1h = await this.fetchBtcCandles1h();

      // V5.36: Check signal with MTF + BTC Volatility filters
      const signal = checkMomentumSignal(symbol, candles, btcCandles, {
        nowMs: now,
        btcCandles1h,  // V5.36: Pass 1h candles for MTF filter
      });
      
      // Process signal features silently (no log)
      const f = signal.features;
      if (f) {
        // 📢 NOTIFICATION: Regime change (detect BTC crossing SMA200)
        // Only notify from one agent (first ticker alphabetically or BTC itself)
        if (shortSymbol === 'BTC' || shortSymbol === 'ADA') {
          const btcPrice = btcCandles[btcCandles.length - 1]?.close || 0;
          // Estimate SMA200 from regime
          const estimatedSma200 = f.btcInBullRegime ? btcPrice * 0.99 : btcPrice * 1.01;
          notifyRegimeChange({
            newRegime: f.btcInBullRegime ? 'bull' : 'bear',
            btcPrice,
            sma200: estimatedSma200,
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
          const isNearBB = Math.abs(bbDistance) < 0.5; // Within 0.5% of BB
          const isConsolidating = isLowVolume && isNearBB;
          
          this.lastMarketConditions = {
            ...this.lastMarketConditions,
            marketQuality: isConsolidating ? 'consolidation' : 'momentum',
            qualityReason: isConsolidating 
              ? `Low vol (${f.volRatio.toFixed(1)}x) + price near BB (${bbDistance.toFixed(2)}%)`
              : `Vol ${f.volRatio.toFixed(1)}x, BB dist ${bbDistance.toFixed(2)}%`,
          };
          
          // 📢 Broadcast updated market conditions to dashboard
          this.config.onMarketConditions?.(this.lastMarketConditions);
        }
      }
      
      if (signal.valid && signal.side) {
        logger.info(`✅ [${shortSymbol}] SIGNAL ${signal.side.toUpperCase()} | $${currentPrice.toFixed(2)} | ${signal.reason}`);
        
        // V5.23: Calculate enhanced signal quality score
        const closes = candles.map(c => c.close);
        const volumes = candles.map(c => c.volume);
        
        // Core indicators
        const roc5 = this.calcROC(closes, 5);
        const currentVol = volumes[volumes.length - 1];
        const avgVol19 = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
        const volumeRatio = avgVol19 > 0 ? currentVol / avgVol19 : 1;
        
        // V5.23: New indicators for enhanced scoring
        const bbPosition = this.calcBBPosition(candles, 20, 2);
        const atrPct = this.calcATR(candles, 14);
        const trendStrength = this.calcTrendStrength(closes, 50);
        
        // V5.23: Use enhanced multi-factor scoring
        const qualityScore = globalSignalRanker.calculateScore({
          roc5,
          volumeRatio,
          bbPosition,
          atrPct,
          trendStrength,
          side: signal.side,
        });
        
        logger.info(`📊 [${shortSymbol}] Signal Quality Score: ${qualityScore.toFixed(2)} | ROC=${(roc5 * 100).toFixed(2)}% Vol=${volumeRatio.toFixed(1)}x BB=${(bbPosition * 100).toFixed(0)}% ATR=${atrPct.toFixed(1)}% Trend=${(trendStrength * 100).toFixed(1)}%`);
        
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
        });
        
        // 📢 NOTIFICATION: Signal detected
        notifySignalDetected({
          symbol,
          side: signal.side,
          price: currentPrice,
          reason: signal.reason || 'momentum_signal',
          mode: this.config.mode,
        });
        
        // Store signal info for frontend display
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
        
        // Notify
        this.config.onSignal?.({
          symbol,
          side: signal.side,
          reason: signal.reason || 'momentum_signal',
          timestamp: new Date(),
        });
        
        // V5.22: Execute trade with ranking check
        // CRITICAL for backtest parity: Wait for batch window to close so all agents
        // have submitted their signals before we check ranking. This ensures the same
        // ranking behavior as backtest which collects all signals synchronously.
        logger.info(`⏳ [${shortSymbol}] Waiting for signal ranking batch...`);
        await globalSignalRanker.waitForBatch();
        
        this.lastRejectReason = ''; // Clear reject reason on signal
        await this.openPosition(signal.side, candles);
      } else {
        // Store reject reason for tick log
        this.lastRejectReason = signal.reason || 'no_signal';
      }
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking entry:`, error);
    }
  }
  
  private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const symbol = this.config.symbol;
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;
    
    // Sync with exchange balance before checking capital (live mode)
    // For live mode, force sync on first position attempt to ensure we have real balance
    if (this.config.mode === 'live') {
      // Force sync if we haven't successfully synced yet
      await this.config.capitalPool.syncWithExchange(!this.config.capitalPool.isSynced());
      
      // In live mode, don't open positions if we haven't successfully synced with exchange
      if (!this.config.capitalPool.isSynced()) {
        logger.error(`❌ [${symbol}] Cannot open live position - failed to sync with exchange balance. Please check API connection.`);
        return;
      }
    }
    
    // V5.18: Check if we're at max positions before proceeding
    const openPositionCount = this.config.capitalPool.getOpenPositionCount();
    const maxPositions = this.config.capitalPool.getMaxPositions();
    if (openPositionCount >= maxPositions) {
      logger.info(`⚠️ [${symbol}] Max positions reached (${openPositionCount}/${maxPositions}) - waiting for existing positions to close`);
      return;
    }
    
    // V5.22: Check if this signal is ranked high enough to execute
    // Calculate how many position slots are available
    const availableSlots = maxPositions - openPositionCount;
    const shouldExecute = globalSignalRanker.shouldExecuteSignal(symbol, availableSlots);
    
    if (!shouldExecute) {
      // This signal is not in the top N opportunities - defer it
      const pendingSignals = globalSignalRanker.getPendingSignals();
      const currentSignal = pendingSignals.find(s => s.symbol === symbol);
      if (currentSignal) {
        logger.info(`⏸️ [${symbol.replace('/USDT:USDT', '')}] Signal DEFERRED (score=${currentSignal.score.toFixed(2)}) - not in top ${availableSlots} opportunities`);
      }
      return;
    }
    
    // Signal approved for execution - remove from pending
    globalSignalRanker.removeSignal(symbol);
    logger.info(`🎯 [${symbol.replace('/USDT:USDT', '')}] Signal APPROVED for execution (top ${availableSlots} opportunity)`);
    
    // Get available capital from pool
    const availableCapital = this.config.capitalPool.getAvailableCapital();
    const poolStatus = this.config.capitalPool.getStatus();
    
    // Log available capital for debugging - include full pool state
    logger.info(`💰 [${symbol}] Capital Pool Status | mode=${this.config.mode} | total=$${poolStatus.totalUsd.toFixed(2)} | inPositions=$${poolStatus.inPositionsUsd.toFixed(2)} | available=$${availableCapital.toFixed(2)} | synced=${this.config.capitalPool.isSynced()}`);
    
    // V5.5: Get 24h volume for liquidity-aware position sizing
    let volume24h: number | undefined;
    try {
      const wsTicker = await getTickerFromWebSocket(symbol);
      volume24h = wsTicker?.quoteVolume || undefined;
      if (volume24h) {
        const tier = getLiquidityTier(symbol);
        logger.info(`📊 [${symbol}] 24h Volume: $${(volume24h / 1_000_000).toFixed(1)}M | Liquidity Tier: ${tier}`);
      }
    } catch (e) {
      logger.warn(`⚠️ [${symbol}] Could not fetch 24h volume for sizing - using tier-based caps`);
    }
    
    // V5.6: Calculate safe leverage based on ATR volatility
    const baseLeverage = MomentumConfig.LEVERAGE[symbol] || 4;
    const leverageCalc = calcSafeLeverage(candles, baseLeverage);
    
    if (leverageCalc.wasReduced) {
      logger.warn(`⚡ [${symbol}] HIGH VOLATILITY DETECTED! ATR=${leverageCalc.atrPct?.toFixed(2)}% > ${LIQUIDATION_CONFIG.HIGH_VOLATILITY_ATR_PCT}% threshold | Leverage reduced: ${baseLeverage}x → ${leverageCalc.leverage}x`);
      
      // 📢 NOTIFICATION: High volatility detected
      notifyHighVolatility({
        symbol,
        atrPct: leverageCalc.atrPct || 0,
        originalLeverage: baseLeverage,
        reducedLeverage: leverageCalc.leverage,
        mode: this.config.mode,
      });
    }
    
    // V5.18: Get initial capital for adaptive sizing
    const initialCapitalUsd = this.config.capitalPool.getTotalCapital();
    
    // Calculate position size V5.18 - now with liquidity awareness, dynamic leverage, AND adaptive sizing
    const sizing = calculatePositionSize({
      symbol,
      currentPrice,
      totalCapitalUsd: availableCapital,
      riskPerTradePct: this.config.riskPerTradePct,
      stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
      volume24h, // V5.5: Pass volume for liquidity-aware sizing
      safeLeverage: leverageCalc.leverage, // V5.6: Pass ATR-adjusted leverage
      initialCapitalUsd, // V5.18: Pass initial capital for adaptive sizing
    });
    
    // V5.18: Calculate adaptive sizing % for logging
    const adaptiveSizingPct = Math.min(
      MomentumConfig.RISK.POSITION_SIZE_PCT_BASE + (initialCapitalUsd / 5000) * MomentumConfig.RISK.POSITION_SIZE_PCT_BOOST_PER_5K,
      MomentumConfig.RISK.POSITION_SIZE_PCT_MAX
    );
    
    // V5.5: Log if position was capped due to liquidity
    if (sizing.wasLiquidityCapped) {
      const targetNotional = availableCapital * adaptiveSizingPct * sizing.suggestedLeverage;
      logger.warn(`🚨 [${symbol}] Position CAPPED by liquidity! Target notional=$${targetNotional.toFixed(0)} → Capped=$${sizing.notionalUsd.toFixed(0)} (max safe=$${sizing.maxSafePosition?.toFixed(0)}, tier=${sizing.liquidityTier})`);
    }
    
    // 🔧 SAFETY CHECK: Validate position size is reasonable compared to available capital
    // This catches cases where capital sync might have failed or returned wrong values
    const maxReasonableNotional = availableCapital * 10; // Max 10x leverage equivalent
    if (sizing.notionalUsd > maxReasonableNotional) {
      logger.error(`🚫 [${symbol}] POSITION REJECTED - Notional ($${sizing.notionalUsd.toFixed(2)}) exceeds 10x available capital ($${availableCapital.toFixed(2)}). Likely capital sync issue.`);
      return;
    }
    
    // 🔧 SAFETY CHECK: Margin should not exceed 100% of capital
    if (sizing.marginUsd > availableCapital) {
      logger.error(`🚫 [${symbol}] POSITION REJECTED - Margin ($${sizing.marginUsd.toFixed(2)}) exceeds available capital ($${availableCapital.toFixed(2)}).`);
      return;
    }
    
    // Check if position size is valid (minimum $20 notional)
    if (sizing.notionalUsd < 20) {
      logger.info(`⚠️ [${symbol}] Cannot open position - insufficient capital (available $${availableCapital.toFixed(2)}, min $20 notional required)`);
      return;
    }
    
    // Try to reserve MARGIN (not notional) - this is what we actually risk
    if (!this.config.capitalPool.reserve(this.config.sessionId, sizing.marginUsd)) {
      logger.info(`⚠️ [${symbol}] Cannot open position - failed to reserve margin $${sizing.marginUsd.toFixed(2)}`);
      return;
    }
    
    // V5.5: Include liquidity info in log
    const slippageInfo = sizing.estimatedSlippage ? ` | est.slip=${sizing.estimatedSlippage.toFixed(3)}%` : '';
    const liquidityInfo = sizing.liquidityTier ? ` | tier=${sizing.liquidityTier}` : '';
    
    // V5.30: Check for multi-position plan (only for large accounts with liquidity caps)
    const multiPlan = sizing.multiPositionPlan;
    if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
      logger.info(`📊 [${symbol}] MULTI-POSITION PLAN ACTIVE | positions=${multiPlan.totalPositions} | perPosition=$${multiPlan.positionSizeUsd.toFixed(0)} | total=$${multiPlan.totalNotionalUsd.toFixed(0)} | efficiency=${(multiPlan.efficiency * 100).toFixed(1)}%`);
    }
    
    logger.info(`🚀 [${symbol}] OPENING ${side.toUpperCase()} | price=$${currentPrice.toFixed(4)} | qty=${sizing.qty.toFixed(6)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x${liquidityInfo}${slippageInfo}`);
    
    // V5.7: Calculate dynamic stop-loss based on ATR
    const slCalc = calcDynamicStopLoss(candles);
    const slPct = slCalc.slPct;
    if (slCalc.isDynamic) {
      logger.info(`🎯 [${symbol}] Dynamic SL: ATR=${slCalc.atrPct?.toFixed(2)}% × 2.0 = ${slPct.toFixed(2)}%`);
    }
    
    if (this.config.mode === 'paper') {
      // Paper trade
      const position: Position = {
        symbol,
        side,
        entryPrice: currentPrice,
        qty: sizing.qty,
        entryTime: lastCandle.timestamp,
        leverage: sizing.suggestedLeverage,   // V5.6: Store leverage used
        marginUsd: sizing.marginUsd,           // V5.6: Store margin blocked
        stopLoss: side === 'long' 
          ? currentPrice * (1 - slPct / 100)
          : currentPrice * (1 + slPct / 100),
        stopLossPct: slPct,                    // V5.7: Store SL percentage used
        highWaterMark: side === 'long' ? currentPrice : undefined,
        lowWaterMark: side === 'short' ? currentPrice : undefined,
        // V5.30: Multi-position tracking
        positionId: multiPlan?.enabled ? `${this.config.sessionId}_0` : undefined,
        groupId: multiPlan?.enabled ? `group_${Date.now()}_${symbol}` : undefined,
        entryIndex: multiPlan?.enabled ? 0 : undefined,
      };
      
      this.position = position;
      this.additionalPositions = []; // Reset additional positions
      this.closingPosition = false;
      
      // Commit MARGIN (not notional)
      this.config.capitalPool.commit(this.config.sessionId, sizing.marginUsd);
      
      // V5.30: Open additional positions if multi-position plan is active
      if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
        const groupId = position.groupId!;
        let totalAdditionalMargin = 0;
        
        for (let i = 1; i < multiPlan.totalPositions; i++) {
          const entryPrice = multiPlan.entryPrices[i];
          const marginPerPosition = multiPlan.positionSizeUsd / sizing.suggestedLeverage;
          const qtyPerPosition = multiPlan.positionSizeUsd / entryPrice;
          
          // Check if we have enough capital for this additional position
          const poolStatus = this.config.capitalPool.getStatus();
          if (poolStatus.availableUsd < marginPerPosition) {
            logger.warn(`⚠️ [${symbol}] Multi-position ${i+1}/${multiPlan.totalPositions} skipped - insufficient capital ($${poolStatus.availableUsd.toFixed(2)} < $${marginPerPosition.toFixed(2)})`);
            break;
          }
          
          const additionalPosition: Position = {
            symbol,
            side,
            entryPrice,
            qty: qtyPerPosition,
            entryTime: lastCandle.timestamp,
            leverage: sizing.suggestedLeverage,
            marginUsd: marginPerPosition,
            stopLoss: side === 'long'
              ? entryPrice * (1 - slPct / 100)
              : entryPrice * (1 + slPct / 100),
            stopLossPct: slPct,
            highWaterMark: side === 'long' ? entryPrice : undefined,
            lowWaterMark: side === 'short' ? entryPrice : undefined,
            positionId: `${this.config.sessionId}_${i}`,
            groupId,
            entryIndex: i,
          };
          
          this.additionalPositions.push(additionalPosition);
          totalAdditionalMargin += marginPerPosition;
          
          // Reserve and commit margin for this additional position
          this.config.capitalPool.commit(`${this.config.sessionId}_multi_${i}`, marginPerPosition);
          
          logger.info(`📝 [${symbol}] PAPER MULTI-POS ${i+1}/${multiPlan.totalPositions} @ $${entryPrice.toFixed(4)} | margin=$${marginPerPosition.toFixed(2)}`);
        }
        
        logger.info(`✅ [${symbol}] Opened ${1 + this.additionalPositions.length} positions | totalMargin=$${(sizing.marginUsd + totalAdditionalMargin).toFixed(2)}`);
      }
      
      // Log the updated capital state after commit
      const statusAfterCommit = this.config.capitalPool.getStatus();
      logger.info(`💰 [${symbol}] Capital after PAPER entry: total=$${statusAfterCommit.totalUsd.toFixed(2)} | inPositions=$${statusAfterCommit.inPositionsUsd.toFixed(2)} | available=$${statusAfterCommit.availableUsd.toFixed(2)}`);
      
      // Calculate entry fee: 0.04% taker on entry notional
      const paperEntryFee = sizing.notionalUsd * 0.0004;
      
      // Save to DB with calculated fee
      await this.savePositionToDb(position, 'paper_entry', paperEntryFee);
      
      logger.info(`📝 [${symbol}] PAPER ${side.toUpperCase()} OPENED @ $${currentPrice.toFixed(4)} | notional=$${sizing.notionalUsd.toFixed(2)} | margin=$${sizing.marginUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x | SL=${slPct.toFixed(2)}% ($${position.stopLoss?.toFixed(4)})`);
      
      // 📢 Send Telegram notification for paper entry
      void notifyPositionOpened({
        agentId: this.config.sessionId,
        symbol,
        side,
        quantity: sizing.qty,
        entryPrice: currentPrice,
        leverage: sizing.suggestedLeverage,
        stopLoss: position.stopLoss,
        mode: 'paper',
        notionalUsd: sizing.notionalUsd,
        marginUsd: sizing.marginUsd,
      });
      
      // Old notification system (kept for compatibility)
      notifyTradeEntry({
        symbol,
        side,
        price: currentPrice,
        qty: sizing.qty,
        notionalUsd: sizing.notionalUsd,
        marginUsd: sizing.marginUsd,
        leverage: sizing.suggestedLeverage,
        stopLoss: position.stopLoss,
        mode: 'paper',
      });
      
    } else {
      // Live trade
      try {
        // � Check circuit breaker FIRST - don't attempt REST calls if IP is banned
        if (!globalRestCircuitBreaker.canMakeRequest()) {
          const state = globalRestCircuitBreaker.getState();
          const remainingMs = state.closesAt ? state.closesAt - Date.now() : 0;
          const remainingSec = Math.round(remainingMs / 1000);
          logger.warn(`🚫 [${symbol}] REST circuit breaker is OPEN - cannot open position (${remainingSec}s remaining)`);
          this.config.capitalPool.cancelReservation(this.config.sessionId);
          return;
        }
        
        // V5.26: Check if markets are loaded before any exchange operation
        // NEVER call loadMarkets - it should have been done at startup via preloadMarkets()
        const exchangeMarkets = (this.config.exchange as any).markets;
        if (!exchangeMarkets || Object.keys(exchangeMarkets).length === 0) {
          if (isIpBanned()) {
            logger.error(`🚫 [${symbol}] Markets not loaded and IP is banned - cannot open position`);
            this.config.capitalPool.cancelReservation(this.config.sessionId);
            return;
          }
          logger.warn(`⚠️ [${symbol}] Markets not loaded - this should have been done at startup!`);
          // Don't call loadMarkets here - it's a REST call that could get us banned
          // Continue anyway - setLeverage might still work with manual symbol conversion
        }
        
        // Set leverage - Binance Futures requires integer leverage
        const intLeverage = Math.round(sizing.suggestedLeverage);
        logger.info(`🔧 [${symbol}] Setting leverage: ${sizing.suggestedLeverage} → ${intLeverage} (rounded to integer for Binance)`);
        
        // 🔧 FIX: Convert symbol to Binance format if needed (e.g., ETH/USDT:USDT → ETHUSDT)
        // Some CCXT versions/exchanges need the raw symbol format
        const binanceSymbol = symbol.replace('/', '').replace(':USDT', '');
        try {
          await this.config.exchange.setLeverage(intLeverage, symbol);
        } catch (levErr: any) {
          // If setLeverage fails with the CCXT symbol, try with Binance format
          if (levErr?.message?.includes('leverage') || levErr?.code === -1102) {
            logger.warn(`⚠️ [${symbol}] setLeverage failed with CCXT symbol, trying Binance format: ${binanceSymbol}`);
            try {
              await this.config.exchange.setLeverage(intLeverage, binanceSymbol);
              logger.info(`✅ [${symbol}] Leverage set successfully with Binance format`);
            } catch (retryErr: any) {
              logger.error(`❌ [${symbol}] setLeverage failed even with Binance format:`, retryErr?.message);
              throw retryErr;
            }
          } else {
            throw levErr;
          }
        }
        
        // Format quantity to exchange precision (critical for Binance Futures)
        const formattedQty = this.formatQtyForExchange(symbol, sizing.qty);
        
        // Validate formatted quantity is still valid
        if (formattedQty <= 0) {
          logger.error(`❌ [${symbol}] Formatted quantity is 0 or negative (raw: ${sizing.qty})`);
          this.config.capitalPool.cancelReservation(this.config.sessionId);
          return;
        }

        // ========================================================================
        // ORDER QUEUE INTEGRATION - Submit order via global queue
        // ========================================================================
        const orderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: this.config.sessionId,
          userId: this.config.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: 'signal_entry',
            isEntry: true,
            urgency: 'medium',
          }),
          symbol,
          side: side === 'long' ? 'buy' : 'sell',
          type: 'market',
          quantity: formattedQty,
          params: { reduceOnly: false },
          isEntry: true,
          reason: 'signal_entry',
          priorityContext: {
            isEntry: true,
            reason: 'signal_entry',
            urgency: 'medium',
          },
          submittedAt: Date.now(),
          retries: 0,
          timeoutMs: 30_000,
        };

        logger.info(`[${symbol}] Submitting ${side} entry order to queue | orderId=${orderRequest.id} | priority=${orderRequest.priority}`);

        const result = await orderQueue.submitOrder(orderRequest);

        if (!result.success) {
          logger.error(`[${symbol}] Order FAILED: ${result.error} (${result.errorCode})`);
          this.config.capitalPool.cancelReservation(this.config.sessionId);
          notifyOrderError({
            symbol,
            side,
            orderType: 'entry',
            error: result.error || 'Unknown error',
            mode: this.config.mode,
          });
          return;
        }

        const order = result.order!;
        const filledPrice = order.average || order.price || currentPrice;
        const filledQty = order.filled || formattedQty;
        const entryTimeMs = (order as any)?.timestamp ?? lastCandle.timestamp;
        
        const position: Position = {
          symbol,
          side,
          entryPrice: filledPrice,
          qty: filledQty,
          entryTime: entryTimeMs,
          leverage: sizing.suggestedLeverage,   // V5.6: Store leverage used
          marginUsd: sizing.marginUsd,           // V5.6: Store margin blocked
          stopLoss: side === 'long'
            ? filledPrice * (1 - slPct / 100)
            : filledPrice * (1 + slPct / 100),
          stopLossPct: slPct,                    // V5.7: Store SL percentage used
          orderId: order.id,
          highWaterMark: side === 'long' ? filledPrice : undefined,
          lowWaterMark: side === 'short' ? filledPrice : undefined,
          // V5.30: Multi-position tracking
          positionId: multiPlan?.enabled ? `${this.config.sessionId}_0` : undefined,
          groupId: multiPlan?.enabled ? `group_${Date.now()}_${symbol}` : undefined,
          entryIndex: multiPlan?.enabled ? 0 : undefined,
        };
        
        this.position = position;
        this.additionalPositions = []; // Reset additional positions
        this.closingPosition = false;
        
        // Commit MARGIN (not notional)
        this.config.capitalPool.commit(this.config.sessionId, sizing.marginUsd);
        
        // V5.30: Open additional positions if multi-position plan is active (LIVE mode)
        if (multiPlan?.enabled && multiPlan.totalPositions > 1) {
          const groupId = position.groupId!;
          
          for (let i = 1; i < multiPlan.totalPositions; i++) {
            const targetEntryPrice = multiPlan.entryPrices[i];
            const marginPerPosition = multiPlan.positionSizeUsd / sizing.suggestedLeverage;
            const qtyPerPosition = this.formatQtyForExchange(symbol, multiPlan.positionSizeUsd / targetEntryPrice);
            
            // Check if we have enough capital
            const poolStatus = this.config.capitalPool.getStatus();
            if (poolStatus.availableUsd < marginPerPosition) {
              logger.warn(`⚠️ [${symbol}] LIVE multi-pos ${i+1}/${multiPlan.totalPositions} skipped - insufficient capital`);
              break;
            }
            
            // Submit additional order via queue
            const additionalOrderRequest: OrderRequest = {
              id: uuidv4(),
              agentId: this.config.sessionId,
              userId: this.config.userId || 'unknown',
              priority: calculateOrderPriority({
                reason: 'signal_entry',
                isEntry: true,
                urgency: 'medium',
              }),
              symbol,
              side: side === 'long' ? 'buy' : 'sell',
              type: 'market',
              quantity: qtyPerPosition,
              params: { reduceOnly: false },
              isEntry: true,
              reason: `multi_entry_${i+1}`,
              priorityContext: {
                isEntry: true,
                reason: 'signal_entry',
                urgency: 'medium',
              },
              submittedAt: Date.now(),
              retries: 0,
              timeoutMs: 30_000,
            };
            
            logger.info(`[${symbol}] Submitting multi-pos ${i+1}/${multiPlan.totalPositions} | orderId=${additionalOrderRequest.id}`);
            
            const additionalResult = await orderQueue.submitOrder(additionalOrderRequest);
            
            if (!additionalResult.success) {
              logger.error(`[${symbol}] Multi-pos ${i+1} FAILED: ${additionalResult.error}`);
              continue;
            }
            
            const addOrder = additionalResult.order!;
            const addFilledPrice = addOrder.average || addOrder.price || targetEntryPrice;
            const addFilledQty = addOrder.filled || qtyPerPosition;
            
            const additionalPosition: Position = {
              symbol,
              side,
              entryPrice: addFilledPrice,
              qty: addFilledQty,
              entryTime: addOrder.timestamp || Date.now(),
              leverage: sizing.suggestedLeverage,
              marginUsd: marginPerPosition,
              stopLoss: side === 'long'
                ? addFilledPrice * (1 - slPct / 100)
                : addFilledPrice * (1 + slPct / 100),
              stopLossPct: slPct,
              orderId: addOrder.id,
              highWaterMark: side === 'long' ? addFilledPrice : undefined,
              lowWaterMark: side === 'short' ? addFilledPrice : undefined,
              positionId: `${this.config.sessionId}_${i}`,
              groupId,
              entryIndex: i,
            };
            
            this.additionalPositions.push(additionalPosition);
            this.config.capitalPool.commit(`${this.config.sessionId}_multi_${i}`, marginPerPosition);
            
            // Set SL for this position too
            await this.setStopLossOnExchange(additionalPosition);
            
            logger.info(`🟢 [${symbol}] LIVE MULTI-POS ${i+1}/${multiPlan.totalPositions} @ $${addFilledPrice.toFixed(4)} | margin=$${marginPerPosition.toFixed(2)}`);
            
            // Delay between orders to avoid rate limits
            await new Promise(r => setTimeout(r, 500));
          }
          
          logger.info(`✅ [${symbol}] Opened ${1 + this.additionalPositions.length} LIVE positions`);
        }
        
        // Log the updated capital state after commit
        const statusAfterCommit = this.config.capitalPool.getStatus();
        logger.info(`💰 [${symbol}] Capital after LIVE entry: total=$${statusAfterCommit.totalUsd.toFixed(2)} | inPositions=$${statusAfterCommit.inPositionsUsd.toFixed(2)} | available=$${statusAfterCommit.availableUsd.toFixed(2)}`);
        
        // Extract entry fee from CCXT order, fallback to 0.04% calculation
        const liveEntryNotional = filledQty * filledPrice;
        const liveEntryFee = order.fee?.cost ?? (liveEntryNotional * 0.0004);
        
        // Exchange-side protection: EMERGENCY STOP ONLY (wide, crash protection)
        // Trailing exit is managed app-side; do NOT move exchange SL above entry.
        const baseSlPct = position.stopLossPct || 2.0;
        const emergencyTargetPct = baseSlPct * (MomentumConfig.EXIT.EMERGENCY_STOP_MULTIPLIER || 2.5);
        const emergencyMaxPct = MomentumConfig.EXIT.EMERGENCY_STOP_MAX_PCT ?? 3.0;
        const emergencySlPct = Math.min(emergencyTargetPct, emergencyMaxPct);
        const emergencyStop = position.side === 'long'
          ? position.entryPrice * (1 - emergencySlPct / 100)
          : position.entryPrice * (1 + emergencySlPct / 100);

        if (this.position) {
          this.position.stopLoss = emergencyStop;
          this.position.emergencyStopPrice = emergencyStop;
        }
        await this.setStopLossOnExchange(position);

        logger.info(`🛡️ [${symbol}] Emergency STOP_MARKET set @ $${emergencyStop.toFixed(4)} (${emergencySlPct.toFixed(2)}%) | trailing exit = app-side`);

        // Save to DB with fee (store the emergency stop, not the tight strategy SL)
        await this.savePositionToDb(position, 'live_entry', liveEntryFee);

        // Realtime app-side exits (WS-based) for fast trailing/stoploss reaction.
        this.startRealtimeExitMonitorIfNeeded();
        
        // Optional: native exchange trailing (disabled by default)
        if (MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) {
          const trailingSuccess = await this.setTrailingStopOnExchange(position);
          
          if (trailingSuccess) {
            logger.info(`✅ [${symbol}] DUAL PROTECTION: Fixed SL @ $${position.stopLoss?.toFixed(4)} + Trailing @ +0.8%`);
          } else {
            logger.warn(`⚠️ [${symbol}] SINGLE PROTECTION: Only fixed SL active (trailing failed)`);
          }
        }
        
        logger.info(`🟢 [${symbol}] LIVE ${side.toUpperCase()} OPENED @ $${filledPrice} | qty=${filledQty} | margin=$${sizing.marginUsd.toFixed(2)} | notional=$${sizing.notionalUsd.toFixed(2)} | lev=${sizing.suggestedLeverage}x | SL=$${position.stopLoss?.toFixed(4)}`);
        
        // 📢 Send Telegram notification for live entry avec détails complets
        void notifyPositionOpened({
          agentId: this.config.sessionId,
          symbol,
          side,
          quantity: filledQty,
          entryPrice: filledPrice,
          leverage: sizing.suggestedLeverage,
          stopLoss: position.stopLoss,
          mode: 'live',
          notionalUsd: sizing.notionalUsd,
          marginUsd: sizing.marginUsd,
        });
        
        // Old notification system (kept for compatibility)
        notifyTradeEntry({
          symbol,
          side,
          price: filledPrice,
          qty: filledQty,
          notionalUsd: sizing.notionalUsd,
          marginUsd: sizing.marginUsd,
          leverage: sizing.suggestedLeverage,
          stopLoss: position.stopLoss,
          mode: 'live',
        });
        
        this.config.onTrade?.({
          symbol,
          side: side === 'long' ? 'buy' : 'sell',
          qty: filledQty,
          price: filledPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error: any) {
        // Enhanced error logging for debugging
        logger.error(`❌ [${symbol}] Failed to open live position:`, {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          info: error?.info,
        });
        
        // 📢 NOTIFICATION: Order error (CRITICAL in live mode)
        notifyOrderError({
          symbol,
          side,
          orderType: 'entry',
          error: error?.message || 'Unknown error',
          mode: 'live',
        });
        
        // Cancel reservation on failure
        this.config.capitalPool.cancelReservation(this.config.sessionId);
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
      const btcCandles = await this.fetchBtcCandles();

      // V5.13: Same fix as checkEntry - use timestamp age instead of slice(0,-1)
      const now = Date.now();
      const CANDLE_INTERVAL_MS = 15 * 60 * 1000;
      
      let lastClosedIdx = allCandles.length - 1;
      const lastCandleAge = now - allCandles[lastClosedIdx].timestamp;
      
      if (lastCandleAge < CANDLE_INTERVAL_MS) {
        lastClosedIdx = allCandles.length - 2;
      }
      
      if (lastClosedIdx < 0) {
        return;
      }
      
      const candles = allCandles.slice(0, lastClosedIdx + 1);
      const latestClosedCandle = candles[candles.length - 1];

      // Only process exit once per newly-closed candle.
      if (latestClosedCandle.timestamp === this.lastProcessedExitCandleTs) {
        return;
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
      
      // Update water marks for trailing stop
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
        });
      }
      
      // V5.13: Pass BTC candles for regime detection and symbol candles for momentum reversal
      const exitSignal = shouldExitPosition(this.position!, currentPrice, candles, {
        nowMs: latestClosedCandle.timestamp,
        priceHigh: latestClosedCandle.high,
        priceLow: latestClosedCandle.low,
        btcCandles: btcCandles,
      });

      // 🔍 DEBUG: Log regime change detection for debugging timing issues
      if (exitSignal.shouldExit && exitSignal.reason === 'regime_change') {
        logger.warn(`🚨 [${symbol}] REGIME CHANGE DETECTED on 15m close | candle_ts=${new Date(latestClosedCandle.timestamp).toISOString()} | price=$${currentPrice.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
      }

      // V5.26: Persist trailing activation - once active, stays active
      if (exitSignal.trailingActivated) {
        this.position!.trailingActive = true;
      }

      // ════════════════════════════════════════════════════════════════════════
      // V5.38: TRAILING STOP with 2-CLOSE CONFIRMATION (aligned with backtest)
      // Requires 2 consecutive 15m candle closes beyond trailing stop to exit
      // This filters out single-candle fakeouts and lets winners run longer
      // ════════════════════════════════════════════════════════════════════════
      if (exitSignal.trailingBreached) {
        // Initialize breach counter if needed
        if (!this.position!.trailingBreachCandles) {
          this.position!.trailingBreachCandles = 0;
        }
        
        this.position!.trailingBreachCandles += 1;
        const breachCount = this.position!.trailingBreachCandles;
        const REQUIRED_CONFIRMATIONS = 2;
        
        if (breachCount >= REQUIRED_CONFIRMATIONS) {
          // Confirmed! 2 consecutive closes beyond trailing stop
          logger.info(`🔴 [${symbol}] TRAILING CONFIRMED (${breachCount}/${REQUIRED_CONFIRMATIONS} closes) | price=$${currentPrice.toFixed(4)} | trail=$${exitSignal.newStopLoss?.toFixed(4)} | PnL=${exitSignal.pnlPct?.toFixed(2)}%`);
          await this.closePosition(this.position!, currentPrice, 'trailing');
          return;
        } else {
          // First breach - wait for confirmation
          logger.warn(`⚠️ [${symbol}] TRAILING BREACH ${breachCount}/${REQUIRED_CONFIRMATIONS} | price=$${currentPrice.toFixed(4)} | trail=$${exitSignal.newStopLoss?.toFixed(4)} | Waiting for confirmation...`);
        }
      } else if (exitSignal.trailingActivated) {
        // No breach this candle - reset counter
        if (this.position!.trailingBreachCandles && this.position!.trailingBreachCandles > 0) {
          logger.info(`✅ [${symbol}] Trailing breach CLEARED - price recovered above stop`);
        }
        this.position!.trailingBreachCandles = 0;
      }

      // Emergency profit-protection (exchange-side): ratchet stop only after +2% PnL.
      // This is NOT the primary exit; trailing/app logic remains the priority.
      await this.updateEmergencyStopProfitProtectionIfNeeded(currentPrice, pnlPct);
      
      if (exitSignal.shouldExit) {
        logger.info(`🔴 [${symbol}] EXIT SIGNAL: reason=${exitSignal.reason} | PnL=${exitSignal.pnlPct?.toFixed(2)}% | holdMin=${exitSignal.holdMinutes?.toFixed(0)}`);
        await this.closePosition(this.position!, currentPrice, exitSignal.reason || 'unknown');
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
            } catch (error: any) {
              // Error already handled by setTrailingStopOnExchange fallback
              logger.warn(`⚠️ [${symbol}] Failed to widen trailing: ${error.message}`);
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
        });
      }
      
    } catch (error) {
      logger.error(`❌ [${symbol}] Error checking exit:`, error);
    }
  }
  
  private async closePosition(
    position: Position, 
    currentPrice: number,
    reason: string
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

    // V5.13: Adaptive cooldown based on exit reason
    // - Profitable exits (TRAILING) = short cooldown (momentum continues)
    // - Loss exits (STOP_LOSS) = longer cooldown (bad signal)
    // - Regime/Momentum change = medium/long cooldown (wait for confirmation)
    let cooldownBars = this.ENTRY_COOLDOWN_BARS; // Default: 8 bars (2h)
    
    if (reason.includes('trailing') || reason === 'take_profit') {
      // Profitable exit = momentum likely continues, short cooldown
      cooldownBars = 2; // 30 minutes
      logger.info(`⏱️ [${symbol}] Cooldown: 2 bars (30min) - profitable exit, quick re-entry allowed`);
    } else if (reason.includes('stop') || reason.includes('sl')) {
      // Stop loss = bad signal, wait longer
      cooldownBars = 10; // 2h30
      logger.info(`⏱️ [${symbol}] Cooldown: 10 bars (2h30) - stop loss, extended wait`);
    } else if (reason.includes('momentum')) {
      // Momentum reversal = wait for momentum to stabilize
      cooldownBars = 8; // 2h
      logger.info(`⏱️ [${symbol}] Cooldown: 8 bars (2h) - momentum reversal`);
    } else if (reason.includes('regime')) {
      // Regime change = major shift, wait longer
      cooldownBars = 12; // 3h
      logger.info(`⏱️ [${symbol}] Cooldown: 12 bars (3h) - regime change, wait for confirmation`);
    }
    
    this.entryCooldownBarsRemaining = cooldownBars;
    
    // Store exit info for frontend display
    this.lastExit = {
      ts: Date.now(),
      price: currentPrice,
      reason,
    };
    this.currentBias = null;
    this.lastSignal = null;
    
    if (this.config.mode === 'paper') {
      // Paper close
      this.position = null;
      
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
      
      // Calculate paper fee: 0.04% taker on exit notional
      const exitNotionalUsd = position.qty * currentPrice;
      const paperFeeUsd = exitNotionalUsd * 0.0004;
      
      await this.saveExitToDb(position, currentPrice, reason, pnlPct, totalPnlUsd, undefined, paperFeeUsd);
      logger.info(`📝 [${symbol}] PAPER CLOSED | PnL=${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${totalPnlUsd.toFixed(2)}) | margin released=$${totalMarginReleased.toFixed(2)}`);
      
      // 📢 Send Telegram notification for paper exit avec P&L et balance
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
      });
      
    } else {
      // Live close
      try {
        // 🚫 Check circuit breaker FIRST - don't attempt REST calls if IP is banned
        if (!globalRestCircuitBreaker.canMakeRequest()) {
          const state = globalRestCircuitBreaker.getState();
          const remainingMs = state.closesAt ? state.closesAt - Date.now() : 0;
          const remainingSec = Math.round(remainingMs / 1000);
          logger.error(`🚫 [${symbol}] REST circuit breaker is OPEN - cannot close position (${remainingSec}s remaining) ⚠️ POSITION REMAINS OPEN!`);
          // Don't clear position or release capital - the position is still open on exchange!
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

        const orderRequest: OrderRequest = {
          id: uuidv4(),
          agentId: this.config.sessionId,
          userId: this.config.userId || 'unknown',
          priority: calculateOrderPriority({
            reason: reason as any,
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
            reason: reason as any,
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
          return;
        }

        const order = result.order!;
        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const exitPrice = order.average || order.price || currentPrice;
        
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
                reason: reason as any,
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
              priorityContext: { isEntry: false, reason: reason as any },
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
        
        // Pass the real exchange orderId and fee for proper tracking
        await this.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd, order.id, liveFeeUsd);
        
        logger.info(`🔴 [${symbol}] LIVE CLOSED @ $${exitPrice} | PnL=${actualPnlPct >= 0 ? '+' : ''}${actualPnlPct.toFixed(2)}% ($${actualPnlUsd.toFixed(2)}) | fee=$${liveFeeUsd.toFixed(2)} | margin released=$${marginToRelease.toFixed(2)} | orderId=${order.id}`)
        
        // 📢 Send Telegram notification for live exit avec tous les détails
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
        });
        
        this.config.onTrade?.({
          symbol,
          side: closeSide,
          qty: position.qty,
          price: exitPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error: any) {
        logger.error(`❌ [${symbol}] Failed to close live position:`, error);
        
        // 📢 NOTIFICATION: Exit order error (CRITICAL)
        notifyOrderError({
          symbol,
          side: position.side,
          orderType: 'exit',
          error: error?.message || 'Unknown error',
          mode: 'live',
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
  
  /**
   * Format quantity to exchange precision
   * Uses CCXT's amountToPrecision if available, otherwise applies fallback rounding
   * This is critical for Binance Futures which requires specific step sizes per symbol
   */
  private formatQtyForExchange(symbol: string, qty: number): number {
    // Try CCXT's amountToPrecision first (most reliable)
    if (this.config.exchange.amountToPrecision) {
      try {
        const formatted = this.config.exchange.amountToPrecision(symbol, qty);
        const result = parseFloat(formatted);
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (via amountToPrecision)`);
        return result;
      } catch (e) {
        logger.warn(`⚠️ [${symbol}] amountToPrecision failed, using fallback:`, e);
      }
    }
    
    // Fallback: Get precision from market info if available
    const market = this.config.exchange.markets?.[symbol];
    if (market?.precision?.amount !== undefined) {
      const precision = market.precision.amount;
      // In CCXT, precision can be represented as:
      // - Number of decimal places (integer >= 0, e.g., 3 means 0.001 step)
      // - Direct step size (decimal < 1, e.g., 0.001)
      // CCXT typically uses Number.isInteger() to distinguish, but we use a heuristic:
      // If precision is an integer AND > 0, treat as decimal places
      // Otherwise treat as step size
      if (Number.isInteger(precision) && precision > 0) {
        // It's decimal places (e.g., 3 means 3 decimal places = 0.001 step)
        const factor = Math.pow(10, precision);
        const result = Math.floor(qty * factor) / factor;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (${precision} decimals)`);
        return result;
      } else {
        // It's step size (e.g., 0.001 or 1)
        const stepSize = precision;
        const result = Math.floor(qty / stepSize) * stepSize;
        logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (step=${stepSize})`);
        return result;
      }
    }
    
    // Known precision map for Binance Futures symbols (fallback when markets not loaded)
    // These are step sizes (quantity increments) for each symbol
    // ⚠️ WARNING: This is a static fallback - step sizes may change on the exchange
    const knownPrecision: Record<string, number> = {
      'SEI/USDT:USDT': 1,      // Step size = 1 (whole units)
      'IMX/USDT:USDT': 0.1,    // Step size = 0.1
      'SUI/USDT:USDT': 0.1,    // Step size = 0.1
      'DOGE/USDT:USDT': 1,     // Step size = 1
      'XRP/USDT:USDT': 0.1,    // Step size = 0.1
      'ADA/USDT:USDT': 0.1,    // Step size = 0.1
      'DOT/USDT:USDT': 0.1,    // Step size = 0.1
      'LINK/USDT:USDT': 0.01,  // Step size = 0.01
      'AVAX/USDT:USDT': 0.01,  // Step size = 0.01
      'SOL/USDT:USDT': 0.01,   // Step size = 0.01
      'ETH/USDT:USDT': 0.001,  // Step size = 0.001
      'BTC/USDT:USDT': 0.001,  // Step size = 0.001
    };
    
    const stepSize = knownPrecision[symbol];
    if (stepSize !== undefined) {
      // Log warning that we're using static fallback - markets should be loaded
      logger.warn(`⚠️ [${symbol}] Using static precision fallback (step=${stepSize}). Consider checking if exchange markets are loaded correctly.`);
      const result = Math.floor(qty / stepSize) * stepSize;
      logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (known step=${stepSize})`);
      return result;
    }
    
    // Ultimate fallback: round to 3 decimal places (more conservative for safety)
    logger.warn(`⚠️ [${symbol}] No precision info available, using conservative 3 decimal fallback`);
    const result = Math.floor(qty * 1000) / 1000;
    logger.info(`🔢 [${symbol}] Qty precision: ${qty} → ${result} (fallback 3 decimals)`);
    return result;
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
    try {
      const wsKlines = getKlinesOhlcvFromWebSocket(binanceSymbol, '15m');
      if (wsKlines && wsKlines.length >= 50) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
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
    const wsKlinesPartial = getKlinesOhlcvFromWebSocket(binanceSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
      this.candleCache = { candles, fetchedAt: Date.now() };
      return candles;
    }
    
    // No data - return cached or empty (agent will skip tick)
    return this.candleCache?.candles || [];
  }
  
  private async fetchBtcCandles(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT'; // Binance format for WebSocket
    const btcSymbolCcxt = 'BTC/USDT:USDT'; // CCXT format for REST fallback
    
    // 1. Subscribe to BTC WebSocket stream (re-subscribe each time to keep TTL alive)
    try {
      const ws = getBinanceWebSocket();
      ws.subscribeToKline(btcSymbol, '15m');
      if (!btcWsSubscribed) {
        btcWsSubscribed = true;
        logger.info('📡 [BTC] Subscribed to WebSocket kline stream (0 API weight)');
      }
    } catch (error) {
      if (!btcWsSubscribed) {
        logger.warn('⚠️ [BTC] Failed to subscribe to WebSocket, will use REST');
      }
    }
    
    // 2. Try WebSocket cache first (0 API weight!) 
    try {
      const wsKlines = getKlinesOhlcvFromWebSocket(btcSymbol, '15m');
      if (wsKlines && wsKlines.length >= 200) {
        const candles: Candle[] = wsKlines.map(c => ({
          timestamp: c[0] as number,
          open: c[1] as number,
          high: c[2] as number,
          low: c[3] as number,
          close: c[4] as number,
          volume: c[5] as number,
        }));
        
        // Update global cache with WS data
        globalBtcCandleCache = { candles, fetchedAt: Date.now() };
        return candles;
      }
    } catch (error) {
      // WebSocket cache miss - continue to cached/wait
    }
    
    // 3. Check global cache (from previous WS data)
    if (globalBtcCandleCache && Date.now() - globalBtcCandleCache.fetchedAt < GLOBAL_BTC_CACHE_TTL_MS) {
      return globalBtcCandleCache.candles;
    }
    
    // 4. NO REST FALLBACK - WebSocket only to avoid IP bans
    // V5.29: Removed REST fallback - caused IP bans from Binance
    const wsKlinesPartial = getKlinesOhlcvFromWebSocket(btcSymbol, '15m');
    if (wsKlinesPartial && wsKlinesPartial.length > 0) {
      const candles: Candle[] = wsKlinesPartial.map(c => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
      globalBtcCandleCache = { candles, fetchedAt: Date.now() };
      return candles;
    }
    
    // No data - return cached or empty
    return globalBtcCandleCache?.candles || [];
  }

  // V5.36: Fetch BTC 1h candles for Multi-Timeframe Confluence filter
  private async fetchBtcCandles1h(): Promise<Candle[]> {
    const btcSymbol = 'BTCUSDT'; // Binance format for WebSocket

    // 0. Check global cache first (shared across all agents)
    if (globalBtc1hCandleCache && Date.now() - globalBtc1hCandleCache.fetchedAt < GLOBAL_BTC_1H_CACHE_TTL_MS) {
      return globalBtc1hCandleCache.candles;
    }

    // Prevent multiple concurrent fetches
    if (globalBtc1hCacheFetchingPromise) {
      return globalBtc1hCacheFetchingPromise;
    }

    // Create fetch promise
    globalBtc1hCacheFetchingPromise = (async () => {
      try {
        // 1. Subscribe to BTC 1h WebSocket stream
        try {
          const ws = getBinanceWebSocket();
          ws.subscribeToKline(btcSymbol, '1h');
        } catch (error) {
          // Silently fail - will try cache or fallback
        }

        // 2. Try WebSocket cache first (0 API weight!)
        try {
          const wsKlines = getKlinesOhlcvFromWebSocket(btcSymbol, '1h');
          if (wsKlines && wsKlines.length >= 20) {  // Need at least 20 candles for MTF filter
            const candles: Candle[] = wsKlines.map(c => ({
              timestamp: c[0] as number,
              open: c[1] as number,
              high: c[2] as number,
              low: c[3] as number,
              close: c[4] as number,
              volume: c[5] as number,
            }));
            globalBtc1hCandleCache = { candles, fetchedAt: Date.now() };
            return candles;
          }
        } catch (error) {
          // WebSocket cache miss - will try REST fallback
        }

        // 3. REST API fallback - fetch BTC 1h candles
        // V5.36 FIX: MTF filter needs actual data to work properly
        try {
          if (this.config.exchange.fetchOHLCV) {
            const ohlcv = await this.config.exchange.fetchOHLCV(
              'BTC/USDT:USDT',
              '1h',
              undefined,
              50  // Fetch 50 candles for MTF filter (need at least 11)
            );

            if (ohlcv && ohlcv.length >= 11) {
              const candles: Candle[] = ohlcv.map(c => ({
                timestamp: c[0] as number,
                open: c[1] as number,
                high: c[2] as number,
                low: c[3] as number,
                close: c[4] as number,
                volume: c[5] as number,
              }));
              globalBtc1hCandleCache = { candles, fetchedAt: Date.now() };
              return candles;
            }
          }
        } catch (error: any) {
          logger.warn(`[fetchBtcCandles1h] REST fallback failed: ${error.message}`);
        }

        // 4. No data - return empty array (MTF filter will pass-through as fail-safe)
        logger.warn('[fetchBtcCandles1h] No BTC 1h data available - MTF filter will be bypassed');
        return [];
      } finally {
        globalBtc1hCacheFetchingPromise = null;
      }
    })();

    return globalBtc1hCacheFetchingPromise;
  }

  /**
   * Cancel ALL orders on exchange (both regular AND algo orders)
   * This is a helper that calls cancelAllOrders twice - once for regular, once for algo
   */
  private async cancelAllOrdersOnExchange(): Promise<void> {
    if (this.config.mode === 'paper') return;
    
    const symbol = this.config.symbol;
    
    if (this.config.exchange.cancelAllOrders) {
      // Step 1: Cancel REGULAR orders
      try {
        await this.config.exchange.cancelAllOrders(symbol);
      } catch (err: any) {
        // Ignore "no orders" errors
      }
      
      // Step 2: Cancel ALGO orders (STOP_MARKET, TRAILING_STOP_MARKET)
      try {
        await this.config.exchange.cancelAllOrders(symbol, { conditional: true });
      } catch (err: any) {
        // Ignore "no orders" errors
      }
      
      if (this.position) {
        this.position.stopLossOrderId = undefined;
        this.position.trailingOrderId = undefined;
      }
    }
  }
  
  /**
   * Cancel existing stop loss order on exchange
   * NOTE: For Binance, we need TWO calls:
   * 1. cancelAllOrders(symbol) - cancels REGULAR orders
   * 2. cancelAllOrders(symbol, { conditional: true }) - cancels ALGO orders (STOP_MARKET, TRAILING_STOP_MARKET)
   */
  private async cancelStopLossOnExchange(): Promise<void> {
    if (this.config.mode === 'paper') return;
    
    const symbol = this.config.symbol;
    
    try {
      await this.cancelAllOrdersOnExchange();
      logger.info(`🗑️ [${symbol}] Cancelled all open orders (regular + algo)`);
    } catch (error) {
      logger.warn(`⚠️ [${symbol}] Failed to cancel orders:`, error);
    }
  }
  
  /**
   * Set or update stop loss on exchange
   * Cancels existing SL first if present
   */
  private async setStopLossOnExchange(position: Position, isUpdate: boolean = false): Promise<void> {
    if (!position.stopLoss) return;
    if (this.config.mode === 'paper') return;
    
    const symbol = this.config.symbol;
    const side = position.side === 'long' ? 'sell' : 'buy';
    
    try {
      // Cancel existing SL order first if updating
      // NOTE: Must cancel both regular AND algo orders, then re-place trailing
      if (isUpdate && this.position?.stopLossOrderId) {
        try {
          await this.cancelAllOrdersOnExchange();
          logger.info(`🔄 [${symbol}] Cancelled all orders for SL update`);
          // Re-place trailing stop if it exists
          if (this.position?.trailingOrderId) {
            await this.setTrailingStopOnExchange(this.position);
          }
        } catch (error: any) {
          logger.warn(`⚠️ [${symbol}] Failed to cancel orders for SL update:`, error);
        }
      }
      
      // Format quantity to exchange precision for SL order
      const formattedQty = this.formatQtyForExchange(symbol, position.qty);
      
      // Create new SL order using stopLossPrice (triggers CCXT Algo Order endpoint for Binance Futures)
      // Binance changed their API in late 2024 - STOP_MARKET now requires Algo Order endpoint
      const slOrder = await this.config.exchange.createOrder(
        symbol,
        'market',  // CCXT will convert to STOP_MARKET when stopLossPrice is set
        side,
        formattedQty,
        undefined,
        {
          stopLossPrice: position.stopLoss,  // This triggers CCXT to use fapiPrivatePostAlgoOrder
          reduceOnly: true,
          workingType: 'MARK_PRICE',  // Use mark price to avoid manipulation
        }
      );
      
      // Store the SL order ID for later cancellation/update
      if (this.position) {
        this.position.stopLossOrderId = slOrder.id;
      }
      
      const action = isUpdate ? 'UPDATED' : 'SET';
      logger.info(`🛡️ [${symbol}] Stop loss ${action} at $${position.stopLoss.toFixed(4)} (order: ${slOrder.id})`);
    } catch (error) {
      logger.warn(`⚠️ [${symbol}] Failed to set stop loss on exchange:`, error);
    }
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
    // V5.13: Skip exchange trailing if app-side management enabled (like paper mode)
    if (this.config.mode === 'paper') return false;
    if (!MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) return false;
    if (!position.entryPrice) return false;
    
    const symbol = this.config.symbol;
    const side = position.side === 'long' ? 'sell' : 'buy';
    
    // V5.12: SMART trailing config
    const trailingActivationPct = MomentumConfig.EXIT.TRAILING_ACTIVATION_PCT;  // 0.8%
    const trailingDistancePct = isWidening 
      ? MomentumConfig.EXIT.TRAILING_WIDE_DISTANCE_PCT    // 0.8% (widened)
      : MomentumConfig.EXIT.TRAILING_DISTANCE_PCT;        // 0.5% (initial)
    
    // Calculate activation price (when trailing starts)
    const activationPrice = position.side === 'long'
      ? position.entryPrice * (1 + trailingActivationPct / 100)
      : position.entryPrice * (1 - trailingActivationPct / 100);
    
    try {
      // Format quantity to exchange precision
      const formattedQty = this.formatQtyForExchange(symbol, position.qty);
      
      // Create TRAILING_STOP_MARKET order using CCXT unified params
      const trailingOrder = await this.config.exchange.createOrder(
        symbol,
        'market',
        side,
        formattedQty,
        undefined,
        {
          trailingPercent: trailingDistancePct,
          trailingTriggerPrice: activationPrice,
          reduceOnly: true,
          workingType: 'MARK_PRICE',
        }
      );
      
      // Store the trailing order ID for tracking
      if (this.position) {
        this.position.trailingOrderId = trailingOrder.id;
      }
      
      const phase = isWidening ? 'WIDENED' : 'INITIAL';
      logger.info(`🎯 [${symbol}] TRAILING_STOP_MARKET [${phase}]: activation=$${activationPrice.toFixed(4)} (+${trailingActivationPct}%) | callback=${trailingDistancePct}% | order=${trailingOrder.id}`);
      
      return true; // Success - trailing stop placed successfully
      
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      
      if (errorMsg.includes('Invalid orderType') || errorMsg.includes('not supported')) {
        logger.warn(`⚠️ [${symbol}] TRAILING_STOP_MARKET not supported, falling back to STOP_MARKET`);
      } else {
        logger.warn(`⚠️ [${symbol}] Failed to set trailing stop: ${errorMsg}`);
      }
      
      // 🔧 FIX: CRITICAL - Fallback to STOP_MARKET when trailing fails
      // Without this, the position would have NO PROTECTION after cancelAllOrdersOnExchange()
      logger.warn(`🛡️ [${symbol}] FALLBACK: Re-placing STOP_MARKET as protection since trailing failed`);
      
      try {
        // Calculate a dynamic SL based on current profit
        // If widening (>2% profit), use a tighter SL at +1% profit
        // Otherwise, use the original SL
        if (this.position?.stopLoss) {
          await this.setStopLossOnExchange(this.position, false);
          logger.info(`🛡️ [${symbol}] FALLBACK STOP_MARKET placed at $${this.position.stopLoss.toFixed(4)}`);
        } else {
          // Calculate emergency SL at -2% from entry
          const emergencySL = position.side === 'long'
            ? position.entryPrice * (1 - 0.02)
            : position.entryPrice * (1 + 0.02);
          
          if (this.position) {
            this.position.stopLoss = emergencySL;
            await this.setStopLossOnExchange(this.position, false);
            logger.warn(`🛡️ [${symbol}] EMERGENCY STOP_MARKET placed at $${emergencySL.toFixed(4)}`);
          }
        }
      } catch (fallbackError: any) {
        // This is CRITICAL - log prominently
        logger.error(`🚨🚨🚨 [${symbol}] CRITICAL: Both trailing AND fallback SL failed! Position UNPROTECTED!`, fallbackError.message);
        
        // Send notification for critical error
        notifyOrderError({
          symbol,
          side: position.side,
          orderType: 'stop_loss', // Using stop_loss type as it's the closest match
          error: `Trailing failed AND fallback SL failed: ${fallbackError.message}`,
          mode: 'live',
        });
        return false; // Fallback failed - indicate failure
      }
      
      return false; // Fallback used - keep fixed SL as protection
    }
  }
  
  /**
   * Update trailing stop on exchange when price moves favorably
   * NOTE: With native TRAILING_STOP_MARKET, this is only used as a fallback
   */
  private async updateTrailingStopOnExchange(newStopPrice: number): Promise<void> {
    if (this.config.mode === 'paper') return;
    if (!this.position) return;

    // App-side trailing mode: do NOT update exchange stop. This avoids wick/mark-price stop-outs.
    // Emergency STOP_MARKET remains in place for crash protection.
    if (!MomentumConfig.EXIT.USE_EXCHANGE_TRAILING) {
      return;
    }
    
    // If we have a native trailing order, Binance handles everything - no manual update needed
    if (this.position.trailingOrderId) {
      // Just log for monitoring, Binance manages the trailing automatically
      logger.debug(`📊 [${this.config.symbol}] Native trailing active, Binance managing stop`);
      return;
    }
    
    const symbol = this.config.symbol;
    const oldSL = this.position.stopLoss;
    
    // Only update if the new stop is better (higher for long, lower for short)
    if (this.position.side === 'long' && newStopPrice <= (oldSL || 0)) return;
    if (this.position.side === 'short' && newStopPrice >= (oldSL || Infinity)) return;
    
    // Update position with new SL
    this.position.stopLoss = newStopPrice;
    
    // Update on exchange
    await this.setStopLossOnExchange(this.position, true);
    
    logger.info(`📈 [${symbol}] Trailing stop moved: $${oldSL?.toFixed(4)} → $${newStopPrice.toFixed(4)}`);
  }

  /**
   * Profit-protection stop (exchange-side) with ~2% buffer.
   * Starts only after +2% PnL, then ratchets in 1% steps:
   * - +2% → stop @ breakeven
   * - +3% → stop @ +1%
   * - +4% → stop @ +2%
   * This protects against crashes while avoiding most wick/mark noise.
   */
  private async updateEmergencyStopProfitProtectionIfNeeded(currentPrice: number, pnlPct: number): Promise<void> {
    if (this.config.mode !== 'live') return;
    if (!this.position) return;
    if (!this.position.entryPrice) return;
    if (!this.position.stopLoss) return; // emergency stop should always exist in live

    const startAt = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_START_PCT ?? 2.0;
    const distance = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_DISTANCE_PCT ?? 2.0;
    const step = MomentumConfig.EXIT.EMERGENCY_PROFIT_LOCK_STEP_PCT ?? 1.0;

    if (pnlPct < startAt) return;

    // Lock profit in steps such that lockedProfitPct = floor(pnl - distance)
    // Example: pnl=3.2, distance=2 → lock=1% (stop @ +1% profit)
    const rawLock = pnlPct - distance;
    const lockedProfitPct = Math.max(0, Math.floor(rawLock / step) * step);

    const entry = this.position.entryPrice;
    const desiredStop = this.position.side === 'long'
      ? entry * (1 + lockedProfitPct / 100)
      : entry * (1 - lockedProfitPct / 100);

    // Safety: avoid placing an immediately-triggering stop
    if (this.position.side === 'long' && desiredStop >= currentPrice) return;
    if (this.position.side === 'short' && desiredStop <= currentPrice) return;

    // Only ratchet in the favorable direction
    const currentStop = this.position.stopLoss;
    const isImprovement = this.position.side === 'long'
      ? desiredStop > currentStop
      : desiredStop < currentStop;
    if (!isImprovement) return;

    // Apply + update on exchange
    this.position.stopLoss = desiredStop;
    this.position.emergencyStopPrice = desiredStop;
    await this.setStopLossOnExchange(this.position, true);

    logger.info(
      `🧷 [${this.config.symbol}] Profit-protection stop ratcheted: pnl=${pnlPct.toFixed(2)}% | locked=+${lockedProfitPct.toFixed(0)}% | stop=$${desiredStop.toFixed(4)} (≈${distance}% buffer)`
    );
  }

  /**
   * 🎯 Layer 3: Progressive Profit Lock
   * DÉSACTIVÉ: Dégrade les performances en coupant les gagnants trop tôt (-85% ROI in backtest)
   */
  private async updateProfitLockIfNeeded(currentPrice: number): Promise<void> {
    // DISABLED: Profit lock cuts winners too early
    return;
  }
  
  // ==========================================================================
  // DATABASE HELPERS
  // ==========================================================================
  
  private async loadExistingPosition(): Promise<void> {
    try {
      const dbPosition = await this.config.prisma.position.findFirst({
        where: {
          sessionId: this.config.sessionId,
          symbol: this.config.symbol,
        },
      });
      
      if (dbPosition && dbPosition.entryPrice && dbPosition.qty) {
        // Calculate margin from notional / leverage
        const notional = dbPosition.qty * dbPosition.entryPrice;
        const leverage = dbPosition.leverage || MomentumConfig.LEVERAGE[this.config.symbol] || 4.5;
        const marginUsd = notional / leverage;
        
        this.position = {
          symbol: dbPosition.symbol,
          side: (dbPosition.side as 'long' | 'short') || 'long',
          entryPrice: dbPosition.entryPrice,
          qty: dbPosition.qty,
          entryTime: dbPosition.openedAt?.getTime() || Date.now(),
          stopLoss: dbPosition.stopPrice || undefined,
          orderId: dbPosition.slOrderId || undefined,
          leverage: leverage,
          marginUsd: marginUsd,
          highWaterMark: dbPosition.side === 'long' ? dbPosition.entryPrice : undefined,
          lowWaterMark: dbPosition.side === 'short' ? dbPosition.entryPrice : undefined,
        };
        
        // ⚠️ CRITICAL: Register margin in CapitalPool to prevent double-spending!
        // This is essential for live mode where exchange balance includes locked margin
        this.config.capitalPool.commit(this.config.sessionId, marginUsd);
        
        logger.info(`📥 [${this.config.symbol}] Loaded existing position: ${this.position?.side} @ $${this.position?.entryPrice} | margin=$${marginUsd.toFixed(2)} registered in pool`);
      }
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to load position:`, error);
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
    
    // Track if this is the first sync (for REST fallback logic)
    const isFirstSync = (this.lastPositionSync === 0);
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
        logger.info(`🔴 [${symbol}] SYNC MISMATCH: Position closed on exchange (likely stop loss hit)`);
        
        // Try to get the last trade to find exit price and orderId
        let exitPrice = this.position.entryPrice;
        let exchangeOrderId: string | undefined;
        let orderType: string | undefined;
        
        // 🔍 Determine exit reason based on order data from Binance
        let reason = 'stop_loss_exchange';
        
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
          if (!exchangeOrderId && this.config.exchange.fetchMyTrades) {
            const trades = await this.config.exchange.fetchMyTrades(symbol, Date.now() - 3600000, 10);
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = lastTrade.price || exitPrice;
              exchangeOrderId = lastTrade.order || lastTrade.info?.orderId;
              orderType = lastTrade.info?.type || lastTrade.type;
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
          reason = 'trailing_stop_exchange';
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderType=${orderType} (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 2: Check if orderId matches our tracked trailingOrderId
        else if (exchangeOrderId && this.position.trailingOrderId && exchangeOrderId === this.position.trailingOrderId) {
          reason = 'trailing_stop_exchange';
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via orderId match (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 3: If PnL > -1% and we had a trailing order active, assume trailing
        // (Trailing activates at +0.8%, so any exit with PnL > -1% is likely trailing)
        else if (pnlPct > -1 && this.position.trailingOrderId) {
          reason = 'trailing_stop_exchange';
          logger.info(`✅ [${symbol}] Detected TRAILING STOP exit via PnL heuristic (PnL: ${pnlPct.toFixed(2)}%)`);
        }
        // Priority 4: Fixed stop loss (significant loss or orderType is STOP_MARKET)
        else {
          reason = 'stop_loss_exchange';
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
        await this.saveExitToDb(this.position, exitPrice, reason, pnlPct, pnlUsd, exchangeOrderId, syncFeeUsd);
        
        logger.info(`✅ [${symbol}] Position synced: Exit @ $${exitPrice.toFixed(4)}, PnL: ${pnlPct.toFixed(2)}%, fee: $${syncFeeUsd.toFixed(2)}, margin released: $${marginToRelease.toFixed(2)}`);
        
        // V5.12: Cancel any remaining orders (trailing stop, backup SL) to avoid orphans
        // This is CRITICAL - when Binance trailing triggers, the STOP_MARKET remains!
        logger.info(`🧹 [${symbol}] Cleaning up orphan orders after position close...`);
        await this.cancelStopLossOnExchange();
        
        // Reset trailing flags
        this.trailingNotified = false;
        this.trailingWidened = false;
        
        this.position = null;
      }
      
      // Case 2: Exchange has position but we don't know about it
      else if (!this.position && exchangeQty > 0) {
        logger.info(`⚠️ [${symbol}] SYNC: Found unexpected position on exchange (${exchangeSide} ${exchangeQty})`);
        
        if (entryPrice > 0) {
          // 🔧 V5.29: Check if position exists in DB to preserve entryTime and maxPnlPct
          // This is critical for stagnant trade detection after restart
          let dbEntryTime: number | undefined;
          let dbMaxPnlPct: number | undefined;
          
          try {
            const dbPosition = await this.config.prisma.position.findFirst({
              where: {
                sessionId: this.config.sessionId,
                symbol: this.config.symbol,
                exitPrice: null, // Only open positions
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
      if (!this.config.exchange.fetchMyTrades) {
        return;
      }
      
      const since = Date.now() - 2 * 3600 * 1000; // Last 2 hours
      const binanceTrades = await this.config.exchange.fetchMyTrades(symbol, since, 50);
      
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
        let reason = 'stop_loss_exchange';
        
        if (orderType && orderType.includes('TRAILING')) {
          reason = 'trailing_stop_exchange';
        } else if (pnlPct > -1) {
          reason = 'trailing_stop_exchange';
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
      
    } catch (error: any) {
      logger.error(`❌ [${symbol}] Failed to reconcile trades:`, error.message);
    }
  }
  
  private async savePositionToDb(position: Position, action: string, entryFeeUsd?: number): Promise<void> {
    try {
      // First create an order for the entry (BUY for long, SELL for short)
      const isLive = this.config.mode === 'live';
      // For live mode, use the orderId from exchange if available, otherwise generate one
      const clientOrderId = position.orderId || `${isLive ? 'live' : 'paper'}_entry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const entrySide = position.side === 'long' ? 'buy' : 'sell';
      
      // Calculate entry fee if not provided (0.04% taker on notional)
      const entryNotionalUsd = position.qty * position.entryPrice;
      const calculatedFee = entryFeeUsd ?? (entryNotionalUsd * 0.0004);
      
      const order = await this.config.prisma.order.create({
        data: {
          clientOrderId,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: entrySide,
          type: 'market',
          qty: position.qty,
          price: position.entryPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
          leverage: position.leverage ?? MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] ?? 4,
        },
      });
      
      // Log entry as a Fill record linked to the order
      await this.config.prisma.fill.create({
        data: {
          orderId: order.id,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          price: position.entryPrice,
          qty: position.qty,
          side: entrySide,
          realizedPnl: 0, // No PnL on entry
          fee: calculatedFee,  // Store entry fee for accurate cost tracking
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(position.entryTime),
        },
      });
      
      logger.info(`💾 [${this.config.symbol}] Entry order logged: ${entrySide.toUpperCase()} @ $${position.entryPrice.toFixed(4)}, fee: $${calculatedFee.toFixed(2)}`);
      
      // Then create the position record
      await this.config.prisma.position.create({
        data: {
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entryPrice,
          qty: position.qty,
          leverage: MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] || 3,
          stopPrice: position.stopLoss,
          openedAt: new Date(position.entryTime),
        },
      });
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to save position to DB:`, error);
    }
  }
  
  private async saveExitToDb(
    position: Position, 
    exitPrice: number, 
    reason: string,
    pnlPct: number,
    pnlUsd: number,
    exchangeOrderId?: string,  // Optional: real orderId from exchange (for live mode)
    feeUsd?: number  // Optional: actual fee from exchange or calculated
  ): Promise<void> {
    try {
      // Exit side is opposite of position side (SELL to close LONG, BUY to close SHORT)
      const exitSide = position.side === 'long' ? 'sell' : 'buy';
      const isLive = this.config.mode === 'live';
      
      // 🔧 FIX: Use exchange orderId if available (for synced exits), otherwise generate unique ID
      // Check if order already exists in DB to avoid duplicate clientOrderId constraint error
      let clientOrderId = exchangeOrderId || `${isLive ? 'live' : 'paper'}_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      if (exchangeOrderId) {
        const existing = await this.config.prisma.order.findFirst({ where: { clientOrderId: exchangeOrderId } });
        if (existing) {
          logger.warn(`⚠️ [${this.config.symbol}] Exit order ${exchangeOrderId} already exists in DB, skipping save`);
          return;
        }
      }
      
      // Calculate fee if not provided (0.04% taker fee on notional)
      const notionalUsd = position.qty * exitPrice;
      const calculatedFee = feeUsd ?? (notionalUsd * 0.0004); // 0.04% taker
      
      const order = await this.config.prisma.order.create({
        data: {
          clientOrderId,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: exitSide,
          type: 'market',
          qty: position.qty,
          price: exitPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
          leverage: position.leverage ?? MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] ?? 4,
          pctChange: pnlPct / 100, // Store as decimal (e.g., 0.015 for 1.5%)
        },
      });
      
      // Log exit as a Fill record linked to the order (using order.id, not clientOrderId)
      const fill = await this.config.prisma.fill.create({
        data: {
          orderId: order.id,  // Use the generated Order ID
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          price: exitPrice,
          qty: position.qty,
          side: exitSide,
          realizedPnl: pnlUsd,
          fee: calculatedFee,  // Store fee for accurate PnL tracking
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(),
          // V5.11: Add exit metadata for detailed trade analysis
          exitReason: reason.toUpperCase(),  // TRAIL, SL, TIME, SIGNAL, MANUAL
          entryTs: new Date(position.entryTime),  // For duration calculation
          maxPnlPct: position.maxPnlPct ?? null,  // High water mark reached
        },
      });
      
      // 🆕 V5.14: Create Trade record for direct DB persistence (no more dynamic aggregation)
      try {
        const entryTs = new Date(position.entryTime);
        const exitTs = fill.ts;
        const durationMs = exitTs.getTime() - entryTs.getTime();
        const durationMinutes = Math.max(0, Math.round(durationMs / 60000));
        const entryNotional = position.entryPrice * position.qty;
        const priceChange = position.side === 'long'
          ? exitPrice - position.entryPrice
          : position.entryPrice - exitPrice;
        const pctChange = (priceChange / position.entryPrice) * 100;
        const roiPct = entryNotional > 0 ? (pnlUsd / entryNotional) * 100 : 0;
        const leverage = position.leverage ?? MomentumConfig.LEVERAGE[position.symbol as keyof typeof MomentumConfig.LEVERAGE] ?? 4;
        const roePct = roiPct * leverage;

        await this.config.prisma.trade.create({
          data: {
            id: order.id,  // Use exitOrderId as tradeId
            sessionId: this.config.sessionId,
            symbol: position.symbol,
            positionSide: position.side,
            qty: position.qty,
            entryPrice: position.entryPrice,
            exitPrice,
            entryNotional,
            realizedPnlUsd: pnlUsd,
            feesUsd: calculatedFee * 2,  // Approximate entry + exit fees (both 0.04%)
            pctChange,
            roiPct,
            leverage,
            roePct,
            orderCount: 2,  // Entry + exit
            exitReason: reason.toUpperCase(),
            durationMinutes,
            maxPnlPct: position.maxPnlPct ?? null,
            entryTs,
            exitTs,
          },
        });

        // Link Fill to Trade
        await this.config.prisma.fill.update({
          where: { id: fill.id },
          data: { tradeId: order.id },
        });

        logger.info(`✅ [${this.config.symbol}] Trade created: ${position.side.toUpperCase()} ${position.qty} PnL=$${pnlUsd.toFixed(2)}`);
      } catch (tradeError) {
        logger.error(`❌ [${this.config.symbol}] Failed to create Trade:`, tradeError);
        // Continue anyway - Fill was saved, Trade is optional for now
      }
      
      // Delete the position (it's closed)
      await this.config.prisma.position.deleteMany({
        where: {
          sessionId: this.config.sessionId,
          symbol: position.symbol,
        },
      });
      
      // Update SessionKpi with new performance metrics
      await this.updateSessionKpi(pnlUsd, pnlPct);
      
      logger.info(`💾 [${this.config.symbol}] Exit logged: ${reason}, PnL: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%), Fee: $${calculatedFee.toFixed(2)}`);
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to save exit to DB:`, error);
    }
  }
  
  /**
   * Update SessionKpi after each trade exit
   * Calculates: realizedPnlUsd, winRate, expectancy, maxDrawdownPct, etc.
   */
  private async updateSessionKpi(tradePnlUsd: number, tradePnlPct: number): Promise<void> {
    try {
      const sessionId = this.config.sessionId;
      
      // Aggregate all fills with realized PnL for this session
      const fills = await this.config.prisma.fill.findMany({
        where: { 
          sessionId,
          realizedPnl: { not: null }
        },
        orderBy: { ts: 'asc' }
      });
      
      // Calculate metrics from fills
      const exitFills = fills.filter(f => f.realizedPnl !== null && f.realizedPnl !== 0);
      const tradeCount = exitFills.length;
      const wins = exitFills.filter(f => (f.realizedPnl || 0) > 0).length;
      const losses = exitFills.filter(f => (f.realizedPnl || 0) < 0).length;
      
      const totalRealizedPnl = exitFills.reduce((sum, f) => sum + (f.realizedPnl || 0), 0);
      const totalFees = fills.reduce((sum, f) => sum + (f.fee || 0), 0);
      const netRealizedPnl = totalRealizedPnl - totalFees;
      
      const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
      
      // Calculate expectancy (average PnL per trade)
      const expectancy = tradeCount > 0 ? netRealizedPnl / tradeCount : 0;
      
      // Calculate max drawdown from cumulative PnL
      let peak = 0;
      let cumulative = 0;
      let maxDrawdown = 0;
      
      for (const fill of exitFills) {
        cumulative += (fill.realizedPnl || 0);
        if (cumulative > peak) peak = cumulative;
        const drawdown = peak > 0 ? (cumulative - peak) / peak * 100 : 0;
        if (drawdown < maxDrawdown) maxDrawdown = drawdown;
      }
      
      // Get session start balance for ROI calculation
      const session = await this.config.prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { startBalanceUsd: true }
      });
      const startBalance = session?.startBalanceUsd || 1000; // Default 1000 if not set
      const roiPct = startBalance > 0 ? (netRealizedPnl / startBalance) * 100 : 0;
      
      // Get current unrealized PnL from open position
      let unrealizedPnlUsd = 0;
      if (this.position && this.lastPrice) {
        if (this.position.side === 'long') {
          unrealizedPnlUsd = this.position.qty * (this.lastPrice - this.position.entryPrice);
        } else {
          unrealizedPnlUsd = this.position.qty * (this.position.entryPrice - this.lastPrice);
        }
      }
      
      // Build stats JSON
      const stats = {
        trades: tradeCount,
        wins,
        losses,
        totalFees,
        netRealizedPnl,
        lastTradeAt: new Date().toISOString(),
        avgWinUsd: wins > 0 ? exitFills.filter(f => (f.realizedPnl || 0) > 0).reduce((s, f) => s + (f.realizedPnl || 0), 0) / wins : 0,
        avgLossUsd: losses > 0 ? exitFills.filter(f => (f.realizedPnl || 0) < 0).reduce((s, f) => s + (f.realizedPnl || 0), 0) / losses : 0,
      };
      
      // Upsert SessionKpi
      await this.config.prisma.sessionKpi.upsert({
        where: { sessionId },
        update: {
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
          lastUpdated: new Date(),
        },
        create: {
          sessionId,
          realizedPnlUsd: netRealizedPnl,
          unrealizedPnlUsd,
          roiPct,
          winRate,
          expectancy,
          maxDrawdownPct: Math.abs(maxDrawdown),
          stats,
        },
      });
      
      logger.info(`📊 [${this.config.symbol}] KPI updated: ${tradeCount} trades, ${winRate.toFixed(1)}% WR, $${netRealizedPnl.toFixed(2)} PnL, ${roiPct.toFixed(2)}% ROI`);
      
    } catch (error) {
      logger.error(`❌ [${this.config.symbol}] Failed to update SessionKpi:`, error);
    }
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
      
      posWithMetrics = {
        ...this.position,
        // Add entry as alias for frontend compatibility (PositionInfoCard expects 'entry')
        entry: this.position.entryPrice,
        // Add leverage for frontend display
        leverage: MomentumConfig.LEVERAGE[this.position.symbol] || 5,
        // Add openedAt for frontend time-held calculation
        openedAt: this.position.entryTime,
        // Add stopPrice as alias for frontend compatibility
        stopPrice: this.position.stopLoss,
        stop: this.position.stopLoss,
        // Add targets from lastSignal
        targets: this.lastSignal?.targets || [],
        currentPrice,
        pnlPct,
        pnlUsd,
        notionalUsd,
        duration,
        trailDistance,
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
