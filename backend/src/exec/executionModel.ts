/**
 * Execution Model Module
 * 
 * Provides sophisticated execution cost modeling and monitoring:
 * - Enhanced slippage estimation with volatility and volume considerations
 * - Realized PnL integration for accurate performance metrics
 * - Latency and fill quality tracking
 */

import { prisma } from '../db/client.js';
import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/preciseDecimal.js';
import { walkBook, BookWalkResult } from './bookWalkSlippage.js';
import type { DepthSnapshot } from '../data/depth.js';

/**
 * Execution model configuration
 */
export interface ExecutionModelConfig {
  // Slippage model parameters
  baseSlippageBps: number;              // Base slippage in basis points (default: 5)
  volatilityScalingFactor: number;      // How much volatility increases slippage (default: 2.0)
  volumeScalingFactor: number;          // How volume affects slippage (default: 1.5)
  maxSlippageBps: number;               // Cap for slippage estimate (default: 100)
  
  // Fill quality thresholds
  partialFillThreshold: number;         // % filled to consider partial (default: 0.95)
  slowFillThresholdMs: number;          // Latency threshold for slow fill (default: 5000)
  
  // Order book depth model
  useDepthModel: boolean;               // Use order book depth for slippage (default: true)
  depthLookbackLevels: number;          // How many levels to consider (default: 10)
}

/**
 * Default configuration
 */
export const DEFAULT_EXECUTION_CONFIG: ExecutionModelConfig = {
  baseSlippageBps: Number(process.env.EXEC_BASE_SLIPPAGE_BPS ?? '5'),
  volatilityScalingFactor: Number(process.env.EXEC_VOL_SCALING ?? '2.0'),
  volumeScalingFactor: Number(process.env.EXEC_VOLUME_SCALING ?? '1.5'),
  maxSlippageBps: Number(process.env.EXEC_MAX_SLIPPAGE_BPS ?? '100'),
  partialFillThreshold: Number(process.env.EXEC_PARTIAL_FILL_THRESHOLD ?? '0.95'),
  slowFillThresholdMs: Number(process.env.EXEC_SLOW_FILL_THRESHOLD_MS ?? '5000'),
  useDepthModel: process.env.EXEC_USE_DEPTH_MODEL !== 'false',
  depthLookbackLevels: Number(process.env.EXEC_DEPTH_LEVELS ?? '10'),
};

/**
 * Slippage estimation result
 */
export interface SlippageEstimate {
  slippageBps: number;
  method: 'simple' | 'volatility_adjusted' | 'depth_based';
  components: {
    base: number;
    volatilityAdjustment: number;
    volumeAdjustment: number;
    depthImpact?: number;
  };
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Fill quality metrics
 */
export interface FillQualityMetrics {
  fillRatio: number;                    // Actual filled / requested
  latencyMs: number;                    // Time from order to fill
  slippageBps: number;                  // Actual slippage vs expected price
  isPartialFill: boolean;
  isSlowFill: boolean;
  fillQualityScore: number;             // 0-100 score
}

/**
 * Realized PnL calculation result
 */
export interface RealizedPnLResult {
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  returnPct: number;
  entryNotional: number;
  exitNotional: number;
}

/**
 * Execution statistics for a session
 */
export interface ExecutionStats {
  totalOrders: number;
  successfulOrders: number;
  partialFills: number;
  slowFills: number;
  avgLatencyMs: number;
  avgSlippageBps: number;
  avgFillRatio: number;
  avgFillQualityScore: number;
  totalFees: number;
  totalSlippage: number;
  netPnl: number;
}

/**
 * Execution Model Manager
 */
export class ExecutionModel {
  constructor(
    private readonly config: ExecutionModelConfig = DEFAULT_EXECUTION_CONFIG
  ) {}

  /**
   * Estimate slippage using simple percentage model
   */
  private estimateSimpleSlippage(
    notionalUsd: number,
    spreadBps: number,
    recentSlippageBps?: number
  ): SlippageEstimate {
    const base = this.config.baseSlippageBps;
    const spreadComponent = spreadBps * 0.5; // Half the spread
    const recentComponent = recentSlippageBps ?? spreadBps;
    
    const slippageBps = Math.min(
      base + spreadComponent * 0.6 + recentComponent * 0.4,
      this.config.maxSlippageBps
    );

    return {
      slippageBps,
      method: 'simple',
      components: {
        base,
        volatilityAdjustment: 0,
        volumeAdjustment: 0,
      },
      confidence: 'low',
    };
  }

