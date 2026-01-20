/**
 * V5.72: Cockpit Page Type Definitions
 *
 * Centralized types for the SessionCockpitPage redesign
 */

// ============================================================================
// SESSION & STATE
// ============================================================================

export type SessionState = 'WATCHING' | 'IN_POSITION' | 'STOPPED' | 'HALT';
export type SessionMode = 'paper' | 'live';

export interface Session {
  id: string;
  symbol: string;
  mode: SessionMode;
  state: SessionState;
  startedAt: string;
  stoppedAt?: string | null;
  profileJson?: Record<string, unknown>;
}

// ============================================================================
// POSITION & HEALTH
// ============================================================================

export type HealthStatus = 'progressing' | 'watching' | 'stagnant' | 'at_risk';

export interface TrailingState {
  active: boolean;
  activatedAt: number | null;
  updateCount: number;
  currentStopPrice: number | undefined;
  peakPrice: number;
  distanceFromPeak: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  qty: number;
  entryTime: number;

  // Calculated metrics
  pnlUsd: number;
  pnlPct: number;
  notionalUsd: number;
  duration: number;

  // Stop/target levels
  stopPrice: number;
  stopLoss?: number;
  targets?: number[];

  // Trailing state
  trailingState: TrailingState;
  trailDistance?: number;

  // Health indicators
  healthStatus: HealthStatus;
  healthReason: string;
  peakPrice: number;
  distanceFromPeak: number;
  stopDistancePct: number;

  // Additional fields
  leverage?: number;
  marginUsd?: number;
  maxPnlPct?: number;
  stagnantState?: {
    triggered: boolean;
    confirmed: boolean;
    cancelled: boolean;
  };
}

// ============================================================================
// AGENT STATE
// ============================================================================

export interface AgentState {
  running: boolean;
  state: SessionState;
  hasPosition: boolean;
  symbol: string;
  sessionId: string;
  mode: SessionMode;

  // Position data (null when not in position)
  pos: Position | null;

  // Strategy plan
  plan: {
    bias?: 'long' | 'short' | null;
    zone?: { from: number; to: number; mid: number } | null;
    stopDistance?: number;
    rPrices?: Array<{ r: number; price: number; pct: number }>;
  } | null;

  // Last exit info
  exit: { ts: number; price: number; reason: string } | null;

  // Profile settings
  profile: {
    riskPerTradePct: number;
    dailyLossLimitPct: number;
    maxLeverage: number;
    aggressiveness: string;
    availableUsd: number;
  };

  // Balance
  balance: {
    freeUsd: number;
    totalUsd: number;
  };

  // Market conditions
  marketConditions?: {
    regime: 'BULL' | 'BEAR' | 'NEUTRAL';
    btcTrend: 'bullish' | 'bearish' | 'neutral';
    volatility: 'HIGH' | 'MEDIUM' | 'LOW';
    momentum?: number;
  } | null;

  lastTickAt: number;
  tickCount: number;
}

// ============================================================================
// TICKER & MARKET DATA
// ============================================================================

export interface TickerData {
  symbol: string;
  price: number;
  change24h: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  bid?: number;
  ask?: number;
  timestamp: number;
}

// ============================================================================
// ORDERS & TRADES
// ============================================================================

export interface Order {
  id: string;
  sessionId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop_market' | 'take_profit_market';
  price?: number;
  qty: number;
  status: 'pending' | 'open' | 'filled' | 'canceled' | 'expired';
  createdAt: string;
  filledAt?: string;
  avgPrice?: number;
  clientOrderId?: string;
}

export interface Trade {
  id: string;
  sessionId: string;
  symbol: string;
  positionSide: 'long' | 'short';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  entryTs: string;
  exitTs: string;
  realizedPnlUsd: number;
  pctChange: number;
  feesUsd: number;
  exitReason?: string;
  durationMinutes?: number;
}

export interface TradeFilters {
  symbol?: string;
  side?: 'long' | 'short';
  result?: 'win' | 'loss' | 'breakeven';
  dateRange?: [Date, Date];
}

// ============================================================================
// PERFORMANCE & PARITY
// ============================================================================

export interface PerformanceMetrics {
  winRate: number;
  expectancy: number;
  totalTrades: number;
  wins: number;
  losses: number;
  avgWin: number;
  avgLoss: number;
}

export interface ParityResult {
  totalTrades: number;
  verifiedTrades: number;
  matchedTrades: number;
  matchRate: number;
  status: 'healthy' | 'warning' | 'critical';
  mismatches: Array<{
    tradeId: string;
    symbol: string;
    liveExitReason: string;
    btExitReason: string;
    pnlDiff: number | null;
  }>;
}

// ============================================================================
// ACTIVITY FEED
// ============================================================================

export type ActivityEventType =
  | 'entry'
  | 'exit'
  | 'trail'
  | 'signal'
  | 'info'
  | 'warn'
  | 'error'
  | 'symbol_proximity'
  | 'market_regime'
  | 'position_update'
  | 'opportunity_alert';

export interface ActivityEvent {
  timestamp: string;
  sessionId: string;
  symbol: string;
  kind: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

// ============================================================================
// COMPONENT PROPS
// ============================================================================

export interface CockpitHeaderProps {
  symbol: string;
  netPnl: number;
  roiPct: number;
  mode: SessionMode;
  state: SessionState;
  wsConnected: boolean;
  sparklineData: number[];
}

export interface LiveMetricsBarProps {
  symbol: string;
  ticker: TickerData | null;
  status: 'loading' | 'live' | 'stale' | 'error';
}

export interface PositionBannerProps {
  position: Position;
}

export interface HealthGaugeProps {
  stopPrice: number;
  currentPrice: number;
  peakPrice: number;
  side: 'long' | 'short';
}

export interface OrdersTradesPanelProps {
  orders: Order[];
  trades: Trade[];
  defaultTab: 'orders' | 'trades';
  filters: TradeFilters;
  onFilterChange: (filters: TradeFilters) => void;
}

export interface PerformanceSummaryProps {
  performance: PerformanceMetrics | null;
  parity: ParityResult | null;
  loading: boolean;
}

export interface ActivityFeedProps {
  sessionId: string;
  events: ActivityEvent[];
  loading: boolean;
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface ApiAgentStateResponse {
  running: boolean;
  state: SessionState;
  hasPosition: boolean;
  symbol: string;
  sessionId: string;
  mode: SessionMode;
  pos: Position | null;
  plan: AgentState['plan'];
  exit: AgentState['exit'];
  profile: AgentState['profile'];
  balance: AgentState['balance'];
  marketConditions?: AgentState['marketConditions'];
  lastTickAt: number;
  tickCount: number;
}

export interface ApiLogsResponse {
  logs: ActivityEvent[];
  agentStates: Array<{
    sessionId: string;
    symbol: string;
    running: boolean;
    hasPosition: boolean;
    bias: string | null;
  }>;
  activeSessions: number;
}

export interface ApiParityResponse extends ParityResult {}

export interface ApiPerfBreakdownResponse {
  totals: PerformanceMetrics;
  bySide: {
    long: PerformanceMetrics;
    short: PerformanceMetrics;
  };
  bySymbol: Record<string, PerformanceMetrics>;
  sample: number;
}
