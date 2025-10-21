import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PythonTrainingMetrics = {
  accuracy?: number;
  f1?: number;
  winRate?: number;
  expectancy?: number;
  gainLossRatio?: number;
  trades?: number;
  cagr?: number;
  maxDrawdown?: number;
  sharpe?: number;
  directionalAccuracy?: number;
};

export type PythonSignalTuning = {
  biasWeight: number;
  neutralThreshold: number;
  gateThreshold: number;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = dirname(dirname(dirname(__dirname)));
const fallbackTuning: PythonSignalTuning = {
  biasWeight: 0.6,
  neutralThreshold: 0.1,
  gateThreshold: 0.2,
};

let cachedTuning: PythonSignalTuning | null = null;
let cachedMetrics: PythonTrainingMetrics | null = null;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function resolveMetricsPath(): string {
  if (process.env.PYTHON_TRAINING_METRICS_PATH?.trim()) {
    return process.env.PYTHON_TRAINING_METRICS_PATH.trim();
  }
  return join(backendRoot, 'python', 'training_metrics.json');
}

export function loadPythonTrainingMetrics(): PythonTrainingMetrics | null {
  if (cachedMetrics) {
    return cachedMetrics;
  }
  try {
    const path = resolveMetricsPath();
    const contents = readFileSync(path, 'utf8');
    const parsed = JSON.parse(contents);
    cachedMetrics = parsed ?? null;
    return cachedMetrics;
  } catch (error) {
    if (process.env.UNIT_TEST_MODE === 'true') {
      console.warn('[pythonSignalTuning] unable to load metrics in test mode:', error);
    }
    return null;
  }
}

function computeTuning(metrics: PythonTrainingMetrics | null): PythonSignalTuning {
  if (!metrics) {
    return fallbackTuning;
  }

  const trades = Number(metrics.trades ?? 0);
  if (!Number.isFinite(trades) || trades < 20) {
    return fallbackTuning;
  }

  const winRate = clamp(Number(metrics.winRate ?? metrics.directionalAccuracy ?? 0.5), 0, 1);
  const expectancy = clamp(Number(metrics.expectancy ?? 0), -1, 1);
  const sharpe = clamp(Number(metrics.sharpe ?? 0), -10, 10);
  const drawdown = clamp(Number(metrics.maxDrawdown ?? 0.2), 0, 1);

  const quality = clamp(
    (winRate - 0.5) * 1.6 + Math.max(0, expectancy) * 4 + Math.max(0, sharpe) * 0.4 - drawdown * 0.5,
    0,
    1,
  );

  const biasWeight = clamp(0.4 + quality * 0.45, 0.4, 0.9);
  const neutralThreshold = clamp(0.12 - quality * 0.05, 0.05, 0.12);
  const gateThreshold = clamp(0.24 - quality * 0.08, 0.14, 0.24);

  return {
    biasWeight,
    neutralThreshold,
    gateThreshold,
  };
}

export function getPythonSignalTuning(): PythonSignalTuning {
  if (cachedTuning) {
    return cachedTuning;
  }
  const metrics = loadPythonTrainingMetrics();
  cachedTuning = computeTuning(metrics);
  return cachedTuning;
}

export function __resetPythonSignalTuningCache(): void {
  cachedTuning = null;
  cachedMetrics = null;
}
