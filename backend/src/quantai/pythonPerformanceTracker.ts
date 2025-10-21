import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type PendingExpectation = {
  expected: number;
  confidence: number;
  timestamp: number;
};

type PerformanceSample = {
  expected: number;
  realized: number;
  confidence: number;
  timestamp: number;
};

type PerformanceMetrics = {
  samples: number;
  hitRate: number;
  expectedHitRate: number;
  realizedEdge: number;
  avgConfidence: number;
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(dirname(dirname(__dirname)));

function resolveMetricsPath(): string {
  if (process.env.PYTHON_PERFORMANCE_PATH?.trim()) {
    return process.env.PYTHON_PERFORMANCE_PATH.trim();
  }
  return join(projectRoot, 'python', 'performance_metrics.json');
}

export class PythonPerformanceTracker {
  private readonly pending = new Map<string, PendingExpectation>();
  private readonly history: PerformanceSample[] = [];
  private readonly maxSamples = 240;
  private readonly metricsPath = resolveMetricsPath();

  constructor(private readonly baseWeight: number) {}

  reset(): void {
    this.pending.clear();
    this.history.length = 0;
    this.flushMetrics();
  }

  recordExpectation(key: string, expected: number, confidence: number): void {
    if (!key) return;
    const sanitizedExpected = clamp(expected, 0, 1);
    const sanitizedConfidence = clamp(confidence, 0, 1);
    this.pending.set(key, {
      expected: sanitizedExpected,
      confidence: sanitizedConfidence,
      timestamp: Date.now(),
    });
  }

  recordOutcome(key: string, normalizedReturn: number): void {
    if (!key) return;
    const expectation = this.pending.get(key);
    if (!expectation) return;
    this.pending.delete(key);
    const realized = normalizedReturn > 0 ? 1 : normalizedReturn < 0 ? 0 : 0.5;
    this.history.push({
      expected: expectation.expected,
      realized,
      confidence: expectation.confidence,
      timestamp: Date.now(),
    });
    if (this.history.length > this.maxSamples) {
      this.history.splice(0, this.history.length - this.maxSamples);
    }
    this.flushMetrics();
  }

  getBiasWeight(fallback = this.baseWeight): number {
    if (this.history.length < 5) {
      return clamp(fallback, 0.2, 1.1);
    }
    const metrics = this.computeMetrics();
    const edgeDelta = clamp(metrics.realizedEdge - (metrics.expectedHitRate - 0.5), -0.35, 0.35);
    const confidenceBoost = clamp(metrics.avgConfidence - 0.5, -0.3, 0.3);
    const weight = fallback * (1 + edgeDelta * 0.8) * (1 + confidenceBoost * 0.4);
    return clamp(weight, 0.35, 1.05);
  }

  getMetrics(): PerformanceMetrics {
    return this.computeMetrics();
  }

  private computeMetrics(): PerformanceMetrics {
    if (this.history.length === 0) {
      return { samples: 0, hitRate: 0.5, expectedHitRate: 0.5, realizedEdge: 0, avgConfidence: 0 };
    }
    const samples = this.history.length;
    let expectedSum = 0;
    let realizedSum = 0;
    let confidenceSum = 0;
    for (const sample of this.history) {
      expectedSum += clamp(sample.expected, 0, 1);
      realizedSum += clamp(sample.realized, 0, 1);
      confidenceSum += clamp(sample.confidence, 0, 1);
    }
    const expectedHitRate = expectedSum / samples;
    const hitRate = realizedSum / samples;
    const avgConfidence = confidenceSum / samples;
    return {
      samples,
      expectedHitRate,
      hitRate,
      realizedEdge: hitRate - 0.5,
      avgConfidence,
    };
  }

  private flushMetrics(): void {
    if (process.env.UNIT_TEST_MODE === 'true') {
      return;
    }
    try {
      const metrics = this.computeMetrics();
      const directory = dirname(this.metricsPath);
      mkdirSync(directory, { recursive: true });
      writeFileSync(this.metricsPath, JSON.stringify(metrics, null, 2), 'utf8');
    } catch (error) {
      if (process.env.DEBUG_PYTHON_TRACKER === 'true') {
        console.warn('[PythonPerformanceTracker] unable to flush metrics', error);
      }
    }
  }
}