  /**
   * Estimate slippage with volatility and volume adjustments
   */
  estimateSlippageWithVolatility(params: {
    notionalUsd: number;
    spreadBps: number;
    volatilityPct: number;
    volume24hUsd: number;
    recentSlippageBps?: number;
  }): SlippageEstimate {
    const { notionalUsd, spreadBps, volatilityPct, volume24hUsd, recentSlippageBps } = params;

    // Base slippage
    const base = this.config.baseSlippageBps;

    // Volatility adjustment: higher volatility = more slippage
    const volAdjustment = (volatilityPct / 100) * this.config.volatilityScalingFactor * spreadBps;

    // Volume adjustment: lower volume relative to order size = more slippage
    const volumeRatio = volume24hUsd > 0 ? notionalUsd / volume24hUsd : 1;
    const volumeAdjustment = Math.min(
      volumeRatio * this.config.volumeScalingFactor * spreadBps,
      spreadBps * 2 // Cap volume impact
    );

    // Recent slippage component
    const recentComponent = (recentSlippageBps ?? spreadBps) * 0.3;

    const totalSlippage = base + volAdjustment + volumeAdjustment + recentComponent;
    const slippageBps = Math.min(totalSlippage, this.config.maxSlippageBps);

    // Determine confidence based on data availability
    let confidence: 'low' | 'medium' | 'high' = 'medium';
    if (volume24hUsd === 0 || !Number.isFinite(volatilityPct)) {
      confidence = 'low';
    } else if (recentSlippageBps !== undefined && volume24hUsd > notionalUsd * 1000) {
      confidence = 'high';
    }

    return {
      slippageBps,
      method: 'volatility_adjusted',
      components: {
        base,
        volatilityAdjustment: volAdjustment,
        volumeAdjustment: volumeAdjustment,
      },
      confidence,
    };
  }

  /**
   * Estimate slippage using order book depth model
   */
  estimateSlippageFromDepth(
    side: 'buy' | 'sell',
    qty: number,
    depth: DepthSnapshot | null | undefined,
    fallbackSpreadBps?: number
  ): SlippageEstimate {
    if (!this.config.useDepthModel || !depth) {
      // Fallback to simple model
      return this.estimateSimpleSlippage(
        qty * (depth?.bids?.[0]?.price ?? 0),
        fallbackSpreadBps ?? 10
      );
    }

    const walkResult = walkBook(side, qty, depth);
    
    if (walkResult.fallback || walkResult.impactBps === 0) {
      // Depth model failed, use fallback
      return this.estimateSimpleSlippage(
        qty * (walkResult.best || 0),
        fallbackSpreadBps ?? 10
      );
    }

    return {
      slippageBps: Math.min(walkResult.impactBps, this.config.maxSlippageBps),
      method: 'depth_based',
      components: {
        base: 0,
        volatilityAdjustment: 0,
        volumeAdjustment: 0,
        depthImpact: walkResult.impactBps,
      },
      confidence: 'high',
    };
  }

  /**
   * Calculate fill quality metrics for an order
   */
  calculateFillQuality(order: {
    qty: number;
    price: number;
    status: string;
    createdAt: Date;
    fills?: Array<{
      qty: number;
      price: number;
      executedAt?: Date | null;
      fee?: number | null;
    }>;
  }): FillQualityMetrics {
    const requestedQty = Math.abs(Number(order.qty));
    const fills = order.fills || [];

    // Calculate total filled quantity
    const totalFilled = fills.reduce((sum, f) => sum + Math.abs(Number(f.qty || 0)), 0);
    const fillRatio = requestedQty > 0 ? totalFilled / requestedQty : 0;

    // Calculate latency (use first fill time or fallback to creation time)
    const firstFill = fills.find(f => f.executedAt);
    const fillTime = firstFill?.executedAt || order.createdAt;
    const latencyMs = fillTime.getTime() - order.createdAt.getTime();

    // Calculate slippage (weighted average fill price vs order price)
    let weightedFillPrice = 0;
    let totalQty = 0;
    for (const fill of fills) {
      const qty = Math.abs(Number(fill.qty || 0));
      const price = Number(fill.price || 0);
      if (qty > 0 && price > 0) {
        weightedFillPrice += qty * price;
        totalQty += qty;
      }
    }
    const avgFillPrice = totalQty > 0 ? weightedFillPrice / totalQty : Number(order.price);
    const expectedPrice = Number(order.price);
    const slippageBps = expectedPrice > 0 
      ? Math.abs((avgFillPrice - expectedPrice) / expectedPrice) * 10000
      : 0;

    // Determine if partial or slow fill
    const isPartialFill = fillRatio < this.config.partialFillThreshold && fillRatio > 0;
    const isSlowFill = latencyMs > this.config.slowFillThresholdMs;

    // Calculate quality score (0-100)
    let qualityScore = 100;
    
    // Penalize partial fills
    if (isPartialFill) {
      qualityScore -= (1 - fillRatio) * 30; // Up to 30 points
    }
    
    // Penalize slow fills
    if (isSlowFill) {
      const slownessFactor = Math.min(latencyMs / this.config.slowFillThresholdMs - 1, 3);
      qualityScore -= slownessFactor * 20; // Up to 60 points for very slow
    }
    
    // Penalize high slippage
    if (slippageBps > 10) {
      qualityScore -= Math.min((slippageBps - 10) / 5, 20); // Up to 20 points
    }

    qualityScore = Math.max(0, Math.min(100, qualityScore));

    return {
      fillRatio,
      latencyMs,
      slippageBps,
      isPartialFill,
      isSlowFill,
      fillQualityScore: qualityScore,
    };
  }

