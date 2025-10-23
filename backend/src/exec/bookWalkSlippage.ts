import { DepthSnapshot } from '../data/depth.js';

export interface BookWalkResult {
  vwap: number;
  best: number;
  impactBps: number;
  filled: number;
  fallback: boolean;
}

function toPositive(value: number | undefined | null): number {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function walkBook(side: 'buy' | 'sell', qty: number, depth: DepthSnapshot | null | undefined): BookWalkResult {
  const desired = toPositive(qty);
  if (!(desired > 0) || !depth) {
    return { vwap: 0, best: 0, impactBps: 0, filled: 0, fallback: true };
  }

  const levels = side === 'buy' ? depth.asks : depth.bids;
  if (!Array.isArray(levels) || levels.length === 0) {
    return { vwap: 0, best: 0, impactBps: 0, filled: 0, fallback: true };
  }

  const best = toPositive(levels[0]?.price);
  if (!(best > 0)) {
    return { vwap: 0, best: 0, impactBps: 0, filled: 0, fallback: true };
  }

  let remaining = desired;
  let notional = 0;
  let filled = 0;

  for (const level of levels) {
    if (!remaining) break;
    const price = toPositive(level?.price);
    const size = toPositive(level?.size);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(size, remaining);
    if (!(take > 0)) continue;
    notional += take * price;
    filled += take;
    remaining -= take;
    if (remaining <= 1e-12) break;
  }

  if (!(filled > 0)) {
    return { vwap: 0, best, impactBps: 0, filled: 0, fallback: true };
  }

  const vwap = notional / filled;
  const impact = best > 0 ? Math.abs(vwap - best) / best * 10_000 : 0;
  const fallback = filled + 1e-9 < desired;

  return {
    vwap,
    best,
    impactBps: Number.isFinite(impact) ? impact : 0,
    filled,
    fallback,
  };
}
