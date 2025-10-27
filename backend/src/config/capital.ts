import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { CapitalManagerConfig } from '../core/capital/types.js';
import { getConfig } from '../utils/env.js';

const envConfig = getConfig();
const configuredMinNotional = (() => {
  const rawValue = Number.isFinite(envConfig.MIN_ORDER_NOTIONAL_USD)
    ? envConfig.MIN_ORDER_NOTIONAL_USD
    : 0;
  if (rawValue > 0) {
    return new PreciseDecimal(rawValue.toString());
  }
  return new PreciseDecimal('40');
})();

export const capitalConfig: CapitalManagerConfig = {
  reserveTtlMs: 8000,
  reserveBufferPct: new PreciseDecimal('0.05'),
  perSymbolCapPct: new PreciseDecimal('0.30'),
  maxPositions: 8,
  minOrderUSD: configuredMinNotional,
  validateLiveBalance: true,
};
