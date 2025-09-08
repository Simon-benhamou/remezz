import { PlanJson } from './planSchema.js';
import { buildTechSnapshot } from '../ai/tech.js';
import { sizeUsd } from '../risk/sizing.js';
import { getTicker } from '../data/market.js';

export type ValidatedPlan = {
  plan: PlanJson;
  symbol: string;
  tf: string;
  bias: 'long'|'short'|'none';
  zone: { from: number; to: number; mid: number };
  atr: number; // absolute ATR (price units)
  atrPct: number; // percent of price
  stopDistance: number; // absolute distance from entry mid
  rPrices: { r: number; price: number }[]; // TP ladder from R multiples
  entryOkNow: boolean; // never true blindly: requires trigger confirmation elsewhere
  sizing: {
    riskPct: number;
    maxLev: number;
    notionalUsd: number; // position notional (capped by leverage)
  };
  guards: {
    spreadOk: boolean;
    leverageOk: boolean;
    volumeOk: boolean | null; // null if unknown
  };
};

export async function validatePlan(plan: PlanJson): Promise<ValidatedPlan> {
  const snap = await buildTechSnapshot(plan.symbol);
  const tf = plan.timeframe || '1h';

  // Auto-detect zone from S/R if price is null
  const near = plan.zone.type === 'support' ? snap.support : snap.resistance;
  const ref = Number.isFinite(near) ? near : (plan.zone.type === 'support' ? Math.min(...snap.supports.map(s=>s.price)) : Math.max(...snap.resistances.map(r=>r.price)));

  // Make a narrow zone around ref using max_distance_pct
  const maxDistPct = Math.max(0.1, Math.min(5, plan.entry_rule.max_distance_pct || 0.4));
  const half = ref * (maxDistPct/100);
  const from = plan.zone.type === 'support' ? ref - half : ref - half; // symmetric small band
  const to   = plan.zone.type === 'support' ? ref + half : ref + half;
  const mid  = (from + to) / 2;

  // ATR from snapshot (14 on 15m window), fallback if needed
  const atrAbs = snap.atr14;
  const atrPct = snap.atrPct;
  const stopDistance = plan.risk.stop.mult * atrAbs;

  // R ladder prices
  const side = plan.bias === 'long' ? 1 : -1;
  const rPrices = plan.risk.tp.map(tp => ({ r: tp.value, price: mid + side * tp.value * stopDistance }));

  // Sizing (riskFraction 1–2% of balance): use session balance on UI; here we only prepare rules
  // We approximate balance from DB later; here just return notional normalized by risk
  const riskPct = plan.position.risk_fraction * 100; // convert fraction to percent
  const notionalUsd = sizeUsd(10000, riskPct, (stopDistance/mid)*100); // placeholder balance=10k; execution will replace

  // Guards: spread and leverage; volume left null by default
  const t = await getTicker(plan.symbol).catch(()=>null as any);
  let spreadOk = true;
  if (t && t.bid && t.ask) {
    const spreadPct = ((t.ask - t.bid) / ((t.ask + t.bid)/2)) * 100;
    // reject if spread > 0.15%
    spreadOk = spreadPct <= 0.15;
  }
  const leverageOk = plan.position.max_leverage <= 5;

  return {
    plan,
    symbol: plan.symbol,
    tf,
    bias: plan.bias,
    zone: { from, to, mid },
    atr: atrAbs,
    atrPct,
    stopDistance,
    rPrices,
    entryOkNow: false,
    sizing: { riskPct, maxLev: plan.position.max_leverage, notionalUsd },
    guards: { spreadOk, leverageOk, volumeOk: null },
  };
}