  /**
   * Calculate realized PnL for a completed trade (entry + exit)
   */
  calculateRealizedPnL(
    entryOrder: {
      qty: number;
      price: number;
      fills?: Array<{ qty: number; price: number; fee?: number | null }>;
    },
    exitOrder: {
      qty: number;
      price: number;
      fills?: Array<{ qty: number; price: number; fee?: number | null }>;
    }
  ): RealizedPnLResult {
    const entryQty = Math.abs(Number(entryOrder.qty));
    const entryFills = entryOrder.fills || [];
    
    // Calculate entry weighted average price and fees
    let entryNotional = 0;
    let entryFees = 0;
    let totalEntryQty = 0;
    
    for (const fill of entryFills) {
      const qty = Math.abs(Number(fill.qty || 0));
      const price = Number(fill.price || 0);
      const fee = Math.abs(Number(fill.fee || 0));
      
      entryNotional += qty * price;
      entryFees += fee;
      totalEntryQty += qty;
    }
    
    const entryAvgPrice = totalEntryQty > 0 ? entryNotional / totalEntryQty : Number(entryOrder.price);
    
    // Calculate exit weighted average price and fees
    const exitFills = exitOrder.fills || [];
    let exitNotional = 0;
    let exitFees = 0;
    let totalExitQty = 0;
    
    for (const fill of exitFills) {
      const qty = Math.abs(Number(fill.qty || 0));
      const price = Number(fill.price || 0);
      const fee = Math.abs(Number(fill.fee || 0));
      
      exitNotional += qty * price;
      exitFees += fee;
      totalExitQty += qty;
    }
    
    const exitAvgPrice = totalExitQty > 0 ? exitNotional / totalExitQty : Number(exitOrder.price);
    
    // Calculate slippage costs
    const entrySlippage = Math.abs(entryAvgPrice - Number(entryOrder.price)) * totalEntryQty;
    const exitSlippage = Math.abs(exitAvgPrice - Number(exitOrder.price)) * totalExitQty;
    const totalSlippage = entrySlippage + exitSlippage;
    
    // Calculate gross PnL (price difference * quantity)
    const tradedQty = Math.min(totalEntryQty, totalExitQty);
    const grossPnl = (exitAvgPrice - entryAvgPrice) * tradedQty;
    
    // Calculate net PnL (gross - fees - slippage)
    const totalFees = entryFees + exitFees;
    const netPnl = grossPnl - totalFees - totalSlippage;
    
    // Calculate return percentage based on entry notional
    const returnPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

    return {
      grossPnl,
      fees: totalFees,
      slippage: totalSlippage,
      netPnl,
      returnPct,
      entryNotional,
      exitNotional,
    };
  }

  /**
   * Get execution statistics for a session
   */
  async getExecutionStats(sessionId: string, lookbackDays: number = 30): Promise<ExecutionStats> {
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - lookbackDays);

    const orders = await prisma.order.findMany({
      where: {
        sessionId,
        createdAt: { gte: lookbackDate },
        status: { in: ['closed', 'filled'] },
      },
      include: { fills: true },
      orderBy: { createdAt: 'desc' },
    });

    if (orders.length === 0) {
      return {
        totalOrders: 0,
        successfulOrders: 0,
        partialFills: 0,
        slowFills: 0,
        avgLatencyMs: 0,
        avgSlippageBps: 0,
        avgFillRatio: 0,
        avgFillQualityScore: 0,
        totalFees: 0,
        totalSlippage: 0,
        netPnl: 0,
      };
    }

