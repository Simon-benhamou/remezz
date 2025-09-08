import { Broker, NewOrder, PlacedOrder } from './types.js';
import { exchange, resolveSymbol } from '../exchange/ccxtClient.js';

// Minimal ccxt-backed live broker (spot or swap per env config)
export class LiveBroker implements Broker {
  mode: 'paper'|'live' = 'live';

  async balance() {
    const ex = await exchange();
    const b = await ex.fetchBalance();
    const totalUsd = (b?.total?.USDT ?? 0) + (b?.total?.USD ?? 0);
    const freeUsd = (b?.free?.USDT ?? 0) + (b?.free?.USD ?? 0);
    return { freeUsd, equityUsd: totalUsd, committedUsd: 0 };
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const ex = await exchange();
    const symbol = await resolveSymbol(o.symbol);

    // Try set leverage if available and provided
    if (o.leverage && typeof (ex as any).setLeverage === 'function') {
      try { await (ex as any).setLeverage(o.leverage, symbol); } catch {}
    }

    let order: any;
    const params: any = {};
    const tif = o.type === 'limit' ? 'GTC' : undefined;
    try {
      if (o.type === 'market') {
        order = await ex.createOrder(symbol, 'market', o.side, o.qty, undefined, params);
      } else {
        order = await ex.createOrder(symbol, 'limit', o.side, o.qty, o.price, { timeInForce: tif, ...params });
      }
    } catch (e: any) {
      return { ...o, id: 'rejected', status: 'rejected', ts: Date.now() };
    }

    const filledQty = Number(order?.filled ?? 0) || undefined;
    const avgPrice = Number(order?.average ?? order?.price ?? o.price) || undefined;
    const status: PlacedOrder['status'] = (order?.status === 'closed' || order?.status === 'filled') ? 'filled'
      : (order?.status === 'canceled' ? 'canceled' : 'open');

    return { ...o, id: String(order?.id || order?.clientOrderId || ''), status, filledQty, avgPrice, ts: Date.now() };
  }

  async cancel(id: string) {
    const ex = await exchange();
    try { await ex.cancelOrder(id); } catch {}
  }
}

