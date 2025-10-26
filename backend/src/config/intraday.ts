import { getConfig } from '../utils/env.js';

export interface SlippageConfig {
  bookWalkEnabled: boolean;
  depthLevels: number;
  fallbackInflation: number;
}

export interface IntradayFeatureFlags {
  INTRADAY_DISALLOW_SYNTHETIC: boolean;
}

export interface IntradayQSConfig {
  enabled: boolean;
  baseRiskPct: number;
  minRiskScale: number;
  maxRiskScale: number;
  qsToScaleSlope: number;
}

export interface IntradayEVConfig {
  enabled: boolean;
  slMinBps: number;
  slMaxBps: number;
  tpGridBps: number[];
  feesBps: number;
}

type IntradayRuntimeConfig = {
  slip: SlippageConfig;
  flags: IntradayFeatureFlags;
  qs: IntradayQSConfig;
  ev: IntradayEVConfig;
};

const DEFAULTS: IntradayRuntimeConfig = {
  slip: {
    bookWalkEnabled: true,
    depthLevels: 10,
    fallbackInflation: 1.3,
  },
  flags: {
    INTRADAY_DISALLOW_SYNTHETIC: true,
  },
  qs: {
    enabled: true,
    baseRiskPct: 0.007,
    minRiskScale: 0.6,
    maxRiskScale: 1.4,
    qsToScaleSlope: 0.7,
  },
  ev: {
    enabled: true,
    slMinBps: 30,
    slMaxBps: 180,
    tpGridBps: [60, 90, 140],
    feesBps: 6,
  },
};

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

function parseBpsArray(value: any, fallback: number[]): number[] {
  if (Array.isArray(value)) {
    const parsed = value.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry) && entry > 0);
    return parsed.length ? parsed : fallback;
  }
  if (typeof value === 'string') {
    const parts = value.split(/[;,]/).map((part) => Number(part.trim()));
    const parsed = parts.filter((entry) => Number.isFinite(entry) && entry > 0);
    return parsed.length ? parsed : fallback;
  }
  return fallback;
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

  const qs: IntradayQSConfig = {
    enabled: parseBool(process.env.INTRADAY_QS_ENABLED, DEFAULTS.qs.enabled),
    baseRiskPct: Math.max(0.0001, parseNumber(process.env.INTRADAY_QS_BASE_RISK_PCT, DEFAULTS.qs.baseRiskPct)),
    minRiskScale: Math.max(0.25, parseNumber(process.env.INTRADAY_QS_MIN_SCALE, DEFAULTS.qs.minRiskScale)),
    maxRiskScale: Math.max(0.1, parseNumber(process.env.INTRADAY_QS_MAX_SCALE, DEFAULTS.qs.maxRiskScale)),
    qsToScaleSlope: parseNumber(process.env.INTRADAY_QS_SCALE_SLOPE, DEFAULTS.qs.qsToScaleSlope),
  };
  if (qs.maxRiskScale < qs.minRiskScale) {
    const mid = (qs.minRiskScale + qs.maxRiskScale) / 2;
    qs.minRiskScale = mid;
    qs.maxRiskScale = mid;
  }

  const ev: IntradayEVConfig = {
    enabled: parseBool(process.env.INTRADAY_EV_ENABLED, DEFAULTS.ev.enabled),
    slMinBps: Math.max(5, Math.round(parseNumber(process.env.INTRADAY_EV_SL_MIN_BPS, DEFAULTS.ev.slMinBps))),
    slMaxBps: Math.max(5, Math.round(parseNumber(process.env.INTRADAY_EV_SL_MAX_BPS, DEFAULTS.ev.slMaxBps))),
    tpGridBps: parseBpsArray(process.env.INTRADAY_EV_TP_GRID_BPS, DEFAULTS.ev.tpGridBps),
    feesBps: Math.max(0, parseNumber(process.env.INTRADAY_EV_FEES_BPS, DEFAULTS.ev.feesBps)),
  };
  if (ev.slMaxBps < ev.slMinBps) {
   const swap = ev.slMinBps;
   ev.slMinBps = ev.slMaxBps;
   ev.slMaxBps = swap;
  }

  return { slip, flags, qs, ev };
}