    let successfulOrders = 0;
    let partialFills = 0;
    let slowFills = 0;
    let totalLatency = 0;
    let totalSlippageBps = 0;
    let totalFillRatio = 0;
    let totalQualityScore = 0;
    let totalFees = 0;
    let totalSlippage = 0;
    let netPnl = 0;

    for (const order of orders) {
      // Convert order to expected format for calculateFillQuality
      const orderForQuality = {
        qty: order.qty,
        price: Number(order.price || 0),
        status: order.status || 'unknown',
        createdAt: order.createdAt,
        fills: order.fills,
      };
      
      const quality = this.calculateFillQuality(orderForQuality);
      
      if (quality.fillRatio > 0) {
        successfulOrders++;
      }
      if (quality.isPartialFill) {
        partialFills++;
      }
      if (quality.isSlowFill) {
        slowFills++;
      }

      totalLatency += quality.latencyMs;
      totalSlippageBps += quality.slippageBps;
      totalFillRatio += quality.fillRatio;
      totalQualityScore += quality.fillQualityScore;

      // Sum up fees and realized PnL
      const fills = order.fills || [];
      for (const fill of fills) {
        const fee = Math.abs(Number(fill.fee || 0));
        const pnl = Number(fill.realizedPnl || 0);
        totalFees += fee;
        netPnl += pnl;
      }
    }

    const count = orders.length;

    return {
      totalOrders: count,
      successfulOrders,
      partialFills,
      slowFills,
      avgLatencyMs: count > 0 ? totalLatency / count : 0,
      avgSlippageBps: count > 0 ? totalSlippageBps / count : 0,
      avgFillRatio: count > 0 ? totalFillRatio / count : 0,
      avgFillQualityScore: count > 0 ? totalQualityScore / count : 0,
      totalFees,
      totalSlippage,
      netPnl,
    };
  }

  /**
   * Log fill quality metrics for monitoring
   */
  async logFillQuality(
    orderId: string,
    metrics: FillQualityMetrics
  ): Promise<void> {
    try {
      // Store metrics in order metadata or separate table
      // For now, we'll log to console and could extend to store in DB
      console.log(`Fill Quality [${orderId}]:`, {
        fillRatio: `${(metrics.fillRatio * 100).toFixed(1)}%`,
        latency: `${metrics.latencyMs}ms`,
        slippage: `${metrics.slippageBps.toFixed(2)}bps`,
        score: `${metrics.fillQualityScore.toFixed(0)}/100`,
        partial: metrics.isPartialFill,
        slow: metrics.isSlowFill,
      });

      // Could extend to:
      // await prisma.fillQualityLog.create({
      //   data: { orderId, ...metrics }
      // });
    } catch (error) {
      console.error('Error logging fill quality:', error);
    }
  }

  /**
   * Get comprehensive execution cost estimate
   */
  async estimateExecutionCosts(params: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    notionalUsd: number;
    spreadBps?: number;
    volatilityPct?: number;
    volume24hUsd?: number;
    depth?: DepthSnapshot;
    feeBps?: number;
  }): Promise<{
    slippage: SlippageEstimate;
    feesUsd: number;
    totalCostUsd: number;
    totalCostBps: number;
  }> {
    const { symbol, side, qty, notionalUsd, spreadBps, volatilityPct, volume24hUsd, depth, feeBps } = params;

    // Determine best slippage estimation method
    let slippage: SlippageEstimate;

    if (depth && this.config.useDepthModel) {
      // Use depth-based model if available
      slippage = this.estimateSlippageFromDepth(side, qty, depth, spreadBps);
    } else if (volatilityPct !== undefined && volume24hUsd !== undefined && spreadBps !== undefined) {
      // Use volatility-adjusted model
      slippage = this.estimateSlippageWithVolatility({
        notionalUsd,
        spreadBps,
        volatilityPct,
        volume24hUsd,
      });
    } else {
      // Fallback to simple model
      slippage = this.estimateSimpleSlippage(notionalUsd, spreadBps ?? 10);
    }

    // Calculate fees
    const effectiveFeeBps = feeBps ?? 10; // Default 10bps (0.1%)
    const feesUsd = (notionalUsd * effectiveFeeBps) / 10000;

    // Calculate slippage cost in USD
    const slippageUsd = (notionalUsd * slippage.slippageBps) / 10000;

    // Total cost
    const totalCostUsd = feesUsd + slippageUsd;
    const totalCostBps = (totalCostUsd / notionalUsd) * 10000;

    return {
      slippage,
      feesUsd,
      totalCostUsd,
      totalCostBps,
    };
  }
}
