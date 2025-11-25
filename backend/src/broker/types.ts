/**
 * Broker Types - Complete
 */

export interface OrderResult {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  price?: number;
  filled: number;
  status: 'open' | 'closed' | 'canceled';
  timestamp: number;
}

export interface Position {
  symbol: string;
  side: 'long' | 'short';
  contracts: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice?: number;
  timestamp: number;
}

export interface Balance {
  total: number;
  free: number;
  used: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  high: number;
  low: number;
  volume: number;
  quoteVolume: number;
  percentage: number;
  timestamp: number;
}

export interface SubAgentMessage {
  type: string;
  payload: any;
  timestamp: number;
}

// ============================================
// NEW ORDER TYPES
// ============================================

export interface NewOrder {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  type?: 'market' | 'limit';
  price?: number;
  reduceOnly?: boolean;
  stopLoss?: number;
  takeProfit?: number;
  slippage?: number;
}

export interface PlacedOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  filled: number;
  avgPrice: number;
  status: 'open' | 'filled' | 'canceled' | 'rejected';
  timestamp: number;
  fee?: number;
}

// ============================================
// MARGIN TYPES
// ============================================

export interface BrokerMarginSnapshot {
  totalEquityUsd: number;
  availableBalanceUsd: number;
  usedMarginUsd: number;
  unrealizedPnl: number;
  marginRatio: number;
  timestamp: number;
}

export interface BrokerPositionMargin {
  symbol: string;
  side: 'long' | 'short';
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  liquidationPrice?: number;
}

export interface BrokerCorrelatedExposure {
  family: string;
  symbols: string[];
  totalNotionalUsd: number;
  correlationFactor: number;
}

// ============================================
// BROKER INTERFACE
// ============================================

export interface Broker {
  mode: 'paper' | 'live';
  
  // Balance
  balance(): Promise<BrokerMarginSnapshot>;
  
  // Orders
  placeOrder(order: NewOrder): Promise<PlacedOrder>;
  cancelOrder(orderId: string, symbol: string): Promise<boolean>;
  getOrder(orderId: string, symbol: string): Promise<PlacedOrder | null>;
  
  // Positions
  getPositions(): Promise<BrokerPositionMargin[]>;
  closePosition(symbol: string, side?: 'long' | 'short'): Promise<PlacedOrder | null>;
  
  // Optional
  estimateFillableQty?(params: { symbol: string; side: string; notionalUsd: number }): Promise<number>;
  syncProtective?(params: { symbol: string; stopLoss?: number; takeProfit?: number }): Promise<void>;
}
