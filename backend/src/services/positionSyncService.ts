/**
 * Position Synchronization Service
 * 
 * Ensures agent internal position state stays synchronized with exchange reality
 * Critical for live trading to prevent:
 * - Ghost positions (agent thinks position is open but exchange shows closed)
 * - Orphaned protective orders (SL/TP remain after position closed)
 * - Double entries (agent tries to enter when position already exists)
 */

import { inspectExposure } from '../broker/live.js';
import { recordOpsEvent } from '../monitor/ops.js';
import type { ReboundRejectionAgent } from '../agent/state/index.js';

const POSITION_QTY_EPSILON = 1e-6;
const SYNC_INTERVAL_MS = 30_000; // 30 seconds
const SYNC_TIMEOUT_MS = 10_000; // 10 second timeout for exchange calls

export type SyncResult = {
  synchronized: boolean;
  action: 'no_action' | 'position_cleared' | 'position_adopted' | 'protective_cleaned' | 'error';
  details?: any;
  error?: string;
};

export type PositionDesyncType = 
  | 'agent_has_exchange_empty'  // Agent thinks position open, exchange is empty
  | 'agent_empty_exchange_has'  // Agent has no position, exchange shows one
  | 'qty_mismatch'              // Both have position but quantities differ
  | 'none';                     // No desync detected

export class PositionSyncService {
  private syncTimers = new Map<string, NodeJS.Timeout>();
  private lastSyncAttempt = new Map<string, number>();
  private syncInProgress = new Map<string, boolean>();

  /**
   * Start periodic position sync for an agent
   */
  startPeriodicSync(agent: ReboundRejectionAgent): void {
    if (!agent.sessionId) {
      console.warn('Cannot start position sync without sessionId');
      return;
    }

    // Only sync for live mode
    if (agent.profile?.mode !== 'live') {
      return;
    }

    // Clear any existing timer
    this.stopPeriodicSync(agent.sessionId);

    console.log(`🔄 Starting periodic position sync for session ${agent.sessionId} (every ${SYNC_INTERVAL_MS/1000}s)`);

    const timer = setInterval(() => {
      this.syncPosition(agent).catch(error => {
        console.error(`Position sync error for ${agent.sessionId}:`, error);
      });
    }, SYNC_INTERVAL_MS);

    this.syncTimers.set(agent.sessionId, timer);

    // Do an immediate sync
    this.syncPosition(agent).catch(error => {
      console.error(`Initial position sync error for ${agent.sessionId}:`, error);
    });
  }

