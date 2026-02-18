/**
 * agentState.ts — State type definitions + frontend state builder
 *
 * V5.108: Defines the state shape of the agent in cohesive groups.
 * V5.108 Phase 4: Added buildAgentState() — extracted from orchestrator.ts getAgentState().
 */

import { MomentumConfig, type Position, type MarketConditions } from '../momentumSimple.js';
import type { CapitalPool } from '../capitalPool.js';

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

// ============================================================================
// EVENT TYPES (shared to avoid circular deps with orchestrator)
// ============================================================================

export interface TradeEvent {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  orderId: string;
  timestamp: Date;
}

// ============================================================================
// AGENT STATE BUILDER — Snapshot input for buildAgentState()
// ============================================================================

export interface AgentStateSnapshot {
  position: Position | null;
  lastPrice: number;
  lastSignal: {
    entryZone?: [number, number];
    stopDistance?: number;
    targets?: number[];
    targetPcts?: number[];
  } | null;
  currentBias: 'long' | 'short' | null;
  lastExit: { ts: number; price: number; reason: string } | null;
  lastTickAt: number;
  tickCount: number;
  // Config
  symbol: string;
  riskPerTradePct: number;
  capitalPool: CapitalPool;
  // RT exit handler trailing state
  trailingActivatedAt: number | null;
  trailingUpdateCount: number;
}

// ============================================================================
// AGENT STATE RESULT TYPE
// ============================================================================

export interface AgentStateResult {
  pos: (Position & {
    currentPrice?: number;
    pnlPct?: number;
    pnlUsd?: number;
    notionalUsd?: number;
    duration?: number;
    trailDistance?: number;
    entry?: number;
    leverage?: number;
    openedAt?: number;
    stopPrice?: number;
    stop?: number;
    targets?: number[];
    trailingState?: {
      active: boolean;
      activatedAt: number | null;
      updateCount: number;
      currentStopPrice: number | undefined;
      peakPrice: number;
      distanceFromPeak: number;
    };
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
}

// ============================================================================
// buildAgentState() — Pure function, no side effects
// ============================================================================

export function buildAgentState(snap: AgentStateSnapshot): AgentStateResult {
  let posWithMetrics: any = null;

  if (snap.position) {
    const pos = snap.position;
    const currentPrice = snap.lastPrice || pos.entryPrice;
    const pnlPct = pos.side === 'long'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const pnlUsd = pos.side === 'long'
      ? pos.qty * (currentPrice - pos.entryPrice)
      : pos.qty * (pos.entryPrice - currentPrice);
    const notionalUsd = pos.qty * pos.entryPrice;
    const duration = Date.now() - pos.entryTime;

    // Trail distance from current price to stop
    const trailDistance = pos.stopLoss
      ? pos.side === 'long'
        ? ((currentPrice - pos.stopLoss) / currentPrice) * 100
        : ((pos.stopLoss - currentPrice) / currentPrice) * 100
      : 0;

    // V5.72: Calculate peak price and distance from peak
    const peakPrice = pos.side === 'long'
      ? pos.highWaterMark || pos.entryPrice
      : pos.lowWaterMark || pos.entryPrice;
    const distanceFromPeak = pos.side === 'long'
      ? peakPrice > 0 ? ((peakPrice - currentPrice) / peakPrice) * 100 : 0
      : peakPrice > 0 ? ((currentPrice - peakPrice) / peakPrice) * 100 : 0;

    // V5.72: Calculate health status based on backend state
    const holdMinutes = duration / 60000;
    const minHoldForJudgment = 15;
    const stopDistancePct = trailDistance;
    const isStagnant = pos.stagnantState?.confirmed && !pos.stagnantState?.cancelled;
    const isAtRisk = stopDistancePct < 0.5;

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
      active: pos.trailingActive || false,
      activatedAt: snap.trailingActivatedAt,
      updateCount: snap.trailingUpdateCount,
      currentStopPrice: pos.appTrailingStop || pos.stopLoss,
      peakPrice,
      distanceFromPeak,
    };

    posWithMetrics = {
      ...pos,
      entry: pos.entryPrice,
      leverage: MomentumConfig.LEVERAGE[pos.symbol] || 5,
      openedAt: pos.entryTime,
      stopPrice: pos.appTrailingStop || pos.stopLoss,
      stop: pos.appTrailingStop || pos.stopLoss,
      targets: snap.lastSignal?.targets || [],
      currentPrice,
      pnlPct,
      pnlUsd,
      notionalUsd,
      duration,
      trailDistance,
      trailingState,
      healthStatus,
      healthReason,
      peakPrice,
      distanceFromPeak,
      stopDistancePct,
    };
  }

  return {
    pos: posWithMetrics,
    plan: snap.currentBias ? {
      bias: snap.currentBias,
      zone: snap.lastSignal?.entryZone ? {
        from: snap.lastSignal.entryZone[0],
        to: snap.lastSignal.entryZone[1],
        mid: (snap.lastSignal.entryZone[0] + snap.lastSignal.entryZone[1]) / 2,
      } : null,
      stopDistance: snap.lastSignal?.stopDistance,
      rPrices: snap.lastSignal?.targets?.map((t, i) => ({
        r: i + 1,
        price: t,
        pct: snap.lastSignal?.targetPcts?.[i] || (i + 1) * 0.5,
      })),
    } : null,
    exit: snap.lastExit,
    profile: {
      riskPerTradePct: snap.riskPerTradePct,
      dailyLossLimitPct: 3,
      maxLeverage: MomentumConfig.LEVERAGE[snap.symbol] || 4,
      aggressiveness: 'reactive',
      availableUsd: snap.capitalPool.getAvailableCapital(),
    },
    balance: {
      freeUsd: snap.capitalPool.getAvailableCapital(),
      totalUsd: snap.capitalPool.getStatus().totalUsd,
    },
    lastTickAt: snap.lastTickAt,
    tickCount: snap.tickCount,
  };
}
