import { Broker, NewOrder, PlacedOrder, BrokerMarginSnapshot, BrokerPositionMargin, BrokerCorrelatedExposure } from './types.js';
import { getTicker, getOHLCV } from '../data/market.js';
import { getConfig } from '../utils/env.js';

// Simple paper broker with committed balance and slippage modelling.
export class PaperBroker implements Broker {
  mode: 'paper'|'live' = 'paper';
  private balanceUsd = 10000; // updated on session start
  private marginReservedUsd = 0; // simulated margin currently locked
  private totalNotionalUsd = 0; // gross notional of open legs (for leverage cap)
  private feesBps = 5; // 0.05%
  private slippageToSpread = 0.8; // 0.8 * spread
  private positions: Map<string, PaperLeg[]> = new Map(); // track open paper legs per symbol

  constructor(startUsd?: number) {
    if (startUsd && startUsd > 0) this.balanceUsd = startUsd;
  }

  setBalanceUsd(amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    this.balanceUsd = amount;
    if (this.marginReservedUsd > this.balanceUsd) {
      this.marginReservedUsd = Math.max(0, Math.min(this.marginReservedUsd, this.balanceUsd));
    }
    if (this.totalNotionalUsd > this.balanceUsd * 10) {
      this.totalNotionalUsd = Math.max(0, Math.min(this.totalNotionalUsd, this.balanceUsd * 10));
    }
  }

  async balance(): Promise<BrokerMarginSnapshot> {
    const freeUsd = Math.max(0, this.balanceUsd - this.marginReservedUsd);
    const equityUsd = this.balanceUsd;
    const committedUsd = this.marginReservedUsd;
    const maintenanceMarginUsd = committedUsd > 0 ? committedUsd * 0.05 : undefined;
    const marginRatio = equityUsd > 0 ? committedUsd / equityUsd : undefined;
    const positions = this.snapshotPositions();
    const correlatedExposure = this.buildCorrelatedExposure(positions);
    return {
      freeUsd,
      equityUsd,
      committedUsd,
      maintenanceMarginUsd,
      marginRatio,
      marginMode: 'paper',
      positions: positions.length ? positions : undefined,
      correlatedExposure: correlatedExposure,
      timestamp: Date.now(),
    };
  }

