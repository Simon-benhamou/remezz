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
  const price = snap.last;
  const supports = snap.supports || [];
  const resistances = snap.resistances || [];

  const near = plan.zone.type === 'support' ? snap.support : snap.resistance;
  const fallbackSupport = supports.length ? Math.min(...supports.map(s => s.price)) : price * 0.97;
  const fallbackResistance = resistances.length ? Math.max(...resistances.map(r => r.price)) : price * 1.03;
  let center = Number.isFinite(near) ? near : (plan.zone.type === 'support' ? fallbackSupport : fallbackResistance);

  // Make a narrow zone around center using max_distance_pct
  const maxDistPct = Math.max(0.1, Math.min(5, plan.entry_rule.max_distance_pct || 0.4));
  let half = Math.max(center * (maxDistPct / 100), price * 0.001);

  // Ensure zone is on the correct side of the current price
  const buffer = price * 0.0005; // 0.05%
  if (plan.bias === 'long') {
    if (center >= price) {
      center = price - Math.max(buffer, price * (maxDistPct / 400));
    }
    if (center + half >= price - buffer) {
      const shift = (center + half) - (price - buffer);
      center -= shift;
    }
  } else if (plan.bias === 'short') {
    if (center <= price) {
      center = price + Math.max(buffer, price * (maxDistPct / 400));
    }
    if (center - half <= price + buffer) {
      const shift = (price + buffer) - (center - half);
      center += shift;
    }
  }

  let from = center - half;
  let to = center + half;
  if (from < 0) {
    const shift = -from;
    from += shift;
    to += shift;
    center += shift;
  }
  if (to <= from) {
    to = from + Math.max(buffer, price * 0.0001);
  }
  const mid = (from + to) / 2;

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
  const leverageOk = plan.position.max_leverage <= 10;

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
