import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export type IntradayStrategyConfig = {
  volatility: {
    atrPeriod: number;
    bollingerPeriod: number;
    keltnerPeriod: number;
    squeezeLow: number;
    squeezeHigh: number;
  };
  momentum: {
    rocPeriods: number[];
    emaSlopes: number[];
    rsiPeriods: number[];
    macd: { fast: number; slow: number; signal: number };
  };
  volume: {
    zScoreLookback: number;
    obvLookback: number;
    spikePcts: { p95: number; p99: number };
  };
  orderBook: {
    topDepthLevels: number;
    aggressionLookbackMs: number;
  };
  entry: {
    bom: {
      atrMinPct: number;
      rsiMin: number;
      confirmationBars: number;
      stopBufferBps: number;
      volumeZMin: number;
      aggressionMin: number;
      pyramidMaxAdds: number;
      pyramidPullbackBps: number;
      pyramidScale: number;
      stopGraceMinutes: number;
      stopGraceBps: number;
    };
    mr: {
      atrMaxPct: number;
      rsiMax: number;
      wickMinPct: number;
      cooldownMs: number;
      priceZScore: number;
      obiExtreme: number;
      obiDeltaMin: number;
    };
  };
  risk: {
    baseRiskPct: number;
    bomMultiplier: number;
    mrMultiplier: number;
    dailyStopPct: number;
    maxConcurrentPositions: number;
    cooldownLosses: number;
    cooldownMinutes: number;
    strategyHealth: {
      expectancyFloor: number;
      hitRateFloor: number;
      riskPctReduction: number;
    };
  };
  execution: {
    maxSlippageBps: number;
    makerOffsetBps: { min: number; max: number };
    fallbackSeconds: { min: number; max: number };
    twapThresholdUsd: number;
  };
  management: ManagementConfig;
  stops: {
    bom: { atrMultiplier: number; minPct: number };
    mr: { atrMultiplier: number; minPct: number };
    tp: {
      firstPct: number;
      firstSize: number;
      secondPct: number;
      secondSize: number;
      runner: { atrMultiplier: number; lookback: number };
    };
    timeStopMinutes: number;
  };
};

export type ManagementConfig = {
  microTrigger: {
    enabled: boolean;
    lookbackSec: number;
    entryNudgeBps: number;
  };
  scratch: {
    enabled: boolean;
    aggressionThreshold: number;
  };
  timeStop: {
    minMinutes: number;
    maxMinutes: number;
  };
  tp: {
    minFraction: number;
    maxFraction: number;
  };
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const distDefault = path.join(moduleDir, 'default.json');
const sourceDefault = path.resolve(process.cwd(), 'src/quantai/strategies/intradayDual/config/default.json');
const presetDir = path.join(moduleDir, 'presets');
const sourcePresetDir = path.resolve(process.cwd(), 'src/quantai/strategies/intradayDual/config/presets');

const DEFAULT_PATH = fs.existsSync(distDefault) ? distDefault : sourceDefault;

const presetMap = new Map<string, string>([
  ['normal', fs.existsSync(path.join(presetDir, 'normal.json'))
    ? path.join(presetDir, 'normal.json')
    : path.join(sourcePresetDir, 'normal.json')],
  ['aggressive', fs.existsSync(path.join(presetDir, 'aggressive.json'))
    ? path.join(presetDir, 'aggressive.json')
    : path.join(sourcePresetDir, 'aggressive.json')],
  ['prudent', fs.existsSync(path.join(presetDir, 'prudent.json'))
    ? path.join(presetDir, 'prudent.json')
    : path.join(sourcePresetDir, 'prudent.json')],
]);

function readConfigFromFile(filePath: string): IntradayStrategyConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) {
    return parseYaml(raw) as IntradayStrategyConfig;
  }
  return JSON.parse(raw) as IntradayStrategyConfig;
}

let cached: IntradayStrategyConfig | null = null;

export function loadIntradayConfig(): IntradayStrategyConfig {
  if (cached) return cached;
  const customPath = process.env.INTRADAY_STRATEGY_CONFIG;
  const presetPath = customPath ? presetMap.get(customPath.toLowerCase()) : undefined;
  const resolvedPreset = presetPath && fs.existsSync(presetPath) ? presetPath : null;
  const directPath = customPath && fs.existsSync(customPath) ? customPath : null;
  const sourcePath = resolvedPreset ?? directPath ?? DEFAULT_PATH;
  cached = readConfigFromFile(sourcePath);
  return cached;
}

export function overrideIntradayConfig(config: IntradayStrategyConfig): void {
  cached = config;
}