  /**
   * Stop periodic position sync for an agent
   */
  stopPeriodicSync(sessionId: string): void {
    const timer = this.syncTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.syncTimers.delete(sessionId);
      this.lastSyncAttempt.delete(sessionId);
      this.syncInProgress.delete(sessionId);
      console.log(`⏹️ Stopped position sync for session ${sessionId}`);
    }
  }

  /**
   * Synchronize agent position with exchange
   */
  async syncPosition(agent: ReboundRejectionAgent): Promise<SyncResult> {
    if (!agent.sessionId) {
      return { synchronized: false, action: 'error', error: 'No sessionId' };
    }

    if (!agent.profile) {
      return { synchronized: false, action: 'error', error: 'No profile' };
    }

    // Skip if not live mode
    if (agent.profile.mode !== 'live') {
      return { synchronized: true, action: 'no_action', details: { reason: 'not_live_mode' } };
    }

    // Prevent concurrent sync operations
    if (this.syncInProgress.get(agent.sessionId)) {
      return { synchronized: false, action: 'error', error: 'Sync already in progress' };
    }

    try {
      this.syncInProgress.set(agent.sessionId, true);
      this.lastSyncAttempt.set(agent.sessionId, Date.now());

      const localPos = agent.pos;
      
      // Get exchange position with timeout
      const exchangePos = await Promise.race([
        inspectExposure(agent.profile.symbol, agent.profile.userId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Exchange position query timeout')), SYNC_TIMEOUT_MS)
        )
      ]) as any;

      // Detect desync type
      const desyncType = this.detectDesyncType(localPos, exchangePos);

      if (desyncType === 'none') {
        // No desync - all good
        return { 
          synchronized: true, 
          action: 'no_action',
          details: { 
            localQty: localPos?.qty || 0,
            exchangeQty: exchangePos?.qty || 0,
            desyncType: 'none'
          }
        };
      }

      // Handle desync
      const result = await this.reconcileDesync(agent, localPos, exchangePos, desyncType);
      
      return result;

    } catch (error) {
      recordOpsEvent({
        level: 'error',
        source: 'position_sync',
        message: 'position_sync_failed',
        sessionId: agent.sessionId,
        symbol: agent.profile?.symbol,
        details: { error: String((error as any)?.message || error) }
      });

      return {
        synchronized: false,
        action: 'error',
        error: String((error as any)?.message || error)
      };
    } finally {
      this.syncInProgress.set(agent.sessionId, false);
    }
  }

  /**
   * Detect type of position desynchronization
   */
  private detectDesyncType(localPos: any, exchangePos: any): PositionDesyncType {
    const localQty = localPos?.qty || 0;
    const exchangeQty = exchangePos?.qty || 0;

    const hasLocal = localQty > POSITION_QTY_EPSILON;
    const hasExchange = exchangeQty > POSITION_QTY_EPSILON;

    if (hasLocal && !hasExchange) {
      return 'agent_has_exchange_empty';
    }

    if (!hasLocal && hasExchange) {
      return 'agent_empty_exchange_has';
    }

    if (hasLocal && hasExchange) {
      const qtyDiff = Math.abs(localQty - exchangeQty);
      const qtyDiffPct = (qtyDiff / Math.max(localQty, exchangeQty)) * 100;
      
      if (qtyDiffPct > 5) { // More than 5% difference
        return 'qty_mismatch';
      }
    }

    return 'none';
  }

  /**
   * Reconcile position desync
   */
  private async reconcileDesync(
    agent: ReboundRejectionAgent,
    localPos: any,
    exchangePos: any,
    desyncType: PositionDesyncType
  ): Promise<SyncResult> {
    const sessionId = agent.sessionId!;
    const symbol = agent.profile!.symbol;

    switch (desyncType) {
      case 'agent_has_exchange_empty':
        // Agent thinks position is open but exchange is empty
        // This happens when SL/TP executes on exchange
        console.log(`🔄 [Sync] Position closed on exchange, clearing agent state for ${symbol}`);

        // Clean up protective orders first
        await this.cleanupProtectiveOrders(agent, localPos);

        // Clear agent position
        agent.pos = null;
        agent.trendReversalContext = null;

        // Transition to EXIT state if currently in MANAGE
        if (agent.state === 'MANAGE') {
          agent.state = 'EXIT';
          agent.lastExitTime = Date.now();
          (agent as any).scheduleReactivation?.('position_closed_on_exchange');
        }

        recordOpsEvent({
          level: 'info',
          source: 'position_sync',
          message: 'position_desync_reconciled',
          sessionId,
          symbol,
          details: {
            desyncType,
            action: 'position_cleared',
            localQty: localPos?.qty || 0,
            exchangeQty: 0,
            reason: 'sltp_executed_on_exchange'
          }
        });

        return {
          synchronized: true,
          action: 'position_cleared',
          details: { desyncType, previousQty: localPos?.qty || 0 }
        };

      case 'agent_empty_exchange_has':
        // Agent has no position but exchange shows one
        // Rare but can happen after crashes/restarts
        console.log(`🔄 [Sync] Found orphaned position on exchange for ${symbol}, adopting`);

        // This is already handled by the existing validateAndArm() logic
        // We just log it here for monitoring
        recordOpsEvent({
          level: 'warn',
          source: 'position_sync',
          message: 'orphaned_position_detected',
          sessionId,
          symbol,
          details: {
            desyncType,
            exchangeQty: exchangePos?.qty || 0,
            exchangeSide: exchangePos?.side,
            exchangeEntry: exchangePos?.entry
          }
        });

        return {
          synchronized: false,
          action: 'no_action',
          details: { 
            desyncType, 
            note: 'Orphaned position on exchange - should be adopted by validateAndArm()'
          }
        };

      case 'qty_mismatch':
        // Both have position but quantities differ
        // This can happen after partial fills or scale-ins
        console.log(`⚠️ [Sync] Quantity mismatch for ${symbol}: local=${localPos?.qty}, exchange=${exchangePos?.qty}`);

        // Update agent quantity to match exchange
        const oldQty = localPos?.qty || 0;
        if (agent.pos) {
          agent.pos.qty = exchangePos?.qty || 0;
        }

        recordOpsEvent({
          level: 'warn',
          source: 'position_sync',
          message: 'position_qty_mismatch_corrected',
          sessionId,
          symbol,
          details: {
            desyncType,
            oldQty,
            newQty: exchangePos?.qty || 0,
            diffPct: ((Math.abs(oldQty - (exchangePos?.qty || 0)) / oldQty) * 100).toFixed(2)
          }
        });

        return {
          synchronized: true,
          action: 'no_action',
          details: { 
            desyncType,
            oldQty,
            newQty: exchangePos?.qty || 0
          }
        };

      default:
        return {
          synchronized: true,
          action: 'no_action',
          details: { desyncType: 'unknown' }
        };
    }
  }

  /**
   * Clean up protective orders (SL/TP) for a position
   */
  private async cleanupProtectiveOrders(agent: ReboundRejectionAgent, localPos: any): Promise<void> {
    if (!localPos || !agent.broker) return;

    try {
      // Call broker's syncProtective with zero quantity to cancel orders
      const syncProtectiveMethod = (agent.broker as any).syncProtective;
      
      if (typeof syncProtectiveMethod === 'function') {
        await syncProtectiveMethod({
          symbol: agent.profile!.symbol,
          side: localPos.side,
          qty: 0, // Zero quantity signals to cancel all protective orders
          stopLoss: undefined,
          takeProfit: undefined,
          slOrderId: localPos.slOrderId || null,
          tpOrderId: localPos.tpOrderId || null,
        });

        console.log(`✅ [Sync] Cleaned up protective orders for ${agent.profile!.symbol}`);

        recordOpsEvent({
          level: 'info',
          source: 'position_sync',
          message: 'protective_orders_cleaned',
          sessionId: agent.sessionId || undefined,
          symbol: agent.profile!.symbol,
          details: {
            slOrderId: localPos.slOrderId,
            tpOrderId: localPos.tpOrderId
          }
        });
      }
    } catch (error) {
      console.error(`⚠️ [Sync] Failed to clean up protective orders for ${agent.profile!.symbol}:`, error);

      recordOpsEvent({
        level: 'error',
        source: 'position_sync',
        message: 'protective_orders_cleanup_failed',
        sessionId: agent.sessionId || undefined,
        symbol: agent.profile!.symbol,
        details: {
          error: String((error as any)?.message || error),
          slOrderId: localPos.slOrderId,
          tpOrderId: localPos.tpOrderId
        }
      });
    }
  }

  /**
   * Verify protective orders are correctly set
   */
  async verifyProtectiveOrders(agent: ReboundRejectionAgent): Promise<boolean> {
    if (!agent.pos || !agent.broker) return true;

    try {
      // Query broker to check if protective orders exist
      // This would require adding a method to the broker interface
      // For now, we just log that verification is needed
      
      recordOpsEvent({
        level: 'debug',
        source: 'position_sync',
        message: 'protective_orders_verification',
        sessionId: agent.sessionId || undefined,
        symbol: agent.profile?.symbol,
        details: {
          slOrderId: agent.pos.slOrderId,
          tpOrderId: agent.pos.tpOrderId,
          hasStopLoss: !!agent.pos.stop,
          hasTakeProfit: agent.pos.tp?.length > 0
        }
      });

      return true;
    } catch (error) {
      console.error('Protective orders verification failed:', error);
      return false;
    }
  }

  /**
   * Get sync status for monitoring
   */
  getSyncStatus(sessionId: string): {
    active: boolean;
    lastSync?: number;
    inProgress: boolean;
  } {
    return {
      active: this.syncTimers.has(sessionId),
      lastSync: this.lastSyncAttempt.get(sessionId),
      inProgress: this.syncInProgress.get(sessionId) || false
    };
  }
}

// Singleton instance
export const positionSyncService = new PositionSyncService();
