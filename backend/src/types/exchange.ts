/**
 * Typed interfaces for CCXT exchange interactions.
 * Replaces loose `any` types in simpleAgent.ts and orderQueue.ts.
 */

export interface CcxtOrder {
  id: string;
  orderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  price: number | null;
  average: number | null;
  amount: number;
  filled: number;
  remaining: number;
  status: 'open' | 'closed' | 'canceled' | 'expired' | 'rejected';
  timestamp: number;
  fee?: { cost: number; currency?: string };
  info: Record<string, unknown>;
}

export interface CcxtPosition {
  symbol: string;
  side: 'long' | 'short';
  contracts: number;
  entryPrice: number;
  unrealizedPnl: number;
  leverage: number;
  info: Record<string, unknown>;
}

export interface CcxtTrade {
  id: string;
  order: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  timestamp: number;
  type: string;
  info: Record<string, unknown>;
}

export interface CcxtBalance {
  total: Record<string, number>;
  free: Record<string, number>;
  USDT?: { total: number; free: number };
  info: Record<string, unknown>;
}

export interface CcxtMarket {
  id: string;
  symbol: string;
  precision: { amount: number; price: number };
  limits: {
    amount: { min: number; max: number };
    price: { min: number; max: number };
    cost: { min: number };
  };
  [key: string]: unknown;
}

export interface Exchange {
  fetchOHLCV: (symbol: string, timeframe: string, since?: number, limit?: number) => Promise<number[][]>;
  setLeverage: (leverage: number, symbol: string) => Promise<void>;
  createMarketBuyOrder: (symbol: string, qty: number, params?: Record<string, unknown>) => Promise<CcxtOrder>;
  createMarketSellOrder: (symbol: string, qty: number, params?: Record<string, unknown>) => Promise<CcxtOrder>;
  createOrder: (symbol: string, type: string, side: string, qty: number, price?: number, params?: Record<string, unknown>) => Promise<CcxtOrder>;
  fetchPositions?: (symbols?: string[]) => Promise<CcxtPosition[]>;
  fetchMyTrades?: (symbol: string, since?: number, limit?: number) => Promise<CcxtTrade[]>;
  cancelOrder?: (orderId: string, symbol: string) => Promise<CcxtOrder>;
  cancelAllOrders?: (symbol: string, params?: Record<string, unknown>) => Promise<CcxtOrder[]>;
  amountToPrecision?: (symbol: string, amount: number) => string;
  markets?: Record<string, CcxtMarket>;
  fetchBalance?: (params?: Record<string, unknown>) => Promise<CcxtBalance>;
  fetchOrder?: (orderId: string, symbol: string) => Promise<CcxtOrder>;
}
