import crypto from 'crypto';
import { getTicker } from '../data/market.js';
import { logTradeEvaluation } from '../learning/tradeEvaluationLogger.js';
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

    // Get per-agent equity if available, otherwise fall back to global equity
    const agentEquity = this.capital.getAgentEquity(this.agentId);
    const equityUsd = agentEquity ? agentEquity.currentEquity.toNumber() : snapshot.totalUSD.toNumber();

    return {
      ...inner,
      freeUsd: snapshot.freeUSD.toNumber(),
      equityUsd: equityUsd,
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
      console.log(`[CapitalPoolBroker] REJECTED - invalid_desired_usd: agentId=${this.agentId}, symbol=${order.symbol}, desiredUsd=${desiredUsd.toNumber()}`);
      return this.rejectOrder(order, 'invalid_desired_usd');
    }

    const leverage = Math.max(1, Number.isFinite(order.leverage) && (order.leverage ?? 0) > 0 ? order.leverage! : 1);

    console.log(`[CapitalPoolBroker] Attempting reserve: agentId=${this.agentId}, symbol=${order.symbol}, desiredUsd=${desiredUsd.toNumber()}, leverage=${leverage}`);

    const reservation = await this.capital.reserve({
      agentId: this.agentId,
      symbol: order.symbol,
      requestedUSD: desiredUsd,
      minUSD: this.minOrderUsd,
      leverage,
    });

    if (!reservation) {
      const snapshot = await this.capital.getBalance();
      
      // Calculate detailed capital breakdown for debugging
      const totalFree = snapshot.freeUSD.toNumber();
      const reserved = snapshot.reservedUSD.toNumber();
      const inPositions = snapshot.inPositionsUSD.toNumber();
      const actuallyAvailable = totalFree - reserved - inPositions;
      const requestedMargin = desiredUsd.toNumber() / leverage;
      
      // Get symbol-specific limits
      const symbolExposureUsd = this.capital.getSymbolExposureUsd(order.symbol).toNumber();
      const totalCapital = snapshot.totalUSD.toNumber();
      const symbolCapPct = 0.50; // Default from capitalConfig
      const symbolCap = totalCapital * symbolCapPct;
      const symbolRoom = Math.max(0, symbolCap - symbolExposureUsd);
      
      console.log(`[CapitalPoolBroker] ❌ REJECTED - capital_reservation_failed`);
      console.log(`  Agent: ${this.agentId}, Symbol: ${order.symbol}`);
      console.log(`  Pool State:`);
      console.log(`    Total:          $${totalFree.toFixed(2)}`);
      console.log(`    Reserved:       $${reserved.toFixed(2)} (pending orders)`);
      console.log(`    In Positions:   $${inPositions.toFixed(2)} (open trades)`);
      console.log(`    Actually Free:  $${actuallyAvailable.toFixed(2)}`);
      console.log(`  Request:`);
      console.log(`    Notional:       $${desiredUsd.toNumber().toFixed(2)}`);
      console.log(`    Leverage:       ${leverage}x`);
      console.log(`    Margin Needed:  $${requestedMargin.toFixed(2)}`);
      console.log(`    Min Order:      $${this.minOrderUsd.toNumber().toFixed(2)}`);
      console.log(`  Symbol Limits (${order.symbol}):`);
      console.log(`    Current Exposure: $${symbolExposureUsd.toFixed(2)}`);
      console.log(`    Symbol Cap:       $${symbolCap.toFixed(2)} (${(symbolCapPct * 100).toFixed(0)}% of pool)`);
      console.log(`    Symbol Room:      $${symbolRoom.toFixed(2)}`);
      console.log(`  ❌ Rejection Reason:`);
      
      let blockedReason = '';
      if (requestedMargin < this.minOrderUsd.toNumber()) {
        console.log(`    Margin ($${requestedMargin.toFixed(2)}) < Min Order ($${this.minOrderUsd.toNumber().toFixed(2)})`);
        blockedReason = `margin_below_minimum: margin=${requestedMargin.toFixed(2)}, min=${this.minOrderUsd.toNumber().toFixed(2)}`;
      } else if (symbolRoom < requestedMargin) {
        console.log(`    Symbol limit reached: room=$${symbolRoom.toFixed(2)} < needed=$${requestedMargin.toFixed(2)}`);
        blockedReason = `symbol_cap_exceeded: exposure=${symbolExposureUsd.toFixed(2)}, cap=${symbolCap.toFixed(2)}, needed=${requestedMargin.toFixed(2)}`;
      } else if (actuallyAvailable < requestedMargin) {
        console.log(`    Insufficient free capital: available=$${actuallyAvailable.toFixed(2)} < needed=$${requestedMargin.toFixed(2)}`);
        blockedReason = `insufficient_capital: available=${actuallyAvailable.toFixed(2)}, needed=${requestedMargin.toFixed(2)}, reserved=${reserved.toFixed(2)}, inPositions=${inPositions.toFixed(2)}`;
      } else {
        console.log(`    Unknown reason - this shouldn't happen!`);
        blockedReason = `unknown: available=${actuallyAvailable.toFixed(2)}, needed=${requestedMargin.toFixed(2)}`;
      }
      
      // Log capital reservation failure with detailed reason
      logTradeEvaluation({
        symbol: order.symbol,
        decision: 'order_blocked_capital',
        blockedReason,
        confidenceScore: order._evaluationContext?.confidence ?? 0.5,
        inputMetrics: order._evaluationContext?.inputMetrics ?? {},
        regimeContext: order._evaluationContext?.regimeContext,
      }).catch(err => console.warn('Failed to log capital block:', err));
      
      return this.rejectOrder(order, 'capital_reservation_failed');
    }

    console.log(`[CapitalPoolBroker] Reserved successfully: granted=${reservation.grantedUSD.toNumber()}, placing order...`);

    try {
      const placed = await this.broker.place(order);
      const filledUsd = this.resolveFilledUsd(order, placed);
      if (!placed || placed.status === 'rejected' || filledUsd.raw <= ZERO_USD.raw) {
        await this.capital.release(reservation.id);
        return placed;
      }

      const filledMarginUsd = new PreciseDecimal(filledUsd.toNumber() / leverage);
      await this.capital.commit(reservation.id, filledMarginUsd);
      return placed;
    } catch (error) {
      await this.capital.release(reservation.id);
      throw error;
    }
  }

  async cancel(id: string): Promise<void> {
    await this.broker.cancel(id);
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
    const releasedNotional = Number((placed as any)?.releasedNotionalUsd ?? 0);
    const pnlDelta = Number((placed as any)?.realizedPnlUsd ?? 0);

    if (releasedNotional > 0) {
      await this.capital.settle(
        `${this.agentId}:${order.symbol}`,
        order.symbol,
        new PreciseDecimal(releasedNotional),
      );
    }

    if (Number.isFinite(pnlDelta) && pnlDelta !== 0) {
      await this.capital.applyPnlDelta(this.agentId, order.symbol, new PreciseDecimal(pnlDelta));
    }
  }
}
