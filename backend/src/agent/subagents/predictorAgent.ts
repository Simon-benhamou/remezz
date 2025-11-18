import { buildTechSnapshot } from '../../ai/tech.js';
import { getPredictionWithCache } from '../../quantai/predictorCache.js';
import { isPythonPredictorAvailable } from '../../quantai/pythonPredictor.js';
import { loadPythonTrainingMetrics } from '../../quantai/pythonSignalTuning.js';
import { storePredictorDecisionIfChanged } from '../../quantai/predictorDecisionStore.js';
import type { PredictorAgent, PredictorInsight } from './types.js';

const METRICS_REFRESH_MS = 10 * 60_000;

type PredictorFeatureBuilder = (
  snapshot: Awaited<ReturnType<typeof buildTechSnapshot>>,
) => Record<string, number> | null;

let predictorFeatureBuilderPromise: Promise<PredictorFeatureBuilder> | null = null;

async function getPredictorFeatureBuilder(): Promise<PredictorFeatureBuilder> {
  if (!predictorFeatureBuilderPromise) {
    predictorFeatureBuilderPromise = import('../../quantai/strategies/metaAdaptive/metaAdaptiveAgent.js')
      .then((mod) => {
        if (typeof mod.buildPredictorFeatures !== 'function') {
          throw new Error('buildPredictorFeatures export missing');
        }
        return mod.buildPredictorFeatures;
      })
      .catch((error) => {
        predictorFeatureBuilderPromise = null;
        throw error;
      });
  }
  return predictorFeatureBuilderPromise!;
}

export class DefaultPredictorAgent implements PredictorAgent {
  private lastMetricsFetch = 0;
  private cachedRetrainTimestamp: number | null = null;

  constructor(
    private readonly cacheTtlMs: number = Number(process.env.META_ADAPTIVE_PREDICTOR_CACHE_TTL ?? 45_000),
  ) {}

  async analyze(symbol: string): Promise<PredictorInsight> {
    if (!isPythonPredictorAvailable()) {
      return this.buildDisabledInsight(symbol, 'python_predictor_unavailable');
    }

    let snapshot;
    try {
      snapshot = await buildTechSnapshot(symbol);
    } catch (error) {
      console.warn('[PredictorAgent] Unable to build technical snapshot', { symbol, error });
      return this.buildDisabledInsight(symbol, 'tech_snapshot_unavailable', error);
    }

    const featureBuilder = await getPredictorFeatureBuilder();
    const features = featureBuilder(snapshot);
    if (!features || Object.keys(features).length === 0) {
      return this.buildDisabledInsight(symbol, 'predictor_features_unavailable');
    }

    try {
      const prediction = await getPredictionWithCache(symbol, features, {
        ttlMs: this.cacheTtlMs,
        forceFresh: process.env.META_ADAPTIVE_PREDICTOR_FORCE_FRESH === 'true',
      });

      const bias: PredictorInsight['bias'] =
        prediction.decision === 'long'
          ? 'long'
          : prediction.decision === 'short'
            ? 'short'
            : 'neutral';

      const lastPrice = Number(snapshot.last ?? 0);
      void storePredictorDecisionIfChanged({
        symbol,
        decision: prediction.decision,
        probabilityLong: prediction.probabilities.long,
        probabilityShort: prediction.probabilities.short,
        confidence: prediction.confidence,
        entryWeight: prediction.entryWeight,
        riskMultiplier: prediction.riskMultiplier,
        price: Number.isFinite(lastPrice) && lastPrice > 0 ? lastPrice : 0,
      }).catch((error) => {
        console.warn('[PredictorAgent] Failed to persist predictor decision', { symbol, error });
      });

      return {
        symbol,
        enabled: true,
        bias,
        confidence: Number(prediction.confidence.toFixed(3)),
        lastRetrainedAt: this.getLastRetrainedTimestamp(),
        details: {
          decision: prediction.decision,
          probabilities: prediction.probabilities,
          entryWeight: prediction.entryWeight,
          riskMultiplier: prediction.riskMultiplier,
          cooldown: prediction.cooldown,
          lastPrice,
          featuresCount: Object.keys(features).length,
          classOrder: prediction.classOrder ?? null,
          meta: prediction.meta ?? null,
        },
      };
    } catch (error) {
      console.warn('[PredictorAgent] Prediction failed', { symbol, error });
      return this.buildDisabledInsight(symbol, 'prediction_failed', error);
    }
  }

  private getLastRetrainedTimestamp(): number | null {
    const now = Date.now();
    if (this.cachedRetrainTimestamp && now - this.lastMetricsFetch < METRICS_REFRESH_MS) {
      return this.cachedRetrainTimestamp;
    }

    try {
      const metrics = loadPythonTrainingMetrics();
      const timestamp = metrics && Number((metrics as Record<string, unknown>).timestamp);
      this.cachedRetrainTimestamp = Number.isFinite(timestamp) ? timestamp : null;
    } catch (error) {
      console.warn('[PredictorAgent] Failed to read training metrics', { error });
      this.cachedRetrainTimestamp = null;
    } finally {
      this.lastMetricsFetch = now;
    }

    return this.cachedRetrainTimestamp;
  }

  private buildDisabledInsight(symbol: string, reason: string, error?: unknown): PredictorInsight {
    return {
      symbol,
      enabled: false,
      bias: 'neutral',
      confidence: 0,
      lastRetrainedAt: this.getLastRetrainedTimestamp(),
      details: {
        disabledReason: reason,
        error: error instanceof Error ? error.message : error ? String(error) : undefined,
      },
    };
  }
}
