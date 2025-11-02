type SymbolPrecisionMeta = {
  tickSize?: number | null;
  stepSize?: number | null;
  minQty?: number | null;
};

type NormalizeOrderParams = {
  symbol: string;
  entryPrice: number;
  qty: number;
  stop?: number | null;
  targets?: number[] | null;
  side: 'long' | 'short';
  metadata?: SymbolPrecisionMeta | null;
};

type NormalizeOrderResult = {
  entryPrice: number;
  qty: number;
  stop?: number | null;
  targets?: number[] | null;
  meta: SymbolPrecisionMeta;
};

const DEFAULT_TICK_SIZE = 0.000001;
const DEFAULT_STEP_SIZE = 0.000001;

const precisionCache = new Map<string, SymbolPrecisionMeta>();

function sanitizeStep(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function roundToTick(value: number, tickSize: number): number {
  if (!Number.isFinite(value)) return value;
  if (tickSize <= 0) return Number(value.toFixed(6));
  return Number((Math.round(value / tickSize) * tickSize).toFixed(10));
}

function adjustStop(side: 'long' | 'short', entry: number, stop: number, tickSize: number): number {
  const rounded = roundToTick(stop, tickSize);
  if (!Number.isFinite(entry) || !Number.isFinite(rounded)) return rounded;
  if (rounded === entry) {
    return side === 'long'
      ? entry - tickSize
      : entry + tickSize;
  }
  if (side === 'long' && rounded > entry) {
    return entry - Math.max(tickSize, Math.abs(rounded - entry));
  }
  if (side === 'short' && rounded < entry) {
    return entry + Math.max(tickSize, Math.abs(entry - rounded));
  }
  return rounded;
}

function adjustTarget(side: 'long' | 'short', entry: number, target: number, tickSize: number): number {
  const rounded = roundToTick(target, tickSize);
  if (!Number.isFinite(entry) || !Number.isFinite(rounded)) return rounded;
  if (side === 'long' && rounded <= entry) {
    return entry + Math.max(tickSize, Math.abs(entry - rounded));
  }
  if (side === 'short' && rounded >= entry) {
    return entry - Math.max(tickSize, Math.abs(rounded - entry));
  }
  return rounded;
}

function clampQty(qty: number, stepSize: number, minQty: number | null): number {
  if (!Number.isFinite(qty)) return qty;
  const step = sanitizeStep(stepSize, DEFAULT_STEP_SIZE);
  const floored = Math.floor(qty / step) * step;
  const minimum = minQty != null && Number.isFinite(minQty) && minQty > 0
    ? Math.max(minQty, step)
    : step;
  const normalized = floored >= minimum ? floored : minimum;
  return Number(normalized.toFixed(10));
}

function resolveMeta(symbol: string, override?: SymbolPrecisionMeta | null): SymbolPrecisionMeta {
  const cached = precisionCache.get(symbol) ?? {};
  const merged: SymbolPrecisionMeta = {
    tickSize: override?.tickSize ?? cached.tickSize ?? null,
    stepSize: override?.stepSize ?? cached.stepSize ?? null,
    minQty: override?.minQty ?? cached.minQty ?? null,
  };
  precisionCache.set(symbol, merged);
  return merged;
}

export function primeSymbolPrecision(symbol: string, meta: SymbolPrecisionMeta): void {
  const current = precisionCache.get(symbol) ?? {};
  precisionCache.set(symbol, {
    ...current,
    ...meta,
  });
}

export function normalizeOrder(params: NormalizeOrderParams): NormalizeOrderResult {
  const meta = resolveMeta(params.symbol, params.metadata);
  const tickSize = sanitizeStep(meta.tickSize ?? null, DEFAULT_TICK_SIZE);
  const stepSize = sanitizeStep(meta.stepSize ?? null, DEFAULT_STEP_SIZE);
  const minQty = meta.minQty ?? null;

  const normalizedEntry = roundToTick(params.entryPrice, tickSize);
  let normalizedStop = params.stop != null ? adjustStop(params.side, normalizedEntry, params.stop, tickSize) : params.stop ?? null;
  let normalizedTargets: number[] | null = null;
  if (Array.isArray(params.targets)) {
    normalizedTargets = params.targets.map((target) => adjustTarget(params.side, normalizedEntry, target, tickSize));
  }

  if (normalizedStop != null && params.side === 'long' && normalizedStop >= normalizedEntry) {
    normalizedStop = normalizedEntry - tickSize;
  } else if (normalizedStop != null && params.side === 'short' && normalizedStop <= normalizedEntry) {
    normalizedStop = normalizedEntry + tickSize;
  }

  const normalizedQty = clampQty(params.qty, stepSize, minQty);

  return {
    entryPrice: normalizedEntry,
    qty: normalizedQty,
    stop: normalizedStop,
    targets: normalizedTargets,
    meta: {
      tickSize,
      stepSize,
      minQty,
    },
  };
}

export type { SymbolPrecisionMeta, NormalizeOrderParams, NormalizeOrderResult };
