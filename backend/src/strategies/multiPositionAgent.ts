/**
 * Multi-Position Agent Wrapper
 *
 * Extends SimpleAgent to support multiple positions per symbol.
 * This is a clean implementation that wraps the existing SimpleAgent
 * without modifying its core logic.
 *
 * Key Features:
 * - Manages multiple Position objects for the same symbol
 * - Each position has independent stops and trailing
 * - Staggered entries based on multi-position allocation plan
 * - Aggregated PnL and metrics across all positions
 */

import { SimpleAgent, type SimpleAgentConfig } from './simpleAgent.js';
import { calculateMultiPositionAllocation, DEFAULT_MULTI_POSITION_CONFIG, type MultiPositionConfig } from './multiPositionScaling.js';
import { type Position } from './momentumSimple.js';
import { getMultiPositionConfig } from '../config/multiPosition.js';

/**
 * Extended config for multi-position support
 */
export interface MultiPositionAgentConfig extends SimpleAgentConfig {
  enableMultiPosition?: boolean;
  multiPositionConfig?: MultiPositionConfig;
}

/**
 * Multi-Position Agent
 *
 * Manages multiple positions of the same symbol by wrapping SimpleAgent instances.
 * Each position is managed by its own SimpleAgent instance with independent stops.
 */
export class MultiPositionAgent {
  private config: MultiPositionAgentConfig;
  private agents: SimpleAgent[] = [];
  private groupId: string | null = null;
  private symbol: string;

  constructor(config: MultiPositionAgentConfig) {
    this.config = config;
    this.symbol = config.symbol;
  }

  /**
   * Check if we should use multi-position for this signal
   */
  private shouldUseMultiPosition(): boolean {
    if (!this.config.enableMultiPosition) return false;

    // Get capital from capital pool
    const capitalSnapshot = this.config.capitalPool.getTotalCapital();
    const totalCapital = parseFloat(capitalSnapshot.toString());

    // Get config for this symbol
    const multiConfig = this.config.multiPositionConfig || getMultiPositionConfig(this.symbol);

    // Only use multi-position if capital is above threshold
    return totalCapital >= multiConfig.minCapitalForMulti;
  }

  /**
   * Open positions (single or multi based on capital)
   */
  async openPositions(
    side: 'long' | 'short',
    currentPrice: number,
    signal: { reason?: string; confidence?: number }
  ): Promise<{ success: boolean; positionsOpened: number }> {
    const shouldMulti = this.shouldUseMultiPosition();

    if (!shouldMulti) {
      // Standard single position - use one SimpleAgent
      return this.openSinglePosition(side, currentPrice, signal);
    }

    // Multi-position logic
    return this.openMultiplePositions(side, currentPrice, signal);
  }

  /**
   * Open a single position (legacy behavior)
   */
  private async openSinglePosition(
    side: 'long' | 'short',
    currentPrice: number,
    signal: { reason?: string; confidence?: number }
  ): Promise<{ success: boolean; positionsOpened: number }> {
    // Create one SimpleAgent for this position
    const agent = new SimpleAgent(this.config);

    // Start the agent and let it handle the position
    await agent.start();

    this.agents.push(agent);
    this.groupId = `group_${Date.now()}_${this.symbol}`;

    console.log(`[MultiPositionAgent] Opened 1 position for ${this.symbol}`);

    return { success: true, positionsOpened: 1 };
  }

