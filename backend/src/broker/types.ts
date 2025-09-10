export type OrderSide = 'buy'|'sell';
export type OrderType = 'market'|'limit';

export type NewOrder = {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  qty: number; // base units (e.g. BTC)
  price?: number; // for limit
  leverage?: number;
  clientOrderId?: string;
  takeProfit?: number;
  stopLoss?: number;
};

export type PlacedOrder = NewOrder & {
  id: string; // broker id
  status: 'new'|'open'|'partially_filled'|'filled'|'canceled'|'rejected';
  avgPrice?: number;
  filledQty?: number;
  ts: number;
};

export interface Broker {
  mode: 'paper'|'live';
  balance(): Promise<{ freeUsd: number; equityUsd: number; committedUsd: number }>;
  place(o: NewOrder): Promise<PlacedOrder>;
  cancel(id: string): Promise<void>;
  // optional: paper-specific reserve release
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  releaseCommitted?(usd: number): void;
}
