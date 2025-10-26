import { Broker, NewOrder, PlacedOrder, BrokerMarginSnapshot, BrokerPositionMargin, BrokerCorrelatedExposure } from './types.js';
import { getTicker, getOHLCV } from '../data/market.js';
import { fetchDepth } from '../data/depth.js';
import { walkBook } from '../exec/bookWalkSlippage.js';
import { getIntradayRuntimeConfig } from '../config/intraday.js';
import { getConfig } from '../utils/env.js';

type SimulatedFill = {
  vwap: number | null;
  bestPrice: number | null;
  impactBps: number;
  filled: number;
  usedDepth: boolean;
  fallback: boolean;
};

type TradeResult = {
  releasedNotionalUsd: number;
  realizedPnlUsd: number;
};

async function simulateBookFill(symbol: string, side: 'buy'|'sell', qty: number, userId?: string): Promise<SimulatedFill> {
  if (!(qty > 0)) {
    return { vwap: null, bestPrice: null, impactBps: 0, filled: 0, usedDepth: false, fallback: true };
  }

  const { slip } = getIntradayRuntimeConfig();
  if (!slip.bookWalkEnabled) {
    return { vwap: null, bestPrice: null, impactBps: 0, filled: qty, usedDepth: false, fallback: true };
  }

  try {
    const depth = await fetchDepth(symbol, slip.depthLevels, userId);
    if (!depth) {
      return { vwap: null, bestPrice: null, impactBps: 0, filled: qty, usedDepth: false, fallback: true };
    }
    const walked = walkBook(side, qty, depth);
    if (!(walked.filled > 0) || walked.fallback) {
      return {
        vwap: walked.vwap || null,
        bestPrice: walked.best || null,
        impactBps: walked.impactBps || 0,
        filled: walked.filled > 0 ? walked.filled : qty,
        usedDepth: walked.filled > 0,
        fallback: true,
      };
    }
    return {
      vwap: walked.vwap,
      bestPrice: walked.best,
      impactBps: walked.impactBps,
      filled: walked.filled,
      usedDepth: true,
      fallback: false,
    };
  } catch {
    return { vwap: null, bestPrice: null, impactBps: 0, filled: qty, usedDepth: false, fallback: true };
  }
}

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
    const slipBase = this.slippageToSpread * spread;
    let depthEstimate: (SimulatedFill & { impactPct?: number }) | null = null;
    const pxMarketFallback = (side: 'buy'|'sell', slipMultiplier: number) =>
      side === 'buy' ? ask + slipBase * slipMultiplier : bid - slipBase * slipMultiplier;

    // Optionally simulate liquidity and scale qty to respect max impact
    let qty = o.qty;
    try {
      const { PAPER_LIQ_SIM_ENABLED, PAPER_MAX_IMPACT_PCT, MIN_ORDER_NOTIONAL_USD } = getConfig();
      if (PAPER_LIQ_SIM_ENABLED && typeof qty === 'number' && qty > 0 && mid > 0) {
        const est = await this.estimateFillableQty({ symbol: o.symbol, side: o.side, desiredQty: qty, maxImpactPct: PAPER_MAX_IMPACT_PCT as any });
        if (est && typeof (est as any).fillableQty === 'number') {
          qty = Math.max(0, Number((est as any).fillableQty));
        }
        if (est) {
          const estAny = est as any;
          depthEstimate = {
            vwap: estAny.vwap ?? null,
            bestPrice: estAny.bestPrice ?? null,
            impactBps: estAny.simImpactBps ?? ((est.impactPct ?? 0) * 100),
            filled: estAny.fillableQty ?? qty,
            usedDepth: Boolean(estAny.usedDepth),
            fallback: Boolean(estAny.simFallback ?? estAny.fallback),
            impactPct: est.impactPct,
          };
        }
        if (qty * mid < MIN_ORDER_NOTIONAL_USD) {
          const id = `paper_rejected_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
          return { ...o, id, status: 'rejected', ts: Date.now() } as PlacedOrder;
        }
      }
    } catch {}

    if (!(qty > 0)) {
      const id = `paper_rejected_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
      return { ...o, id, status: 'rejected', ts: Date.now() } as PlacedOrder;
    }

    if (!depthEstimate) {
      const sim = await simulateBookFill(o.symbol, o.side, qty);
      depthEstimate = { ...sim, impactPct: sim.impactBps / 100 };
    }

    const { slip } = getIntradayRuntimeConfig();
    const useDepthPrice = Boolean(
      o.type === 'market'
        && depthEstimate
        && depthEstimate.vwap != null
        && depthEstimate.usedDepth
        && !depthEstimate.fallback,
    );
    const slipMultiplier = depthEstimate?.fallback ? slip.fallbackInflation : 1;

    const px = o.type === 'market'
      ? useDepthPrice
        ? (depthEstimate!.vwap as number)
        : pxMarketFallback(o.side, slipMultiplier)
      : (o.price!);

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
      fillRatio: o.qty > 0 ? Math.min(1, qty / o.qty) : 1,
    };

    const bestPx = o.side === 'buy' ? ask : bid;
    const simImpactBps = (() => {
      if (useDepthPrice && depthEstimate) {
        return Math.max(0, depthEstimate.impactBps);
      }
      if (o.type === 'market' && bestPx > 0) {
        const impact = Math.abs(px - bestPx) / bestPx * 10_000;
        return Number.isFinite(impact) ? impact : 0;
      }
      return undefined;
    })();

    if (simImpactBps !== undefined) {
      out.slippageBps = simImpactBps;
      out.simImpactBps = simImpactBps;
    }
    out.usedDepth = useDepthPrice;
    out.depthFallback = Boolean(depthEstimate?.fallback);

    this.balanceUsd -= fee; // fees paid
    const tradeResult = this.applyFilledTrade(o.symbol, o.side, qty, px, lev);
    if (tradeResult) {
      (out as any).releasedNotionalUsd = tradeResult.releasedNotionalUsd;
      (out as any).realizedPnlUsd = tradeResult.realizedPnlUsd;
    }
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

  private applyFilledTrade(symbol: string, side: 'buy'|'sell', qty: number, price: number, leverage: number): TradeResult {
    if (!(qty > 0) || !(price > 0)) return { releasedNotionalUsd: 0, realizedPnlUsd: 0 };
    const legs = this.positions.get(symbol) ?? [];
    const opposite = side === 'buy' ? 'short' : 'long';
    const aligned = side === 'buy' ? 'long' : 'short';
    let remaining = qty;
    const EPS = 1e-8;
    let releasedNotionalUsd = 0;
    let realizedPnlUsd = 0;

    // First, offset opposite legs (closing positions)
    for (let i = 0; i < legs.length && remaining > EPS; ) {
      const leg = legs[i];
      if (leg.side !== opposite || leg.qty <= EPS) {
        i++;
        continue;
      }
      const legQtyBefore = leg.qty;
      const legNotionalBefore = leg.notionalUsd;
      const legMarginBefore = leg.marginUsd;
      const closedQty = Math.min(legQtyBefore, remaining);
      if (!(closedQty > 0) || !(legQtyBefore > EPS)) {
        i++;
        continue;
      }
      const proportion = closedQty / legQtyBefore;
      const marginRelease = legMarginBefore * proportion;
      const notionalRelease = legNotionalBefore * proportion;
      const entryNotionalPortion = notionalRelease;
      const exitNotional = closedQty * price;
      const pnlPortion = leg.side === 'long'
        ? exitNotional - entryNotionalPortion
        : entryNotionalPortion - exitNotional;

      leg.qty -= closedQty;
      leg.marginUsd -= marginRelease;
      leg.notionalUsd -= notionalRelease;
      remaining -= closedQty;

      this.marginReservedUsd = Math.max(0, this.marginReservedUsd - marginRelease);
      this.totalNotionalUsd = Math.max(0, this.totalNotionalUsd - notionalRelease);
      releasedNotionalUsd += entryNotionalPortion;
      realizedPnlUsd += pnlPortion;

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
    if (realizedPnlUsd !== 0) {
      this.balanceUsd = Math.max(0, this.balanceUsd + realizedPnlUsd);
    }

    return { releasedNotionalUsd, realizedPnlUsd };
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

  async estimateFillableQty(params: { symbol: string; side: 'buy'|'sell'; desiredQty: number; maxImpactPct?: number }) {
    const cfg = getConfig();
    const { slip } = getIntradayRuntimeConfig();
    const symbol = params.symbol;
    const maxImpactPct = Math.max(0, Number(params.maxImpactPct ?? cfg.PAPER_MAX_IMPACT_PCT));
    try {
      const [t, o15] = await Promise.all([
        getTicker(symbol).catch(()=>null as any),
        getOHLCV(symbol, '15m', 30).catch(()=>null as any),
      ]);
      const price = Number(t?.last || t?.close || t?.ask || t?.bid || 0);
      const desiredQty = Math.max(0, params.desiredQty || 0);
      if (!(desiredQty > 0) || !(price > 0)) {
        return { fillableQty: desiredQty, impactPct: 0, vwap: price, bestPrice: price, usedDepth: false, simFallback: true } as any;
      }

      let volBase = 0;
      if (Array.isArray(o15) && o15.length) {
        const last = o15[o15.length - 1];
        volBase = Number(last?.[5] || 0);
      }
      const volUsd15m = price > 0 ? volBase * price : 0;

      const depthSim = await simulateBookFill(symbol, params.side, desiredQty);
      let fillableQty = Math.min(desiredQty, depthSim.filled > 0 ? depthSim.filled : desiredQty);
      if (!(fillableQty > 0)) {
        fillableQty = desiredQty;
      }

      const bestGuess = params.side === 'buy' ? Number(t?.ask || price) : Number(t?.bid || price);
      const bestPrice = depthSim.bestPrice ?? (Number.isFinite(bestGuess) && bestGuess > 0 ? bestGuess : price);
      let vwap = depthSim.vwap ?? bestPrice ?? price;
      let impactPct = depthSim.usedDepth && !depthSim.fallback ? Math.max(0, depthSim.impactBps / 100) : 0;

      if (volUsd15m > 0 && volUsd15m < cfg.LIQUIDITY_MIN_15M_USD) {
        const scale = Math.max(0, volUsd15m / cfg.LIQUIDITY_MIN_15M_USD);
        const scaledQty = desiredQty * Math.max(0.1, Math.min(1, scale));
        fillableQty = Math.min(fillableQty, scaledQty);
        impactPct = Math.max(impactPct, 2.5);
      }

      if (depthSim.fallback) {
        const k = 0.2;
        const orderNotional = desiredQty * price;
        const flowShare = volUsd15m > 0 ? orderNotional / volUsd15m : 0;
        const fallbackImpact = Math.max(0, Math.min(5, k * flowShare * 100)) * slip.fallbackInflation;
        if (Number.isFinite(fallbackImpact)) {
          impactPct = Math.max(impactPct, fallbackImpact);
        }
        if (!Number.isFinite(vwap) || vwap <= 0) {
          vwap = bestPrice;
        }
      }

      if (impactPct > maxImpactPct && maxImpactPct > 0) {
        const scale = maxImpactPct / Math.max(0.0001, impactPct);
        fillableQty = Math.min(fillableQty, desiredQty * Math.max(0, Math.min(1, scale)));
      }

      fillableQty = Math.max(0, Math.min(desiredQty, fillableQty));
      return {
        fillableQty,
        impactPct,
        vwap,
        bestPrice,
        usedDepth: depthSim.usedDepth && !depthSim.fallback,
        simFallback: depthSim.fallback,
        simImpactBps: depthSim.usedDepth ? depthSim.impactBps : impactPct * 100,
      } as any;
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
