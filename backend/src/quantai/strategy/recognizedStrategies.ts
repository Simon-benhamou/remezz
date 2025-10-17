import { metaAdaptiveStrategyAgent, AdaptiveSignal, PreciseDecimal } from './metaAdaptiveAgent.js';
import { TechnicalSnapshot } from '../../ai/tech.js';

type StrategyBias = 'long' | 'short' | 'both';

export type RecognizedStrategyId =
  | 'classic_trend_following'
  | 'bollinger_mean_reversion'
  | 'breakout_retest'
  | 'momentum_scanner_focus';

export type RecognizedStrategySignal = {
  id: RecognizedStrategyId;
  label: string;
  bias: StrategyBias;
  confidence: number;
  active: boolean;
  reasons: string[];
  metrics: Record<string, number | string | null>;
  meta?: {
    score: number;
    guardrail?: string | null;
    penalties: string[];
    exploration: boolean;
    token?: string | null;
    executionMode?: 'market' | 'limit' | 'twap';
    riskPct?: string;
    stopAtrMult?: string;
    takeProfitMultiples?: string[];
  };
};

type EvaluateOptions = {
  sessionId?: string | null;
  symbol?: string | null;
  bias?: 'long' | 'short' | 'none';
  regime?: string | null;
  allowMomentumOverride?: boolean;
  favorMeanReversion?: boolean;
  micro?: {
    spreadBps?: number | null;
    depthUsd?: number | null;
    slippageBps?: number | null;
    fillRatio?: number | null;
  };
  atr1h?: number | null;
  atr4h?: number | null;
};

function toRecognizedSignal(signal: AdaptiveSignal): RecognizedStrategySignal {
  const labelMap: Record<RecognizedStrategyId, string> = {
    classic_trend_following: 'Adaptive trend follower',
    breakout_retest: 'Adaptive breakout structure',
    bollinger_mean_reversion: 'Adaptive mean reversion',
    momentum_scanner_focus: 'Adaptive momentum scanner',
  };

  const metrics: Record<string, number | string | null> = {
    score: Number(signal.score.toFixed(4)),
    confidence: Number(signal.confidence.toFixed(4)),
    guardrail: signal.guardrail ?? null,
  };

  return {
    id: signal.id,
    label: labelMap[signal.id],
    bias: signal.bias,
    confidence: Number(signal.confidence.toFixed(4)),
    active: signal.active,
    reasons: signal.reasons,
    metrics,
    meta: {
      score: Number(signal.score.toFixed(4)),
      guardrail: signal.guardrail ?? null,
      penalties: signal.penalties,
      exploration: signal.exploration,
      token: signal.token ?? undefined,
      executionMode: signal.plan.executionMode,
      riskPct: signal.plan.riskPct.toFixed(6),
      stopAtrMult: signal.plan.stopAtrMult.toFixed(6),
      takeProfitMultiples: signal.plan.takeProfitMultiples.map(tp => tp.toFixed(4)),
    },
  };
}

export function evaluateRecognizedStrategies(
  snap: TechnicalSnapshot,
  opts: EvaluateOptions = {},
): RecognizedStrategySignal[] {
  const evaluation = metaAdaptiveStrategyAgent.evaluate({
    sessionId: opts.sessionId ?? null,
    symbol: opts.symbol ?? (snap.symbol || 'UNKNOWN'),
    snap,
    biasHint: opts.bias,
    micro: opts.micro,
    atr1h: opts.atr1h,
    atr4h: opts.atr4h,
  });

  return evaluation.signals
    .map(toRecognizedSignal)
    .sort((a, b) => b.meta!.score - a.meta!.score);
}

export function registerAdaptiveTradeEntry(params: {
  sessionId?: string | null;
  symbol: string;
  signal: RecognizedStrategySignal | null;
  qty: number;
  entryPrice: number;
  stopDistance: number;
}): void {
  if (!params.signal || !params.signal.meta) return;
  const planRiskPct = new PreciseDecimal(params.signal.meta.riskPct ?? '0');
  const stopAtrMult = new PreciseDecimal(params.signal.meta.stopAtrMult ?? '1');
  metaAdaptiveStrategyAgent.registerActiveTrade({
    sessionId: params.sessionId,
    symbol: params.symbol,
    family: params.signal.id === 'classic_trend_following'
      ? 'trend'
      : params.signal.id === 'breakout_retest'
        ? 'breakout'
        : params.signal.id === 'bollinger_mean_reversion'
          ? 'mean_reversion'
          : 'momentum',
    id: params.signal.id,
    token: params.signal.meta.token ?? null,
    qty: params.qty,
    entryPrice: params.entryPrice,
    stopDistance: params.stopDistance,
    plan: {
      riskPct: planRiskPct,
      stopAtrMult,
      takeProfitMultiples: (params.signal.meta.takeProfitMultiples ?? []).map(v => new PreciseDecimal(v)),
      executionMode: params.signal.meta.executionMode ?? 'market',
    },
  });
}

export function registerAdaptiveTradeOutcome(params: {
  sessionId?: string | null;
  symbol: string;
  token?: string | null;
  realizedPnlUsd?: number | null;
}): void {
  metaAdaptiveStrategyAgent.registerOutcome(params);
}

export type { StrategyBias };
