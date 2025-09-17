import { PlanJson } from './planSchema.js';
import { buildTechSnapshot } from '../ai/tech.js';
import type { RegimeProfile } from '../ai/regime.js';
import { sizeUsd } from '../risk/sizing.js';
import { getTicker } from '../data/market.js';
import { getConfig } from '../utils/env.js';

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
  regime?: RegimeProfile;
};

export async function validatePlan(plan: PlanJson): Promise<ValidatedPlan> {
  const snap = await buildTechSnapshot(plan.symbol);
  const tf = plan.timeframe || '1h';

  if (plan.position.risk_fraction_range?.recommended != null) {
    plan.position.risk_fraction = plan.position.risk_fraction_range.recommended;
  }

  // Auto-detect zone from S/R if price is null
  const near = plan.zone.type === 'support' ? snap.support : snap.resistance;
  const ref = Number.isFinite(near) ? near : (plan.zone.type === 'support' ? Math.min(...snap.supports.map(s=>s.price)) : Math.max(...snap.resistances.map(r=>r.price)));

  // Make a narrow zone around ref using max_distance_pct
  const maxDistPct = Math.max(0.1, Math.min(5, plan.entry_rule.max_distance_pct || 0.4));
  const half = ref * (maxDistPct/100);
  const from = plan.zone.type === 'support' ? ref - half : ref - half; // symmetric small band
  const to   = plan.zone.type === 'support' ? ref + half : ref + half;
  const mid  = (from + to) / 2;

  // ATR: prefer 1h ATR when plan timeframe is 1h, else 15m
  const atrAbs = (tf === '1h' && (snap as any).atr14_1h) ? (snap as any).atr14_1h as number : snap.atr14;
  const atrPct = snap.atrPct;
  // Enforce a minimum stop distance in % of price to avoid micro moves
  const cfg = getConfig();
  const minStopAbs = mid * (Math.max(0, cfg.MIN_STOP_PCT) / 100);
  const rawStop = plan.risk.stop.mult * atrAbs;
  const stopDistance = Math.max(rawStop, minStopAbs);

  // R ladder prices
  const side = plan.bias === 'long' ? 1 : -1;
  const firstR = plan.risk.tp?.[0]?.value ?? 1.0;
  const minTpAbs = mid * (Math.max(0, cfg.MIN_TP_PCT) / 100);
  const minRFromPct = stopDistance > 0 ? (minTpAbs / stopDistance) : firstR;
  const minFirstR = Math.max(cfg.MIN_FIRST_R, minRFromPct);
  const shift = Math.max(0, minFirstR - firstR);
  const rPrices = plan.risk.tp.map(tp => {
    const rEff = tp.value + shift;
    return { r: rEff, price: mid + side * rEff * stopDistance };
  });

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

  const regime = snap.regime;
  if (regime) {
    plan.meta = { ...(plan.meta || {}), playbook: regime.playbook, regime: regime.trend, volatility: regime.volatility };
  }

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
    regime,
  };
}
