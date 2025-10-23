import { getConfig } from '../utils/env.js';

export interface SlippageConfig {
  bookWalkEnabled: boolean;
  depthLevels: number;
  fallbackInflation: number;
}

export interface IntradayFeatureFlags {
  INTRADAY_DISALLOW_SYNTHETIC: boolean;
}

type IntradayRuntimeConfig = {
  slip: SlippageConfig;
  flags: IntradayFeatureFlags;
};

const DEFAULTS: IntradayRuntimeConfig = {
  slip: {
    bookWalkEnabled: true,
    depthLevels: 20,
    fallbackInflation: 1.5,
  },
  flags: {
    INTRADAY_DISALLOW_SYNTHETIC: true,
  },
};

let overrideConfig: Partial<IntradayRuntimeConfig> | null = null;

function parseBool(value: any, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const lowered = String(value).trim().toLowerCase();
  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  return fallback;
}

function parseNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function setIntradayRuntimeOverride(config: Partial<IntradayRuntimeConfig> | null): void {
  overrideConfig = config;
}

export function getIntradayRuntimeConfig(): IntradayRuntimeConfig {
  const envCfg = getConfig();
  const slip: SlippageConfig = {
    bookWalkEnabled: parseBool(process.env.INTRADAY_BOOK_WALK_ENABLED, DEFAULTS.slip.bookWalkEnabled),
    depthLevels: Math.max(
      1,
      parseNumber(
        process.env.INTRADAY_DEPTH_LEVELS ?? envCfg.INTRADAY_DEPTH_LEVELS,
        DEFAULTS.slip.depthLevels,
      ),
    ),
    fallbackInflation: Math.max(
      1,
      parseNumber(
        process.env.INTRADAY_SLIP_FALLBACK_INFLATION,
        DEFAULTS.slip.fallbackInflation,
      ),
    ),
  };

  const flags: IntradayFeatureFlags = {
    INTRADAY_DISALLOW_SYNTHETIC: parseBool(
      process.env.INTRADAY_DISALLOW_SYNTHETIC ?? envCfg.INTRADAY_DISALLOW_SYNTHETIC,
      DEFAULTS.flags.INTRADAY_DISALLOW_SYNTHETIC,
    ),
  };

  let runtime: IntradayRuntimeConfig = { slip, flags };
  if (overrideConfig) {
    runtime = {
      slip: { ...runtime.slip, ...(overrideConfig.slip ?? {}) },
      flags: { ...runtime.flags, ...(overrideConfig.flags ?? {}) },
    };
  }
  return runtime;
}
