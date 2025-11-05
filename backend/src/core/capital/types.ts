import { PreciseDecimal } from '../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

export type USD = PreciseDecimal;

export const ZERO_USD = new PreciseDecimal('0');
export const ONE = new PreciseDecimal('1');
export const NEG_ONE = new PreciseDecimal('-1');

export function toUSD(value: string | number | PreciseDecimal | null | undefined): USD {
  if (value instanceof PreciseDecimal) return value;
  if (value === null || value === undefined) return ZERO_USD;
  return new PreciseDecimal(value);
}

export function usdNeg(value: USD): USD {
  return value.times(NEG_ONE);
}

export function usdMax(a: USD, b: USD): USD {
  return a.raw >= b.raw ? a : b;
}

export function usdMin(a: USD, b: USD): USD {
  return a.raw <= b.raw ? a : b;
}

export interface BalanceSnapshot {
  totalUSD: USD;
  freeUSD: USD;
  reservedUSD: USD;
  inPositionsUSD: USD;
  ts: number;
}

export type LedgerDelta = {
  freeUSD?: USD;
  reservedUSD?: USD;
  inPositionsUSD?: USD;
};

export interface BalanceProvider {
  getSnapshot(): Promise<BalanceSnapshot>;
  applyLedgerDelta(delta: LedgerDelta): Promise<void>;
}

export interface Reservation {
  id: string;
  agentId: string;
  symbol: string;
  requestedUSD: USD;
  grantedUSD: USD;
  leverage?: number; // leverage multiplier (e.g., 10 for 10x)
  expiresAt: number;
  state: 'reserved' | 'committed' | 'released';
}

export interface CapitalManagerConfig {
  reserveTtlMs: number;
  reserveBufferPct: USD; // fraction 0..1
  perSymbolCapPct: USD; // fraction of pool total, 0..1
  maxPositions: number;
  minOrderUSD: USD;
  validateLiveBalance?: boolean;
}
