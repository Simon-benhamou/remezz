import { getTicker } from '../../data/market.js';
import { fetchDepth, type DepthSnapshot } from '../../data/depth.js';
import { getSubagentTuning, type MarketQualityLearningRecommendation } from '../../services/subagentLearning.js';
import type { MarketQualityAgent, MarketQualityScore } from './types.js';

const DEFAULT_TARGET_NOTIONAL_USD = 50_000;
const DEFAULT_CACHE_TTL = 20_000;
const DEFAULT_MAX_SPREAD = 16;
const MIN_DEPTH_LEVELS = 10;

type CacheEntry = {
  expires: number;
  score: MarketQualityScore;
};

export class DefaultMarketQualityAgent implements MarketQualityAgent {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly targetNotionalUsd: number = DEFAULT_TARGET_NOTIONAL_USD,
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL,
  ) {}

  async assess(symbol: string): Promise<MarketQualityScore> {
    const key = symbol.toUpperCase();
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.score;
    }

    const learning = await getSubagentTuning('market_quality', symbol);

    const [ticker, depth] = await Promise.all([
      getTicker(symbol).catch((error) => {
        console.warn('[MarketQualityAgent] ticker failed', { symbol, error });
        return null;
      }),
      fetchDepth(symbol, MIN_DEPTH_LEVELS).catch((error) => {
        console.warn('[MarketQualityAgent] depth failed', { symbol, error });
        return null;
      }),
    ]);

    const score = this.buildScore(symbol, ticker, depth, {
      targetNotionalUsd: learning?.liquidityFloorUsd,
      spreadCeilBps: learning?.spreadCeilBps,
      learning,
    });
    const ttlMs = Math.max(5_000, Math.round(this.cacheTtlMs * (learning?.confidence ?? 1)));
    this.cache.set(key, { score, expires: Date.now() + ttlMs });
    return score;
  }

  private buildScore(
    symbol: string,
    ticker: any,
    depth: DepthSnapshot | null,
    opts?: {
      targetNotionalUsd?: number | null;
      spreadCeilBps?: number | null;
      learning?: MarketQualityLearningRecommendation | null;
    },
  ): MarketQualityScore {
    const midPrice = this.computeMidPrice(ticker);
    const targetNotional = opts?.targetNotionalUsd && opts.targetNotionalUsd > 0
      ? opts.targetNotionalUsd
      : this.targetNotionalUsd;
    const rawSpreadBps = this.computeSpreadBps(ticker, midPrice);
    const spreadCap = opts?.spreadCeilBps && opts.spreadCeilBps > 0
      ? opts.spreadCeilBps
      : DEFAULT_MAX_SPREAD;
    const spreadBps = Math.min(rawSpreadBps, spreadCap);
    const bookDepthUsd = this.computeBookDepth(depth, midPrice);
    const impactUsd = this.computeImpactUsd(depth, midPrice, targetNotional);
    const score = this.computeScore(spreadBps, bookDepthUsd, impactUsd, targetNotional);
    return {
      symbol,
      spreadBps,
      bookDepthUsd,
      impactUsd,
      score,
      timestamp: Date.now(),
      tuning: opts?.learning
        ? {
            minScore: opts.learning.minScore,
            liquidityFloorUsd: opts.learning.liquidityFloorUsd,
            spreadCeilBps: opts.learning.spreadCeilBps,
            confidence: opts.learning.confidence,
          }
        : undefined,
    };
  }

  private computeMidPrice(ticker: any): number {
    const bid = Number(ticker?.bid ?? 0);
    const ask = Number(ticker?.ask ?? 0);
    if (bid > 0 && ask > 0) {
      return Number(((bid + ask) / 2).toFixed(6));
    }
    const last = Number(ticker?.last ?? ticker?.close ?? 0);
    return Number(last.toFixed(6)) || 0;
  }

  private computeSpreadBps(ticker: any, midPrice: number): number {
    const bid = Number(ticker?.bid ?? 0);
    const ask = Number(ticker?.ask ?? 0);
    if (!(bid > 0 && ask > 0 && midPrice > 0)) {
      return 12;
    }
    const bps = ((ask - bid) / midPrice) * 10_000;
    if (!Number.isFinite(bps)) {
      return 12;
    }
    return Number(Math.max(0, bps).toFixed(2));
  }

  private computeBookDepth(depth: DepthSnapshot | null, midPrice: number): number {
    if (!depth || !(midPrice > 0)) {
      return 150_000;
    }
    const bidUsd = depth.bids.reduce((acc, level) => acc + level.price * level.size, 0);
    const askUsd = depth.asks.reduce((acc, level) => acc + level.price * level.size, 0);
    const effectiveDepth = Math.min(bidUsd, askUsd);
    if (!Number.isFinite(effectiveDepth) || effectiveDepth <= 0) {
      return 150_000;
    }
    return Number(Math.max(10_000, effectiveDepth).toFixed(0));
  }

  private computeImpactUsd(depth: DepthSnapshot | null, midPrice: number, targetNotionalUsd: number): number {
    if (!depth || !(midPrice > 0)) {
      return 750;
    }
    const target = Math.max(10_000, targetNotionalUsd);
    const buyImpact = this.simulateImpact(depth.asks, midPrice, target, 'buy');
    const sellImpact = this.simulateImpact(depth.bids, midPrice, target, 'sell');
    const fallbackImpact = target * 0.02;
    const worstImpact = Math.max(buyImpact ?? fallbackImpact, sellImpact ?? fallbackImpact);
    if (!Number.isFinite(worstImpact)) {
      return fallbackImpact;
    }
    return Number(Math.max(0, worstImpact).toFixed(0));
  }

  private simulateImpact(
    levels: DepthSnapshot['asks'] | DepthSnapshot['bids'],
    midPrice: number,
    notionalUsd: number,
    side: 'buy' | 'sell',
  ): number | null {
    if (!levels.length || !(midPrice > 0) || !(notionalUsd > 0)) {
      return null;
    }
    let remaining = notionalUsd;
    let cost = 0;
    let filledQty = 0;
    for (const level of levels) {
      if (remaining <= 0) break;
      const availableUsd = level.price * level.size;
      if (!(availableUsd > 0)) continue;
      const takeUsd = Math.min(remaining, availableUsd);
      const qty = takeUsd / level.price;
      cost += qty * level.price;
      filledQty += qty;
      remaining -= takeUsd;
    }
    if (remaining > notionalUsd * 0.2) {
      // Not enough depth to satisfy even 80% of target
      return null;
    }
    const avgFillPrice = cost / filledQty;
    const priceDelta = side === 'buy' ? avgFillPrice - midPrice : midPrice - avgFillPrice;
    const impactUsd = Math.abs(priceDelta) * filledQty;
    if (!Number.isFinite(impactUsd)) {
      return null;
    }
    return impactUsd;
  }

  private computeScore(spreadBps: number, depthUsd: number, impactUsd: number, targetNotionalUsd: number): number {
    const target = Math.max(10_000, targetNotionalUsd);
    const spreadScore = this.clamp(1 - spreadBps / 25);
    const depthScore = this.clamp(depthUsd / (target * 6));
    const impactScore = this.clamp(1 - impactUsd / (target * 0.01));
    const blended = (spreadScore * 0.35) + (depthScore * 0.4) + (impactScore * 0.25);
    return Number(blended.toFixed(2));
  }

  private clamp(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }
}
