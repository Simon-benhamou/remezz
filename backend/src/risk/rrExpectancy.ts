export type RRExpectancyConfig = {
  rrFloor: number;
  rrCeil: number;
  rrBaseMin: number;
  enabled: boolean;
  minTrades: number;
  lookbackDays: number;
  decay: number;
  safetyMult: number;
  blend: number;
  hysteresis: number;
};

export type RRExpectancyOverrides = {
  rrFloor?: number | null;
  rrCeil?: number | null;
  rrBaseMin?: number | null;
  rrExpectancy?: Partial<{
    enabled: boolean;
    minTrades: number;
    lookbackDays: number;
    decay: number;
    safetyMult: number;
    blend: number;
    hysteresis: number;
  }> | null;
};

const DEFAULTS: RRExpectancyConfig = {
  rrFloor: 1.0,
  rrCeil: 2.0,
  rrBaseMin: 1.25,
  enabled: true,
  minTrades: 40,
  lookbackDays: 30,
  decay: 0.9,
  safetyMult: 1.0,
  blend: 0.45,
  hysteresis: 0.05,
};

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return value;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clampR(value: number, cfg: RRExpectancyConfig): number {
  return clampNum(value, cfg.rrFloor, cfg.rrCeil);
}

export const DEFAULT_RR_EXPECTANCY_CONFIG: RRExpectancyConfig = { ...DEFAULTS };

export function resolveRrExpectancyConfig(input?: RRExpectancyOverrides | null): RRExpectancyConfig {
  const rrFloorRaw = typeof input?.rrFloor === 'number' ? input!.rrFloor : DEFAULTS.rrFloor;
  const rrCeilRaw = typeof input?.rrCeil === 'number' ? input!.rrCeil : DEFAULTS.rrCeil;
  let rrFloor = Number.isFinite(rrFloorRaw) ? rrFloorRaw : DEFAULTS.rrFloor;
  let rrCeil = Number.isFinite(rrCeilRaw) ? rrCeilRaw : DEFAULTS.rrCeil;
  if (rrFloor < 0.5) rrFloor = 0.5;
  if (rrCeil <= rrFloor) rrCeil = rrFloor + 0.1;
  if (rrCeil > 5) rrCeil = 5;

  const baseMinRaw = typeof input?.rrBaseMin === 'number' ? input!.rrBaseMin : DEFAULTS.rrBaseMin;
  let rrBaseMin = Number.isFinite(baseMinRaw) ? baseMinRaw : DEFAULTS.rrBaseMin;
  rrBaseMin = clampNum(rrBaseMin, rrFloor, rrCeil);

  const extras = input?.rrExpectancy ?? {};
  const enabled = extras.enabled === undefined ? DEFAULTS.enabled : Boolean(extras.enabled);
  const minTrades = Number.isFinite(extras.minTrades) ? Math.max(1, Math.floor(extras.minTrades!)) : DEFAULTS.minTrades;
  const lookbackDays = Number.isFinite(extras.lookbackDays)
    ? Math.max(1, Math.floor(extras.lookbackDays!))
    : DEFAULTS.lookbackDays;
  const decay = Number.isFinite(extras.decay) ? clampNum(extras.decay!, 0.01, 1) : DEFAULTS.decay;
  const safetyMult = Number.isFinite(extras.safetyMult) ? clampNum(extras.safetyMult!, 0.5, 3) : DEFAULTS.safetyMult;
  const blend = Number.isFinite(extras.blend) ? clampNum(extras.blend!, 0, 1) : DEFAULTS.blend;
  const hysteresis = Number.isFinite(extras.hysteresis)
    ? clampNum(extras.hysteresis!, 0, 0.2)
    : DEFAULTS.hysteresis;

  return {
    rrFloor: roundTwo(rrFloor),
    rrCeil: roundTwo(rrCeil),
    rrBaseMin: roundTwo(rrBaseMin),
    enabled,
    minTrades,
    lookbackDays,
    decay,
    safetyMult: roundTwo(safetyMult),
    blend: roundTwo(blend),
    hysteresis: roundTwo(hysteresis),
  };
}

export function rrMinFromWinrate(p: number, cfg: RRExpectancyConfig): number {
  if (!Number.isFinite(p) || p <= 0) {
    return roundTwo(cfg.rrCeil);
  }
  if (p >= 1) {
    return roundTwo(cfg.rrFloor);
  }
  const rrTheoretical = (1 - p) / p;
  const rrSafe = rrTheoretical * (cfg.safetyMult ?? 1.0);
  return roundTwo(clampR(rrSafe, cfg));
}

export function blendRR(base: number, dynamic: number, blend: number): number {
  const weight = Number.isFinite(blend) ? clampNum(blend, 0, 1) : 0.5;
  const rr = (1 - weight) * base + weight * dynamic;
  return roundTwo(rr);
}

export function applyHysteresis(prev: number | undefined, next: number, delta: number): number {
  if (!Number.isFinite(next)) return next;
  if (prev == null || !Number.isFinite(prev)) {
    return roundTwo(next);
  }
  const hysteresis = Number.isFinite(delta) ? Math.max(0, delta) : 0;
  const shouldHold = next < prev && prev - next < hysteresis;
  return shouldHold ? roundTwo(prev) : roundTwo(next);
}
