import { getExecutionTuning } from '../../services/executionTelemetry.js';
import { getSubagentTuning } from '../../services/subagentLearning.js';
import type {
  ExecutionAgent,
  ExecutionPlan,
  MarketQualityScore,
  RiskLimits,
} from './types.js';

const DEFAULT_BOOK_DEPTH_USD = 120_000;
const DEFAULT_MAX_SPREAD = 16;

type SizeBucket = 'small' | 'medium' | 'large' | 'mega';

export class DefaultExecutionAgent implements ExecutionAgent {
  constructor(private readonly baseMinFillUsd = 1_000) {}

  async plan(params: {
    symbol: string;
    side: 'buy' | 'sell';
    sizeUsd: number;
    spreadBps: number;
    marketQualityScore: number;
    marketQuality?: MarketQualityScore | null;
    riskLimits?: RiskLimits | null;
  }): Promise<ExecutionPlan> {
    const { symbol, side, riskLimits } = params;
    const requestedSize = Math.max(0, Number(params.sizeUsd) || 0);
    const spreadBps = Number.isFinite(params.spreadBps) ? Math.max(0, params.spreadBps) : DEFAULT_MAX_SPREAD;
    const qualityScore = this.clamp(Number(params.marketQualityScore ?? 0.5), 0, 1);
    const marketQuality = params.marketQuality ?? null;
    const depthUsd = this.resolveDepthUsd(marketQuality);
    const depthRatio = depthUsd > 0 ? requestedSize / depthUsd : Number.POSITIVE_INFINITY;
    const impactUsd = Number.isFinite(marketQuality?.impactUsd ?? NaN) ? marketQuality?.impactUsd ?? null : null;
    const sizeBucket = this.pickSizeBucket(requestedSize);
    const tuning = getExecutionTuning(symbol);
    const learning = await getSubagentTuning('execution', symbol);

    // Determine core execution strategy
    const baseStrategy = this.pickStrategy({
      sizeBucket,
      spreadBps,
      qualityScore,
      depthRatio,
      tuningOverride: tuning.modeOverride ?? null,
    });

    let strategy = baseStrategy;
    const learningNotes: string[] = [];
    if (learning?.preferredMode) {
      strategy = learning.preferredMode;
      learningNotes.push(`learning_strategy_${learning.preferredMode}`);
    }

    const urgency = this.pickUrgency({ sizeBucket, qualityScore, strategy });
    const minFillUsd = this.computeMinFill(requestedSize, strategy);
    const maxSlippageBps = this.computeMaxSlippage(spreadBps, qualityScore, strategy);
    let passiveOffsetBps = strategy === 'market'
      ? undefined
      : this.computePassiveOffset({ qualityScore, spreadBps, tuning });
    let fallbackDelayMs = strategy === 'market'
      ? undefined
      : this.computeFallbackDelay({ qualityScore, spreadBps, tuning });
    let twapSlices = strategy === 'twap'
      ? this.computeTwapSlices({ requestedSize, depthUsd, tuning })
      : undefined;
    const twapIntervalMs = strategy === 'twap'
      ? this.computeTwapInterval({ spreadBps, qualityScore, tuning })
      : undefined;

    if (learning) {
      if (strategy !== 'market' && learning.fallbackMs) {
        fallbackDelayMs = Math.max(1200, Math.round(learning.fallbackMs));
        learningNotes.push('learning_fallback');
      }
      if (strategy === 'twap' && learning.twapSliceMultiplier) {
        twapSlices = Math.max(
          2,
          Math.round((twapSlices ?? 2) * this.clamp(learning.twapSliceMultiplier, 0.6, 2.5)),
        );
        learningNotes.push('learning_twap_slices');
      }
      if (passiveOffsetBps != null && learning.passiveBias != null) {
        const bias = this.clamp(learning.passiveBias, 0, 1);
        const scale = bias >= 0.5 ? 1 + (bias - 0.5) * 0.6 : 1 - (0.5 - bias) * 0.6;
        passiveOffsetBps = Math.max(1, Math.round(passiveOffsetBps * scale));
      }
    }

    const notes: string[] = [];
    if (depthRatio > 1.2) notes.push('depth_ratio_gt_1.2');
    if (spreadBps >= DEFAULT_MAX_SPREAD) notes.push('wide_spread');
    if (qualityScore < 0.45) notes.push('low_quality_flow');
    if (requestedSize > (riskLimits?.maxPositionUsd ?? requestedSize) * 0.9) {
      notes.push('near_position_cap');
    }
    if (tuning.modeOverride) {
      notes.push(`telemetry_${tuning.modeOverride}`);
    }
    if (learningNotes.length) {
      notes.push(...learningNotes);
    }

    const preferPassive = learning?.passiveBias != null
      ? learning.passiveBias >= 0.55
      : tuning.preferPassive ?? (strategy === 'iceberg' || strategy === 'twap');
    const preferAggressive = learning?.passiveBias != null
      ? learning.passiveBias <= 0.45
      : tuning.preferAggressive ?? (strategy === 'market' || strategy === 'sweep');

    const plan: ExecutionPlan = {
      symbol,
      side,
      sizeUsd: Math.round(requestedSize),
      urgency,
      strategy,
      minFillUsd,
      maxSlippageBps,
      meta: {
        passiveOffsetBps,
        fallbackDelayMs,
        twapSlices,
        twapIntervalMs,
        preferPassive,
        preferAggressive,
        depthRatio: Number.isFinite(depthRatio) ? Number(depthRatio.toFixed(2)) : undefined,
        sizeBucket,
        tuningSource: learningNotes.length
          ? 'subagentLearning'
          : tuning.modeOverride
            ? 'executionTelemetry'
            : undefined,
        notes: notes.length ? notes : undefined,
        telemetry: {
          marketQualityScore: Number(qualityScore.toFixed(2)),
          spreadBps: Number(spreadBps.toFixed(2)),
          bookDepthUsd: depthUsd,
          impactUsd: impactUsd ?? undefined,
          requestedSizeUsd: requestedSize,
        },
      },
    };

    return plan;
  }