  /**
   * Open multiple staggered positions
   */
  private async openMultiplePositions(
    side: 'long' | 'short',
    currentPrice: number,
    signal: { reason?: string; confidence?: number }
  ): Promise<{ success: boolean; positionsOpened: number }> {
    // Get capital
    const capitalSnapshot = this.config.capitalPool.getTotalCapital();
    const totalCapital = parseFloat(capitalSnapshot.toString());

    // Calculate multi-position allocation
    const multiConfig = this.config.multiPositionConfig || getMultiPositionConfig(this.symbol);

    // Get position sizing percentage (adaptive)
    const positionSizePct = 0.55; // Simplified - in real impl, use MomentumConfig adaptive sizing

    const allocation = calculateMultiPositionAllocation(
      this.symbol,
      totalCapital,
      currentPrice,
      positionSizePct,
      5, // leverage - simplified
      multiConfig
    );

    if (allocation.totalPositions === 1) {
      // No benefit from multi-position, use single
      return this.openSinglePosition(side, currentPrice, signal);
    }

    this.groupId = `group_${Date.now()}_${this.symbol}`;

    console.log(`[MultiPositionAgent] Opening ${allocation.totalPositions} positions for ${this.symbol}:`);
    console.log(`   Total notional: $${allocation.totalNotionalUsd.toLocaleString()}`);
    console.log(`   Size per position: $${allocation.positionSizeUsd.toLocaleString()}`);
    console.log(`   Entry prices: ${allocation.entryPrices.map(p => p.toFixed(4)).join(', ')}`);
    console.log(`   Efficiency: ${(allocation.efficiency * 100).toFixed(1)}%`);

    // Open each position with staggered entry
    for (let i = 0; i < allocation.totalPositions; i++) {
      const entryPrice = allocation.entryPrices[i];

      // Create a SimpleAgent for this position
      // Note: In real implementation, we'd need to modify SimpleAgent to accept
      // a specific entry price target or use limit orders
      const agent = new SimpleAgent({
        ...this.config,
        // Could pass position-specific config here
      });

      await agent.start();
      this.agents.push(agent);

      // Add delay between position openings
      if (i < allocation.totalPositions - 1) {
        await this.sleep(multiConfig.entryDelayMs);
      }
    }

    console.log(`[MultiPositionAgent] Successfully opened ${allocation.totalPositions} positions`);

    return { success: true, positionsOpened: allocation.totalPositions };
  }

  /**
   * Get all active positions across all agents
   */
  getPositions(): Position[] {
    const positions: Position[] = [];

    for (const agent of this.agents) {
      // Note: SimpleAgent doesn't expose getPosition() publicly
      // In real implementation, we'd need to add this method or use a different approach
      // For now, this is a placeholder
    }

    return positions;
  }

  /**
   * Get aggregated metrics across all positions
   */
  getAggregatedMetrics(): {
    totalPositions: number;
    totalNotionalUsd: number;
    totalMarginUsd: number;
    aggregatedPnlUsd: number;
    aggregatedPnlPct: number;
  } {
    const positions = this.getPositions();

    const totalNotionalUsd = positions.reduce((sum, p) => {
      const notional = p.qty * p.entryPrice;
      return sum + notional;
    }, 0);

    const totalMarginUsd = positions.reduce((sum, p) => {
      return sum + (p.marginUsd || 0);
    }, 0);

    // Calculate aggregated PnL
    let aggregatedPnlUsd = 0;
    // Would calculate from actual positions

    const aggregatedPnlPct = totalMarginUsd > 0 ? (aggregatedPnlUsd / totalMarginUsd) * 100 : 0;

    return {
      totalPositions: positions.length,
      totalNotionalUsd,
      totalMarginUsd,
      aggregatedPnlUsd,
      aggregatedPnlPct,
    };
  }

  /**
   * Close all positions
   */
  async closeAllPositions(reason: string): Promise<void> {
    console.log(`[MultiPositionAgent] Closing all ${this.agents.length} positions: ${reason}`);

    for (const agent of this.agents) {
      await agent.stop();
    }

    this.agents = [];
    this.groupId = null;
  }

  /**
   * Stop all agents
   */
  async stop(): Promise<void> {
    for (const agent of this.agents) {
      await agent.stop();
    }

    this.agents = [];
  }

  /**
   * Utility: sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Check if agent has any active positions
   */
  hasPositions(): boolean {
    return this.agents.length > 0;
  }
}

/**
 * Factory function to create appropriate agent based on capital
 */
export function createAgent(config: MultiPositionAgentConfig): MultiPositionAgent | SimpleAgent {
  if (config.enableMultiPosition) {
    return new MultiPositionAgent(config);
  }

  // Standard SimpleAgent
  return new SimpleAgent(config);
}
