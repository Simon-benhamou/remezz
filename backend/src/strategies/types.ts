/**
 * Strategy-agnostic types for Remezz trading platform.
 * Shared across ALL strategies and the backtest engine.
 */

// ============================================================================
// MARKET DATA
// ============================================================================

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isFinal?: boolean;
}

// ============================================================================
// POSITION
// ============================================================================

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  qty: number;
  entryTime: number;
  realEntryTime?: number;
  stopLoss?: number;
  appTrailingStop?: number;
  stopLossPct?: number;
  orderId?: string;
  stopLossOrderId?: string;
  trailingOrderId?: string;
  leverage?: number;
  marginUsd?: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  trailingActive?: boolean;
  maxPnlPct?: number;
  entryAtrPct?: number;
  trailingBreachCandles?: number;
  stagnantState?: {
    triggered: boolean;
    triggeredAtMinutes?: number;
    confirmed: boolean;
    cancelled: boolean;
    obsPeakPct: number;
  };
  emergencyStopPrice?: number;
  positionId?: string;
  groupId?: string;
  entryIndex?: number;
}

// ============================================================================
// STRATEGY INTERFACE
// ============================================================================

export interface EntryContext {
  symbol: string;
  candles: Candle[];
  btcCandles: Candle[];
  currentPrice: number;
  timestamp: number;
  capital: number;
  openPositions: number;
}

export interface ExitContext {
  symbol: string;
  position: Position;
  candles: Candle[];
  btcCandles: Candle[];
  currentPrice: number;
  timestamp: number;
  entryPrice: number;
  unrealizedPnlPct: number;
  holdingMinutes: number;
}

export interface StrategySignal {
  valid: boolean;
  side: 'long' | 'short';
  confidence: number;
  reason: string;
  stopLossPct?: number;
  takeProfitPct?: number;
  metadata?: Record<string, unknown>;
}

export interface StrategyExitSignal {
  shouldExit: boolean;
  reason: string;
  exitPrice?: number;
}

export interface StrategyConfig {
  name: string;
  version: string;
  symbols: string[];
  leverage: number;
  maxPositions: number;
  positionSizePct: number;
  minCandlesRequired: number;
  timeframeMs: number;
  fees: {
    tradingPct: number;
    slippagePct: number;
    fundingPct: number;
  };
}

export interface IStrategy {
  readonly name: string;
  getConfig(): StrategyConfig;
  checkEntry(ctx: EntryContext): StrategySignal | null;
  checkExit(ctx: ExitContext): StrategyExitSignal;
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const CANDLE_15M_MS = 15 * 60 * 1000;
