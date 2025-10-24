import { CapitalManager } from '../core/capital/CapitalManager.js';
import { toUSD } from '../core/capital/types.js';
import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

type BrokerAdapter = {
  placeOrder: (p: { symbol: string; side: 'buy' | 'sell'; qty: number }) => Promise<{
    accepted: boolean;
    id?: string;
    reason?: string;
    filledQty?: number;
    avgPrice?: number;
  }>;
};

type PlaceParams = {
  capital: CapitalManager;
  agentId: string;
  symbol: string;
  desiredUSD: PreciseDecimal | number | string;
  minUSD: PreciseDecimal | number | string;
  side: 'buy' | 'sell';
  estimateEntryPriceEv: (symbol: string, side: 'buy' | 'sell') => Promise<number>;
  broker: BrokerAdapter;
};

export async function placeWithPool(params: PlaceParams): Promise<
  | { accepted: false; reason: string }
  | { accepted: true; orderId: string; grantedUSD: number; filledUSD: number }
> {
  const desiredUSD = toUSD(params.desiredUSD);
  const minUSD = toUSD(params.minUSD);
  const reservation = await params.capital.reserve({
    agentId: params.agentId,
    symbol: params.symbol,
    requestedUSD: desiredUSD,
    minUSD,
  });

  if (!reservation) {
    return { accepted: false, reason: 'not_enough_free_capital' };
  }

  try {
    const entryPxEv = await params.estimateEntryPriceEv(params.symbol, params.side);
    const entryPrice = new PreciseDecimal(entryPxEv);
    if (entryPrice.raw <= 0n) {
      await params.capital.release(reservation.id);
      return { accepted: false, reason: 'invalid_entry_price' };
    }

    const qtyDecimal = reservation.grantedUSD.dividedBy(entryPrice);
    const qty = qtyDecimal.toNumber();
    if (!(qty > 0)) {
      await params.capital.release(reservation.id);
      return { accepted: false, reason: 'invalid_qty' };
    }

    const order = await params.broker.placeOrder({ symbol: params.symbol, side: params.side, qty });
    if (!order.accepted || !order.id) {
      await params.capital.release(reservation.id);
      return { accepted: false, reason: order.reason ?? 'order_rejected' };
    }

    const filledQtyDecimal = new PreciseDecimal(order.filledQty ?? qty);
    const avgPriceDecimal = new PreciseDecimal(order.avgPrice ?? entryPxEv);
    const filledUsdDecimal = filledQtyDecimal.times(avgPriceDecimal);

    await params.capital.commit(reservation.id, filledUsdDecimal);

    return {
      accepted: true,
      orderId: order.id,
      grantedUSD: reservation.grantedUSD.toNumber(),
      filledUSD: filledUsdDecimal.toNumber(),
    };
  } catch (error) {
    await params.capital.release(reservation.id);
    throw error;
  }
}
