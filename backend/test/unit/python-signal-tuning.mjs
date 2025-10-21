import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.UNIT_TEST_MODE = 'true';

const {
  getPythonSignalTuning,
  __resetPythonSignalTuningCache,
} = await import('../../dist/src/quantai/pythonSignalTuning.js');

function writeMetrics(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'python-metrics-'));
  const file = join(dir, 'metrics.json');
  writeFileSync(file, JSON.stringify(payload), 'utf8');
  process.env.PYTHON_TRAINING_METRICS_PATH = file;
  __resetPythonSignalTuningCache();
  return file;
}

const qualityMetrics = {
  accuracy: 0.64,
  f1: 0.61,
  winRate: 0.62,
  expectancy: 0.08,
  gainLossRatio: 1.4,
  trades: 120,
  cagr: 0.45,
  maxDrawdown: 0.12,
  sharpe: 1.2,
  directionalAccuracy: 0.63,
};

writeMetrics(qualityMetrics);
const tuned = getPythonSignalTuning();
assert(tuned.biasWeight > 0.6, 'high quality metrics should boost bias weight');
assert(tuned.neutralThreshold < 0.1, 'high quality metrics should narrow neutral zone');
assert(tuned.gateThreshold < 0.2, 'high quality metrics should ease gating');

const weakMetrics = {
  winRate: 0.52,
  expectancy: -0.02,
  trades: 10,
  maxDrawdown: 0.4,
  sharpe: -0.5,
};

writeMetrics(weakMetrics);
const fallback = getPythonSignalTuning();
assert(Math.abs(fallback.biasWeight - 0.6) < 1e-9, 'insufficient trades should fallback to default weight');
assert(Math.abs(fallback.neutralThreshold - 0.1) < 1e-9, 'fallback neutral threshold should match default');
assert(Math.abs(fallback.gateThreshold - 0.2) < 1e-9, 'fallback gate threshold should match default');

console.log('✅ python signal tuning adapts thresholds based on metrics');
