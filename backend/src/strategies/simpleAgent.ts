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
  type Candle,
  type Position,
  type MarketConditions,
} from './momentumSimple.js';

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
  cancelAllOrders?: (symbol: string) => Promise<any>;
};

// ============================================================================
// CAPITAL POOL - Shared between all agents
// ============================================================================

export class CapitalPool {
  private totalCapitalUsd: number;
  private reservedByAgent: Map<string, number> = new Map();
  private inPositionByAgent: Map<string, number> = new Map();
  
  constructor(initialCapitalUsd: number) {
    this.totalCapitalUsd = initialCapitalUsd;
  }
  
  /**
   * Get available capital for new positions
   */
  getAvailableCapital(): number {
    let reserved = 0;
    let inPosition = 0;
    this.reservedByAgent.forEach(v => reserved += v);
    this.inPositionByAgent.forEach(v => inPosition += v);
    return Math.max(0, this.totalCapitalUsd - reserved - inPosition);
  }
  
  /**
   * Reserve capital for a potential trade
   */
  reserve(agentId: string, amountUsd: number): boolean {
    const available = this.getAvailableCapital();
    if (amountUsd > available) {
      console.log(`[CapitalPool] Cannot reserve $${amountUsd} for ${agentId}, only $${available} available`);
      return false;
    }
    
    const current = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, current + amountUsd);
    console.log(`[CapitalPool] Reserved $${amountUsd} for ${agentId}`);
    return true;
  }
  
  /**
   * Commit reserved capital to a position
   */
  commit(agentId: string, amountUsd: number): void {
    // Move from reserved to in-position
    const reserved = this.reservedByAgent.get(agentId) || 0;
    this.reservedByAgent.set(agentId, Math.max(0, reserved - amountUsd));
    
    const inPos = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, inPos + amountUsd);
    console.log(`[CapitalPool] Committed $${amountUsd} for ${agentId}`);
  }
  
  /**
   * Release capital when position is closed
   */
  release(agentId: string, amountUsd: number, pnlUsd: number = 0): void {
    const inPos = this.inPositionByAgent.get(agentId) || 0;
    this.inPositionByAgent.set(agentId, Math.max(0, inPos - amountUsd));
    
    // Add PnL to total capital
    this.totalCapitalUsd += pnlUsd;
    console.log(`[CapitalPool] Released $${amountUsd} for ${agentId}, PnL: $${pnlUsd.toFixed(2)}, Total: $${this.totalCapitalUsd.toFixed(2)}`);
  }
  
  /**
   * Cancel a reservation
   */
  cancelReservation(agentId: string): void {
    this.reservedByAgent.delete(agentId);
  }
  
  /**
   * Get pool status
   */
  getStatus(): {
    totalUsd: number;
    availableUsd: number;
    reservedUsd: number;
    inPositionsUsd: number;
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
      byAgent,
    };
  }
  
  /**
   * Set total capital (used when user updates paper balance)
   */
  setTotalCapital(newTotalUsd: number): void {
    this.totalCapitalUsd = newTotalUsd;
    console.log(`[CapitalPool] Total capital set to $${newTotalUsd}`);
  }
}

// Per-user capital pools (not a global singleton anymore)
const userCapitalPools = new Map<string, CapitalPool>();

export function getCapitalPool(userId: string, initialCapital?: number): CapitalPool | null {
  if (!userId) return null;
  
  let pool = userCapitalPools.get(userId);
  if (!pool && initialCapital !== undefined) {
    pool = new CapitalPool(initialCapital);
    userCapitalPools.set(userId, pool);
  }
  return pool || null;
}

