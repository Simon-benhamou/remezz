/**
 * Order Reconciliation Service
 * 
 * Ensures 100% accuracy between exchange orders and application database.
 * Critical for live trading to prevent:
 * - Duplicate stop-loss/take-profit orders
 * - Orphaned orders after position closes
 * - Missed fills due to stale order tracking
 * 
 * This service periodically syncs with the exchange and updates the database.
 */

import { prisma } from '../db/client.js';
import type { Broker } from '../broker/types.js';

export interface OrderReconciliationResult {
  sessionId: string;
  symbol: string;
  synchronized: boolean;
  issues: string[];
  actions: string[];
  slOrderId?: string | null;
  tpOrderId?: string | null;
}

class OrderReconciliationService {
  /**
   * Reconcile position orders with exchange
   * Returns true if everything is synchronized
   */
  async reconcilePosition(
    sessionId: string,
    broker: Broker
  ): Promise<OrderReconciliationResult> {
    const result: OrderReconciliationResult = {
      sessionId,
      symbol: '',
      synchronized: true,
      issues: [],
      actions: [],
    };

    try {
      // Get position from database (source of truth)
      const dbPosition = await prisma.position.findFirst({
        where: { sessionId },
      });

      if (!dbPosition) {
        result.actions.push('no_position_in_db');
        return result;
      }

      result.symbol = dbPosition.symbol;

      // Skip if not live mode
      const session = await prisma.agentSession.findUnique({
        where: { id: sessionId },
        select: { mode: true },
      });

      if (session?.mode !== 'live') {
        result.actions.push('skip_paper_mode');
        return result;
      }

      // Sync protective orders with exchange
      if (broker.syncProtective && dbPosition.qty && dbPosition.qty > 0) {
        try {
          const syncResult = await broker.syncProtective({
            symbol: dbPosition.symbol,
            side: dbPosition.side as 'buy' | 'sell',
            qty: dbPosition.qty,
            stopLoss: dbPosition.stopPrice ?? undefined,
            takeProfit: this.extractTakeProfitLevels(dbPosition.takeProfit),
            slOrderId: dbPosition.slOrderId ?? undefined,
            tpOrderId: dbPosition.tpOrderId ?? undefined,
          });

          if (syncResult) {
            const slChanged = syncResult.slOrderId !== dbPosition.slOrderId;
            const tpChanged = syncResult.tpOrderId !== dbPosition.tpOrderId;

            if (slChanged || tpChanged) {
              result.synchronized = false;
              result.actions.push('updated_protective_order_ids');

              // Update database with new order IDs
              await prisma.position.update({
                where: { id: dbPosition.id },
                data: {
                  slOrderId: syncResult.slOrderId ?? null,
                  tpOrderId: syncResult.tpOrderId ?? null,
                  lastProtectiveSyncAt: new Date(),
                  protectiveStatus: 'synced',
                  updatedAt: new Date(),
                },
              });

              result.slOrderId = syncResult.slOrderId ?? null;
              result.tpOrderId = syncResult.tpOrderId ?? null;
            } else {
              result.actions.push('protective_orders_in_sync');
              
              // Update last sync time even if no changes
              await prisma.position.update({
                where: { id: dbPosition.id },
                data: {
                  lastProtectiveSyncAt: new Date(),
                  protectiveStatus: 'verified',
                },
              });
            }
          }
        } catch (error) {
          result.synchronized = false;
          result.issues.push(`sync_protective_failed: ${(error as Error).message}`);
        }
      } else {
        result.actions.push('no_position_qty_or_broker_no_sync');
      }

      // Check for stale protective sync (>5 minutes without update)
      if (dbPosition.lastProtectiveSyncAt) {
        const minutesSinceSync = (Date.now() - dbPosition.lastProtectiveSyncAt.getTime()) / 60000;
        if (minutesSinceSync > 5) {
          result.issues.push(`stale_protective_sync: ${minutesSinceSync.toFixed(1)}min`);
        }
      }

      return result;
    } catch (error) {
      result.synchronized = false;
      result.issues.push(`reconciliation_error: ${(error as Error).message}`);
      return result;
    }
  }

