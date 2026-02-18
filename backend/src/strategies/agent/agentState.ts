/**
 * agentState.ts — State type definitions for AgentOrchestrator
 *
 * V5.108: Defines the state shape of the agent in cohesive groups.
 * These interfaces document which instance variables belong together
 * and will be used by extracted modules (candleFetcher, exchangeSync).
 */

import type { Position, MarketConditions } from '../momentumSimple.js';

// ============================================================================
// POSITION STATE
// ============================================================================

export interface PositionState {
  position: Position | null;
  additionalPositions: Position[];
  closingPosition: boolean;
  exitAttemptCount: number;
  lastExitAttemptTs: number;
}

// ============================================================================
// TRAILING STATE
// ============================================================================

export interface TrailingState {
  trailingNotified: boolean;
  trailingWidened: boolean;
  stagnantSlUpdated: boolean;
}

// ============================================================================
// SIGNAL STATE
// ============================================================================

export interface SignalState {
  lastMarketConditions: MarketConditions | null;
  lastSignal: {
    entryZone?: [number, number];
    stopDistance?: number;
    targets?: number[];
    targetPcts?: number[];
  } | null;
  lastSignalFeatures: {
    volRatio: number;
    roc: number;
    bbDistance: number;
    reason: string;
  } | null;
  currentBias: 'long' | 'short' | null;
  lastKnownRegime: 'BULL' | 'BEAR' | 'NEUTRAL' | null;
  lastRejectReason: string;
  lastExit: { ts: number; price: number; reason: string } | null;
}

// ============================================================================
// TIME KEEPER
// ============================================================================

export interface TimeKeeper {
  tickCount: number;
  lastTickAt: number;
  lastPrice: number;
  lastProcessedCandleTs: number;
  lastProcessedExitCandleTs: number;
}

// ============================================================================
// COOLDOWN STATE
// ============================================================================

export interface CooldownState {
  entryCooldownBarsRemaining: number;
  readonly ENTRY_COOLDOWN_BARS: number;
}

// ============================================================================
// LIFECYCLE STATE
// ============================================================================

export interface LifecycleState {
  running: boolean;
  tickIntervalId: NodeJS.Timeout | null;
  tickAlignTimeoutId: NodeJS.Timeout | null;
  finalKlineUnsubscribe: (() => void) | null;
  tickInProgress: boolean;
}

// ============================================================================
// ERROR STATE
// ============================================================================

export interface ErrorState {
  consecutiveTickErrors: number;
  lastErrorAlertTs: number;
}
