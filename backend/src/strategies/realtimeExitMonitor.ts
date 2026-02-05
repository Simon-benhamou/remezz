/**
 * RealtimeExitMonitor - Extracted from SimpleAgent (Phase 4C).
 *
 * Manages real-time exit detection via WebSocket ticker data.
 * Includes NFS (Noise Filter Score) adaptive exit system,
 * proactive LIMIT order placement, and stagnant trade detection.
 *
 * NOTE: This module currently defines the interface and state.
 * The full checkRealtimeExit() logic is being migrated incrementally
 * from SimpleAgent to avoid breaking changes in a single commit.
 */

import { MomentumConfig, type Position } from './momentumSimple.js';
import type { ExchangeOrderManager } from './exchangeOrderManager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('rt-exit');

export interface RealtimeExitCallbacks {
  onExitTriggered: (price: number, reason: string) => Promise<void>;
  onTrailingUpdated: (newStop: number) => void;
  onStopLossUpdated: (newStop: number) => void;
}

export interface RealtimeExitState {
  rtBreachSinceMs: number | null;
  rtBreachTicks: number;
  lastAppTrailingStop: number | null;
  lastRtTrailingKlineTs: number | null;
  rtTrailingBreachCandles: number;
  trailingActivatedAt: number | null;
  trailingUpdateCount: number;
  trailingNotified: boolean;
  trailingWidened: boolean;
  stagnantSlUpdated: boolean;
  realtimeExitInProgress: boolean;
}

export function createInitialRealtimeExitState(): RealtimeExitState {
  return {
    rtBreachSinceMs: null,
    rtBreachTicks: 0,
    lastAppTrailingStop: null,
    lastRtTrailingKlineTs: null,
    rtTrailingBreachCandles: 0,
    trailingActivatedAt: null,
    trailingUpdateCount: 0,
    trailingNotified: false,
    trailingWidened: false,
    stagnantSlUpdated: false,
    realtimeExitInProgress: false,
  };
}

export function resetRealtimeExitState(state: RealtimeExitState): void {
  state.rtBreachSinceMs = null;
  state.rtBreachTicks = 0;
  state.lastAppTrailingStop = null;
  state.lastRtTrailingKlineTs = null;
  state.rtTrailingBreachCandles = 0;
  state.realtimeExitInProgress = false;
}