  /**
   * Periodic reconciliation for all active positions
   */
  async reconcileAllActiveSessions(getBrokerForSession: (session: { id: string; userId: string | null; mode: string }) => Promise<Broker | null>): Promise<void> {
    try {
      // Get all active sessions with positions
      const activeSessions = await prisma.agentSession.findMany({
        where: {
          stoppedAt: null,
          mode: 'live',
          positions: {
            some: {
              qty: {
                gt: 0,
              },
            },
          },
        },
        include: {
          positions: {
            where: {
              qty: {
                gt: 0,
              },
            },
          },
        },
      });

      console.log(`[OrderReconciliation] Reconciling ${activeSessions.length} active sessions`);

      for (const session of activeSessions) {
        try {
          const broker = await getBrokerForSession({ id: session.id, userId: session.userId, mode: session.mode });
          if (!broker) {
            console.warn(`[OrderReconciliation] No broker for session ${session.id}`);
            continue;
          }

          const result = await this.reconcilePosition(session.id, broker);
          
          if (!result.synchronized) {
            console.warn(
              `[OrderReconciliation] Session ${session.id} (${result.symbol}): ${result.issues.join(', ')}`,
            );
          }

          if (result.actions.length > 0) {
            console.log(
              `[OrderReconciliation] Session ${session.id} (${result.symbol}): ${result.actions.join(', ')}`,
            );
          }
        } catch (error) {
          console.error(`[OrderReconciliation] Error reconciling session ${session.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[OrderReconciliation] Error in reconcileAllActiveSessions:', error);
    }
  }

  /**
   * Extract take profit levels from database JSON
   */
  private extractTakeProfitLevels(tpJson: any): number[] | undefined {
    if (!tpJson) return undefined;
    
    try {
      if (Array.isArray(tpJson)) {
        return tpJson.filter(v => typeof v === 'number' && Number.isFinite(v));
      }
      
      if (typeof tpJson === 'object') {
        const levels = tpJson.levels || tpJson.targets || [];
        if (Array.isArray(levels)) {
          return levels.filter(v => typeof v === 'number' && Number.isFinite(v));
        }
      }
      
      if (typeof tpJson === 'number' && Number.isFinite(tpJson)) {
        return [tpJson];
      }
    } catch (error) {
      console.error('[OrderReconciliation] Error extracting TP levels:', error);
    }
    
    return undefined;
  }

  /**
   * Clean up orphaned protective orders (when position closed but orders remain)
   */
  async cleanupOrphanedOrders(
    sessionId: string,
    broker: Broker,
    symbol: string
  ): Promise<{ cancelled: number }> {
    let cancelled = 0;

    try {
      // Check if position exists
      const position = await prisma.position.findFirst({
        where: { sessionId },
      });

      if (!position || !position.qty || position.qty <= 0) {
        // Position closed or doesn't exist, cancel any protective orders
        if (broker.syncProtective) {
          await broker.syncProtective({
            symbol,
            side: 'buy', // Doesn't matter, we're just cancelling
            qty: 0, // Zero qty signals to cancel all
            slOrderId: position?.slOrderId ?? undefined,
            tpOrderId: position?.tpOrderId ?? undefined,
          });

          if (position?.slOrderId) cancelled++;
          if (position?.tpOrderId) cancelled++;

          // Clear order IDs from database
          if (position) {
            await prisma.position.update({
              where: { id: position.id },
              data: {
                slOrderId: null,
                tpOrderId: null,
                lastProtectiveSyncAt: new Date(),
                protectiveStatus: 'cleaned',
              },
            });
          }
        }
      }
    } catch (error) {
      console.error(`[OrderReconciliation] Error cleaning orphaned orders for ${sessionId}:`, error);
    }

    return { cancelled };
  }
}

// Singleton instance
export const orderReconciliationService = new OrderReconciliationService();