  async place(o: NewOrder): Promise<PlacedOrder> {
    const startTs = Date.now();
    const t = await getTicker(o.symbol).catch(()=>null as any);
    const mid = t && t.last ? t.last : (o.price || 0);
    const bid = t?.bid ?? mid * 0.999;
    const ask = t?.ask ?? mid * 1.001;
    const spread = Math.max(1e-8, ask - bid);
    const slip = this.slippageToSpread * spread;

    const px = o.type === 'market' ? (o.side === 'buy' ? ask + slip : bid - slip) : (o.price!);
    // Optionally simulate liquidity and scale qty to respect max impact
    let qty = o.qty;
    try {
      const { PAPER_LIQ_SIM_ENABLED, PAPER_MAX_IMPACT_PCT, MIN_ORDER_NOTIONAL_USD } = getConfig();
      if (PAPER_LIQ_SIM_ENABLED && typeof qty === 'number' && qty > 0 && mid > 0) {
        const est = await this.estimateFillableQty({ symbol: o.symbol, desiredQty: qty, maxImpactPct: PAPER_MAX_IMPACT_PCT as any });
        if (est && typeof (est as any).fillableQty === 'number') {
          qty = (est as any).fillableQty;
        }
        if (qty * mid < MIN_ORDER_NOTIONAL_USD) {
          const id = `paper_rejected_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          return { ...o, id, status: 'rejected', ts: Date.now() } as PlacedOrder;
        }
      }
    } catch {}

    const notional = px * qty;
    const fee = (this.feesBps / 10000) * notional;

    // Margin capacity check: allow at most balanceUsd * leverage minus already committed
    const lev = Math.max(1, Math.min(10, o.leverage || 1));
    const maxNotional = this.balanceUsd * lev;
    const notionalIncrease = this.previewNotionalIncrease(o.symbol, o.side, qty, px);
    const freeCapacity = Math.max(0, maxNotional - this.totalNotionalUsd);
    if (notionalIncrease > freeCapacity + 1e-9) {
      const id = `paper_rejected_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      return { ...o, id, status: 'rejected', ts: Date.now() } as PlacedOrder;
    }

    const id = `paper_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const out: PlacedOrder = {
      ...o, id,
      status: 'filled',
      avgPrice: px,
      filledQty: qty,
      ts: Date.now(),
      latencyMs: Math.max(0, Date.now() - startTs),
      requestedQty: o.qty,
      requestedPrice: o.type === 'limit' ? o.price : undefined,
      fillRatio: 1,
    };

    // Simplified PnL handling will be done by agent engine on exit
    this.balanceUsd -= fee; // fees paid
    this.applyFilledTrade(o.symbol, o.side, qty, px, lev);
    return out;
  }

  async cancel(_id: string) { /* no-op for filled instantly */ }

  // Release reserved notional on position close (approximate)
  releaseCommitted(usd: number) {
    if (!Number.isFinite(usd)) return;
    this.marginReservedUsd = Math.max(0, this.marginReservedUsd - Math.max(0, usd));
  }

  private previewNotionalIncrease(symbol: string, side: 'buy'|'sell', qty: number, price: number): number {
    if (!(qty > 0) || !(price > 0)) return 0;
    const legs = this.positions.get(symbol);
    if (!legs || !legs.length) return qty * price;
    const opposite = side === 'buy' ? 'short' : 'long';
    const oppositeQty = legs
      .filter((leg) => leg.side === opposite)
      .reduce((sum, leg) => sum + leg.qty, 0);
    const additionalQty = Math.max(0, qty - oppositeQty);
    return additionalQty * price;
  }

  private applyFilledTrade(symbol: string, side: 'buy'|'sell', qty: number, price: number, leverage: number) {
    if (!(qty > 0) || !(price > 0)) return;
    const legs = this.positions.get(symbol) ?? [];
    const opposite = side === 'buy' ? 'short' : 'long';
    const aligned = side === 'buy' ? 'long' : 'short';
    let remaining = qty;
    const EPS = 1e-8;

    // First, offset opposite legs (closing positions)
    for (let i = 0; i < legs.length && remaining > EPS; ) {
      const leg = legs[i];
      if (leg.side !== opposite || leg.qty <= EPS) {
        i++;
        continue;
      }
      const closedQty = Math.min(leg.qty, remaining);
      const proportion = closedQty / leg.qty;
      const marginRelease = leg.marginUsd * proportion;
      const notionalRelease = leg.notionalUsd * proportion;

      leg.qty -= closedQty;
      leg.marginUsd -= marginRelease;
      leg.notionalUsd -= notionalRelease;
      remaining -= closedQty;

      this.marginReservedUsd = Math.max(0, this.marginReservedUsd - marginRelease);
      this.totalNotionalUsd = Math.max(0, this.totalNotionalUsd - notionalRelease);

      if (leg.qty <= EPS || leg.notionalUsd <= EPS) {
        legs.splice(i, 1);
      } else {
        i++;
      }
    }

    // Any remaining quantity opens / adds to aligned side exposure
    if (remaining > EPS) {
      const notional = remaining * price;
      const margin = notional / Math.max(1, leverage);
      legs.push({
        side: aligned,
        qty: remaining,
        notionalUsd: notional,
        marginUsd: margin,
      });
      this.marginReservedUsd += margin;
      this.totalNotionalUsd += notional;
    }

    if (legs.length) this.positions.set(symbol, legs);
    else this.positions.delete(symbol);

    this.marginReservedUsd = Math.max(0, this.marginReservedUsd);
    this.totalNotionalUsd = Math.max(0, this.totalNotionalUsd);
  }

  private snapshotPositions(): BrokerPositionMargin[] {
    const positions: BrokerPositionMargin[] = [];
    for (const [symbol, legs] of this.positions.entries()) {
      for (const leg of legs) {
        if (!(leg.qty > 0) || !(leg.notionalUsd > 0)) continue;
        const entryPrice = leg.notionalUsd / leg.qty;
        const leverage = leg.marginUsd > 0 ? leg.notionalUsd / leg.marginUsd : undefined;
        positions.push({
          symbol,
          side: leg.side,
          qty: leg.qty,
          notionalUsd: leg.notionalUsd,
          entryPrice,
          leverage,
          initialMarginUsd: leg.marginUsd,
        });
      }
    }
    return positions;
  }

  private buildCorrelatedExposure(positions: BrokerPositionMargin[]): Record<string, BrokerCorrelatedExposure> | undefined {
    if (!positions.length) return undefined;
    const map: Record<string, BrokerCorrelatedExposure> = {};
    for (const pos of positions) {
      const notional = Math.abs(pos.notionalUsd || 0);
      if (!(notional > 0)) continue;
      const [baseRaw, quoteRaw] = pos.symbol.includes('/') ? pos.symbol.split('/') : [pos.symbol, undefined];
      const base = baseRaw;
      const quote = quoteRaw ? quoteRaw.split(':')[0] : undefined;
      const key = base || pos.symbol;
      if (!map[key]) {
        map[key] = {
          key,
          base,
          quote,
          totalNotionalUsd: 0,
          longNotionalUsd: 0,
          shortNotionalUsd: 0,
          positions: [],
        };
      }
      const bucket = map[key];
      bucket.totalNotionalUsd += notional;
      if (pos.side === 'long') bucket.longNotionalUsd += notional;
      else bucket.shortNotionalUsd += notional;
      if (!bucket.positions.includes(pos.symbol)) bucket.positions.push(pos.symbol);
    }

    const totalExposure = Object.values(map).reduce((sum, entry) => sum + entry.totalNotionalUsd, 0);
    if (totalExposure > 0) {
      for (const entry of Object.values(map)) {
        entry.concentrationPct = (entry.totalNotionalUsd / totalExposure) * 100;
      }
    }
    return map;
  }

  async syncProtective(_params: { symbol: string; side: 'buy'|'sell'; qty: number; stopLoss?: number; takeProfit?: number | number[] }) {
    return {};
  }

  async estimateFillableQty(params: { symbol: string; desiredQty: number; maxImpactPct?: number }) {
    const cfg = getConfig();
    const symbol = params.symbol;
    const maxImpactPct = Math.max(0, Number(params.maxImpactPct ?? cfg.PAPER_MAX_IMPACT_PCT));
    try {
      const t = await getTicker(symbol).catch(()=>null as any);
      const price = Number(t?.last || t?.close || t?.ask || t?.bid || 0);
      const o15 = await getOHLCV(symbol, '15m', 30).catch(()=>null as any);
      let volBase = 0;
      if (Array.isArray(o15) && o15.length) {
        const last = o15[o15.length - 1];
        volBase = Number(last?.[5] || 0);
      }
      const volUsd15m = price > 0 ? volBase * price : 0;
      const desiredQty = Math.max(0, params.desiredQty || 0);
      if (!(desiredQty > 0) || !(price > 0)) return { fillableQty: desiredQty, impactPct: 0 } as any;

      // If extremely low recent volume, scale down aggressively
      if (volUsd15m > 0 && volUsd15m < cfg.LIQUIDITY_MIN_15M_USD) {
        const scale = Math.max(0, volUsd15m / cfg.LIQUIDITY_MIN_15M_USD);
        const scaledQty = desiredQty * Math.max(0.1, Math.min(1, scale));
        return { fillableQty: scaledQty, impactPct: 2.5 } as any;
      }

      // Simple impact model: impactPct ≈ k * (orderNotional / 15mVolUsd) * 100
      const k = 0.2; // 0.2% impact per 1% of 15m flow consumed
      const orderNotional = desiredQty * price;
      const flowShare = volUsd15m > 0 ? orderNotional / volUsd15m : 0;
      const impactPct = Math.max(0, Math.min(5, k * flowShare * 100));
      if (impactPct <= maxImpactPct) return { fillableQty: desiredQty, impactPct } as any;
      // Scale down to fit max impact
      const scale = maxImpactPct > 0 ? (maxImpactPct / Math.max(0.0001, impactPct)) : 0;
      const fillableQty = desiredQty * Math.max(0, Math.min(1, scale));
      return { fillableQty, impactPct } as any;
    } catch {
      return { fillableQty: params.desiredQty } as any;
    }
  }
}

type PaperLeg = {
  side: 'long'|'short';
  qty: number;
  notionalUsd: number;
  marginUsd: number;
};