export function resetCapitalPool(userId: string, initialCapital: number, _mode?: 'paper' | 'live'): CapitalPool {
  const pool = new CapitalPool(initialCapital);
  userCapitalPools.set(userId, pool);
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
  private running = false;
  private tickIntervalId: NodeJS.Timeout | null = null;
  private lastMarketConditions: MarketConditions | null = null;
  private tickCount: number = 0;
  private lastTickAt: number = 0;
  private lastPrice: number = 0;
  
  // Current trading state for frontend display
  private currentBias: 'long' | 'short' | null = null;
  private lastSignal: {
    entryZone?: [number, number];
    stopDistance?: number;
    targets?: number[];
    targetPcts?: number[];
  } | null = null;
  private lastExit: { ts: number; price: number; reason: string } | null = null;
  
  // Cache pour éviter trop d'appels API
  private candleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private btcCandleCache: { candles: Candle[]; fetchedAt: number } | null = null;
  private readonly CACHE_TTL_MS = 60_000; // 1 minute
  
  constructor(config: SimpleAgentConfig) {
    this.config = config;
  }
  
  // ==========================================================================
  // LIFECYCLE
  // ==========================================================================
  
  async start(): Promise<void> {
    if (this.running) {
      console.log(`[SimpleAgent:${this.config.symbol}] Already running`);
      return;
    }
    
    this.running = true;
    console.log(`[SimpleAgent:${this.config.symbol}] ✅ Started`);
    console.log(`  Mode: ${this.config.mode}`);
    console.log(`  Symbol: ${this.config.symbol}`);
    console.log(`  Risk/trade: ${this.config.riskPerTradePct}%`);
    console.log(`  Capital Pool: $${this.config.capitalPool.getAvailableCapital().toFixed(2)} available`);
    
    // Charger les positions existantes depuis la DB
    await this.loadExistingPosition();
    
    // 🔄 LIVE MODE: Initial sync with exchange to catch any missed stop losses
    if (this.config.mode === 'live') {
      console.log(`[SimpleAgent:${this.config.symbol}] 🔄 Initial exchange sync...`);
      await this.syncWithExchange();
    }
    
    // Tick toutes les minutes
    this.tickIntervalId = setInterval(() => this.tick(), 60_000);
    
    // Premier tick immédiat
    await this.tick();
  }
  
  async stop(): Promise<void> {
    this.running = false;
    
    if (this.tickIntervalId) {
      clearInterval(this.tickIntervalId);
      this.tickIntervalId = null;
    }
    
    console.log(`[SimpleAgent:${this.config.symbol}] ⏹️ Stopped`);
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
    
    const now = new Date();
    const symbol = this.config.symbol;
    this.tickCount = (this.tickCount || 0) + 1;
    this.lastTickAt = Date.now();
    
    // Log every tick to confirm agent is alive
    const hasPosition = this.position ? `📊 IN ${this.position.side.toUpperCase()} @ $${this.position.entryPrice.toFixed(2)}` : '👀 Watching';
    console.log(`[SimpleAgent:${symbol}] 🔄 Tick #${this.tickCount} | ${hasPosition} | ${now.toISOString()}`);
    
    try {
      // 🔄 LIVE MODE: Sync with exchange first to detect stop loss executions
      if (this.config.mode === 'live') {
        await this.syncWithExchange();
      }
      
      // Fetch BTC candles for market conditions
      const btcCandles = await this.fetchBtcCandles();
      
      // Update and broadcast market conditions
      this.lastMarketConditions = getMarketConditions(btcCandles);
      this.config.onMarketConditions?.(this.lastMarketConditions);
      
      // Fetch current candles for price and S/R
      const candles = await this.fetchCandles();
      const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : this.lastPrice;
      this.lastPrice = currentPrice;
      
      // Calculate basic S/R from recent highs/lows
      const recentHigh = Math.max(...candles.slice(-20).map(c => c.high));
      const recentLow = Math.min(...candles.slice(-20).map(c => c.low));
      
      // 🔔 Broadcast tick to frontend via callback
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
        await this.checkExit(this.position);
        return; // Don't look for new entries while in position
      }
      
      // 2. Sinon, chercher une entrée
      await this.checkEntry();
      
    } catch (error) {
      console.error(`[SimpleAgent:${symbol}] Tick error:`, error);
      this.config.onError?.(error as Error);
    }
  }
  
  // ==========================================================================
  // ENTRY LOGIC
  // ==========================================================================
  
  private async checkEntry(): Promise<void> {
    const symbol = this.config.symbol;
    
    try {
      // Fetch candles pour le symbol
      const candles = await this.fetchCandles();
      if (candles.length < 60) {
        console.log(`[SimpleAgent:${symbol}] Not enough candles (${candles.length})`);
        return;
      }
      
      // Store last price for frontend
      const currentPrice = candles[candles.length - 1].close;
      this.lastPrice = currentPrice;
      
      // Fetch BTC candles pour corrélation
      const btcCandles = await this.fetchBtcCandles();
      
      // Check signal (returns side: 'long' or 'short')
      const signal = checkMomentumSignal(symbol, candles, btcCandles);
      
      if (signal.valid && signal.side) {
        console.log(`[SimpleAgent:${symbol}] ✅ SIGNAL ${signal.side.toUpperCase()}: ${signal.reason}`);
        
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
        
        // Execute trade
        await this.openPosition(signal.side, candles);
      }
      
    } catch (error) {
      console.error(`[SimpleAgent:${symbol}] Error checking entry:`, error);
    }
  }
  
  private async openPosition(side: 'long' | 'short', candles: Candle[]): Promise<void> {
    const symbol = this.config.symbol;
    const lastCandle = candles[candles.length - 1];
    const currentPrice = lastCandle.close;
    
    // Get available capital from pool
    const availableCapital = this.config.capitalPool.getAvailableCapital();
    
    // Calculate position size
    const sizing = calculatePositionSize({
      symbol,
      currentPrice,
      totalCapitalUsd: availableCapital,
      riskPerTradePct: this.config.riskPerTradePct,
      stopLossPct: MomentumConfig.EXIT.STOP_LOSS_PCT,
    });
    
    // Try to reserve capital
    if (!this.config.capitalPool.reserve(this.config.sessionId, sizing.notionalUsd)) {
      console.log(`[SimpleAgent:${symbol}] Cannot open position - insufficient capital`);
      return;
    }
    
    console.log(`[SimpleAgent:${symbol}] Opening ${side.toUpperCase()} position:`);
    console.log(`  Price: $${currentPrice.toFixed(4)}`);
    console.log(`  Qty: ${sizing.qty}`);
    console.log(`  Notional: $${sizing.notionalUsd.toFixed(2)}`);
    console.log(`  Leverage: ${sizing.suggestedLeverage}x`);
    
    if (this.config.mode === 'paper') {
      // Paper trade
      const position: Position = {
        symbol,
        side,
        entryPrice: currentPrice,
        qty: sizing.qty,
        entryTime: Date.now(),
        stopLoss: side === 'long' 
          ? currentPrice * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100)
          : currentPrice * (1 + MomentumConfig.EXIT.STOP_LOSS_PCT / 100),
        highWaterMark: side === 'long' ? currentPrice : undefined,
        lowWaterMark: side === 'short' ? currentPrice : undefined,
      };
      
      this.position = position;
      
      // Commit capital
      this.config.capitalPool.commit(this.config.sessionId, sizing.notionalUsd);
      
      // Save to DB
      await this.savePositionToDb(position, 'paper_entry');
      
      console.log(`[SimpleAgent:${symbol}] 📝 Paper ${side} position opened`);
      
    } else {
      // Live trade
      try {
        // Set leverage
        await this.config.exchange.setLeverage(sizing.suggestedLeverage, symbol);
        
        // Place market order
        const order = side === 'long'
          ? await this.config.exchange.createMarketBuyOrder(symbol, sizing.qty, { reduceOnly: false })
          : await this.config.exchange.createMarketSellOrder(symbol, sizing.qty, { reduceOnly: false });
        
        const filledPrice = order.average || order.price || currentPrice;
        const filledQty = order.filled || sizing.qty;
        
        const position: Position = {
          symbol,
          side,
          entryPrice: filledPrice,
          qty: filledQty,
          entryTime: Date.now(),
          stopLoss: side === 'long'
            ? filledPrice * (1 - MomentumConfig.EXIT.STOP_LOSS_PCT / 100)
            : filledPrice * (1 + MomentumConfig.EXIT.STOP_LOSS_PCT / 100),
          orderId: order.id,
          highWaterMark: side === 'long' ? filledPrice : undefined,
          lowWaterMark: side === 'short' ? filledPrice : undefined,
        };
        
        this.position = position;
        
        // Commit capital
        this.config.capitalPool.commit(this.config.sessionId, sizing.notionalUsd);
        
        // Save to DB
        await this.savePositionToDb(position, 'live_entry');
        
        // Set stop loss on exchange
        await this.setStopLossOnExchange(position);
        
        console.log(`[SimpleAgent:${symbol}] 🟢 Live ${side} position opened @ $${filledPrice}`);
        
        this.config.onTrade?.({
          symbol,
          side: side === 'long' ? 'buy' : 'sell',
          qty: filledQty,
          price: filledPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error) {
        console.error(`[SimpleAgent:${symbol}] Failed to open live position:`, error);
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
      const candles = await this.fetchCandles();
      if (candles.length === 0) return;
      
      const currentPrice = candles[candles.length - 1].close;
      this.lastPrice = currentPrice;
      
      // Update water marks for trailing stop
      this.position = updatePositionWaterMarks(position, currentPrice);
      
      // Log position status every tick when in position
      const pnlPct = position.side === 'long'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
      console.log(`[SimpleAgent:${symbol}] 📊 Position: ${position.side.toUpperCase()} | Entry: $${position.entryPrice.toFixed(2)} | Now: $${currentPrice.toFixed(2)} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% | SL: $${this.position?.stopLoss?.toFixed(2) || 'N/A'}`);
      
      const exitSignal = shouldExitPosition(this.position!, currentPrice);
      
      if (exitSignal.shouldExit) {
        console.log(`[SimpleAgent:${symbol}] 🔴 EXIT (${exitSignal.reason}): PnL ${exitSignal.pnlPct?.toFixed(2)}%`);
        await this.closePosition(this.position!, currentPrice, exitSignal.reason || 'unknown');
      } else if (exitSignal.newStopLoss) {
        // Update trailing stop in DB if needed
        console.log(`[SimpleAgent:${symbol}] 📈 Trailing stop updated: $${exitSignal.newStopLoss.toFixed(4)}`);
      }
      
    } catch (error) {
      console.error(`[SimpleAgent:${symbol}] Error checking exit:`, error);
    }
  }
  
  private async closePosition(
    position: Position, 
    currentPrice: number,
    reason: string
  ): Promise<void> {
    const symbol = this.config.symbol;
    
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
    
    console.log(`[SimpleAgent:${symbol}] Closing ${position.side} position:`);
    console.log(`  Entry: $${position.entryPrice.toFixed(4)}`);
    console.log(`  Exit: $${currentPrice.toFixed(4)}`);
    console.log(`  PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% ($${pnlUsd.toFixed(2)})`);
    console.log(`  Reason: ${reason}`);
    
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
      
      // Release capital with PnL
      this.config.capitalPool.release(this.config.sessionId, notionalUsd, pnlUsd);
      
      await this.saveExitToDb(position, currentPrice, reason, pnlPct, pnlUsd);
      console.log(`[SimpleAgent:${symbol}] 📝 Paper position closed`);
      
    } else {
      // Live close
      try {
        const closeSide = position.side === 'long' ? 'sell' : 'buy';
        const order = position.side === 'long'
          ? await this.config.exchange.createMarketSellOrder(symbol, position.qty, { reduceOnly: true })
          : await this.config.exchange.createMarketBuyOrder(symbol, position.qty, { reduceOnly: true });
        
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
        
        // Release capital with PnL
        this.config.capitalPool.release(this.config.sessionId, notionalUsd, actualPnlUsd);
        
        await this.saveExitToDb(position, exitPrice, reason, actualPnlPct, actualPnlUsd);
        
        console.log(`[SimpleAgent:${symbol}] 🔴 Live position closed @ $${exitPrice}`);
        
        this.config.onTrade?.({
          symbol,
          side: closeSide,
          qty: position.qty,
          price: exitPrice,
          orderId: order.id,
          timestamp: new Date(),
        });
        
      } catch (error) {
        console.error(`[SimpleAgent:${symbol}] Failed to close live position:`, error);
      }
    }
  }
  
  // ==========================================================================
  // EXCHANGE HELPERS
  // ==========================================================================
  
  private async fetchCandles(): Promise<Candle[]> {
    const symbol = this.config.symbol;
    
    if (this.candleCache && Date.now() - this.candleCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.candleCache.candles;
    }
    
    try {
      const ohlcv = await this.config.exchange.fetchOHLCV(symbol, '15m', undefined, 100);
      
      const candles: Candle[] = ohlcv.map(c => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
      
      this.candleCache = { candles, fetchedAt: Date.now() };
      
      return candles;
      
    } catch (error) {
      console.error(`[SimpleAgent:${symbol}] Failed to fetch candles:`, error);
      return this.candleCache?.candles || [];
    }
  }
  
  private async fetchBtcCandles(): Promise<Candle[]> {
    if (this.btcCandleCache && Date.now() - this.btcCandleCache.fetchedAt < this.CACHE_TTL_MS) {
      return this.btcCandleCache.candles;
    }
    
    const btcSymbol = 'BTC/USDT:USDT';
    
    try {
      const ohlcv = await this.config.exchange.fetchOHLCV(btcSymbol, '15m', undefined, 100);
      
      const candles: Candle[] = ohlcv.map(c => ({
        timestamp: c[0] as number,
        open: c[1] as number,
        high: c[2] as number,
        low: c[3] as number,
        close: c[4] as number,
        volume: c[5] as number,
      }));
      
      this.btcCandleCache = { candles, fetchedAt: Date.now() };
      
      return candles;
      
    } catch (error) {
      console.error('[SimpleAgent] Failed to fetch BTC candles:', error);
      return this.btcCandleCache?.candles || [];
    }
  }
  
  private async setStopLossOnExchange(position: Position): Promise<void> {
    if (!position.stopLoss) return;
    
    const symbol = this.config.symbol;
    const side = position.side === 'long' ? 'sell' : 'buy';
    
    try {
      await this.config.exchange.createOrder(
        symbol,
        'market',
        side,
        position.qty,
        undefined,
        {
          stopPrice: position.stopLoss,
          triggerPrice: position.stopLoss,
          reduceOnly: true,
        }
      );
      console.log(`[SimpleAgent:${symbol}] Stop loss set at $${position.stopLoss.toFixed(4)}`);
    } catch (error) {
      console.warn(`[SimpleAgent:${symbol}] Failed to set stop loss on exchange:`, error);
    }
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
        this.position = {
          symbol: dbPosition.symbol,
          side: (dbPosition.side as 'long' | 'short') || 'long',
          entryPrice: dbPosition.entryPrice,
          qty: dbPosition.qty,
          entryTime: dbPosition.openedAt?.getTime() || Date.now(),
          stopLoss: dbPosition.stopPrice || undefined,
          orderId: dbPosition.slOrderId || undefined,
          highWaterMark: dbPosition.side === 'long' ? dbPosition.entryPrice : undefined,
          lowWaterMark: dbPosition.side === 'short' ? dbPosition.entryPrice : undefined,
        };
        
        console.log(`[SimpleAgent:${this.config.symbol}] Loaded existing position`);
      }
      
    } catch (error) {
      console.error(`[SimpleAgent:${this.config.symbol}] Failed to load position:`, error);
    }
  }
  
  /**
   * 🔄 SYNC WITH EXCHANGE (Live Mode Only)
   * Fetches real positions from Binance and detects if stop losses were executed
   */
  private async syncWithExchange(): Promise<void> {
    const symbol = this.config.symbol;
    
    if (!this.config.exchange.fetchPositions) {
      console.log(`[SimpleAgent:${symbol}] ⚠️ Exchange does not support fetchPositions`);
      return;
    }
    
    try {
      // Fetch all positions from exchange
      const exchangePositions = await this.config.exchange.fetchPositions([symbol]);
      
      // Find position for our symbol
      const exchangePos = exchangePositions.find((p: any) => 
        p.symbol === symbol || 
        p.info?.symbol === symbol.replace('/', '').replace(':USDT', '')
      );
      
      const exchangeQty = Math.abs(parseFloat(exchangePos?.contracts || exchangePos?.info?.positionAmt || '0'));
      const exchangeSide = parseFloat(exchangePos?.info?.positionAmt || '0') > 0 ? 'long' : 'short';
      
      // Case 1: We think we have a position but exchange says NO
      if (this.position && exchangeQty === 0) {
        console.log(`[SimpleAgent:${symbol}] 🔴 SYNC MISMATCH: Position closed on exchange (likely stop loss hit)`);
        
        // Try to get the last trade to find exit price
        let exitPrice = this.position.entryPrice;
        let reason = 'stop_loss_exchange';
        
        try {
          if (this.config.exchange.fetchMyTrades) {
            const trades = await this.config.exchange.fetchMyTrades(symbol, Date.now() - 3600000, 10);
            if (trades && trades.length > 0) {
              const lastTrade = trades[trades.length - 1];
              exitPrice = lastTrade.price || exitPrice;
              console.log(`[SimpleAgent:${symbol}] Found exit trade: $${exitPrice}`);
            }
          }
        } catch (tradeError) {
          console.warn(`[SimpleAgent:${symbol}] Could not fetch trades:`, tradeError);
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
        
        const notionalUsd = this.position.qty * this.position.entryPrice;
        
        // Release capital
        this.config.capitalPool.release(this.config.sessionId, notionalUsd, pnlUsd);
        
        // Save exit to DB
        await this.saveExitToDb(this.position, exitPrice, reason, pnlPct, pnlUsd);
        
        console.log(`[SimpleAgent:${symbol}] ✅ Position synced: Exit @ $${exitPrice.toFixed(4)}, PnL: ${pnlPct.toFixed(2)}%`);
        
        this.position = null;
      }
      
      // Case 2: Exchange has position but we don't know about it
      else if (!this.position && exchangeQty > 0) {
        console.log(`[SimpleAgent:${symbol}] ⚠️ SYNC: Found unexpected position on exchange`);
        
        // Load from exchange
        const entryPrice = parseFloat(exchangePos?.entryPrice || exchangePos?.info?.entryPrice || '0');
        
        if (entryPrice > 0) {
          this.position = {
            symbol,
            side: exchangeSide,
            entryPrice,
            qty: exchangeQty,
            entryTime: Date.now(),
            highWaterMark: exchangeSide === 'long' ? entryPrice : undefined,
            lowWaterMark: exchangeSide === 'short' ? entryPrice : undefined,
          };
          
          // Commit capital for this position
          const notionalUsd = exchangeQty * entryPrice;
          this.config.capitalPool.commit(this.config.sessionId, notionalUsd);
          
          // Save to DB
          await this.savePositionToDb(this.position, 'synced_from_exchange');
          
          console.log(`[SimpleAgent:${symbol}] ✅ Position synced from exchange: ${exchangeSide} @ $${entryPrice}`);
        }
      }
      
      // Case 3: Both have position - verify they match
      else if (this.position && exchangeQty > 0) {
        // Just log for now, could add reconciliation logic
        const entryPrice = parseFloat(exchangePos?.entryPrice || exchangePos?.info?.entryPrice || '0');
        const unrealizedPnl = parseFloat(exchangePos?.unrealizedPnl || exchangePos?.info?.unRealizedProfit || '0');
        
        console.log(`[SimpleAgent:${symbol}] ✅ Position verified on exchange: ${exchangeQty} @ $${entryPrice}, uPnL: $${unrealizedPnl.toFixed(2)}`);
      }
      
    } catch (error) {
      console.error(`[SimpleAgent:${symbol}] Failed to sync with exchange:`, error);
    }
  }
  
  private async savePositionToDb(position: Position, action: string): Promise<void> {
    try {
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
      console.error(`[SimpleAgent:${this.config.symbol}] Failed to save position to DB:`, error);
    }
  }
  
  private async saveExitToDb(
    position: Position, 
    exitPrice: number, 
    reason: string,
    pnlPct: number,
    pnlUsd: number
  ): Promise<void> {
    try {
      // First create an order for the exit
      const clientOrderId = `paper_exit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const order = await this.config.prisma.order.create({
        data: {
          clientOrderId,
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          side: 'sell',
          type: 'market',
          qty: position.qty,
          price: exitPrice,
          status: 'filled',
          source: 'simple_agent',
          strategyUsed: 'momentum_simple',
        },
      });
      
      // Log exit as a Fill record linked to the order (using order.id, not clientOrderId)
      await this.config.prisma.fill.create({
        data: {
          orderId: order.id,  // Use the generated Order ID
          sessionId: this.config.sessionId,
          symbol: position.symbol,
          price: exitPrice,
          qty: position.qty,
          side: 'sell',
          realizedPnl: pnlUsd,
          strategyUsed: 'momentum_simple',
          strategyFamily: 'momentum',
          ts: new Date(),
        },
      });
      
      // Delete the position (it's closed)
      await this.config.prisma.position.deleteMany({
        where: {
          sessionId: this.config.sessionId,
          symbol: position.symbol,
        },
      });
      
      console.log(`[SimpleAgent:${this.config.symbol}] Exit logged: ${reason}, PnL: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
      
    } catch (error) {
      console.error(`[SimpleAgent:${this.config.symbol}] Failed to save exit to DB:`, error);
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
    let posWithMetrics: (Position & { 
      currentPrice: number;
      pnlPct: number;
      pnlUsd: number;
      notionalUsd: number;
      duration: number;
      trailDistance: number;
    }) | null = null;
    
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
