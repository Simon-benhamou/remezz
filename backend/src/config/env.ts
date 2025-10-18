import { PreciseDecimal } from '../quantai/strategy/metaAdaptiveAgent.js';

export interface TradingEnv {
  MIN_TARGET_GAIN_USD: PreciseDecimal;
  RISK_PCT_PER_TRADE: number;
  MIN_RR: number;
  FEES_BPS: number;
  SLIP_ALPHA: number;
  SLIP_BETA: number;
  SLIP_CAP_BPS: number;
  ENTRY_LIMIT_TIMEOUT_MS: number;
  ENTRY_TWAP_TRIGGER_SPREAD_BPS: number;
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

export function getEnv(): TradingEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const env: TradingEnv = {
    MIN_TARGET_GAIN_USD: parseDecimal('MIN_TARGET_GAIN_USD', '30'),
    RISK_PCT_PER_TRADE: parseRatio('RISK_PCT_PER_TRADE', 0.015),
    MIN_RR: parsePositive('MIN_RR', 2),
    FEES_BPS: parsePositive('FEES_BPS', 7),
    SLIP_ALPHA: parsePositive('SLIP_ALPHA', 0.7),
    SLIP_BETA: parsePositive('SLIP_BETA', 0.3),
    SLIP_CAP_BPS: parsePositive('SLIP_CAP_BPS', 18),
    ENTRY_LIMIT_TIMEOUT_MS: parsePositive('ENTRY_LIMIT_TIMEOUT_MS', 2500),
    ENTRY_TWAP_TRIGGER_SPREAD_BPS: parsePositive('ENTRY_TWAP_TRIGGER_SPREAD_BPS', 18),
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
