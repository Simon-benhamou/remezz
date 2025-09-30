import { Broker, NewOrder, PlacedOrder } from './types.js';
import { getTicker, getOHLCV } from '../data/market.js';
import { getConfig } from '../utils/env.js';

// Simple paper broker with committed balance and slippage modelling.
export class PaperBroker implements Broker {
  mode: 'paper'|'live' = 'paper';
  private balanceUsd = 10000; // updated on session start
  private committedUsd = 0;
  private feesBps = 5; // 0.05%
  private slippageToSpread = 0.8; // 0.8 * spread

  constructor(startUsd?: number) {
    if (startUsd && startUsd > 0) this.balanceUsd = startUsd;
  }

  async balance() {
    return { freeUsd: Math.max(0, this.balanceUsd - this.committedUsd), equityUsd: this.balanceUsd, committedUsd: this.committedUsd };
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
    const freeCapacity = Math.max(0, maxNotional - this.committedUsd);
    if (notional > freeCapacity) {
      const id = `paper_rejected_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      return { ...o, id, status: 'rejected', ts: Date.now() } as PlacedOrder;
    }

    this.committedUsd += notional; // reserve margin capacity

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
    return out;
  }

  async cancel(_id: string) { /* no-op for filled instantly */ }

  // Release reserved notional on position close (approximate)
  releaseCommitted(usd: number) {
    if (!Number.isFinite(usd)) return;
    this.committedUsd = Math.max(0, this.committedUsd - Math.max(0, usd));
  }

  async syncProtective(_params: { symbol: string; side: 'buy'|'sell'; qty: number; stopLoss?: number; takeProfit?: number }) {
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
