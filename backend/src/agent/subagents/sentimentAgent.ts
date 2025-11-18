import { getHybridSentiment, type HybridSentiment } from '../../sentiment/index.js';
import { detectWhaleActivity, type WhaleActivitySignal } from '../../quantai/strategies/metaAdaptive/whaleActivity.js';
import { getSubagentTuning, type SentimentLearningRecommendation } from '../../services/subagentLearning.js';
import type { SentimentAgent, SentimentSignal } from './types.js';

const DEFAULT_CACHE_TTL_MS = 45_000;
const SEVERITY_WEIGHT: Record<WhaleActivitySignal['severity'], number> = {
  none: 0.25,
  low: 0.4,
  medium: 0.55,
  high: 0.75,
  extreme: 0.9,
};

type CacheEntry = {
  expires: number;
  signal: SentimentSignal;
};

export class DefaultSentimentAgent implements SentimentAgent {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_CACHE_TTL_MS) {}

  async getSignal(symbol: string): Promise<SentimentSignal> {
    const key = symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.signal;
    }

    const learning = await getSubagentTuning('sentiment', symbol);

    const [hybrid, whaleActivity] = await Promise.all([
      getHybridSentiment(symbol).catch((error) => {
        console.warn('[SentimentAgent] hybrid sentiment failed', { symbol, error });
        return null;
      }),
      detectWhaleActivity(symbol, 'both').catch((error) => {
        console.warn('[SentimentAgent] whale activity failed', { symbol, error });
        return null;
      }),
    ]);

    const signal = this.composeSignal(symbol, hybrid, whaleActivity, learning ?? null);
    const ttlMs = Math.max(10_000, learning?.cooldownMs ?? this.ttlMs);
    this.cache.set(key, { signal, expires: Date.now() + ttlMs });
    return signal;
  }

  private composeSignal(
    symbol: string,
    hybrid: HybridSentiment | null,
    whale: WhaleActivitySignal | null,
    learning: SentimentLearningRecommendation | null,
  ): SentimentSignal {
    const bias = this.deriveBias(hybrid, whale);
    const confidence = this.deriveConfidence(hybrid, whale, learning);
    const signal: SentimentSignal = {
      symbol,
      whaleActivity: this.deriveWhaleActivity(whale),
      newsHeat: this.deriveNewsHeat(hybrid, learning),
      bias,
      confidence,
      timestamp: Date.now(),
    };

    return signal;
  }

  private deriveBias(hybrid: HybridSentiment | null, whale: WhaleActivitySignal | null): 'bullish' | 'bearish' | 'neutral' {
    if (hybrid?.label) {
      return hybrid.label;
    }
    if (!whale) {
      return 'neutral';
    }
    if (whale.imbalanceLevel === 'extreme_buy' || whale.imbalanceLevel === 'buy') {
      return 'bullish';
    }
    if (whale.imbalanceLevel === 'extreme_sell' || whale.imbalanceLevel === 'sell') {
      return 'bearish';
    }
    return 'neutral';
  }

  private deriveConfidence(
    hybrid: HybridSentiment | null,
    whale: WhaleActivitySignal | null,
    learning: SentimentLearningRecommendation | null,
  ): number {
    const sentimentComponent = hybrid
      ? Math.max(0.2, Math.min(1, hybrid.confidence ?? Math.abs(hybrid.score - 0.5) * 2))
      : 0.35;
    const whaleComponent = whale ? SEVERITY_WEIGHT[whale.severity] : 0.3;
    const signalWeight = learning ? this.clamp(learning.signalWeight) : 0.7;
    const combined = (sentimentComponent * signalWeight) + (whaleComponent * (1 - signalWeight));
    return Number(this.clamp(combined).toFixed(3));
  }

  private deriveWhaleActivity(whale: WhaleActivitySignal | null): number {
    if (!whale) {
      return 0.35;
    }
    const direction = whale.imbalanceLevel === 'extreme_buy'
      ? 1
      : whale.imbalanceLevel === 'buy'
        ? 0.8
        : whale.imbalanceLevel === 'balanced'
          ? 0.5
          : whale.imbalanceLevel === 'sell'
            ? 0.2
            : 0.05;
    const severity = SEVERITY_WEIGHT[whale.severity];
    const normalized = (severity * 0.6) + (direction * 0.4);
    return Number(this.clamp(normalized).toFixed(3));
  }

  private deriveNewsHeat(
    hybrid: HybridSentiment | null,
    learning: SentimentLearningRecommendation | null,
  ): number {
    if (!hybrid) {
      return 0.3;
    }
    const mentions = this.normalizeMentions(hybrid.mentions ?? this.findFirstNumber(hybrid.sources, 'mentions'));
    const velocity = this.normalizeVelocity(hybrid.velocity ?? this.findFirstNumber(hybrid.sources, 'velocity'));
    const keywordScore = Array.isArray(hybrid.keywords) && hybrid.keywords.length
      ? Math.min(1, hybrid.keywords.length / 6)
      : 0.25;
    const weight = learning ? this.clamp(learning.newsHeatWeight) : 1;
    const newsHeat = (mentions * 0.5) + (velocity * 0.3) + (keywordScore * 0.2);
    return Number(this.clamp(newsHeat * weight).toFixed(3));
  }

  private normalizeMentions(value?: number | null): number {
    const numeric = typeof value === 'number' ? value : null;
    if (numeric == null || !Number.isFinite(numeric) || numeric <= 0) {
      return 0.25;
    }
    const clamped = Math.min(1, Math.log10(numeric + 10) / 3); // ~1 at ~1000 mentions
    return Number(this.clamp(clamped).toFixed(3));
  }

  private normalizeVelocity(value?: number | null): number {
    const numeric = typeof value === 'number' ? value : null;
    if (numeric == null || !Number.isFinite(numeric)) {
      return 0.4;
    }
    const clamped = Math.max(-3, Math.min(3, numeric));
    return Number(((clamped + 3) / 6).toFixed(3));
  }

  private findFirstNumber(
    sources: HybridSentiment['sources'] | undefined,
    field: 'mentions' | 'velocity',
  ): number | null {
    if (!sources?.length) {
      return null;
    }
    for (const source of sources) {
      const value = source[field as keyof typeof source];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) {
      return 0.5;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}
