import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';
import { CapitalManagerConfig } from '../core/capital/types.js';

export const capitalConfig: CapitalManagerConfig = {
  reserveTtlMs: 8000,
  reserveBufferPct: new PreciseDecimal('0.05'),
  perSymbolCapPct: new PreciseDecimal('0.30'),
  maxPositions: 8,
  minOrderUSD: new PreciseDecimal('50'),
  validateLiveBalance: true,
};
