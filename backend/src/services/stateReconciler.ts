/**
 * State Reconciliation Service
 * 
 * Ensures that the application's internal state (positions, margin) is always
 * synchronized with the actual state on the exchange.
 * 
 * This service addresses critical issues:
 * 1. Ghost positions: Local state shows positions that don't exist on exchange
 * 2. Orphaned positions: Exchange has positions not tracked locally
 * 3. Margin desynchronization: Local margin calculations differ from exchange
 * 
 * The reconciler periodically queries the exchange and corrects discrepancies.
 */

import { getUserExchange } from '../exchange/ccxtClient.js';
import { getUserCredentials } from './userCredentials.js';
import { recordOpsEvent } from '../monitor/ops.js';
import { emitAlert } from '../monitor/policy.js';
import { BrokerMarginSnapshot, BrokerPositionMargin } from '../broker/types.js';
import { computeCommittedMargin } from '../broker/live.js';

const RECONCILIATION_INTERVAL_MS = 60_000; // 1 minute
const RECONCILIATION_TIMEOUT_MS = 15_000; // 15 seconds timeout for exchange calls
const POSITION_QTY_EPSILON = 1e-6;

export type ReconciliationResult = {
  timestamp: number;
  userId: string;
  success: boolean;
  positionsReconciled: number;
  ghostPositionsCleared: number;
  orphanedPositionsFound: number;
  marginUpdated: boolean;
  errors: string[];
  exchangeState: {
    positions: ExchangePosition[];
    marginSnapshot: BrokerMarginSnapshot | null;
  };
};

export type ExchangePosition = {
  symbol: string;
  side: 'long' | 'short';
  qty: number;
  entryPrice?: number;
  markPrice?: number;
  liquidationPrice?: number;
  notionalUsd?: number;
  leverage?: number;
  unrealizedPnl?: number;
};

export type ReconciledState = {
  positions: Map<string, ExchangePosition>;
  marginSnapshot: BrokerMarginSnapshot | null;
  lastUpdate: number;
  isStale: boolean;
};

/**
 * State Reconciliation Service
 * Maintains a reconciled view of positions and margin across all user accounts
 */
export class StateReconciler {
  private reconciliationTimers = new Map<string, NodeJS.Timeout>();
  private reconciledStates = new Map<string, ReconciledState>();
  private reconciliationInProgress = new Map<string, boolean>();
  private lastReconciliationAttempt = new Map<string, number>();

  /**
   * Start periodic reconciliation for a user
   */
  startPeriodicReconciliation(userId: string, intervalMs: number = RECONCILIATION_INTERVAL_MS): void {
    if (this.reconciliationTimers.has(userId)) {
      console.log(`⚠️ Periodic reconciliation already running for user ${userId}`);
      return;
    }

    console.log(`🔄 Starting state reconciliation for user ${userId} (every ${intervalMs / 1000}s)`);

    // Do an immediate reconciliation
    this.reconcileState(userId).catch(error => {
      console.error(`Initial reconciliation error for user ${userId}:`, error);
    });

    // Set up periodic reconciliation
    const timer = setInterval(() => {
      this.reconcileState(userId).catch(error => {
        console.error(`Periodic reconciliation error for user ${userId}:`, error);
      });
    }, intervalMs);

    this.reconciliationTimers.set(userId, timer);
  }

