import type { ActivationProfile } from "./state.js";
import { resolveRrExpectancyConfig } from "../risk/rrExpectancy.js";

function clampBudgetFraction(raw: number | undefined | null) {
  if (raw == null) return undefined;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(numeric)) return undefined;
  const safe = Math.min(1, Math.max(0.1, numeric));
  return Number.isFinite(safe) ? safe : undefined;
}

function parseMaybeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function serializeActivationProfile(profile: ActivationProfile, extras: Record<string, unknown> = {}) {
  const budgetFraction = typeof profile.budgetFraction === "number"
    ? clampBudgetFraction(profile.budgetFraction)
    : undefined;
  const budgetPct = typeof extras.budgetPct === "number"
    ? extras.budgetPct
    : budgetFraction != null
    ? Math.round(budgetFraction * 100)
    : undefined;
  const rrConfig = resolveRrExpectancyConfig({
    rrFloor: profile.rrFloor,
    rrCeil: profile.rrCeil,
    rrBaseMin: profile.rrBaseMin,
    rrExpectancy: profile.rrExpectancy,
  });

  return {
    symbol: profile.symbol,
    mode: profile.mode,
    riskPerTradePct: profile.riskPerTradePct,
    maxLeverage: profile.maxLeverage,
    requestedMaxLeverage: profile.requestedMaxLeverage,
    leverageCap: profile.leverageCap,
    dailyLossLimitPct: profile.dailyLossLimitPct,
    budgetFraction,
    budgetPct,
    aggressiveness: profile.aggressiveness,
    startBalanceUsd: profile.startBalanceUsd,
    timestamp: profile.timestamp,
    sizingMode: profile.sizingMode,
    dynamicLeverage: profile.dynamicLeverage,
    minLeverage: profile.minLeverage,
    userId: profile.userId,
    rrFloor: rrConfig.rrFloor,
    rrCeil: rrConfig.rrCeil,
    rrBaseMin: rrConfig.rrBaseMin,
    rrExpectancy: {
      enabled: rrConfig.enabled,
      minTrades: rrConfig.minTrades,
      lookbackDays: rrConfig.lookbackDays,
      decay: rrConfig.decay,
      safetyMult: rrConfig.safetyMult,
      blend: rrConfig.blend,
      hysteresis: rrConfig.hysteresis,
    },
    ...extras,
  } as Record<string, unknown>;
}

type SessionRecord = {
  id: string;
  symbol: string;
  mode: string;
  startBalanceUsd: number | null;
  userId: string | null;
  startedAt: Date;
  profileJson: unknown;
  rrFloor?: number | null;
  rrCeil?: number | null;
  rrBaseMin?: number | null;
  rrExpectancy?: unknown;
};

export function hydrateActivationProfile(session: SessionRecord): ActivationProfile | null {
  const stored = (session.profileJson ?? {}) as Record<string, any>;
  const leverageCap = stored?.leverageCap ?? undefined;
  const requestedMaxLeverage = parseMaybeNumber(
    stored?.requestedMaxLeverage ?? leverageCap?.requested ?? stored?.maxLeverage
  );
  const resolvedMaxLeverage = parseMaybeNumber(
    leverageCap?.resolved ?? stored?.maxLeverage ?? requestedMaxLeverage
  );
  const riskPerTradePct = parseMaybeNumber(stored?.riskPerTradePct);
  const dailyLossLimitPct = parseMaybeNumber(stored?.dailyLossLimitPct);
  const rrFloorRaw = parseMaybeNumber(stored?.rrFloor ?? (session as any).rrFloor);
  const rrCeilRaw = parseMaybeNumber(stored?.rrCeil ?? (session as any).rrCeil);
  const rrBaseMinRaw = parseMaybeNumber(stored?.rrBaseMin ?? (session as any).rrBaseMin);
  const rrExpectancyRaw = stored?.rrExpectancy ?? (session as any).rrExpectancy ?? undefined;
  const rrConfig = resolveRrExpectancyConfig({
    rrFloor: rrFloorRaw,
    rrCeil: rrCeilRaw,
    rrBaseMin: rrBaseMinRaw,
    rrExpectancy: typeof rrExpectancyRaw === 'object' && rrExpectancyRaw !== null ? rrExpectancyRaw : undefined,
  });

  if (!riskPerTradePct || !resolvedMaxLeverage || !dailyLossLimitPct) {
    return null;
  }

  const budgetFractionFromStored = typeof stored?.budgetFraction === "number"
    ? stored.budgetFraction
    : undefined;
  const budgetPct = parseMaybeNumber(stored?.budgetPct);
  const budgetFraction = clampBudgetFraction(
    budgetFractionFromStored != null
      ? budgetFractionFromStored
      : budgetPct != null
      ? (budgetPct > 1 ? budgetPct / 100 : budgetPct)
      : undefined
  );

  const minLeverage = parseMaybeNumber(stored?.minLeverage);
  const timestamp = typeof stored?.timestamp === "string"
    ? stored.timestamp
    : session.startedAt instanceof Date
    ? session.startedAt.toISOString()
    : new Date().toISOString();

  const profile: ActivationProfile = {
    symbol: session.symbol,
    mode: (session.mode === "live" ? "live" : "paper"),
    maxLeverage: Math.max(1, Math.min(10, resolvedMaxLeverage)),
    requestedMaxLeverage: Math.max(1, Math.min(10, requestedMaxLeverage ?? resolvedMaxLeverage)),
    leverageCap: leverageCap,
    riskPerTradePct: Math.max(0.5, Math.min(5, riskPerTradePct)),
    dailyLossLimitPct: Math.max(3, Math.min(4, dailyLossLimitPct)),
    timestamp,
    startBalanceUsd: typeof stored?.startBalanceUsd === "number"
      ? stored.startBalanceUsd
      : typeof session.startBalanceUsd === "number"
      ? session.startBalanceUsd
      : undefined,
    budgetFraction: budgetFraction ?? undefined,
    aggressiveness:
      stored?.aggressiveness === "conservative" || stored?.aggressiveness === "aggressive"
        ? stored.aggressiveness
        : "reactive",
    userId: session.userId ?? stored?.userId ?? undefined,
    sizingMode: stored?.sizingMode,
    dynamicLeverage: stored?.dynamicLeverage,
    minLeverage: minLeverage != null ? Math.max(1, Math.min(minLeverage, resolvedMaxLeverage)) : undefined,
    rrFloor: rrConfig.rrFloor,
    rrCeil: rrConfig.rrCeil,
    rrBaseMin: rrConfig.rrBaseMin,
    rrExpectancy: {
      enabled: rrConfig.enabled,
      minTrades: rrConfig.minTrades,
      lookbackDays: rrConfig.lookbackDays,
      decay: rrConfig.decay,
      safetyMult: rrConfig.safetyMult,
      blend: rrConfig.blend,
      hysteresis: rrConfig.hysteresis,
    },
  };

  return profile;
}
