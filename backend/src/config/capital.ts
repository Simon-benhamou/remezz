import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/preciseDecimal.js';
import { CapitalManagerConfig } from '../core/capital/types.js';
import { getConfig } from '../utils/env.js';

const envConfig = getConfig();
const parsePctOverride = (value?: string | number | null): PreciseDecimal | null => {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const clamped = Math.min(1, Math.max(0.01, parsed));
  return new PreciseDecimal(clamped.toString());
};

const configuredMinNotional = (() => {
  const rawValue = Number.isFinite(envConfig.MIN_ORDER_NOTIONAL_USD)
    ? envConfig.MIN_ORDER_NOTIONAL_USD
    : 0;
  if (rawValue > 0) {
    return new PreciseDecimal(rawValue.toString());
  }
  return new PreciseDecimal('40');
})();

const perSymbolCapOverride = (() => {
  const raw = process.env.META_ADAPTIVE_PER_SYMBOL_CAP_PCT ?? process.env.CAPITAL_PER_SYMBOL_PCT;
  return parsePctOverride(raw ?? null);
})();

export const capitalConfig: CapitalManagerConfig = {
  reserveTtlMs: 8000,
  reserveBufferPct: new PreciseDecimal('0.05'),
  perSymbolCapPct: perSymbolCapOverride ?? new PreciseDecimal('0.30'),
  maxPositions: 8,
  minOrderUSD: configuredMinNotional,
  validateLiveBalance: true,
};