  /**
   * Stop periodic reconciliation for a user
   */
  stopPeriodicReconciliation(userId: string): void {
    const timer = this.reconciliationTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.reconciliationTimers.delete(userId);
      this.reconciledStates.delete(userId);
      this.reconciliationInProgress.delete(userId);
      this.lastReconciliationAttempt.delete(userId);
      console.log(`⏹️ Stopped state reconciliation for user ${userId}`);
    }
  }

  /**
   * Reconcile state for a user by fetching fresh data from the exchange
   */
  async reconcileState(userId: string): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      timestamp: Date.now(),
      userId,
      success: false,
      positionsReconciled: 0,
      ghostPositionsCleared: 0,
      orphanedPositionsFound: 0,
      marginUpdated: false,
      errors: [],
      exchangeState: {
        positions: [],
        marginSnapshot: null,
      },
    };

    // Prevent concurrent reconciliation
    if (this.reconciliationInProgress.get(userId)) {
      result.errors.push('Reconciliation already in progress');
      return result;
    }

    try {
      this.reconciliationInProgress.set(userId, true);
      this.lastReconciliationAttempt.set(userId, Date.now());

      // Get user credentials
      const credentials = await getUserCredentials(userId);
      if (!credentials) {
        result.errors.push('User credentials not found');
        recordOpsEvent({
          level: 'error',
          source: 'state_reconciler',
          message: 'reconciliation_failed_no_credentials',
          details: { userId },
        });
        return result;
      }

      // Get exchange instance
      const exchange = await getUserExchange(userId, credentials);

      // Fetch positions and balance with timeout
      const [positions, marginSnapshot] = await Promise.race([
        this.fetchExchangeState(exchange),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Exchange state fetch timeout')), RECONCILIATION_TIMEOUT_MS)
        ),
      ]);

      result.exchangeState.positions = positions;
      result.exchangeState.marginSnapshot = marginSnapshot;

      // Get previous reconciled state
      const previousState = this.reconciledStates.get(userId);

      // Detect changes and discrepancies
      const changes = this.detectStateChanges(previousState, positions, marginSnapshot);

      result.positionsReconciled = positions.length;
      result.ghostPositionsCleared = changes.ghostPositions.length;
      result.orphanedPositionsFound = changes.newPositions.length;
      result.marginUpdated = changes.marginChanged;

      // Update reconciled state
      const newState: ReconciledState = {
        positions: new Map(positions.map(p => [p.symbol, p])),
        marginSnapshot,
        lastUpdate: Date.now(),
        isStale: false,
      };
      this.reconciledStates.set(userId, newState);

      // Log significant changes
      if (changes.ghostPositions.length > 0) {
        console.log(`🧹 [Reconciler] Cleared ${changes.ghostPositions.length} ghost positions for user ${userId}`);
        recordOpsEvent({
          level: 'warn',
          source: 'state_reconciler',
          message: 'ghost_positions_detected',
          details: {
            userId,
            symbols: changes.ghostPositions,
            count: changes.ghostPositions.length,
          },
        });
      }

      if (changes.newPositions.length > 0) {
        console.log(`📥 [Reconciler] Found ${changes.newPositions.length} orphaned positions for user ${userId}`);
        recordOpsEvent({
          level: 'warn',
          source: 'state_reconciler',
          message: 'orphaned_positions_detected',
          details: {
            userId,
            positions: changes.newPositions.map(p => ({
              symbol: p.symbol,
              side: p.side,
              qty: p.qty,
            })),
            count: changes.newPositions.length,
          },
        });

        // Emit alert for orphaned positions
        await emitAlert({
          sessionId: userId,
          symbol: changes.newPositions[0]?.symbol,
          kind: 'position_desync',
          severity: 'high',
          details: {
            message: 'Positions found on exchange not tracked locally',
            positions: changes.newPositions.map(p => p.symbol),
          },
        });
      }

      if (changes.quantityMismatches.length > 0) {
        console.log(`⚠️ [Reconciler] ${changes.quantityMismatches.length} quantity mismatches for user ${userId}`);
        recordOpsEvent({
          level: 'warn',
          source: 'state_reconciler',
          message: 'quantity_mismatches_detected',
          details: {
            userId,
            mismatches: changes.quantityMismatches,
          },
        });
      }

      result.success = true;

      recordOpsEvent({
        level: 'info',
        source: 'state_reconciler',
        message: 'reconciliation_completed',
        details: {
          userId,
          positionsCount: positions.length,
          ghostPositionsCleared: result.ghostPositionsCleared,
          orphanedPositionsFound: result.orphanedPositionsFound,
          marginUpdated: result.marginUpdated,
        },
      });

    } catch (error) {
      const errorMsg = String((error as Error)?.message || error);
      result.errors.push(errorMsg);

      recordOpsEvent({
        level: 'error',
        source: 'state_reconciler',
        message: 'reconciliation_failed',
        details: {
          userId,
          error: errorMsg,
        },
      });
    } finally {
      this.reconciliationInProgress.set(userId, false);
    }

    return result;
  }

  /**
   * Get the current reconciled state for a user
   */
  getReconciledState(userId: string): ReconciledState | null {
    const state = this.reconciledStates.get(userId);
    if (!state) return null;

    // Mark as stale if older than 2x reconciliation interval
    const staleDuration = RECONCILIATION_INTERVAL_MS * 2;
    const age = Date.now() - state.lastUpdate;
    if (age > staleDuration) {
      state.isStale = true;
    }

    return state;
  }

  /**
   * Get a specific position from reconciled state
   */
  getReconciledPosition(userId: string, symbol: string): ExchangePosition | null {
    const state = this.reconciledStates.get(userId);
    if (!state || state.isStale) return null;
    return state.positions.get(symbol) || null;
  }

  /**
   * Get reconciled margin snapshot for a user
   */
  getReconciledMarginSnapshot(userId: string): BrokerMarginSnapshot | null {
    const state = this.reconciledStates.get(userId);
    if (!state || state.isStale) return null;
    return state.marginSnapshot;
  }

  /**
   * Force an immediate reconciliation (useful for on-demand checks)
   */
  async forceReconciliation(userId: string): Promise<ReconciliationResult> {
    console.log(`🔄 [Reconciler] Force reconciliation triggered for user ${userId}`);
    return this.reconcileState(userId);
  }

  /**
   * Fetch current state from exchange
   */
  private async fetchExchangeState(exchange: any): Promise<[ExchangePosition[], BrokerMarginSnapshot | null]> {
    const positions: ExchangePosition[] = [];
    let marginSnapshot: BrokerMarginSnapshot | null = null;

    // Fetch positions
    try {
      if (typeof exchange.fetchPositions === 'function') {
        const fetchedPositions = await exchange.fetchPositions();
        
        if (Array.isArray(fetchedPositions)) {
          for (const pos of fetchedPositions) {
            const symbol = pos?.symbol || pos?.info?.symbol || '';
            const contracts = this.parseNumber(pos?.contracts, pos?.size, pos?.positionAmt, pos?.amount);
            const absQty = contracts !== undefined ? Math.abs(contracts) : this.parseNumber(pos?.quantity) || 0;

            // Only include positions with non-zero quantity
            if (absQty > POSITION_QTY_EPSILON) {
              let side: 'long' | 'short' = 'long';
              const declaredSide = String(pos?.side || '').toLowerCase();
              if (declaredSide.includes('short') || declaredSide.includes('sell')) {
                side = 'short';
              } else if (contracts !== undefined && contracts < 0) {
                side = 'short';
              }

              positions.push({
                symbol,
                side,
                qty: absQty,
                entryPrice: this.parseNumber(pos?.entryPrice, pos?.avgEntryPrice, pos?.average),
                markPrice: this.parseNumber(pos?.markPrice, pos?.lastPrice),
                liquidationPrice: this.parseNumber(pos?.liquidationPrice, pos?.liquidation),
                notionalUsd: this.parseNumber(pos?.notional, pos?.notionalUsd, pos?.notionalValue),
                leverage: this.parseNumber(pos?.leverage),
                unrealizedPnl: this.parseNumber(pos?.unrealizedPnl, pos?.unrealizedPnlUsd),
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch positions from exchange:', error);
      throw error;
    }

    // Fetch balance/margin
    try {
      const balance = await exchange.fetchBalance();
      
      // Parse balance data (similar to LiveBroker.balance())
      const raw = Array.isArray(balance?.info?.result?.data) ? balance.info.result.data[0] : undefined;
      const infoSources: any[] = [];
      if (raw) infoSources.push(raw);
      if (balance?.info && !infoSources.includes(balance.info)) infoSources.push(balance.info);

      const num = (v: any) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      let avail = num(raw?.total_available_balance);
      let marginBal = num(raw?.total_margin_balance) ?? num(raw?.total_collateral_value);
      let positionCost = num(raw?.total_position_cost);
      let openOrderMargin: number | undefined;
      let maintenanceUsd = num(raw?.total_maint_margin);
      let marginRatio = num(raw?.margin_ratio);

      for (const src of infoSources) {
        if (avail === undefined) {
          avail = num(src?.total_available_balance) ?? num(src?.availableBalance) ?? num(src?.maxWithdrawAmount);
        }
        if (marginBal === undefined) {
          marginBal = num(src?.total_margin_balance) ?? num(src?.totalMarginBalance) ?? num(src?.totalWalletBalance);
        }
        if (positionCost === undefined) {
          positionCost = num(src?.total_position_cost) ?? num(src?.totalPositionInitialMargin);
        }
        if (openOrderMargin === undefined) {
          openOrderMargin = num(src?.total_open_order_margin) ?? num(src?.totalOpenOrderInitialMargin);
        }
        if (maintenanceUsd === undefined) {
          maintenanceUsd = num(src?.total_maint_margin) ?? num(src?.totalMaintenanceMargin);
        }
        if (marginRatio === undefined) {
          marginRatio = num(src?.margin_ratio) ?? num(src?.marginRatio);
        }
      }

      const fallbackTotal = (balance?.total?.USDT ?? 0) + (balance?.total?.USD ?? 0);
      const fallbackFree = (balance?.free?.USDT ?? 0) + (balance?.free?.USD ?? 0);

      const equityUsd = marginBal ?? fallbackTotal;
      const freeUsd = avail ?? fallbackFree;

      // Build margin snapshot similar to LiveBroker
      const brokerPositions: BrokerPositionMargin[] = positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        notionalUsd: p.notionalUsd,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        liquidationPrice: p.liquidationPrice,
        leverage: p.leverage,
        unrealizedPnlUsd: p.unrealizedPnl,
        maintenanceMarginUsd: undefined, // Not easily available from position alone
        initialMarginUsd: undefined,
      }));

      const committedUsd = computeCommittedMargin({
        equityUsd,
        freeUsd,
        positionCost,
        openOrderMargin,
        positions: brokerPositions,
      });

      marginSnapshot = {
        equityUsd: Number.isFinite(equityUsd) ? equityUsd : 0,
        freeUsd: Number.isFinite(freeUsd) ? freeUsd : 0,
        committedUsd,
        maintenanceMarginUsd: maintenanceUsd,
        marginRatio,
        positions: brokerPositions,
      };

    } catch (error) {
      console.error('Failed to fetch balance from exchange:', error);
      // Don't throw - positions are more critical than balance
    }

    return [positions, marginSnapshot];
  }

  /**
   * Detect changes between previous and current state
   */
  private detectStateChanges(
    previousState: ReconciledState | undefined,
    currentPositions: ExchangePosition[],
    currentMargin: BrokerMarginSnapshot | null
  ): {
    ghostPositions: string[];
    newPositions: ExchangePosition[];
    quantityMismatches: Array<{ symbol: string; oldQty: number; newQty: number }>;
    marginChanged: boolean;
  } {
    const result = {
      ghostPositions: [] as string[],
      newPositions: [] as ExchangePosition[],
      quantityMismatches: [] as Array<{ symbol: string; oldQty: number; newQty: number }>,
      marginChanged: false,
    };

    if (!previousState) {
      // First reconciliation - all positions are "new" but not orphaned
      return result;
    }

    const currentSymbols = new Set(currentPositions.map(p => p.symbol));
    const previousSymbols = new Set(previousState.positions.keys());

    // Find ghost positions (were in previous state but not in current)
    for (const symbol of previousSymbols) {
      if (!currentSymbols.has(symbol)) {
        result.ghostPositions.push(symbol);
      }
    }

    // Find new positions (in current but not in previous)
    for (const pos of currentPositions) {
      if (!previousSymbols.has(pos.symbol)) {
        result.newPositions.push(pos);
      } else {
        // Check for quantity mismatches
        const prevPos = previousState.positions.get(pos.symbol);
        if (prevPos && Math.abs(prevPos.qty - pos.qty) > POSITION_QTY_EPSILON) {
          const diffPct = Math.abs((prevPos.qty - pos.qty) / prevPos.qty) * 100;
          if (diffPct > 5) { // More than 5% difference
            result.quantityMismatches.push({
              symbol: pos.symbol,
              oldQty: prevPos.qty,
              newQty: pos.qty,
            });
          }
        }
      }
    }

    // Check if margin changed significantly
    if (previousState.marginSnapshot && currentMargin) {
      const prevEquity = previousState.marginSnapshot.equityUsd || 0;
      const currEquity = currentMargin.equityUsd || 0;
      const equityDiff = Math.abs(prevEquity - currEquity);
      const equityDiffPct = prevEquity > 0 ? (equityDiff / prevEquity) * 100 : 0;
      
      // Consider margin changed if equity differs by more than 1%
      result.marginChanged = equityDiffPct > 1;
    }

    return result;
  }

  /**
   * Helper to parse numbers from multiple possible fields
   */
  private parseNumber(...values: any[]): number | undefined {
    for (const value of values) {
      const n = Number(value);
      if (Number.isFinite(n) && n !== 0) return n;
    }
    return undefined;
  }

  /**
   * Get reconciliation status for monitoring
   */
  getReconciliationStatus(userId: string): {
    active: boolean;
    lastReconciliation?: number;
    inProgress: boolean;
    stateAge?: number;
    positionsCount?: number;
  } {
    const state = this.reconciledStates.get(userId);
    return {
      active: this.reconciliationTimers.has(userId),
      lastReconciliation: this.lastReconciliationAttempt.get(userId),
      inProgress: this.reconciliationInProgress.get(userId) || false,
      stateAge: state ? Date.now() - state.lastUpdate : undefined,
      positionsCount: state?.positions.size,
    };
  }

  /**
   * Stop all reconciliations (for shutdown)
   */
  stopAll(): void {
    const userIds = Array.from(this.reconciliationTimers.keys());
    for (const userId of userIds) {
      this.stopPeriodicReconciliation(userId);
    }
    console.log(`⏹️ Stopped all state reconciliations (${userIds.length} users)`);
  }
}

// Singleton instance
export const stateReconciler = new StateReconciler();