  private resolveDepthUsd(marketQuality: MarketQualityScore | null): number {
    const depth = marketQuality?.bookDepthUsd;
    if (Number.isFinite(depth) && depth && depth > 0) {
      return depth;
    }
    return DEFAULT_BOOK_DEPTH_USD;
  }

  private pickSizeBucket(sizeUsd: number): SizeBucket {
    if (sizeUsd <= 15_000) return 'small';
    if (sizeUsd <= 45_000) return 'medium';
    if (sizeUsd <= 120_000) return 'large';
    return 'mega';
  }

  private pickStrategy(params: {
    sizeBucket: SizeBucket;
    spreadBps: number;
    qualityScore: number;
    depthRatio: number;
    tuningOverride: ('market' | 'limit' | 'twap') | null;
  }): ExecutionPlan['strategy'] {
    if (params.tuningOverride) {
      if (params.tuningOverride === 'market') return 'market';
      if (params.tuningOverride === 'twap') return 'twap';
      return 'iceberg';
    }

    if (params.sizeBucket === 'mega' || params.depthRatio > 1.25) {
      return 'twap';
    }
    if (params.qualityScore >= 0.75 && params.spreadBps < 8 && params.sizeBucket === 'small') {
      return 'market';
    }
    if (params.spreadBps >= 14 || params.qualityScore < 0.5) {
      return 'iceberg';
    }
    if (params.depthRatio > 0.9 || params.sizeBucket === 'large') {
      return 'twap';
    }
    return 'sweep';
  }

  private pickUrgency(params: {
    sizeBucket: SizeBucket;
    qualityScore: number;
    strategy: ExecutionPlan['strategy'];
  }): ExecutionPlan['urgency'] {
    if (params.strategy === 'market') return 'high';
    if (params.strategy === 'twap' && params.sizeBucket !== 'small') return 'low';
    if (params.sizeBucket === 'large' || params.sizeBucket === 'mega') return 'high';
    return params.qualityScore >= 0.65 ? 'high' : 'medium';
  }

  private computeMinFill(sizeUsd: number, strategy: ExecutionPlan['strategy']): number {
    const floor = strategy === 'twap' ? this.baseMinFillUsd * 0.5 : this.baseMinFillUsd;
    const ratio = strategy === 'twap' ? 0.08 : strategy === 'market' ? 0.35 : 0.2;
    const candidate = Math.max(floor, sizeUsd * ratio);
    return Math.min(Math.round(sizeUsd), Math.round(Math.max(500, candidate)));
  }

  private computeMaxSlippage(spreadBps: number, qualityScore: number, strategy: ExecutionPlan['strategy']): number {
    let base = spreadBps;
    if (strategy === 'market') {
      base *= qualityScore >= 0.7 ? 0.6 : 0.85;
      base += 3;
    } else if (strategy === 'twap') {
      base = base * 0.75 + 5;
    } else {
      base = base * 0.9 + (1 - qualityScore) * 10;
    }
    return Math.round(this.clamp(base, 4, 28));
  }

  private computePassiveOffset(params: {
    qualityScore: number;
    spreadBps: number;
    tuning: ReturnType<typeof getExecutionTuning>;
  }): number | undefined {
    if (params.tuning.passiveOffsetBps != null) {
      return Math.max(1, Math.round(params.tuning.passiveOffsetBps));
    }
    const spreadPenalty = params.spreadBps >= 18 ? 4 : params.spreadBps >= 12 ? 2 : 0;
    const qualityPenalty = (1 - params.qualityScore) * 6;
    const base = 4 + spreadPenalty + qualityPenalty;
    return Math.round(this.clamp(base, 2, 16));
  }

  private computeFallbackDelay(params: {
    qualityScore: number;
    spreadBps: number;
    tuning: ReturnType<typeof getExecutionTuning>;
  }): number | undefined {
    if (params.tuning.limitFallbackMs != null) {
      return Math.max(1_200, Math.round(params.tuning.limitFallbackMs));
    }
    const base = 2_600 + params.spreadBps * 45;
    const qualityMultiplier = params.qualityScore >= 0.7 ? 0.85 : params.qualityScore <= 0.4 ? 1.2 : 1;
    return Math.round(this.clamp(base * qualityMultiplier, 1_500, 6_000));
  }

  private computeTwapSlices(params: {
    requestedSize: number;
    depthUsd: number;
    tuning: ReturnType<typeof getExecutionTuning>;
  }): number {
    if (params.tuning.twapSliceCount != null) {
      return Math.max(2, Math.round(params.tuning.twapSliceCount));
    }
    const depthRatio = params.depthUsd > 0 ? params.requestedSize / params.depthUsd : 2;
    const base = depthRatio > 1 ? Math.ceil(depthRatio * 3) : Math.ceil(params.requestedSize / 10_000);
    return this.clamp(Math.max(2, base), 2, 12);
  }

  private computeTwapInterval(params: {
    spreadBps: number;
    qualityScore: number;
    tuning: ReturnType<typeof getExecutionTuning>;
  }): number {
    if (params.tuning.twapIntervalMs != null) {
      return Math.max(200, Math.round(params.tuning.twapIntervalMs));
    }
    const base = 450 + params.spreadBps * 15;
    const adjusted = params.qualityScore >= 0.7 ? base * 0.9 : base * 1.1;
    return Math.round(this.clamp(adjusted, 250, 1_200));
  }

  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
}
