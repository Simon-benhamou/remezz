import { PreciseDecimal } from '../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js';

export interface TradingEnv {
  MIN_TARGET_GAIN_USD: PreciseDecimal;
  RISK_PCT_PER_TRADE: number;
  MIN_RR: number;
  FEES_BPS: number;
  SLIP_ALPHA: number;
  SLIP_BETA: number;
  SLIP_CAP_BPS: number;
  ORDER_LIMIT_TIMEOUT_MS: number;
  ORDER_TWAP_SPREAD_BPS: number;
  ORDER_MARKET_ATR_PCT: number;
  ORDER_MAX_IMPACT_PCT: number;
  ENTRY_SPLIT_LIMIT: number;
  ENTRY_SPLIT_PA: number;
  ACCEPT_Q_TREND: number;
  ACCEPT_Q_RANGE: number;
  ACCEPT_Q_VOL: number;
}

let cachedEnv: TradingEnv | null = null;

function parseNumber(name: string, fallback: number, options?: { clampMin?: number; clampMax?: number }): number {
  const raw = process.env[name];
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const min = options?.clampMin ?? value;
  const max = options?.clampMax ?? value;
  const clamped = Math.min(max, Math.max(min, value));
  return clamped;
}

function parseRatio(name: string, fallback: number): number {
  const parsed = parseNumber(name, fallback, { clampMin: 0, clampMax: 1 });
  return parsed;
}

function parsePositive(name: string, fallback: number): number {
  const parsed = parseNumber(name, fallback, { clampMin: 0 });
  return parsed;
}

function parseDecimal(name: string, fallback: number | string): PreciseDecimal {
  const raw = process.env[name];
  return new PreciseDecimal(raw ?? fallback);
}

function parsePositiveFallback(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw != null) {
      const value = Number(raw);
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }
  return fallback;
}

export function getEnv(): TradingEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const env: TradingEnv = {
    MIN_TARGET_GAIN_USD: parseDecimal('MIN_TARGET_GAIN_USD', '30'),
    RISK_PCT_PER_TRADE: parseRatio('RISK_PCT_PER_TRADE', 0.015),
    MIN_RR: parsePositive('MIN_RR', 2),
    FEES_BPS: parsePositive('FEES_BPS', 8),
    SLIP_ALPHA: parsePositive('SLIP_ALPHA', 0.5),
    SLIP_BETA: parsePositive('SLIP_BETA', 1.2),
    SLIP_CAP_BPS: parsePositive('SLIP_CAP_BPS', 15),
    ORDER_LIMIT_TIMEOUT_MS: parsePositiveFallback(['ORDER_LIMIT_TIMEOUT_MS', 'ENTRY_LIMIT_TIMEOUT_MS'], 2500),
    ORDER_TWAP_SPREAD_BPS: parsePositiveFallback(['ORDER_TWAP_SPREAD_BPS', 'ENTRY_TWAP_TRIGGER_SPREAD_BPS'], 16),
    ORDER_MARKET_ATR_PCT: parsePositive('ORDER_MARKET_ATR_PCT', 4),
    ORDER_MAX_IMPACT_PCT: parsePositive('ORDER_MAX_IMPACT_PCT', 0.35),
    ENTRY_SPLIT_LIMIT: parseRatio('ENTRY_SPLIT_LIMIT', 0.6),
    ENTRY_SPLIT_PA: parseRatio('ENTRY_SPLIT_PA', 0.4),
    ACCEPT_Q_TREND: parseRatio('ACCEPT_Q_TREND', 0.65),
    ACCEPT_Q_RANGE: parseRatio('ACCEPT_Q_RANGE', 0.4),
    ACCEPT_Q_VOL: parseRatio('ACCEPT_Q_VOL', 0.3),
  };

  cachedEnv = env;
  return env;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
