import { PlanJson } from './planSchema.js';
import { buildTechSnapshot } from '../ai/tech.js';
import type { RegimeProfile } from '../ai/regime.js';
import { sizeUsd } from '../risk/sizing.js';
import { getTicker } from '../data/market.js';
import { getConfig } from '../utils/env.js';
import { classifySymbolVolatility, computeLeverageGuardForSymbol } from '../utils/riskGuards.js';

type VolProfile = 'HIGH' | 'MODERATE' | 'LOW';

const STOP_DISTANCE_MULTIPLIER_BY_VOL = {
  HIGH: 1.35,
  MODERATE: 1.1,
  LOW: 0.9,
} as const;

const STOP_DISTANCE_MAX_PCT_BY_VOL = {
  HIGH: 0.22,
  MODERATE: 0.18,
  LOW: 0.14,
} as const;

const MIN_STOP_PCT_BY_VOL = {
  HIGH: 0.65,
  MODERATE: 0.45,
  LOW: 0.32,
} as const;

const MIN_TP_PCT_BY_VOL = {
  HIGH: 1.8,
  MODERATE: 1.4,
  LOW: 1.2,
} as const;

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

function adjustedStopsPct(cfg: ReturnType<typeof getConfig>, symbol: string) {
  const prof = classifySymbolVolatility(symbol) as VolProfile | null;
  const profile: VolProfile = prof ?? 'MODERATE';
  const minStopPct = Math.max(Math.max(0, cfg.MIN_STOP_PCT), MIN_STOP_PCT_BY_VOL[profile]);
  const minTpPct = Math.max(Math.max(0, cfg.MIN_TP_PCT), MIN_TP_PCT_BY_VOL[profile]);
  const stopMultiplier = STOP_DISTANCE_MULTIPLIER_BY_VOL[profile] ?? 1;
  const maxStopPct = STOP_DISTANCE_MAX_PCT_BY_VOL[profile] ?? 0.25;
  return { minStopPct, minTpPct, stopMultiplier, maxStopPct, profile };
}

export function normalizeStopDistance(
  mid: number,
  desiredStop: number,
  minStopAbs: number,
  opts?: { maxStopPct?: number }
): number {
  const fallbackAbs = minStopAbs > 0
    ? minStopAbs
    : (mid > 0 ? mid * 0.01 : 0.0001);

  let stopDistance = Number.isFinite(desiredStop) && desiredStop > 0 ? desiredStop : fallbackAbs;
  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    stopDistance = fallbackAbs;
  }

  if (stopDistance < minStopAbs) {
    stopDistance = minStopAbs;
  }

  if (mid > 0) {
    const maxStopPct = opts?.maxStopPct != null ? Math.max(0, opts.maxStopPct) : 0.25;
    const maxStopAbs = mid * maxStopPct; // cap stops to avoid nonsensical distances
    if (maxStopAbs > 0 && Number.isFinite(maxStopAbs) && stopDistance > maxStopAbs) {
      stopDistance = Math.max(minStopAbs, maxStopAbs);
    }
  }

  if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
    stopDistance = fallbackAbs;
  }

  return stopDistance;
}

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
  const atrAbsRaw = (tf === '1h' && (snap as any).atr14_1h) ? (snap as any).atr14_1h as number : snap.atr14;
  const atrAbs = Number.isFinite(atrAbsRaw) && atrAbsRaw > 0 ? atrAbsRaw : mid * 0.01;
  const atrPct = Number.isFinite(snap.atrPct) ? snap.atrPct : ((atrAbs / Math.max(mid, 1e-8)) * 100);
  // Enforce a minimum stop distance in % of price to avoid micro moves
  const cfg = getConfig();
  const { minStopPct, minTpPct, stopMultiplier, maxStopPct } = adjustedStopsPct(cfg, plan.symbol);
  const minStopAbs = mid * (minStopPct / 100);
  const rawStopBase = Number.isFinite(plan.risk.stop.mult) && Number.isFinite(atrAbsRaw)
    ? plan.risk.stop.mult * atrAbsRaw
    : NaN;
  const tunedStop = Number.isFinite(rawStopBase) ? rawStopBase * stopMultiplier : rawStopBase;
  const stopDistance = normalizeStopDistance(mid, tunedStop, minStopAbs, { maxStopPct });

  // R ladder prices
  const side = plan.bias === 'long' ? 1 : -1;
  const firstR = plan.risk.tp?.[0]?.value ?? 1.0;
  const minTpAbs = mid * (minTpPct / 100);
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
  const leverageGuard = computeLeverageGuardForSymbol({
    symbol: plan.symbol,
    atrPct,
    volatilityTag: plan.meta?.volatility,
  });
  if (leverageGuard.cap != null && plan.position.max_leverage > leverageGuard.cap) {
    const capped = Math.max(1, Math.min(10, leverageGuard.cap));
    plan.position.max_leverage = capped;
    const note = leverageGuard.reason
      ? `[Guard] Max leverage capped at ${capped}x (${leverageGuard.reason})`
      : `[Guard] Max leverage capped at ${capped}x due to volatility guard`;
    if (!plan.notes || !plan.notes.includes('[Guard] Max leverage capped')) {
      plan.notes = plan.notes ? `${plan.notes}\n${note}` : note;
    }
    plan.meta = {
      ...(plan.meta || {}),
      leverageGuard: { cap: capped, reason: leverageGuard.reason, riskLevel: leverageGuard.riskLevel },
    } as any;
  }

  const leverageOk = plan.position.max_leverage <= 10;

  const regime = snap.regime;
  if (regime) {
    const aiPlaybook = plan.meta?.playbook;
    const finalPlaybook = aiPlaybook != null ? aiPlaybook : regime.playbook;
    plan.meta = {
      ...(plan.meta || {}),
      playbook: finalPlaybook,
      regime: regime.trend,
      volatility: regime.volatility,
    };
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
