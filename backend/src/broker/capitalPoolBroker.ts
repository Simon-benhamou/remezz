import crypto from 'crypto';
import { getTicker } from '../data/market.js';
import type { Broker, BrokerMarginSnapshot, NewOrder, PlacedOrder } from './types.js';
import { CapitalManager } from '../core/capital/CapitalManager.js';
import { USD, ZERO_USD } from '../core/capital/types.js';
import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

type CapitalPoolBrokerParams = {
  agentId: string;
  mode: 'paper' | 'live';
  capital: CapitalManager;
  broker: Broker;
  minOrderUsd: USD;
};

export class CapitalPoolBroker implements Broker {
  public readonly mode: 'paper' | 'live';
  private readonly agentId: string;
  private readonly capital: CapitalManager;
  private readonly broker: Broker;
  private readonly minOrderUsd: USD;
  private readonly pendingReservations = new Map<string, string>();
  public readonly estimateFillableQty?: Broker['estimateFillableQty'];
  public readonly syncProtective?: Broker['syncProtective'];

  constructor(params: CapitalPoolBrokerParams) {
    this.mode = params.mode;
    this.agentId = params.agentId;
    this.capital = params.capital;
    this.broker = params.broker;
    this.minOrderUsd = params.minOrderUsd;
    if (typeof params.broker.estimateFillableQty === 'function') {
      this.estimateFillableQty = async (p) => params.broker.estimateFillableQty!(p);
    }
    if (typeof params.broker.syncProtective === 'function') {
      this.syncProtective = async (p) => params.broker.syncProtective!(p);
    }
  }

  async balance(): Promise<BrokerMarginSnapshot> {
    const [inner, snapshot] = await Promise.all([
      this.broker.balance(),
      this.capital.getBalance(),
    ]);

    return {
      ...inner,
      freeUsd: snapshot.freeUSD.toNumber(),
      equityUsd: snapshot.totalUSD.toNumber(),
      committedUsd: snapshot.reservedUSD.plus(snapshot.inPositionsUSD).toNumber(),
    };
  }

  async place(order: NewOrder): Promise<PlacedOrder> {
    if (order.reduceOnly) {
      const placed = await this.broker.place(order);
      await this.handleReduceFill(order, placed);
      return placed;
    }

    const desiredUsd = await this.estimateDesiredUsd(order);
    if (desiredUsd.raw <= ZERO_USD.raw) {
      return this.rejectOrder(order, 'invalid_desired_usd');
    }

    const reservation = await this.capital.reserve({
      agentId: this.agentId,
      symbol: order.symbol,
      requestedUSD: desiredUsd,
      minUSD: this.minOrderUsd,
    });

    if (!reservation) {
      return this.rejectOrder(order, 'capital_reservation_failed');
    }

    try {
      const placed = await this.broker.place(order);
      const filledUsd = this.resolveFilledUsd(order, placed);

      if (!placed || !placed.id || placed.status === 'rejected' || placed.status === 'canceled') {
        await this.capital.release(reservation.id);
        if (placed?.id) {
          this.pendingReservations.delete(placed.id);
        }
        return placed;
      }

      if (filledUsd.raw > ZERO_USD.raw) {
        await this.capital.commit(reservation.id, filledUsd);
        this.pendingReservations.delete(placed.id);
        return placed;
      }

      if (placed.status === 'filled') {
        await this.capital.commit(reservation.id);
        this.pendingReservations.delete(placed.id);
        return placed;
      }

      this.pendingReservations.set(placed.id, reservation.id);
      return placed;
    } catch (error) {
      await this.capital.release(reservation.id);
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    await this.broker.cancel(id);
    const reservationId = this.pendingReservations.get(id);
    if (reservationId) {
      await this.capital.release(reservationId);
      this.pendingReservations.delete(id);
    }
  }

  private async estimateDesiredUsd(order: NewOrder): Promise<USD> {
    const qty = Math.abs(order.qty ?? 0);
    if (!(qty > 0)) {
      return ZERO_USD;
    }
    let price: number | null = null;
    if (order.type === 'limit' && typeof order.price === 'number') {
      price = order.price;
    } else {
      const ticker = await getTicker(order.symbol).catch(() => null as any);
      const candidate = Number(ticker?.last ?? ticker?.close ?? ticker?.mark ?? ticker?.ask ?? ticker?.bid ?? 0);
      if (Number.isFinite(candidate) && candidate > 0) {
        price = candidate;
      }
    }
    if (!(price && price > 0)) {
      return ZERO_USD;
    }
    const qtyDec = new PreciseDecimal(qty);
    const priceDec = new PreciseDecimal(price);
    return qtyDec.times(priceDec);
  }

  private resolveFilledUsd(order: NewOrder, placed: PlacedOrder): USD {
    const filledQty = typeof placed.filledQty === 'number' ? Math.abs(placed.filledQty) : 0;
    const avgPrice = typeof placed.avgPrice === 'number' && placed.avgPrice > 0
      ? placed.avgPrice
      : (order.type === 'limit' && order.price ? order.price : 0);
    if (!(filledQty > 0) || !(avgPrice > 0)) {
      return ZERO_USD;
    }
    const qtyDec = new PreciseDecimal(filledQty);
    const priceDec = new PreciseDecimal(avgPrice);
    return qtyDec.times(priceDec);
  }

  private rejectOrder(order: NewOrder, _reason: string): PlacedOrder {
    return {
      ...order,
      id: `capital_rejected_${crypto.randomUUID()}`,
      status: 'rejected',
      ts: Date.now(),
      requestedQty: order.qty,
      requestedPrice: order.price,
    } as PlacedOrder;
  }

  private async handleReduceFill(order: NewOrder, placed: PlacedOrder) {
    const filledQty = typeof placed.filledQty === 'number' ? Math.abs(placed.filledQty) : 0;
    if (!(filledQty > 0)) return;
    const price = typeof placed.avgPrice === 'number' && placed.avgPrice > 0
      ? placed.avgPrice
      : (order.type === 'limit' && order.price ? order.price : 0);
    if (!(price > 0)) return;
    const freedUsd = new PreciseDecimal(filledQty).times(new PreciseDecimal(price));
    await this.capital.settle(`${this.agentId}:${order.symbol}`, order.symbol, freedUsd);
  }
}
