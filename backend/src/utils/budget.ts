import { getConfig, type Cfg } from './env.js';

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function getBudgetFractionBounds(cfg: Cfg = getConfig()): { min: number; max: number } {
  const minCandidate = toNumberOrNull(cfg.PORTFOLIO_MIN_BUDGET_FRACTION);
  const maxCandidate = toNumberOrNull(cfg.PORTFOLIO_MAX_BUDGET_FRACTION);
  const min = Math.max(0.01, Math.min(1, minCandidate ?? 0.25));
  const max = Math.max(min, Math.min(1, maxCandidate ?? 1));
  return { min, max };
}

export function clampBudgetFraction(raw: unknown, cfg: Cfg = getConfig()): number | undefined {
  if (raw == null) return undefined;
  const numeric = toNumberOrNull(raw);
  if (numeric == null) return undefined;
  const { min, max } = getBudgetFractionBounds(cfg);
  const clamped = Math.max(min, Math.min(max, numeric));
  return Number.isFinite(clamped) ? clamped : undefined;
}

export function resolveBudgetFraction(
  raw: unknown,
  cfg: Cfg = getConfig(),
  fallback?: number,
): number {
  const { min, max } = getBudgetFractionBounds(cfg);
  const numeric = toNumberOrNull(raw);
  const fallbackNumeric = toNumberOrNull(fallback);
  const defaultFraction = toNumberOrNull(cfg.DEFAULT_BUDGET_FRACTION) ?? max;
  const candidate = numeric ?? fallbackNumeric ?? defaultFraction;
  return Math.max(min, Math.min(max, candidate));
}

export function derivePortfolioBudgetFraction(
  allocationShare: number,
  cfg: Cfg = getConfig(),
): number {
  const { min, max } = getBudgetFractionBounds(cfg);
  const shareNumeric = toNumberOrNull(allocationShare);
  const multiplierCandidate = toNumberOrNull(cfg.PORTFOLIO_BUDGET_FRACTION_MULTIPLIER);
  const offsetCandidate = toNumberOrNull(cfg.PORTFOLIO_BUDGET_FRACTION_OFFSET);
  const multiplier = multiplierCandidate != null && multiplierCandidate > 0 ? multiplierCandidate : 1;
  const offset = offsetCandidate ?? 0;
  const baseline = shareNumeric != null && shareNumeric > 0 ? shareNumeric * multiplier : 0;
  const candidate = baseline + offset;
  return Math.max(min, Math.min(max, candidate));
}
